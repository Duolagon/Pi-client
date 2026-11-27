import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

export interface CliSessionHistoryInput {
	agentDir: string;
	project?: string;
	/** Host-selected CLI --session-dir. The renderer must not supply arbitrary import paths. */
	sessionDir?: string;
}

export interface CliSessionHistoryItem {
	token: string;
	sourceSessionId: string;
	sourcePath: string;
	project: string;
	title: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	entryCount: number;
	branchCount: number;
	leafId: string | null;
	model: { provider: string; modelId: string } | null;
	importedConversationId?: string;
}

export interface CliSessionHistoryResult {
	roots: Array<{ path: string; kind: "default" | "configured" }>;
	sessions: CliSessionHistoryItem[];
	skipped: Array<{ path: string; reason: string }>;
	truncated: boolean;
}

export interface CliSessionImportInput {
	token: string;
}

export interface CliSessionImportResult {
	conversationId: string;
	sessionFile: string;
	project: string;
	title: string;
	sourceSessionId: string;
	alreadyImported: boolean;
}

export interface SessionHistoryInspectInput {
	sessionFile: string;
	/** Omitted restores the physical file leaf; null explicitly selects the empty root. */
	leafId?: string | null;
}

export interface SessionHistoryInspection {
	entries: SessionEntry[];
	tree: SessionTreeNode[];
	leafId: string | null;
	messages: AgentMessage[];
	forkMessages: Array<{ entryId: string; text: string }>;
}

export const maximumSearchSessions = 2000;

export interface SessionHistorySearchCandidate extends SessionHistoryInspectInput {
	conversationId: string;
	/** A new live session can have a path before its first message is saved. */
	unmaterialized?: boolean;
}

/** Internal sidecar wire types. Only the host selects the permitted search root and session paths. */
export type SessionHistoryHelperRequest =
	| { type: "discover"; files: Array<{ key: string; content: string }> }
	| { type: "inspect"; content: string; leafId?: string | null }
	| { type: "search"; query: string; root: string; sessions: SessionHistorySearchCandidate[] };

export interface SessionHistorySourceInspection {
	sourceSessionId: string;
	project: string;
	title: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	entryCount: number;
	branchCount: number;
	leafId: string | null;
	model: { provider: string; modelId: string } | null;
	/** Legacy migration occurs only in memory; v3 keeps the original lines verbatim. */
	migratedContent?: string;
}

export type SessionHistoryHelperResponse =
	| { type: "discover"; files: Array<{ key: string; source?: SessionHistorySourceInspection; error?: string }> }
	| { type: "inspect"; result: SessionHistoryInspection }
	| { type: "search"; matches: Array<{ conversationId: string; snippet: string }>; partial: boolean };
