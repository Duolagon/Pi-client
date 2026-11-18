import { spawn } from "node:child_process";
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
}

const servers: Record<string, [string, string[], string]> = {
	".ts": ["typescript-language-server", ["--stdio"], "typescript"],
	".tsx": ["typescript-language-server", ["--stdio"], "typescriptreact"],
	".js": ["typescript-language-server", ["--stdio"], "javascript"],
	".jsx": ["typescript-language-server", ["--stdio"], "javascriptreact"],
	".py": ["pyright-langserver", ["--stdio"], "python"],
	".go": ["gopls", [], "go"],
	".rs": ["rust-analyzer", [], "rust"],
};

function within(project: string, file: string): string | undefined {
	const path = relative(project, file);
	if (path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) return path.split(sep).join("/");
}

type Position = { line: number; character: number };
type Range = { start: Position };
type Symbol = { name: string; selectionRange?: Range; location?: { range: Range }; children?: Symbol[] };
type Diagnostic = { range: Range; message: string; severity?: number };
type Definition = { uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range };
type Packet = { id?: number; method?: string; params?: unknown; error?: { message?: string }; result?: unknown };

function position(range?: Range): CodePosition | undefined {
	const start = range?.start;
	if (start && Number.isSafeInteger(start.line) && Number.isSafeInteger(start.character) && start.line >= 0 && start.character >= 0)
		return { line: start.line + 1, column: start.character + 1 };
}

export async function codeIntelligence(project: string, path: string, env?: NodeJS.ProcessEnv, at?: CodePosition): Promise<CodeIntelligence> {
	const root = await realpath(project);
	const file = await realpath(resolve(root, path));
	if (!within(root, file)) throw new Error("文件超出项目目录。");
	const [server, argv, languageId] = servers[extname(file).toLowerCase()] ?? [];
	if (!server) throw new Error("语言服务支持 JS、TS、Python、Go 和 Rust 文件。");
	const info = await stat(file);
	if (!info.isFile() || info.size > 512 * 1024) throw new Error("语言服务仅支持 512 KiB 以内的文件。");
	const contents = await readFile(file, "utf8");
	const uri = pathToFileURL(file).href;
	const rootUri = pathToFileURL(root).href;
	const result: CodeIntelligence = { server, symbols: [], diagnostics: [], definitions: [] };
	const serverEnv = { ...process.env, ...env };
	for (const key of Object.keys(serverEnv))
		if (key.startsWith("PI_DESKTOP_") || key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS") delete serverEnv[key];
	const child = spawn(server, argv, { cwd: root, env: serverEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
	child.stderr.resume();

	return new Promise((resolveResult, reject) => {
		let buffer = Buffer.alloc(0);
		let complete = false;
		let gotSymbols = false;
		let gotDefinitions = !at;
		let gotDiagnostics = false;
		let analysisTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => finish(gotSymbols && gotDefinitions ? undefined : new Error(`${server} 响应超时。`)), 10000);
		function finish(error?: Error) {
			if (complete) return;
			complete = true;
			clearTimeout(timer);
			clearTimeout(analysisTimer);
			child.stdin.destroy();
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* The language server may have already exited. */ }
			if (error) reject(error);
			else resolveResult(result);
		}
		function send(packet: object) {
			if (complete) return;
			const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...packet }));
			child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
		}
		function maybeFinish() {
			if (!gotSymbols || !gotDefinitions || complete) return;
			if (gotDiagnostics) finish();
			else analysisTimer ??= setTimeout(() => finish(), 1800);
		}
		async function receive(packet: Packet) {
			if (packet.method && packet.id !== undefined) {
				const params = packet.params as { items?: unknown[] } | undefined;
				send({ id: packet.id, result: packet.method === "workspace/configuration" ? (params?.items ?? []).map(() => null) : null });
			} else if (packet.method === "textDocument/publishDiagnostics") {
				const params = packet.params as { uri: string; diagnostics: Diagnostic[] };
				if (params?.uri !== uri || !Array.isArray(params.diagnostics)) return;
				result.diagnostics = params.diagnostics.slice(0, 100).flatMap((item) => {
					const at = position(item.range);
					return at && typeof item.message === "string" ? [{ ...at, message: item.message.slice(0, 2000), severity: item.severity ?? 0 }] : [];
				});
				gotDiagnostics = true;
			} else if (packet.id === 1) {
				if (packet.error) return finish(new Error(`${server} 初始化失败。`));
				send({ method: "initialized", params: {} });
				send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId, version: 1, text: contents } } });
				send({ id: 2, method: "textDocument/documentSymbol", params: { textDocument: { uri } } });
				if (at) send({ id: 3, method: "textDocument/definition", params: { textDocument: { uri }, position: { line: at.line - 1, character: at.column - 1 } } });
			} else if (packet.id === 2) {
				const queue = Array.isArray(packet.result) ? (packet.result as Symbol[]).slice(0, 100) : [];
				for (let i = 0; i < queue.length && i < 100; i++) {
					const item = queue[i];
					const at = position(item.selectionRange ?? item.location?.range);
					if (at && typeof item.name === "string") result.symbols.push({ ...at, name: item.name.slice(0, 200) });
					if (item.children && queue.length < 100) queue.push(...item.children.slice(0, 100 - queue.length));
				}
				gotSymbols = true;
			} else if (packet.id === 3) {
				const definitions = (Array.isArray(packet.result) ? packet.result : packet.result ? [packet.result] : []) as Definition[];
				for (const item of definitions.slice(0, 20)) {
					const at = position(item.targetSelectionRange ?? item.range);
					const target = item.targetUri ?? item.uri;
					if (!at || !target?.startsWith("file:")) continue;
					const actual = await realpath(fileURLToPath(target)).catch(() => "");
					const path = actual && within(root, actual);
					if (path) result.definitions.push({ ...at, path });
				}
				gotDefinitions = true;
			}
			maybeFinish();
		}
		child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? new Error(`未找到 ${server}，请将其安装到系统 PATH。`) : error));
		child.once("exit", () => finish(new Error(`${server} 已退出。`)));
		child.stdin.on("error", (error) => finish(error));
		child.stdout.on("data", (data: Buffer) => {
			if (complete) return;
			buffer = Buffer.concat([buffer, data]);
			while (buffer.length) {
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd < 0) {
					if (buffer.length > 4096) finish(new Error("语言服务器消息头无效。"));
					return;
				}
				const length = Number(/^Content-Length: *(\d+)\r?$/im.exec(buffer.toString("ascii", 0, headerEnd))?.[1]);
				if (!Number.isSafeInteger(length) || length <= 0 || length > 2 * 1024 * 1024) return finish(new Error("语言服务器消息长度无效。"));
				const body = headerEnd + 4;
				if (buffer.length < body + length) return;
				try {
					void receive(JSON.parse(buffer.toString("utf8", body, body + length))).catch(finish);
				} catch {
					return finish(new Error("语言服务器返回无效 JSON。"));
				}
				buffer = buffer.subarray(body + length);
			}
		});
		send({ id: 1, method: "initialize", params: {
			processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: root.split(sep).at(-1) }],
			capabilities: { workspace: { workspaceFolders: true, configuration: true }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, definition: { linkSupport: true } } },
		} });
	});
}
