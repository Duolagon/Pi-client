import type { SessionEntriesResult } from "../session-types.ts";
import type { GitCheckpoint } from "../git-types.ts";
import type { Message } from "../shared.ts";

type UserMessage = Extract<Message, { role: "user" }>;

function sameUserMessage(message: UserMessage, candidate: UserMessage): boolean {
	if (message.timestamp !== candidate.timestamp) return false;
	return JSON.stringify(message.content) === JSON.stringify(candidate.content);
}

/** Pair the visible transcript with Pi's active native branch, including repeated prompts. */
export function matchUserEntries(messages: Message[], session: SessionEntriesResult): Record<number, string> {
	const entries = new Map(session.entries.map((entry) => [entry.id, entry]));
	const users: { id: string; message: UserMessage }[] = [];
	const visited = new Set<string>();
	for (let id = session.leafId; id;) {
		if (visited.has(id)) return {};
		visited.add(id);
		const entry = entries.get(id);
		if (!entry) return {};
		if (entry.type === "message" && entry.message.role === "user") users.push({ id, message: entry.message });
		id = entry.parentId;
	}
	users.reverse();
	const visible = messages.flatMap((message, index) => message.role === "user" ? [{ message, index }] : []);
	const offset = users.length - visible.length;
	if (offset < 0) return {};
	const pairs: Record<number, string> = {};
	// Compaction can omit a prefix of the native history. Anchor to the active leaf and validate each pair.
	for (let i = 0; i < visible.length; i++) {
		const user = visible[i];
		const native = users[offset + i];
		if (!sameUserMessage(user.message, native.message)) return {};
		pairs[user.index] = native.id;
	}
	return pairs;
}

export function checkpointByEntry(checkpoints: GitCheckpoint[]): Map<string, GitCheckpoint> {
	const byEntry = new Map<string, GitCheckpoint>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.userEntryId && checkpoint.status !== "pending" && !byEntry.has(checkpoint.userEntryId))
			byEntry.set(checkpoint.userEntryId, checkpoint);
	}
	return byEntry;
}

export function submittedPlan(messages: Message[]): { id: string; content: string } | undefined {
	const start = messages.findLastIndex((message) => message.role === "user");
	for (let i = messages.length - 1; i > start; i--) {
		const message = messages[i];
		if (message.role !== "toolResult" || message.toolName !== "ExitPlanMode") continue;
		if (message.isError) return undefined;
		const result = message.details as { saved?: boolean; content?: string } | undefined;
		return result?.saved && typeof result.content === "string" && result.content.trim()
			? { id: message.toolCallId, content: result.content } : undefined;
	}
}
