import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CliSessionHistoryInput,
	CliSessionHistoryItem,
	CliSessionHistoryResult,
	CliSessionImportInput,
	CliSessionImportResult,
	SessionHistoryHelperRequest,
	SessionHistoryHelperResponse,
	SessionHistoryInspectInput,
	SessionHistoryInspection,
	SessionHistorySourceInspection,
} from "./session-history-types.ts";

const maximumFileBytes = 64 * 1024 * 1024;
const maximumDiscoveryBytes = 128 * 1024 * 1024;
const maximumDiscoveryFiles = 2000;
interface DiscoveredSource {
	path: string;
	root: string;
	digest: string;
	source: SessionHistorySourceInspection;
	conversationId: string;
}

export interface SessionHistoryServiceOptions {
	dataDir: string;
	executable: string;
	entry: string;
	env?: NodeJS.ProcessEnv;
}

/** Import only discovered CLI snapshots; native parsing stays isolated in a read-only ESM subprocess. */
export class SessionHistoryService {
	private options: SessionHistoryServiceOptions;
	private discovered = new Map<string, DiscoveredSource>();
	private sourceTokens = new Map<string, string>();
	private retainedMigrationBytes = 0;
	constructor(options: SessionHistoryServiceOptions) {
		this.options = options;
	}

