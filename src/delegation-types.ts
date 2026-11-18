import type { Conversation, Message, Snapshot, ThinkingLevel } from "./shared.ts";
import type { AgentDefinition } from "./agent-types.ts";
import type { DesktopTask, TaskStartInput, TaskStatus } from "./task-types.ts";
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
}
export interface DelegationContext {
	conversationId: string;
	toolCallId: string;
	signal?: AbortSignal;
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
	error?: string;
	pending_approvals: number;
}
export interface AgentToolInput {
	description: string;
	prompt: string;
	subagent_type: SubagentType;
	run_in_background?: boolean;
	isolation?: "worktree" | "shared";
	worktree_id?: string;
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
	/** Persist metadata and apply inherited permissions before the task is scheduled. */
	startTask(input: TaskStartInput, metadata: DelegationMetadata): Promise<DesktopTask>;
	cancelTask(id: string): Promise<DesktopTask>;
	taskSnapshot(id: string): Promise<Pick<Snapshot, "messages" | "pendingUI">>;
	listWorktrees(project?: string): Promise<WorktreeInfo[]>;
	createWorktree(input: WorktreeCreateInput): Promise<WorktreeInfo>;
	removeWorktree(id: string, owner: string, toolCallId: string): Promise<WorktreeRemoveResult>;
	mergeWorktree(id: string, owner: string, toolCallId: string): Promise<WorktreeMergeResult>;
	isGit(project: string): Promise<boolean>;
	/** Shared writable work must not wait forever behind the delegating parent. */
	canRunShared?(parentConversationId: string, readOnly: boolean): boolean | Promise<boolean>;
	/** Return true if parent conversation is currently in engine-level plan mode. */
	isPlanMode?(parentConversationId: string): boolean | Promise<boolean>;
	/** Wake the parent with a compact result, without copying the child's complete transcript. */
	notify?(parentConversationId: string, result: DelegatedTaskResult): void | Promise<void>;
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
