import type { RuntimePermissionPolicy } from "./permission-types.ts";
import type { TaskStatus } from "./task-types.ts";
import type { AgentOutputSchema } from "./agent-output-schema.ts";
import type { GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";

export type BuiltinExternalProvider = "codex" | "claude" | "kimi" | "antigravity";
/** Catalog IDs additionally require membership in the bundled ACP registry at runtime. */
export type ExternalProvider = BuiltinExternalProvider | `acp-${string}`;
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
	/** Host-only grant for the exact operation within this external task's session. */
	rememberForSession?: boolean;
}
export interface ExternalUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}
export interface ExternalPlanStep {
	text: string;
	status: "pending" | "in_progress" | "completed";
}
export type ExternalAdapterEvent =
	| { type: "session"; sessionId: string }
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; id: string; name: string; input: unknown }
	| { type: "tool_update"; id: string; text: string }
	| { type: "tool_end"; id: string; isError: boolean; output?: string }
	| { type: "plan"; steps: ExternalPlanStep[]; explanation?: string }
	| { type: "diagnostic"; message: string }
	| ({ type: "usage"; sessionCostUsd?: number; sessionTokens?: Omit<ExternalUsage, "costUsd"> } & ExternalUsage);
export interface ExternalTurnResult {
	status: "completed" | "cancelled";
	text: string;
	sessionId?: string;
	/** Native SDK structured result. The host validates the payload independently. */
	structuredOutput?: unknown;
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
	outputSchema?: AgentOutputSchema;
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
	readonly supportsResume?: boolean;
	run(prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult>;
	/** Returns false when the active native turn has definitively declined the input. */
	steer?(message: string): Promise<boolean>;
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
	label?: string;
	enabled: boolean;
	available: boolean;
	executable?: string;
	version?: string;
	error?: string;
	installCommand?: string;
	compatibility?: "compatible" | "incompatible" | "unverified";
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
	supportsResume?: boolean;
	output: string;
	truncated: boolean;
	error?: string;
	pendingApprovals: ExternalApprovalRequest[];
	/** True when the parent does not wait and the result arrives as a notification. */
	runInBackground?: boolean;
	model?: string;
	effort?: string;
	accessFailure?: "auth" | "subscription" | "quota";
	pendingMessages?: number;
	sendDisposition?: "steered" | "queued";
	usage?: ExternalUsage;
	reviewOf?: string;
	comparisonId?: string;
	/** Files the last turn changed, from the host checkpoint (tracked and untracked files). */
	changes?: ExternalChangeSummary;
	/** Validated structured result of the last completed turn. */
	structuredOutput?: unknown;
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
	/** A bounded patch for a small change. Larger changes use the checkpoint reference. */
	patch?: string;
	/** Stable hash of a complete nonempty patch, used to coalesce identical candidates. */
	fingerprint?: string;
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
	model?: string;
	effort?: string;
	output_schema?: AgentOutputSchema;
}
export interface ExternalTaskSendInput { taskId: string; message: string; runInBackground?: boolean }
export interface ExternalCandidate { executor: ExternalProvider; model?: string; effort?: string }
export interface ExternalComparison { comparisonId: string; tasks: ExternalTask[]; errors?: string[] }
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
	pending_messages?: number;
	usage?: ExternalUsage;
	/** Changed files and line counts of the last turn; absent for read-only tasks. */
	changes?: ExternalChangeSummary;
	structured_output?: unknown;
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
	executors(options?: { verifyCompatibility?: boolean }): Promise<ExternalExecutor[]>;
	configure(input: ExternalExecutorInput): Promise<ExternalExecutor[]>;
	start(input: ExternalTaskStartInput): Promise<ExternalTask>;
	list(conversationId?: string): Promise<ExternalTask[]>;
	snapshot(taskId: string): Promise<ExternalTask>;
	send(input: ExternalTaskSendInput): Promise<ExternalTask>;
	result(taskId: string, options?: { block?: boolean; timeout?: number }): Promise<ExternalTaskResult>;
	cancel(taskId: string): Promise<ExternalTask>;
	respond(taskId: string, requestId: string, response: ExternalApprovalResponse): Promise<void>;
	replay(taskId: string, afterSequence?: number): Promise<ExternalReplay>;
	diff(taskId: string, checkpointId: string, path?: string, includeText?: boolean): Promise<GitCheckpointDiff>;
	changeFiles(input: { taskId: string; checkpointId: string; action: "apply" | "discard"; paths?: string[] }): Promise<GitRestoreResult>;
	review(input: { taskId: string; executor?: ExternalProvider }): Promise<ExternalTask>;
	compare(input: { taskId: string; candidates: ExternalCandidate[] }): Promise<ExternalComparison>;
	onEvent(listener: (event: ExternalEvent) => void): () => void;
}
