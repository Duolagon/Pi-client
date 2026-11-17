import type { Command, ThinkingLevel } from "./shared.ts";
import type { SubagentType } from "./delegation-types.ts";

export type TaskStatus =
	| "queued"
	| "running"
	| "waiting_for_input"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface DesktopTask {
	id: string;
	conversationId: string;
	project: string;
	workingDirectory: string;
	worktreeId?: string;
	title: string;
	prompt: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	revision: number;
	error?: string;
	checkpointId?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	/** Present only on model-delegated children; manual tasks have no parent. */
	parentConversationId?: string;
	parentToolCallId?: string;
	subagentType?: SubagentType;
	delegationDepth?: 1;
	readOnly?: boolean;
	/** Explicit tool allowlist for a custom agent; built-in Pi tools only. */
	allowedTools?: string[];
	runInBackground?: boolean;
	result?: { text: string; truncated: boolean };
}

export interface TaskStartInput {
	project?: string;
	message: string;
	title?: string;
	isolation?: "worktree" | "shared";
	baseRef?: string;
	worktreeId?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	allowedTools?: string[];
}

export type TaskEvent = { type: "task_updated"; task: DesktopTask };
export type TaskCommand = Exclude<Command, { type: "new_session" | "switch_session" | "fork" | "clone" }>;
