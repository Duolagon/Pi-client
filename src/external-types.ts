import type { RuntimePermissionPolicy } from "./permission-types.ts";
import type { TaskStatus } from "./task-types.ts";

export type ExternalProvider = "codex" | "claude" | "kimi" | "antigravity";
export interface ExternalApprovalOption { id: string; label: string; kind?: string }
export interface ExternalApprovalRequest {
	id: string;
	kind: "tool" | "command" | "file" | "question" | "permissions";
	toolName: string;
	input: Record<string, unknown>;
	description?: string;
	options?: ExternalApprovalOption[];
}
export interface ExternalApprovalResponse {
	decision: "allow" | "deny" | "cancel";
	optionId?: string;
	answers?: Record<string, string | string[]>;
}
export type ExternalAdapterEvent =
	| { type: "session"; sessionId: string }
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; id: string; name: string; input: unknown }
	| { type: "tool_update"; id: string; text: string }
	| { type: "tool_end"; id: string; isError: boolean; output?: string }
	| { type: "diagnostic"; message: string }
	| { type: "usage"; inputTokens?: number; outputTokens?: number; sessionCostUsd?: number };
export interface ExternalTurnResult {
	status: "completed" | "cancelled";
	text: string;
	sessionId?: string;
}
export interface ExternalSessionOptions {
	executable: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	resumeSessionId?: string;
	policy: RuntimePermissionPolicy;
	/** The host resolved trust for the original project, including runs in its Worktree. */
	projectTrusted?: boolean;
	/** Native model id the user pinned for this executor (multi tier settings); absent keeps the CLI default. */
	model?: string;
	/** Native reasoning effort the user pinned; absent keeps the CLI default. */
	effort?: string;
	/** A native USD cap for this turn, where the executor exposes one. */
	maxBudgetUsd?: number;
	/** SDK helper is shipped with the desktop host; never model supplied. */
	helperPath?: string;
	nodeExecutable?: string;
	onEvent(event: ExternalAdapterEvent): void;
	/** Mandatory authorization for every operation the protocol exposes. */
	onPermission(request: ExternalApprovalRequest, signal?: AbortSignal): Promise<ExternalApprovalResponse>;
}
export interface ExternalSession {
	readonly sessionId: string | undefined;
	run(prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult>;
	/** Redacted tail of the native program's diagnostic output. */
	diagnostics?(): string;
	interrupt(): Promise<void>;
	close(): Promise<void>;
}
export interface ExternalAdapter {
	open(options: ExternalSessionOptions): Promise<ExternalSession>;
}

export interface ExternalExecutor {
	id: ExternalProvider;
	enabled: boolean;
	available: boolean;
	executable?: string;
	version?: string;
	error?: string;
	capabilities: { transport: "app-server" | "sdk" | "acp"; continuation: boolean; approvals: boolean; cancellation: boolean; readOnly: boolean; fineGrainedPolicy: boolean; approvalSemantics: "per-tool-hook" | "native" | "agent-rules" };
}
export interface ExternalExecutorInput { id: ExternalProvider; executable?: string | null; enabled?: boolean }
export interface ExternalTask {
	id: string;
	executor: ExternalProvider;
	parentConversationId: string;
	parentToolCallId?: string;
	title: string;
	project: string;
	workingDirectory: string;
	worktreeId?: string;
	subagentType: "Explore" | "Plan" | "general-purpose";
	readOnly: boolean;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	revision: number;
	turn: number;
	eventSequence: number;
	nativeSessionId?: string;
	output: string;
	truncated: boolean;
	error?: string;
	pendingApprovals: ExternalApprovalRequest[];
	/** True when the parent does not wait and the result arrives as a notification. */
	runInBackground?: boolean;
	/** Files the last turn changed, from the host checkpoint (tracked and untracked files). */
	changes?: ExternalChangeSummary;
}
export interface ExternalChangedFile { path: string; status: "added" | "modified" | "deleted" | "type-changed"; additions?: number; deletions?: number; binary?: boolean }
export interface ExternalChangeSummary {
	files: ExternalChangedFile[];
	/** More files changed than `files` lists. */
	truncated: boolean;
	additions: number;
	deletions: number;
	/** Checkpoint holding the full before/after diff. */
	checkpointId?: string;
}
export interface ExternalTaskStartInput {
	executor: ExternalProvider;
	conversationId?: string;
	description: string;
	prompt: string;
	subagent_type?: "Explore" | "Plan" | "general-purpose";
	isolation?: "shared" | "worktree";
	worktree_id?: string;
	run_in_background?: boolean;
}
export interface ExternalTaskSendInput { taskId: string; message: string; runInBackground?: boolean }
export interface ExternalTaskResult {
	task_id: string;
	executor: ExternalProvider;
	parent_conversation_id: string;
	parent_tool_call_id?: string;
	status: TaskStatus;
	turn: number;
	native_session_id?: string;
	worktree_id?: string;
	working_directory: string;
	output: string;
	truncated: boolean;
	error?: string;
	pending_approvals: number;
	/** Changed files and line counts of the last turn; absent for read-only tasks. */
	changes?: ExternalChangeSummary;
}
export type ExternalEvent = {
	taskId: string;
	executor: ExternalProvider;
	parentConversationId: string;
	sequence: number;
	turn: number;
	timestamp: number;
	event: ExternalAdapterEvent | { type: "task_updated"; task: ExternalTask } | { type: "approval"; request: ExternalApprovalRequest } | { type: "approval_resolved"; id: string };
};
export interface ExternalReplay { events: ExternalEvent[]; latestSequence: number; truncated: boolean }
export interface DesktopExternalAgentsAPI {
	executors(): Promise<ExternalExecutor[]>;
	configure(input: ExternalExecutorInput): Promise<ExternalExecutor[]>;
	start(input: ExternalTaskStartInput): Promise<ExternalTask>;
	list(conversationId?: string): Promise<ExternalTask[]>;
	snapshot(taskId: string): Promise<ExternalTask>;
	send(input: ExternalTaskSendInput): Promise<ExternalTask>;
	result(taskId: string, options?: { block?: boolean; timeout?: number }): Promise<ExternalTaskResult>;
	cancel(taskId: string): Promise<ExternalTask>;
	respond(taskId: string, requestId: string, response: ExternalApprovalResponse): Promise<void>;
	replay(taskId: string, afterSequence?: number): Promise<ExternalReplay>;
	onEvent(listener: (event: ExternalEvent) => void): () => void;
}
