import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CodePosition { line: number; column: number }
export interface CodeLocation extends CodePosition { path: string }
export interface CodeIntelligence {
	server: string;
	symbols: (CodePosition & { name: string })[];
	diagnostics: (CodePosition & { message: string; severity: number })[];
	definitions: CodeLocation[];
	/** False when the server did not publish or return a diagnostic report. */
	diagnosticsComplete?: boolean;
}

export type CodeIntelligenceOperation = "diagnostics" | "documentSymbol" | "goToDefinition" | "inspect";

const servers: Record<string, [string, string[], string]> = {
	".ts": ["typescript-language-server", ["--stdio"], "typescript"],
	".tsx": ["typescript-language-server", ["--stdio"], "typescriptreact"],
	".js": ["typescript-language-server", ["--stdio"], "javascript"],
	".jsx": ["typescript-language-server", ["--stdio"], "javascriptreact"],
	".py": ["pyright-langserver", ["--stdio"], "python"],
	".go": ["gopls", [], "go"],
	".rs": ["rust-analyzer", [], "rust"],
};

export const LSP_SUPPORTED_EXTENSIONS = new Set(Object.keys(servers));

export function isLspSupportedFile(filePath: string): boolean {
	return LSP_SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

const SEVERITY_LABELS: Record<number, string> = {
	1: "Error",
	2: "Warning",
	3: "Info",
	4: "Hint",
};

export function formatLspDiagnostics(filePath: string, intel: Pick<CodeIntelligence, "server" | "diagnostics">): string {
	if (!intel.diagnostics.length) return "";
	const lines = [`[LSP 诊断 (${intel.server}) ${filePath}]:`];
	for (const d of intel.diagnostics.slice(0, 30)) {
		const level = SEVERITY_LABELS[d.severity] ?? "Diagnostic";
		lines.push(`- L${d.line}:${d.column} [${level}] ${d.message}`);
	}
	if (intel.diagnostics.length > 30) lines.push(`…另有 ${intel.diagnostics.length - 30} 条诊断。`);
	return lines.join("\n");
}

export function formatCodeIntelligence(
	filePath: string,
	intel: CodeIntelligence,
	operation: CodeIntelligenceOperation = "inspect",
): string {
	const sections: string[] = [];
	if (operation === "diagnostics" || operation === "inspect") {
		const diag = formatLspDiagnostics(filePath, intel);
		const status = intel.diagnosticsComplete === false ? "语言服务器尚未报告诊断。" : "无诊断问题。";
		sections.push(diag || `[LSP 诊断 (${intel.server}) ${filePath}]: ${status}`);
	}
	if (operation === "documentSymbol" || operation === "inspect") {
		if (intel.symbols.length) {
			sections.push(
				`[LSP 符号 (${intel.server}) ${filePath}]:\n` +
					intel.symbols.slice(0, 60).map((s) => `- ${s.name} (L${s.line}:${s.column})`).join("\n"),
			);
		} else if (operation === "documentSymbol") {
			sections.push(`[LSP 符号 (${intel.server}) ${filePath}]: 未找到符号。`);
		}
	}
	if (operation === "goToDefinition" || (operation === "inspect" && intel.definitions.length > 0)) {
		if (intel.definitions.length) {
			sections.push(
				`[LSP 定义位置 (${intel.server})]:\n` +
					intel.definitions.map((loc) => `- ${loc.path}:${loc.line}:${loc.column}`).join("\n"),
			);
		} else if (operation === "goToDefinition") {
			sections.push(`[LSP 定义位置 (${intel.server})]: 未找到定义位置。`);
		}
	}
	return sections.join("\n\n");
}

function within(project: string, file: string): string | undefined {
	const path = relative(project, file);
	if (path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) return path.split(sep).join("/");
}

type Position = { line: number; character: number };
type Range = { start: Position };
type Symbol = { name: string; selectionRange?: Range; location?: { range: Range }; children?: Symbol[] };
type Diagnostic = { range: Range; message: string; severity?: number };
type Definition = { uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range };
type Packet = { id?: number | string; method?: string; params?: unknown; error?: { message?: string; code?: number }; result?: unknown };

function position(range?: Range): CodePosition | undefined {
	const start = range?.start;
	if (start && Number.isSafeInteger(start.line) && Number.isSafeInteger(start.character) && start.line >= 0 && start.character >= 0)
		return { line: start.line + 1, column: start.character + 1 };
}

const MAX_SERVERS = 6;
const MAX_QUEUED_INSPECTIONS = 16;
const IDLE_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_REPORT_TIMEOUT_MS = 2_400;
const DIAGNOSTIC_QUIET_MS = 250;
const EMPTY_DIAGNOSTIC_QUIET_MS = 900;

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		void promise.then(
			(value) => { signal.removeEventListener("abort", stop); resolve(value); },
			(error) => { signal.removeEventListener("abort", stop); reject(error); },
		);
	});
}

