import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { ComposerDraft } from "./composer-draft.ts";
import type { Conversation, Snapshot } from "./shared.ts";
import type {
	CliSessionHistoryInput,
	CliSessionHistoryResult,
	CliSessionImportResult,
} from "./session-history-types.ts";

export interface SessionCopyInput {
	conversationId?: string;
	title?: string;
	activate?: boolean;
}
export interface SessionForkInput extends SessionCopyInput {
	entryId: string;
}
export interface SessionCopyResult {
	cancelled: boolean;
	conversation?: Conversation;
	selectedText?: string;
	snapshot: Snapshot;
}
export interface SessionEntriesInput {
	conversationId?: string;
	since?: string;
}
export interface SessionEntriesResult {
	entries: SessionEntry[];
	leafId: string | null;
}
export interface SessionTreeResult {
	tree: SessionTreeNode[];
	leafId: string | null;
}
export interface SessionNavigateInput {
	conversationId?: string;
	targetId: string;
	label?: string;
}
export interface SessionNavigateResult {
	cancelled: boolean;
	leafId: string | null;
	editorText?: string;
	editorDraft?: ComposerDraft;
	snapshot: Snapshot;
}
export interface SessionHistoryInput extends Omit<CliSessionHistoryInput, "agentDir"> {}
export interface SessionHistoryImportInput {
	token: string;
	activate?: boolean;
}
export interface SessionHistoryImportResult extends CliSessionImportResult {
	conversation: Conversation;
	snapshot: Snapshot;
}
export interface DesktopSessionAPI {
	fork(input: SessionForkInput): Promise<SessionCopyResult>;
	clone(input?: SessionCopyInput): Promise<SessionCopyResult>;
	entries(input?: SessionEntriesInput): Promise<SessionEntriesResult>;
	tree(conversationId?: string): Promise<SessionTreeResult>;
	forkMessages(conversationId?: string): Promise<{ messages: { entryId: string; text: string }[] }>;
	navigate(input: SessionNavigateInput): Promise<SessionNavigateResult>;
	history(input?: SessionHistoryInput): Promise<CliSessionHistoryResult>;
	importHistory(input: SessionHistoryImportInput): Promise<SessionHistoryImportResult>;
}
