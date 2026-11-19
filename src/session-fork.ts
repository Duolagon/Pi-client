import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface SessionEntryLike {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: {
		role?: string;
		content?: unknown;
	};
	[key: string]: unknown;
}

export async function findSessionFileById(sessionDir: string, sessionId: string): Promise<string | undefined> {
	try {
		const entries = await readdir(sessionDir, { withFileTypes: true });
		const suffix = `_${sessionId}.jsonl`;
		const direct = entries.find((item) => item.isFile() && item.name.endsWith(suffix));
		if (direct) return join(sessionDir, direct.name);
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const full = join(sessionDir, entry.name);
			const head = (await readFile(full, "utf8")).split("\n", 1)[0];
			if (!head) continue;
			try {
				const parsed = JSON.parse(head) as { type?: unknown; id?: unknown };
				if (parsed.type === "session" && parsed.id === sessionId) return full;
			} catch {
				// Skip malformed session headers.
			}
		}
	} catch {
		// Session directory may not exist yet.
	}
	return undefined;
}

function unresolvedToolCallIds(entries: SessionEntryLike[]): Set<string> {
	const unresolved = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") {
					const id = (block as { id?: unknown }).id;
					if (typeof id === "string" && id) unresolved.add(id);
				}
			}
		} else if (entry.message.role === "toolResult") {
			const toolCallId = (entry.message as { toolCallId?: unknown }).toolCallId;
			if (typeof toolCallId === "string") unresolved.delete(toolCallId);
		}
	}
	return unresolved;
}

/**
 * Snapshot a parent conversation branch into an isolated Pi v3 JSONL session file for forked subagents.
 * Trailing unresolved assistant toolCall turns are trimmed so the forked child never inherits orphaned tool calls.
 */
export async function createForkedSessionSnapshot(options: {
	sourceSessionFile: string;
	leafId?: string | null;
	childSessionId: string;
	childCwd: string;
	targetDir: string;
}): Promise<string | undefined> {
	const raw = await readFile(options.sourceSessionFile, "utf8");
	const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return undefined;
	const header = JSON.parse(lines[0]!) as { type?: unknown; version?: unknown };
	if (header?.type !== "session") return undefined;

	const byId = new Map<string, SessionEntryLike>();
	const ordered: SessionEntryLike[] = [];
	for (const line of lines.slice(1)) {
		try {
			const entry = JSON.parse(line) as SessionEntryLike;
			if (entry && typeof entry === "object" && typeof entry.id === "string") {
				byId.set(entry.id, entry);
				ordered.push(entry);
			}
		} catch {
			// Skip incomplete line if parent is actively appending mid-turn.
		}
	}
	if (!ordered.length) return undefined;
	if (options.leafId === null) return undefined;

	const targetLeaf = options.leafId && byId.has(options.leafId) ? byId.get(options.leafId)! : ordered.at(-1)!;
	const branch: SessionEntryLike[] = [];
	const seen = new Set<string>();
	let cursor: SessionEntryLike | undefined = targetLeaf;
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		branch.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	branch.reverse();

	// Trim trailing incomplete assistant toolCall turn (e.g. the currently executing Agent invocation).
	while (branch.length > 0 && unresolvedToolCallIds(branch).size > 0) {
		const last = branch.at(-1)!;
		if (last.type === "message" && last.message?.role === "assistant") {
			branch.pop();
			continue;
		}
		if (last.type === "message" && last.message?.role === "toolResult") {
			branch.pop();
			continue;
		}
		break;
	}

	const hasMessages = branch.some((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"));
	if (!hasMessages) return undefined;

	const outFile = join(options.targetDir, `fork-${options.childSessionId}.jsonl`);
	const newHeader = {
		type: "session",
		version: 3,
		id: options.childSessionId,
		timestamp: new Date().toISOString(),
		cwd: options.childCwd,
		parentSession: options.sourceSessionFile,
	};
	const content = [newHeader, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await writeFile(outFile, content, { mode: 0o600 });
	return outFile;
}