/** Bound the wait for push diagnostics and let a later semantic report replace an early empty report. */
function diagnosticsForDocument() {
	let report: Diagnostic[] | undefined;
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let resolveReport!: (value: Diagnostic[] | undefined) => void;
	const result = new Promise<Diagnostic[] | undefined>((resolve) => { resolveReport = resolve; });
	const finish = () => { clearTimeout(quiet); clearTimeout(deadline); resolveReport(report); };
	const deadline = setTimeout(finish, DIAGNOSTIC_REPORT_TIMEOUT_MS);
	return {
		result,
		receive(items: Diagnostic[]) {
			report = items;
			clearTimeout(quiet);
			quiet = setTimeout(finish, items.length ? DIAGNOSTIC_QUIET_MS : EMPTY_DIAGNOSTIC_QUIET_MS);
		},
		finish,
	};
}

class LanguageServer {
	readonly root: string;
	pending = 0;
	private readonly name: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly onClose: () => void;
	private readonly ready: Promise<void>;
	private readonly lifetime = new AbortController();
	private requests = new Map<number, (packet?: Packet) => void>();
	private operation: Promise<unknown> = Promise.resolve();
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private documentVersion = 0;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private diagnosticListener?: (params: unknown) => void;
	private closed = false;

	constructor(root: string, name: string, argv: string[], env: NodeJS.ProcessEnv, onClose: () => void) {
		this.root = root;
		this.name = name;
		this.onClose = onClose;
		this.child = spawn(name, argv, { cwd: root, env, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
		this.child.stderr.resume();
		this.child.once("error", (error: NodeJS.ErrnoException) =>
			this.close(error.code === "ENOENT" ? new Error(`未找到 ${name}，请将其安装到系统 PATH。`) : error));
		this.child.once("exit", () => this.close(new Error(`${name} 已退出。`)));
		this.child.stdin.on("error", (error) => this.close(error));
		this.child.stdout.on("data", (data: Buffer) => this.acceptData(data));
		const rootUri = pathToFileURL(root).href;
		this.ready = this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: root.split(sep).at(-1) }],
			capabilities: {
				workspace: { workspaceFolders: true, configuration: true },
				textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, definition: { linkSupport: true } },
			},
		}, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).then(() => this.send({ method: "initialized", params: {} })).catch((error) => {
			this.close(error);
			throw error;
		});
		void this.ready.catch(() => {});
	}

	private send(packet: object): void {
		if (this.closed) return;
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...packet }));
		this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	}

	private request(method: string, params: object, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted || this.closed) return Promise.reject(signal.reason ?? this.lifetime.signal.reason);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const cleanup = () => { this.requests.delete(id); signal.removeEventListener("abort", stop); };
			const stop = () => {
				cleanup();
				this.send({ method: "$/cancelRequest", params: { id } });
				reject(signal.reason);
			};
			this.requests.set(id, (packet) => {
				cleanup();
				if (!packet) reject(this.lifetime.signal.reason);
				else if (packet.error?.code === -32601 && method !== "initialize") resolve(undefined);
				else if (packet.error) reject(new Error(packet.error.message || `${this.name} 请求失败。`));
				else resolve(packet.result);
			});
			signal.addEventListener("abort", stop, { once: true });
			this.send({ id, method, params });
		});
	}

	private acceptData(data: Buffer): void {
		if (this.closed) return;
		this.buffer = Buffer.concat([this.buffer, data]);
		while (this.buffer.length) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (this.buffer.length > 4096) this.close(new Error("语言服务器消息头无效。"));
				return;
			}
			const length = Number(/^Content-Length: *(\d+)\r?$/im.exec(this.buffer.toString("ascii", 0, headerEnd))?.[1]);
			if (!Number.isSafeInteger(length) || length <= 0 || length > 2 * 1024 * 1024) {
				this.close(new Error("语言服务器消息长度无效。"));
				return;
			}
			const body = headerEnd + 4;
			if (this.buffer.length < body + length) return;
			try {
				const packet = JSON.parse(this.buffer.toString("utf8", body, body + length)) as Packet;
				this.buffer = this.buffer.subarray(body + length);
				if (packet.method && packet.id !== undefined) {
					const items = (packet.params as { items?: unknown[] } | undefined)?.items;
					this.send({ id: packet.id, result: packet.method === "workspace/configuration" && Array.isArray(items) ? items.map(() => null) : null });
				} else if (packet.method === "textDocument/publishDiagnostics") {
					this.diagnosticListener?.(packet.params);
				} else if (typeof packet.id === "number") {
					this.requests.get(packet.id)?.(packet);
				}
			} catch {
				this.close(new Error("语言服务器返回无效 JSON。"));
				return;
			}
		}
	}

	inspect(file: string, languageId: string, text: string, operation: CodeIntelligenceOperation, at: CodePosition | undefined, signal: AbortSignal): Promise<CodeIntelligence> {
		if (this.pending >= MAX_QUEUED_INSPECTIONS) return Promise.reject(new Error("语言服务器正在处理其他文件，请稍后重试。"));
		clearTimeout(this.idleTimer);
		this.pending++;
		// One open query per server keeps unversioned diagnostic reports scoped to the requested document.
		const request = this.operation.then(async () => {
			signal.throwIfAborted();
			await waitWithSignal(this.ready, signal);
			this.lifetime.signal.throwIfAborted();
			return this.inspectDocument(file, languageId, text, operation, at, AbortSignal.any([signal, this.lifetime.signal]));
		});
		this.operation = request.catch(() => {});
		const settled = () => {
			this.pending--;
			if (!this.closed && this.pending === 0) {
				this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT_MS);
				this.idleTimer.unref?.();
			}
		};
		void request.then(settled, settled);
		return waitWithSignal(request, signal);
	}

	private async inspectDocument(file: string, languageId: string, text: string, operation: CodeIntelligenceOperation, at: CodePosition | undefined, signal: AbortSignal): Promise<CodeIntelligence> {
		const uri = pathToFileURL(file).href;
		const textDocument = { uri };
		const version = ++this.documentVersion;
		const result: CodeIntelligence = { server: this.name, symbols: [], diagnostics: [], definitions: [] };
		const diagnostics = operation === "inspect" || operation === "diagnostics" ? diagnosticsForDocument() : undefined;
		if (diagnostics) {
			this.diagnosticListener = (value) => {
				const report = value as { uri?: string; version?: number | null; diagnostics?: Diagnostic[] } | undefined;
				if (report?.uri === uri && (report.version == null || report.version === version) && Array.isArray(report.diagnostics))
					diagnostics.receive(report.diagnostics.slice(0, 100));
			};
		}
		this.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId, version, text } } });
		try {
			const [symbols, definitions, report] = await Promise.all([
				operation === "inspect" || operation === "documentSymbol" ? this.request("textDocument/documentSymbol", { textDocument }, signal) : undefined,
				at && (operation === "inspect" || operation === "goToDefinition")
					? this.request("textDocument/definition", { textDocument, position: { line: at.line - 1, character: at.column - 1 } }, signal) : undefined,
				diagnostics ? waitWithSignal(diagnostics.result, signal) : undefined,
			]);
			const queue = Array.isArray(symbols) ? (symbols as Symbol[]).slice(0, 100) : [];
			for (let i = 0; i < queue.length; i++) {
				const item = queue[i];
				const at = position(item?.selectionRange ?? item?.location?.range);
				if (at && typeof item.name === "string") result.symbols.push({ ...at, name: item.name.slice(0, 200) });
				if (Array.isArray(item?.children) && queue.length < 100) queue.push(...item.children.slice(0, 100 - queue.length));
			}
			const locations = (Array.isArray(definitions) ? definitions : definitions ? [definitions] : []) as Definition[];
			for (const item of locations.slice(0, 20)) {
				const at = position(item?.targetSelectionRange ?? item?.range);
				const target = item?.targetUri ?? item?.uri;
				if (!at || typeof target !== "string" || !target.startsWith("file:")) continue;
				const actual = await realpath(fileURLToPath(target)).catch(() => "");
				const path = actual && within(this.root, actual);
				if (path) result.definitions.push({ ...at, path });
			}
			if (diagnostics) {
				result.diagnosticsComplete = report !== undefined;
				result.diagnostics = (report ?? []).flatMap((item) => {
					const at = position(item?.range);
					return at && typeof item.message === "string" ? [{ ...at, message: item.message.slice(0, 2000), severity: item.severity ?? 0 }] : [];
				});
			}
			return result;
		} finally {
			this.diagnosticListener = undefined;
			diagnostics?.finish();
			this.send({ method: "textDocument/didClose", params: { textDocument } });
		}
	}

	close(error = new Error(`${this.name} 语言服务已关闭。`)): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idleTimer);
		this.lifetime.abort(error);
		for (const request of this.requests.values()) request();
		this.child.stdin.destroy();
		try {
			if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
			else this.child.kill("SIGKILL");
		} catch {}
		this.onClose();
	}
}

