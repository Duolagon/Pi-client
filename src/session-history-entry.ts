import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { SessionManager, type ContextEditEntry, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { safeDirectory } from "./session-history.ts";
import { maximumSearchSessions } from "./session-history-types.ts";
import type {
	SessionHistoryHelperRequest,
	SessionHistoryHelperResponse,
	SessionHistorySourceInspection,
} from "./session-history-types.ts";
import { isDesktopWorkspaceContext, visiblePromptText } from "./file-references.ts";

const maximumSearchFileBytes = 64 * 1024 * 1024;
const maximumSearchBytes = 256 * 1024 * 1024;
const maximumSearchMatches = 100;

// Keep the SDK in this ESM sidecar: its import.meta asset URLs cannot run inside Electron's CJS host.
process.stdin.setEncoding("utf8");
const chunks: string[] = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
	const text = String(chunk);
	inputBytes += Buffer.byteLength(text);
	if (inputBytes > 320 * 1024 * 1024) throw new Error("历史读取请求超过大小限制。");
	chunks.push(text);
}
const request: unknown = JSON.parse(chunks.join(""));
validateRequest(request);
let response: SessionHistoryHelperResponse;
if (request.type === "discover") {
	response = {
		type: "discover",
		files: request.files.map(({ key, content }) => {
			try {
				return { key, source: discover(content) };
			} catch (error) {
				return { key, error: error instanceof Error ? error.message : "无法读取 Pi 会话。" };
			}
		}),
	};
} else if (request.type === "search") {
	response = await searchFiles(request);
} else {
	const manager = readOnlySession(request.content);
	if (request.leafId === null) manager.resetLeaf();
	else if (request.leafId !== undefined) manager.branch(request.leafId);
	const entries = manager.getEntries();
	response = {
		type: "inspect",
		result: {
			entries,
			tree: manager.getTree(),
			leafId: manager.getLeafId(),
			messages: manager.buildSessionContext().messages,
			forkMessages: userMessages(entries),
		},
	};
}
process.stdout.write(JSON.stringify(response));

function validateRequest(value: unknown): asserts value is SessionHistoryHelperRequest {
	// The subprocess stdin is a wire boundary, even though its producer is our host.
	if (!value || typeof value !== "object" || !("type" in value)) throw new Error("无效的历史读取请求。");
	if (value.type === "inspect") {
		if (!("content" in value) || typeof value.content !== "string") throw new Error("缺少会话内容。");
		if ("leafId" in value && value.leafId !== null && typeof value.leafId !== "string")
			throw new Error("无效的会话节点。");
		return;
	}
	if (value.type === "search") {
		if (!("query" in value) || typeof value.query !== "string" || value.query.length > 400 ||
			!("root" in value) || typeof value.root !== "string" || !isAbsolute(value.root) ||
			!("sessions" in value) || !Array.isArray(value.sessions) || value.sessions.length > maximumSearchSessions)
			throw new Error("无效的历史搜索请求。");
		for (const file of value.sessions) {
			if (
				!file ||
				typeof file !== "object" ||
				typeof file.conversationId !== "string" ||
				typeof file.sessionFile !== "string" || !isAbsolute(file.sessionFile) ||
				(file.unmaterialized !== undefined && typeof file.unmaterialized !== "boolean") ||
				(file.leafId !== undefined && file.leafId !== null && typeof file.leafId !== "string")
			)
				throw new Error("无效的历史搜索文件。");
		}
		return;
	}
	if (value.type !== "discover" || !("files" in value) || !Array.isArray(value.files))
		throw new Error("无效的历史发现请求。");
	for (const file of value.files) {
		if (!file || typeof file !== "object" || typeof file.key !== "string" || typeof file.content !== "string")
			throw new Error("无效的历史发现文件。");
	}
}

function extractSearchableMessageText(role: string, c: unknown): string {
	if (role !== "user" && role !== "assistant") return "";
	if (typeof c === "string") return visiblePromptText(c);
	if (!Array.isArray(c)) return "";
	return c
		.flatMap((b, index) =>
			b &&
			typeof b === "object" &&
			(b as { type?: string }).type === "text" &&
			typeof (b as { text?: unknown }).text === "string" &&
			(index === 0 || !isDesktopWorkspaceContext((b as { text: string }).text))
				? [visiblePromptText((b as { text: string }).text)]
				: [],
		)
		.join(" ");
}

function searchText(value: string): string {
	return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

async function searchFiles(request: Extract<SessionHistoryHelperRequest, { type: "search" }>):
	Promise<Extract<SessionHistoryHelperResponse, { type: "search" }>> {
	const needle = searchText(request.query).toLowerCase();
	const result: Extract<SessionHistoryHelperResponse, { type: "search" }> = { type: "search", matches: [], partial: false };
	if (needle.length < 2) return result;
	let remaining = maximumSearchBytes;
	for (const session of request.sessions) {
		if (session.leafId === null) continue;
		if (!remaining || result.matches.length === maximumSearchMatches) {
			result.partial = true;
			break;
		}
		try {
			const file = await readSearchFile(session.sessionFile, request.root, Math.min(maximumSearchFileBytes, remaining));
			remaining -= file.size;
			result.partial ||= file.partial;
			if (!file.content) {
				result.partial ||= !session.unmaterialized;
				continue;
			}
			const manager = readOnlySession(file.content);
			if (session.leafId !== undefined) manager.branch(session.leafId);
			const snippet = branchSearchSnippet(manager.getBranch(), needle);
			if (snippet) result.matches.push({ conversationId: session.conversationId, snippet });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !session.unmaterialized) result.partial = true;
		}
	}
	return result;
}