	async discover(input: CliSessionHistoryInput): Promise<CliSessionHistoryResult> {
		const agentDir = resolve(expandPath(input.agentDir));
		const project = input.project ? resolve(expandPath(input.project)) : undefined;
		const result: CliSessionHistoryResult = {
			roots: [{ path: join(agentDir, "sessions"), kind: "default" }], sessions: [], skipped: [], truncated: false,
		};
		const globalDir = await configuredSessionDir(join(agentDir, "settings.json"), result.skipped);
		const localDir = project ? await configuredSessionDir(join(project, ".pi", "settings.json"), result.skipped) : undefined;
		const configured = input.sessionDir ?? this.options.env?.PI_CODING_AGENT_SESSION_DIR ??
			(this.options.env ? undefined : process.env.PI_CODING_AGENT_SESSION_DIR) ?? localDir ?? globalDir;
		if (configured) {
			const path = resolve(project ?? process.cwd(), expandPath(configured));
			if (path !== result.roots[0].path) result.roots.push({ path, kind: "configured" });
		}
		const candidates: Array<{ path: string; root: string }> = [];
		for (const root of result.roots) {
			if (candidates.length >= maximumDiscoveryFiles) { result.truncated = true; break; }
			try {
				await safeDirectory(root.path);
				const children = await readdir(root.path, { withFileTypes: true });
				for (const child of children) {
					if (candidates.length >= maximumDiscoveryFiles) { result.truncated = true; break; }
					const path = join(root.path, child.name);
					if (child.isSymbolicLink()) {
						result.skipped.push({ path, reason: "不读取符号链接历史。" });
						continue;
					}
					if (child.isFile() && child.name.endsWith(".jsonl")) candidates.push({ path, root: root.path });
					else if (root.kind === "default" && child.isDirectory()) {
						try {
							await safeDirectory(path, root.path);
							for (const file of await readdir(path, { withFileTypes: true })) {
								if (candidates.length >= maximumDiscoveryFiles) { result.truncated = true; break; }
								if (!file.name.endsWith(".jsonl")) continue;
								const sessionPath = join(path, file.name);
								if (file.isSymbolicLink()) result.skipped.push({ path: sessionPath, reason: "不读取符号链接历史。" });
								else if (file.isFile()) candidates.push({ path: sessionPath, root: root.path });
							}
						} catch (error) { result.skipped.push({ path, reason: errorMessage(error) }); }
					}
				}
			} catch (error) {
				if (!isMissing(error)) result.skipped.push({ path: root.path, reason: errorMessage(error) });
			}
		}
		// Preserve tokens from earlier scans while a renderer may still be displaying their results.
		// A changed source always gets a different token and is checked again at import time.
		const files: Array<{ key: string; content: string }> = [];
		const reads = new Map<string, { path: string; root: string; digest: string }>();
		const seenPaths = new Set<string>();
		const canonicalPaths = new Set<string>();
		let totalBytes = 0;
		for (const candidate of candidates) {
			if (seenPaths.has(candidate.path)) continue;
			seenPaths.add(candidate.path);
			if (files.length >= maximumDiscoveryFiles) { result.truncated = true; break; }
			try {
				const content = await safeRead(candidate.path, candidate.root);
				const canonicalPath = await realpath(candidate.path);
				if (canonicalPaths.has(canonicalPath)) continue;
				canonicalPaths.add(canonicalPath);
				const bytes = Buffer.byteLength(content);
				if (totalBytes + bytes > maximumDiscoveryBytes) { result.truncated = true; break; }
				totalBytes += bytes;
				const key = randomUUID();
				reads.set(key, { path: canonicalPath, root: await realpath(candidate.root), digest: digest(content) });
				files.push({ key, content });
			} catch (error) {
				result.skipped.push({ path: candidate.path, reason: errorMessage(error) });
			}
		}
		if (!files.length) return result;
		const response = await this.helper({ type: "discover", files });
		if (response.type !== "discover") throw new Error("Pi 历史读取响应不匹配。");
		for (const file of response.files) {
			const read = reads.get(file.key);
			if (!read) throw new Error("Pi 历史读取返回未知文件。");
			if (!file.source) {
				result.skipped.push({ path: read.path, reason: file.error ?? "无法读取 Pi 会话。" });
				continue;
			}
			if (project && resolve(file.source.project) !== project) continue;
			const sourceKey = `${read.path}\0${read.digest}`;
			const token = this.sourceTokens.get(sourceKey) ?? randomUUID();
			const previous = this.discovered.get(token);
			const source = previous?.source ?? file.source;
			const conversationId = importedId(read.path, read.digest);
			if (!previous) this.retainedMigrationBytes += Buffer.byteLength(source.migratedContent ?? "");
			this.discovered.delete(token);
			this.discovered.set(token, { ...read, source, conversationId });
			this.sourceTokens.set(sourceKey, token);
			const { migratedContent: _migrated, ...metadata } = source;
			const item: CliSessionHistoryItem = { token, sourcePath: read.path, ...metadata };
			if (await this.existingImport(conversationId, file.source.project)) item.importedConversationId = conversationId;
			result.sessions.push(item);
		}
		result.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.sourcePath.localeCompare(b.sourcePath));
		// Only metadata tokens need retention. Bound repeated scans without evicting the latest scan.
		while (this.discovered.size > maximumDiscoveryFiles * 3 || this.retainedMigrationBytes > maximumDiscoveryBytes * 2) {
			const oldest = this.discovered.keys().next().value!;
			const record = this.discovered.get(oldest)!;
			this.retainedMigrationBytes -= Buffer.byteLength(record.source.migratedContent ?? "");
			this.discovered.delete(oldest);
			this.sourceTokens.delete(`${record.path}\0${record.digest}`);
		}
		return result;
	}

	async importSession(input: CliSessionImportInput): Promise<CliSessionImportResult> {
		const record = this.discovered.get(input.token);
		if (!record) throw new Error("历史选择已过期，请重新发现 Pi CLI 历史。");
		const current = await safeRead(record.path, record.root);
		if (digest(current) !== record.digest) throw new Error("源 CLI 历史已变化，请刷新历史后重新导入。");
		const result: CliSessionImportResult = {
			conversationId: record.conversationId,
			sessionFile: this.importPath(record.conversationId),
			project: record.source.project,
			title: record.source.title,
			sourceSessionId: record.source.sourceSessionId,
			alreadyImported: false,
		};
		await mkdir(join(this.options.dataDir, "sessions"), { recursive: true, mode: 0o700 });
		await safeDirectory(join(this.options.dataDir, "sessions"));
		if (await this.existingImport(record.conversationId, record.source.project)) return { ...result, alreadyImported: true };
		const lines = (record.source.migratedContent ?? current).split("\n");
		const headerIndex = lines.findIndex((line) => line.trim());
		const header = JSON.parse(lines[headerIndex]) as Record<string, unknown>;
		// Preserve cwd, parentSession and every other header field. Import lineage is held in the host result.
		lines[headerIndex] = JSON.stringify({ ...header, id: record.conversationId, timestamp: new Date().toISOString() });
		const content = lines.join("\n");
		const temporary = join(dirname(result.sessionFile), `.import-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { flag: "wx", mode: 0o600 });
			// A hard-link publishes the complete file atomically and cannot replace an existing import.
			try { await link(temporary, result.sessionFile); }
			catch (error) {
				if (!isExists(error) || !await this.existingImport(record.conversationId, record.source.project)) throw error;
				result.alreadyImported = true;
			}
		} finally { await rm(temporary, { force: true }); }
		return result;
	}

	async inspect(input: SessionHistoryInspectInput): Promise<SessionHistoryInspection> {
		const content = await safeRead(resolve(input.sessionFile), resolve(this.options.dataDir, "sessions"));
		const response = await this.helper({ type: "inspect", content, leafId: input.leafId });
		if (response.type !== "inspect") throw new Error("Pi 会话树响应不匹配。");
		return response.result;
	}

	private importPath(id: string): string {
		return resolve(this.options.dataDir, "sessions", `cli-import_${id}.jsonl`);
	}

	private async existingImport(id: string, project: string): Promise<boolean> {
		try {
			const content = await safeRead(this.importPath(id), resolve(this.options.dataDir, "sessions"));
			const header: unknown = JSON.parse(content.split("\n").find((line) => line.trim()) ?? "{}");
			if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session" ||
				!("id" in header) || header.id !== id || !("cwd" in header) || header.cwd !== project)
				throw new Error("已有导入副本损坏，请先检查客户端会话文件。");
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	private helper(request: SessionHistoryHelperRequest): Promise<SessionHistoryHelperResponse> {
		return new Promise((resolveResult, reject) => {
			const child = spawn(this.options.executable, [this.options.entry], {
				env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: "1", PI_OFFLINE: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			let outputBytes = 0;
			let stderr = "";
			let failure: Error | undefined;
			const timer = setTimeout(() => { failure = new Error("Pi 历史读取超时。"); child.kill(); }, 60000);
			child.stdout.on("data", (chunk: Buffer) => {
				outputBytes += chunk.length;
				if (outputBytes > maximumDiscoveryBytes * 2) { failure = new Error("Pi 历史读取响应过大。"); child.kill(); }
				else stdout.push(chunk);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
			child.stdin.on("error", (error) => { failure ??= error; });
			child.on("error", (error) => { failure = error; });
			child.on("close", (code) => {
				clearTimeout(timer);
				if (failure) { reject(failure); return; }
				if (code !== 0) { reject(new Error(`Pi 历史读取失败：${stderr.trim() || code}`)); return; }
				try {
					const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
					validateResponse(value);
					resolveResult(value);
				} catch (error) { reject(error); }
			});
			child.stdin.end(JSON.stringify(request));
		});
	}
}

async function configuredSessionDir(path: string, skipped: CliSessionHistoryResult["skipped"]): Promise<string | undefined> {
	try {
		const settings: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!settings || typeof settings !== "object" || !("sessionDir" in settings)) return undefined;
		if (typeof settings.sessionDir !== "string") throw new Error("Pi sessionDir 配置必须是路径字符串。");
		return settings.sessionDir || undefined;
	} catch (error) {
		if (!isMissing(error)) skipped.push({ path, reason: "无法读取 Pi 会话目录配置。" });
		return undefined;
	}
}

async function safeDirectory(path: string, root: string = path): Promise<string> {
	const normalized = resolve(path);
	const base = resolve(root);
	const rootInfo = await lstat(base);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("历史目录不能是符号链接或非文件夹。");
	// macOS exposes /var and /tmp through system symlinks. The selected root establishes the boundary;
	// canonicalize its ancestors, then prohibit links at the root itself and inside that boundary.
	const canonicalRoot = await realpath(base);
	const boundary = contains(base, normalized) ? base : canonicalRoot;
	if (!contains(boundary, normalized)) throw new Error("历史路径超出允许目录。");
	const segments = relative(boundary, normalized).split(sep).filter(Boolean);
	let current = canonicalRoot;
	for (const segment of ["", ...segments]) {
		if (segment) current = join(current, segment);
		const info = await lstat(current);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("历史目录不能是符号链接或非文件夹。");
	}
	if (await realpath(normalized) !== join(canonicalRoot, ...segments)) throw new Error("历史目录包含符号链接。");
	return join(canonicalRoot, ...segments);
}

async function safeRead(path: string, root: string): Promise<string> {
	const original = resolve(path);
	const base = await safeDirectory(resolve(root));
	const parent = await safeDirectory(dirname(original), resolve(root));
	const normalized = join(parent, basename(original));
	const handle = await open(normalized, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > maximumFileBytes) throw new Error("历史必须是 64 MB 以内的普通文件。");
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await handle.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(normalized);
		await safeDirectory(dirname(normalized), base);
		if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
			current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev ||
			await realpath(normalized) !== join(await realpath(base), relative(base, normalized)))
			throw new Error("历史文件读取期间发生变化，请重新发现。");
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally { await handle.close(); }
}

function contains(root: string, path: string): boolean {
	const part = relative(root, path);
	return !part || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function importedId(path: string, contentDigest: string): string {
	const bytes = createHash("sha256").update(path).update("\0").update(contentDigest).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path.startsWith("file://") ? fileURLToPath(path) : path;
}

function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function isExists(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "EEXIST"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "无法读取 Pi 历史。"; }

function validateResponse(value: unknown): asserts value is SessionHistoryHelperResponse {
	// Validate the subprocess wire envelope; its detailed records are generated by our typed ESM sidecar.
	if (!value || typeof value !== "object" || !("type" in value)) throw new Error("无效的 Pi 历史响应。");
	if (value.type === "discover" && "files" in value && Array.isArray(value.files)) return;
	if (value.type === "inspect" && "result" in value && value.result && typeof value.result === "object") return;
	throw new Error("无效的 Pi 历史响应。");
}