/** Retain a bounded set of project-local servers across edit/write and interactive requests. */
export class LanguageService {
	private readonly env: NodeJS.ProcessEnv;
	private readonly connections = new Map<string, LanguageServer>();
	private closed = false;
	private generation = 0;

	constructor(env?: NodeJS.ProcessEnv) {
		this.env = { ...process.env, ...env };
		for (const key of Object.keys(this.env))
			if (key.startsWith("PI_DESKTOP_") || key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS") delete this.env[key];
	}

	async inspect(project: string, path: string, at?: CodePosition, operation: CodeIntelligenceOperation = "inspect", caller?: AbortSignal): Promise<CodeIntelligence> {
		const generation = this.generation;
		const bounded = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const signal = caller ? AbortSignal.any([bounded, caller]) : bounded;
		signal.throwIfAborted();
		const root = await realpath(project);
		const file = await realpath(resolve(root, path));
		if (!within(root, file)) throw new Error("文件超出项目目录。");
		const [name, argv, languageId] = servers[extname(file).toLowerCase()] ?? [];
		if (!name) throw new Error("语言服务支持 JS、TS、Python、Go 和 Rust 文件。");
		const info = await stat(file);
		if (!info.isFile() || info.size > 512 * 1024) throw new Error("语言服务仅支持 512 KiB 以内的文件。");
		const text = await readFile(file, { encoding: "utf8", signal });
		signal.throwIfAborted();
		if (this.closed || generation !== this.generation) throw new Error("语言服务配置已改变，请重试。");
		const key = `${root}\0${name}`;
		let connection = this.connections.get(key);
		if (!connection) {
			if (this.connections.size >= MAX_SERVERS) {
				const idle = [...this.connections.values()].find((server) => server.pending === 0);
				if (!idle) throw new Error("语言服务已达到并发上限，请稍后重试。");
				idle.close();
			}
			connection = new LanguageServer(root, name, argv, this.env, () => this.connections.delete(key));
			this.connections.set(key, connection);
		}
		return connection.inspect(file, languageId, text, operation, at, signal);
	}

	closeProject(project: string): void {
		this.generation++;
		for (const server of this.connections.values()) {
			if (server.root === project || within(project, server.root)) server.close();
		}
	}

	close(): void {
		this.closed = true;
		for (const server of this.connections.values()) server.close();
	}
}

export async function codeIntelligence(project: string, path: string, env?: NodeJS.ProcessEnv, at?: CodePosition): Promise<CodeIntelligence> {
	const service = new LanguageService(env);
	try {
		return await service.inspect(project, path, at);
	} finally {
		service.close();
	}
}
