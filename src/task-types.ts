import type { Command, ThinkingLevel } from "./shared.ts";

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
}

export type TaskEvent = { type: "task_updated"; task: DesktopTask };
export type TaskCommand = Exclude<Command, { type: "new_session" | "switch_session" | "fork" | "clone" }>;
