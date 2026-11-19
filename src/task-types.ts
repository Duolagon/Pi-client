import type { Command, ThinkingLevel } from "./shared.ts";
import type { AgentPermissionMode } from "./agent-types.ts";
import type { SubagentType } from "./delegation-types.ts";

export type TaskStatus =
	| "queued"
	| "running"
	| "waiting_for_input"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

/**
 * Why a task left the active states. `max_turns` completes with a partial result;
 * `model_stop` means the parent model called TaskStop; `user_stop` is a user action;
 * `parent_abort` is a cascade from the parent's abort; `restart` is an app restart or close.
 */
export type TaskStopReason = "max_turns" | "model_stop" | "user_stop" | "parent_abort" | "restart" | "error";
export const taskStopReasons: readonly TaskStopReason[] = ["max_turns", "model_stop", "user_stop", "parent_abort", "restart", "error"];
export const taskStatuses: readonly TaskStatus[] = ["queued", "running", "waiting_for_input", "completed", "failed", "cancelled", "interrupted"];

/** Token and tool usage of one child run, measured with Pi's `get_session_stats`. */
export interface TaskRunStats {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	toolUses: number;
	/** Wall-clock start of the run (ms since epoch) and its duration. */
	startedAt: number;
	durationMs: number;
	model?: { provider: string; id: string };
}
/** Raw session totals when the current run started; `stats` is the difference to them. */
export interface TaskStatsBaseline {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	toolCalls: number;
	startedAt: number;
}

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
	/** Call-level Agent `name`; SendMessage can address the child by it. */
	name?: string;
	/** Optional active Agent Team name when experimental agentTeams is enabled. */
	teamName?: string;
	/** Owning workflow ID when spawned by WorkflowService. */
	workflowId?: string;
	/** JSON Schema enforced via StructuredOutput for workflow agent steps. */
	structuredOutputSchema?: unknown;
	/** Validated StructuredOutput payload captured from this child task. */
	structuredOutput?: unknown;
	/** 1 for a direct child of a user conversation; validated against MAX_DELEGATION_DEPTH. */
	delegationDepth?: number;
	readOnly?: boolean;
	/** Explicit tool allowlist for a custom agent; built-in Pi tools only. */
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode?: AgentPermissionMode;
	maxTurns?: number;
	isFork?: boolean;
	omitClaudeMd?: boolean;
	mcpServers?: string[];
	runInBackground?: boolean;
	/** `partial` marks a result cut short by maxTurns. */
	result?: { text: string; truncated: boolean; partial?: boolean };
	stopReason?: TaskStopReason;
	/**
	 * Private file under `<dataDir>/agent-prompts/` holding the definition prompt, skills
	 * and memory; passed to the child with `--append-system-prompt`.
	 */
	systemPromptFile?: string;
	/** Usage of the latest run (difference to `statsAtTurnStart`). */
	stats?: TaskRunStats;
	statsAtTurnStart?: TaskStatsBaseline;
	/** Run number of this task; the first run is 1. A notification is keyed by (id, turn). */
	turn: number;
	/** Turn whose background result has been delivered to the parent session. */
	notifiedTurn?: number;
	/**
	 * The parent must not be notified about this turn: the parent model stopped the child
	 * itself (`model_stop`) or the user stopped the parent (`parent_abort`).
	 */
	notifySuppressed?: boolean;
	/**
	 * Message for the next run of a resumed task (SendMessage or the user's "继续对话");
	 * sent instead of `prompt` when `turn > 1` and cleared once Pi accepted it.
	 */
	pendingMessage?: string;
	/** SendMessage tool call ids already applied to this task, newest last (bounded). */
	turnCalls?: string[];
	/**
	 * Set when a persisted delegated record failed validation on load. The host keeps a
	 * minimal record so the child conversation stays read-only and cannot delegate,
	 * instead of falling back to an unrestricted root conversation.
	 */
	quarantined?: boolean;
	/** Runtime-only sanitized view of open interactive requests; never written to disk. */
	pendingApprovals?: TaskPendingApproval[];
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
	disallowedTools?: string[];
	permissionMode?: AgentPermissionMode;
	maxTurns?: number;
	forkParentConversationId?: string;
	isFork?: boolean;
	omitClaudeMd?: boolean;
	mcpServers?: string[];
	/** Appended to the child's system prompt (definition body, skills, memory). */
	systemPrompt?: string;
	/** JSON Schema for StructuredOutput injection on workflow steps. */
	structuredOutputSchema?: unknown;
}

export interface TaskProgressActivity {
	toolName: string;
	summary?: string;
	startedAt: number;
}
/**
 * Sanitized view of an open interactive request (`extension_ui_request`) on a task.
 * Bounded (message <= 4 KiB, options <= 50) and runtime-only (never persisted to disk).
 */
export interface TaskPendingApproval {
	id: string;
	method: "confirm" | "select" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}
/** A descendant task's open approval surfaced to its ancestor conversation. */
export interface ChildApprovalRequest {
	taskId: string;
	conversationId: string;
	description: string;
	name?: string;
	subagentType?: string;
	depth: number;
	request: TaskPendingApproval;
}
/** Live progress of an active child run; emitted throttled without persisting on every tick. */
export interface TaskProgress {
	taskId: string;
	status: TaskStatus;
	turn: number;
	toolUses: number;
	lastToolName?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	startedAt: number;
	durationMs: number;
	waitingForApproval?: boolean;
	recentActivities: TaskProgressActivity[];
}

export type TaskEvent =
	| { type: "task_updated"; task: DesktopTask }
	/** Throttled live progress for an active task; never persisted on each event. */
	| { type: "task_progress"; taskId: string; progress: TaskProgress }
	/**
	 * Background results held for a parent conversation: queued for its next turn or
	 * waiting for a parent runtime. The renderer shows them with a "立即交付" action.
	 */
	| { type: "task_notifications"; conversationId: string; pending: number };
/**
 * Outcome of a message sent to an existing task: `resumed` started a new run of a
 * finished task, `delivered_to_running_agent` steered a running one.
 */
export interface TaskSendResult {
	status: "resumed" | "delivered_to_running_agent";
	task: DesktopTask;
}
export interface TaskSendInput {
	taskId: string;
	message: string;
	/** Deliver the finished run's result to the parent conversation (delegated children only). */
	notifyParent?: boolean;
}
export type TaskCommand = Exclude<Command, { type: "new_session" | "switch_session" | "fork" | "clone" }>;
