import type { Conversation, Message, ThinkingLevel } from "./shared.ts";
import type { AgentDefinition, AgentModelAlias } from "./agent-types.ts";
import type { DesktopTask, TaskSendResult, TaskStartInput, TaskStatus, TaskStopReason } from "./task-types.ts";
import type {
	WorktreeCreateInput,
	WorktreeInfo,
	WorktreeMergeResult,
	WorktreeRemoveResult,
} from "./worktree-types.ts";

/** Built-in names are conventional; the host also resolves user-defined agents. */
export type SubagentType = string;
export interface DelegationMetadata {
	parentConversationId: string;
	parentToolCallId: string;
	subagentType: SubagentType;
	delegationDepth: 1;
	readOnly: boolean;
	runInBackground: boolean;
	/** Call-level Agent `name`. */
	name?: string;
}
export interface DelegationContext {
	conversationId: string;
	toolCallId: string;
	signal?: AbortSignal;
	/** The other calls of the Agent call's assistant message, when the parent reported them. */
	batch?: { writers: number };
}
export interface DelegatedTaskResult {
	task_id: string;
	conversation_id: string;
	parent_conversation_id: string;
	parent_tool_call_id: string;
	status: TaskStatus;
	description: string;
	subagent_type: SubagentType;
	read_only: boolean;
	worktree_id?: string;
	working_directory: string;
	output: string;
	truncated: boolean;
	/** Present when maxTurns cut the child short; the output is its last partial answer. */
	partial?: true;
	error?: string;
	pending_approvals: number;
	/** Call-level name, present when the parent named the child. */
	name?: string;
	/** Usage of the child's latest finished run. */
	usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
	/** Accepted-but-ignored Agent parameters, e.g. `mode` and `team_name`. */
	warnings?: string[];
}
/** Claude-style model aliases accepted by the Agent tool's `model` parameter. */
export type AgentCallModel = AgentModelAlias;
export const agentCallModels: readonly AgentCallModel[] = ["sonnet", "opus", "haiku", "fable", "inherit"];
export interface AgentToolInput {
	description: string;
	prompt: string;
	/** Defaults to general-purpose; `"fork"` forks this conversation (same as `fork: true`). */
	subagent_type: SubagentType;
	run_in_background?: boolean;
	isolation?: "worktree" | "shared";
	worktree_id?: string;
	fork?: boolean;
	model?: AgentCallModel;
	name?: string;
	/** Accepted for compatibility with Claude Code and ignored (`mode`, `team_name`). */
	ignored?: string[];
}
/** SendMessage: continue an owned child by agentId or call-level name. */
export interface SendMessageInput {
	to: string;
	message: string;
	/** Short preview of the message; accepted for compatibility and not shown to the child. */
	summary?: string;
	run_in_background?: boolean;
}
/**
 * How a message reaches an existing task. `model` messages carry the parent-agent prefix;
 * `user` messages come from the renderer and are sent as typed.
 */
export interface ResumeOptions {
	source: "model" | "user";
	/** Run a finished task's next turn in the background (the parent does not wait on it). */
	background?: boolean;
	/** User messages only: deliver the finished run's result to the parent conversation. */
	notifyParent?: boolean;
	/** The parent's SendMessage tool call; recorded so a replayed call is a no-op. */
	toolCallId?: string;
}
/**
 * Model-facing result of a desktop tool: `text` is what the parent model reads,
 * `details` is structured data for the renderer and `usage` is counted into the
 * parent session's statistics by Pi (it does not change the context usage).
 */
export interface ToolUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ModelToolResult<T = unknown> {
	kind: "desktop_tool_result";
	text: string;
	details: T;
	usage?: ToolUsage;
}
export interface TaskOutputInput {
	task_id: string;
	block?: boolean;
	/** Milliseconds, bounded to 60 seconds. */
	timeout?: number;
}
export interface DelegationCallbacks {
	getConversation(id: string): Conversation | Promise<Conversation>;
	getSelection(id: string): Promise<{
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	}>;
	listTasks(): Promise<DesktopTask[]>;
	/** Resolve a project/user agent definition; built-ins are available when absent. */
	resolveAgent?(project: string, name: string): Promise<AgentDefinition | undefined>;
	/** Resolve Claude-style model aliases (sonnet/opus/haiku/inherit) for the parent conversation. */
	resolveModelAlias?(parentConversationId: string, alias: NonNullable<AgentDefinition["modelAlias"]>, strict?: boolean): Promise<{ provider: string; id: string } | undefined>;
	/** Names of the agent types available in `project` (trusted scopes only), for error messages. */
	listAgentNames?(project: string): Promise<string[]>;
	/** `settings.subagentDefaultBackground`; true when absent. */
	defaultBackground?(): boolean | Promise<boolean>;
	/** `settings.foregroundSubagentTimeoutMs`; 0 waits without limit. */
	foregroundTimeoutMs?(): number | Promise<number>;
	/** Load preloaded skills and persistent agent memory block for a custom agent. */
	prepareAgentContext?(project: string, definition: AgentDefinition): Promise<string | undefined>;
	/** Persist metadata and apply inherited permissions before the task is scheduled. */
	startTask(input: TaskStartInput, metadata: DelegationMetadata): Promise<DesktopTask>;
	cancelTask(id: string, reason?: TaskStopReason): Promise<DesktopTask>;
	/**
	 * Send a message to an existing task: steer a running one, or start the next run of a
	 * finished one with its full history. Never changes the task's permission ceiling.
	 */
	resumeTask?(id: string, message: string, options: ResumeOptions): Promise<TaskSendResult>;
	/**
	 * Count open approvals of a child without starting or waiting on its runtime.
	 * Reading a result must never have lifecycle side effects.
	 */
	pendingApprovalCount?(id: string): number | Promise<number>;
	/** Latest assistant text of a still-active child; never starts a runtime. */
	peekOutput?(id: string): Promise<string | undefined>;
	listWorktrees(project?: string): Promise<WorktreeInfo[]>;
	createWorktree(input: WorktreeCreateInput): Promise<WorktreeInfo>;
	removeWorktree(id: string, owner: string, toolCallId: string): Promise<WorktreeRemoveResult>;
	mergeWorktree(id: string, owner: string, toolCallId: string): Promise<WorktreeMergeResult>;
	isGit(project: string): Promise<boolean>;
	/**
	 * Shared work must not race the delegating parent. Read-only work always may; writable
	 * work only in the foreground (the parent waits on the call) where the host allows it.
	 */
	canRunShared?(parentConversationId: string, readOnly: boolean, foreground: boolean): boolean | Promise<boolean>;
	/** Return true if parent conversation is currently in engine-level plan mode. */
	isPlanMode?(parentConversationId: string): boolean | Promise<boolean>;
	/**
	 * Wait for a task transition without polling: resolve once `predicate` holds or after
	 * `timeout` ms with the latest state (`undefined` if the task no longer exists).
	 */
	waitForTask(id: string, predicate: (task: DesktopTask) => boolean, signal: AbortSignal | undefined, timeout: number): Promise<DesktopTask | undefined>;
	/**
	 * Hand a still-running foreground child over to background delivery, so its result
	 * reaches the parent through the persisted outbox once it finishes.
	 */
	detachTask?(id: string): void | Promise<void>;
	/**
	 * Deliver pending background results of `parentConversationId` from the host's
	 * persisted outbox. Never starts a stopped parent runtime.
	 */
	flushNotifications?(parentConversationId: string): void | Promise<void>;
}

export function finalAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text) return text;
	}
	return "";
}