function branchSearchSnippet(entries: SessionEntry[], needle: string): string | undefined {
	const edits = new Map<string, ContextEditEntry["replacement"]>();
	for (const entry of entries) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	// The full selected branch includes earlier messages that compaction removed from the model context.
	for (const entry of entries) {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
		const replacement = edits.get(entry.id);
		if (replacement === null) continue;
		const clean = searchText(extractSearchableMessageText(entry.message.role, replacement?.content ?? entry.message.content));
		const at = clean.toLowerCase().indexOf(needle);
		if (at < 0) continue;
		const start = Math.max(0, at - 28);
		const end = Math.min(clean.length, at + needle.length + 56);
		return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
	}
}

async function readSearchFile(path: string, root: string, maxBytes: number):
	Promise<{ content: string; size: number; partial: boolean }> {
	const base = await safeDirectory(root);
	const parent = await safeDirectory(dirname(path), root);
	const normalized = join(parent, basename(path));
	const handle = await open(normalized, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > maxBytes) return { content: "", size: 0, partial: true };
		const bytes = Buffer.allocUnsafe(before.size);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(normalized);
		await safeDirectory(parent, base);
		if (length !== before.size || after.size < before.size || current.size < after.size ||
			(after.size === before.size && current.size === before.size && before.mtimeMs !== current.mtimeMs) ||
			current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev ||
			await realpath(normalized) !== join(base, relative(base, normalized))) {
			return { content: "", size: length, partial: true };
		}
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const lastNewline = bytes.lastIndexOf(10);
		if (lastNewline + 1 < length) {
			try {
				const tail = decoder.decode(bytes.subarray(lastNewline + 1));
				if (tail.trim()) JSON.parse(tail);
			} catch {
				return { content: decoder.decode(bytes.subarray(0, lastNewline + 1)), size: length, partial: true };
			}
		}
		return { content: decoder.decode(bytes), size: length, partial: false };
	} finally {
		await handle.close();
	}
}

function readOnlySession(content: string): SessionManager {
	// Pi's forgiving parser drops damaged lines. Reject them first so an import cannot silently lose history.
	const rawEntries: unknown[] = content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	if (!rawEntries.length) throw new Error("空会话文件。");
	for (const entry of rawEntries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("type" in entry) || typeof entry.type !== "string")
			throw new Error("会话包含无效条目。");
	}
	const rawHeader = rawEntries[0] as Record<string, unknown>;
	if (rawHeader.type !== "session" || typeof rawHeader.id !== "string" || !rawHeader.id ||
		typeof rawHeader.cwd !== "string" || !isAbsolute(rawHeader.cwd) ||
		typeof rawHeader.timestamp !== "string" || !Number.isFinite(Date.parse(rawHeader.timestamp)))
		throw new Error("缺少有效的 Pi 会话头或原项目路径。");
	if (rawHeader.version !== undefined && rawHeader.version !== 1 && rawHeader.version !== 2 && rawHeader.version !== 3)
		throw new Error("暂不支持该 Pi 会话版本。");
	if (rawEntries.slice(1).some((entry) => (entry as Record<string, unknown>).type === "session"))
		throw new Error("会话包含重复的会话头。");
	const manager = SessionManager.inMemory(rawHeader.cwd, undefined, rawEntries as FileEntry[]);
	const seen = new Set<string>();
	for (const entry of manager.getEntries()) {
		// Native loading accepts orphan parents; reject cycles and forward references before traversing its tree.
		if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id) ||
			(entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId))) ||
			typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)))
			throw new Error("会话树包含重复节点、无效父节点或时间戳。");
		seen.add(entry.id);
		if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string"))
			throw new Error("会话包含无效消息。");
	}
	return manager;
}

function discover(content: string): SessionHistorySourceInspection {
	const sourceVersion = (JSON.parse(content.split("\n").find((line) => line.trim()) ?? "{}") as { version?: number }).version ?? 1;
	const manager = readOnlySession(content);
	const header = manager.getHeader()!;
	const entries = manager.getEntries();
	const forkMessages = userMessages(entries);
	const name = manager.getSessionName()?.trim() || undefined;
	let updatedAt = Date.parse(header.timestamp);
	let messageCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		messageCount++;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
		const timestamp = entry.message.timestamp;
		updatedAt = Math.max(updatedAt, typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.parse(entry.timestamp));
	}
	let branchCount = 0;
	const pending = [...manager.getTree()];
	while (pending.length) {
		const node = pending.pop()!;
		if (!node.children.length) branchCount++;
		else pending.push(...node.children);
	}
	return {
		sourceSessionId: header.id,
		project: header.cwd,
		title: (name ?? forkMessages[0]?.text ?? "未命名 Pi 会话").replace(/\s+/g, " ").slice(0, 100),
		name,
		createdAt: Date.parse(header.timestamp),
		updatedAt,
		messageCount,
		entryCount: entries.length,
		branchCount,
		leafId: manager.getLeafId(),
		model: manager.buildSessionContext().model,
		migratedContent: sourceVersion < 3 ? [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n" : undefined,
	};
}

function userMessages(entries: SessionEntry[]): Array<{ entryId: string; text: string }> {
	const result: Array<{ entryId: string; text: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = typeof entry.message.content === "string" ? entry.message.content :
			entry.message.content.flatMap((block, index) => block.type === "text" && (index === 0 || !isDesktopWorkspaceContext(block.text)) ? [block.text] : []).join("");
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
}
