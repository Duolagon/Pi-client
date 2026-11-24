import { isAbsolute } from "node:path";
import { parseSessionEntries, SessionManager, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	SessionHistoryHelperRequest,
	SessionHistoryHelperResponse,
	SessionHistorySourceInspection,
} from "./session-history-types.ts";
import { isDesktopWorkspaceContext } from "./file-references.ts";

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
	if (value.type !== "discover" || !("files" in value) || !Array.isArray(value.files))
		throw new Error("无效的历史发现请求。");
	for (const file of value.files) {
		if (!file || typeof file !== "object" || typeof file.key !== "string" || typeof file.content !== "string")
			throw new Error("无效的历史发现文件。");
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
	const entries: FileEntry[] = parseSessionEntries(content);
	const manager = SessionManager.inMemory(rawHeader.cwd, undefined, entries);
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
