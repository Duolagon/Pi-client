import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcResponse,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcSessionState,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
import type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
import type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";
import type { ChildApprovalRequest, DesktopTask, TaskEvent, TaskPendingApproval, TaskProgress, TaskProgressActivity, TaskSendInput, TaskSendResult, TaskStartInput } from "./task-types.ts";
import type { DesktopSessionAPI } from "./session-types.ts";
import type { LiveTranscript } from "./transcript.ts";
import type { DesktopToolsAPI, DesktopPermissionsAPI } from "./control-types.ts";
import type { DelegatedTaskResult } from "./delegation-types.ts";
import type { DesktopExternalAgentsAPI } from "./external-types.ts";
import type { DesktopAgentsAPI } from "./agent-types.ts";
import type { DesktopMcpAPI } from "./mcp-types.ts";
import type { DesktopHooksAPI } from "./hook-types.ts";
import type { ContextBreakdown, ContextMemorySource } from "./context-inspector.ts";
import type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
import type { DraftPullRequest } from "./review-service.ts";
import type { CodeIntelligence, CodePosition } from "./language-service.ts";
import type { PreviewCheck } from "./preview-check.ts";
export type { CodeIntelligence, CodePosition } from "./language-service.ts";
export type { PreviewCheck } from "./preview-check.ts";
export type * from "./external-types.ts";
export type * from "./agent-types.ts";
export type * from "./mcp-types.ts";
export type * from "./hook-types.ts";
export type * from "./control-types.ts";
export type * from "./permission-types.ts";
export type * from "./tool-control-types.ts";
export type { ContextBreakdown, ContextMemorySource } from "./context-inspector.ts";
export type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput, SkillScope } from "./skill-registry.ts";

export type * from "./session-types.ts";
export type * from "./session-history-types.ts";

export type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
export type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
export type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";
export type { ChildApprovalRequest, DesktopTask, TaskEvent, TaskPendingApproval, TaskProgress, TaskProgressActivity, TaskSendInput, TaskSendResult, TaskStartInput, TaskStatus } from "./task-types.ts";

export interface CheckpointInput {
	conversationId?: string;
	label?: string;
}
export interface CheckpointTarget {
	checkpointId: string;
	conversationId?: string;
}
export interface DesktopGitAPI {
	begin(input?: CheckpointInput): Promise<GitCheckpoint>;
	finish(input: CheckpointTarget): Promise<GitCheckpoint>;
	list(conversationId?: string): Promise<GitCheckpoint[]>;
	diff(input: CheckpointTarget & { path?: string }): Promise<GitCheckpointDiff>;
	restore(input: CheckpointTarget & { paths?: string[] }): Promise<GitRestoreResult>;
}
export type PiPackageAction = "list" | "install" | "update" | "remove";
export interface DesktopTerminalAPI {
	packages(conversationId: string, action: PiPackageAction, source?: string): Promise<TerminalInfo>;
	ssh(conversationId: string, host: string, startPi: boolean): Promise<TerminalInfo>;
	mcpOAuth(conversationId: string, name: string): Promise<TerminalInfo>;
	create(
		input?: Omit<TerminalCreateInput, "project" | "conversationId"> & { conversationId?: string },
	): Promise<TerminalInfo>;
	list(conversationId?: string): Promise<TerminalInfo[]>;
	write(id: string, data: string): Promise<void>;
	resize(id: string, cols: number, rows: number): Promise<void>;
	close(id: string): Promise<void>;
	replay(id: string, afterSequence?: number): Promise<TerminalReplay>;
	onEvent(listener: (event: TerminalEvent) => void): () => void;
}
export interface DesktopTaskAPI {
	start(input: TaskStartInput): Promise<DesktopTask>;
	list(): Promise<DesktopTask[]>;
	snapshot(id: string): Promise<Snapshot>;
	cancel(id: string): Promise<DesktopTask>;
	/** Move an active foreground sub-agent to the background (Ctrl+B); result arrives via outbox. */
	background(id: string): Promise<DesktopTask>;
	/** Stop every background sub-agent (Pi and external) that this conversation delegated. */
	stopAll(conversationId: string): Promise<{ stopped: number }>;
	/** Deliver held background results to this conversation now and start a run for them. */
	deliverNow(conversationId: string): Promise<{ pending: number }>;
	/**
	 * Continue a task with a message ("继续对话"): a finished one starts its next run with its
	 * history, a running one receives it before its next model call. `notifyParent` delivers
	 * the finished run's result to the delegating conversation (default: not delivered).
	 */
	send(input: TaskSendInput): Promise<TaskSendResult>;
	/** Report that a task conversation is shown (or no longer shown); a shown child keeps its process. */
	viewing(conversationId: string, viewing: boolean): Promise<void>;
	result(id: string, options?: { block?: boolean; timeout?: number }): Promise<DelegatedTaskResult>;
	command(id: string, command: Command): Promise<unknown>;
	respond(id: string, response: RpcExtensionUIResponse): Promise<void>;
	files(id: string, path: string): Promise<FileEntry[]>;
	readFile(id: string, path: string): Promise<{ path: string; content: string }>;
	workspace(id: string): Promise<Workspace>;
	diff(id: string, path: string): Promise<string>;
	onEvent(listener: (event: TaskEvent) => void): () => void;
}
export interface DesktopWorktreeAPI {
	create(input: WorktreeCreateInput): Promise<WorktreeInfo>;
	list(project?: string): Promise<WorktreeInfo[]>;
	remove(id: string): Promise<WorktreeRemoveResult>;
	merge(id: string): Promise<WorktreeMergeResult>;
}

export type PermissionMode = "ask" | "acceptEdits" | "auto" | "read" | "plan";
export type ProjectTrustDecision = "trusted" | "untrusted";
export interface ProjectTrustState {
	project: string;
	/** Resources that Pi would load only after a trust decision. */
	resources: string[];
	required: boolean;
	decision?: ProjectTrustDecision;
}
export type Message = Extract<RpcResponse, { command: "get_messages"; success: true }>["data"]["messages"][number];
export type BashResult = Extract<RpcResponse, { command: "bash"; success: true }>["data"];
export type ThinkingLevel = RpcSessionState["thinkingLevel"];
export type SlashCommand = Extract<RpcResponse, { command: "get_commands"; success: true }>["data"]["commands"][number];
export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "deepseek";
export type ConnectionMode = "preset" | "custom";
export type ConnectionProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "openai-completions"
	| "google-generative-ai";
export interface ConnectionInput {
	provider: Provider;
	mode?: ConnectionMode;
	apiKey?: string;
	baseUrl?: string;
	modelId?: string;
	api?: ConnectionProtocol;
}
export interface ConnectionTestResult {
	success: boolean;
	message: string;
	model?: string;
	latencyMs?: number;
}
export interface ProviderModelPreset {
	id: string;
	name: string;
	api: ConnectionProtocol;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
}
export interface ProviderPreset {
	provider: Provider;
	name: string;
	baseUrl: string;
	api: ConnectionProtocol;
	defaultModelId: string;
	models: ProviderModelPreset[];
}
export interface Model {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
}
export interface Conversation {
	id: string;
	title: string;
	project: string;
	sessionFile?: string;
	parentConversationId?: string;
	forkEntryId?: string;
	origin?: "fork" | "clone" | "cli";
	sourceSessionId?: string;
	/** Selected native tree cursor, including an explicitly empty root. */
	sessionLeafId?: string | null;
	/** Host-derived marker for delegated child sessions; folded under their parent in the sidebar. */
	kind?: "subagent";
	updatedAt: number;
}
export interface Project {
	path: string;
	name: string;
}
export interface Settings {
	agentDir?: string;
	defaultModel?: { provider: string; id: string };
	permission: PermissionMode;
	theme: "light" | "dark" | "system";
	sandbox?: boolean;
	sandboxOffline?: boolean;
	notifications?: boolean;
	/** Agent calls without run_in_background run in the background; absent means true. */
	subagentDefaultBackground?: boolean;
	/**
	 * How long a foreground Agent call waits before the child is handed to background
	 * delivery, in milliseconds; 0 waits without limit (default).
	 */
	foregroundSubagentTimeoutMs?: number;
	/** Allow `Agent(subagent_type: "fork")` / `fork: true`; absent means true. */
	forkSubagent?: boolean;
	/** Isolate writable worktree subagent Bash inside the worktree via Seatbelt on macOS; absent means true. */
	confineSubagentBash?: boolean;
	/** Maximum subagent nesting depth (1–3); absent means 1. */
	maxSubagentDepth?: number;
	/** Maximum concurrent active subagents per parent conversation (1–20); absent means 8. */
	maxConcurrentSubagents?: number;
	configuredProviders: Provider[];
	connections: Partial<
		Record<Provider, { baseUrl?: string; modelId?: string; api?: ConnectionProtocol; mode?: ConnectionMode }>
	>;
}
export interface PlanFileState {
	path: string;
	relativePath: string;
	content: string;
	exists: boolean;
}
export interface SandboxStatus {
	enabled: boolean;
	supported: boolean;
	reason?: string;
}
export interface BtwResult {
	question: string;
	answer: string;
	model?: string;
	latencyMs: number;
}
export interface ClaudePermissionsSyncResult {
	path: string;
	imported?: number;
	exported?: number;
	/** Claude specs that have no safe Desktop equivalent and were not imported. */
	skipped?: string[];
}
export interface DesktopSkillsAPI {
	list(project?: string): Promise<SkillDefinitionEntry[]>;
	save(input: SkillSaveInput): Promise<SkillDefinitionEntry[]>;
	remove(input: SkillRemoveInput): Promise<SkillDefinitionEntry[]>;
}
export interface FileEntry {
	name: string;
	path: string;
	directory: boolean;
}
export interface Change {
	path: string;
	status: string;
	staged?: boolean;
	unstaged?: boolean;
}
export interface Workspace {
	branch: string;
	changes: Change[];
	isGit: boolean;
}
export interface GitCommitResult {
	hash: string;
	summary: string;
	workspace: Workspace;
}
export interface MemoryFileEntry {
	file: "AGENTS.md" | "CLAUDE.md";
	path: string;
	content: string;
	exists: boolean;
}
export type SessionActivity = "running" | "approval";

export interface PullRequestStatus {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	reviewDecision?: string;
	checks: {name: string; status: string}[];
}

export interface Snapshot {
	activity?: Record<string, SessionActivity>;
	activitySequence?: number;
	bashBusy?: boolean;
	/** Sequence of the last host event included in this snapshot. */
	eventSequence?: number;
	/** Current output omitted from Pi's finalized get_messages transcript. */
	liveTranscript?: LiveTranscript;
	archived?: boolean;
	projects: Project[];
	conversations: Conversation[];
	active?: Conversation;
	state?: RpcSessionState;
	models: Model[];
	providerPresets: ProviderPreset[];
	settings: Settings;
	messages: Message[];
	stats?: SessionStats;
	engineStatus: "ready" | "starting" | "error";
	engineError?: string;
	pendingUI: RpcExtensionUIRequest[];
	thinkingLevels: ThinkingLevel[];
	commands: SlashCommand[];
	/** Trust state for the active project; absent when no project is active. */
	trust?: ProjectTrustState;
	/** Background sub-agent results this conversation holds without delivery ("待交付"). */
	pendingTaskNotifications?: number;
	/** Open interactive approvals of all descendant tasks of the active conversation. */
	childApprovals?: ChildApprovalRequest[];
}
export type DesktopEvent = {
	conversationId: string;
	/** Monotonic within this desktop host; used to replay events crossing a snapshot. */
	sequence?: number;
	event:
		| JsonAgentSessionEvent
		| RpcExtensionUIRequest
		| { type: "desktop_error"; message: string }
		| { type: "extension_error"; extensionPath: string; event: string; error: string };
};
export type Command = RpcCommand;
export interface DesktopAPI {
	externalAgents: DesktopExternalAgentsAPI;
	agents: DesktopAgentsAPI;
	mcp: DesktopMcpAPI;
	hooks: DesktopHooksAPI;
	skills: DesktopSkillsAPI;
	tools: DesktopToolsAPI;
	permissions: DesktopPermissionsAPI;
	sessions: DesktopSessionAPI;
	git: DesktopGitAPI;
	terminals: DesktopTerminalAPI;
	tasks: DesktopTaskAPI;
	worktrees: DesktopWorktreeAPI;
	snapshot(): Promise<Snapshot>;
	openProject(): Promise<Snapshot | null>;
	selectProject(path: string): Promise<Snapshot>;
	setProjectTrust(input: { project: string; decision: ProjectTrustDecision }): Promise<Snapshot>;
	newConversation(): Promise<Snapshot>;
	selectConversation(id: string): Promise<Snapshot>;
	renameConversation(id: string, title: string): Promise<Snapshot>;
	command(command: Command, conversationId?: string): Promise<unknown>;
	respond(response: RpcExtensionUIResponse, conversationId?: string): Promise<void>;
	files(path: string): Promise<FileEntry[]>;
	readFile(path: string): Promise<{ path: string; content: string }>;
	workspace(): Promise<Workspace>;
	createDraftPullRequest(conversationId: string, draft: DraftPullRequest): Promise<{ url: string; number: number }>;
	pullRequest(conversationId: string, number?: number): Promise<PullRequestStatus | null>;
	diff(path: string): Promise<string>;
	gitStage(paths?: string[]): Promise<Workspace>;
	gitUnstage(paths?: string[]): Promise<Workspace>;
	gitDiscard(paths: string[]): Promise<Workspace>;
	gitCommit(message: string): Promise<GitCommitResult>;
	readMemory(): Promise<MemoryFileEntry[]>;
	writeMemory(file: "AGENTS.md" | "CLAUDE.md", content: string): Promise<MemoryFileEntry>;
	contextReport(): Promise<ContextBreakdown>;
	writeMemoryFile(relativePath: string, content: string): Promise<ContextMemorySource>;
	deleteMemoryRule(relativePath: string): Promise<ContextBreakdown>;
	readPlan(conversationId?: string): Promise<PlanFileState>;
	writePlan(content: string, conversationId?: string): Promise<PlanFileState>;
	btw(question: string): Promise<BtwResult>;
	checkPreview(url: string, mobile: boolean): Promise<PreviewCheck>;
	inspectCode(conversationId: string, path: string, at?: CodePosition): Promise<CodeIntelligence>;
	sandboxStatus(): Promise<SandboxStatus>;
	importClaudePermissions(): Promise<ClaudePermissionsSyncResult>;
	exportClaudePermissions(): Promise<ClaudePermissionsSyncResult>;
	saveSettings(settings: {
		agentDir?: string;
		permission: PermissionMode;
		theme: Settings["theme"];
		sandbox?: boolean;
		sandboxOffline?: boolean;
		notifications?: boolean;
		subagentDefaultBackground?: boolean;
		foregroundSubagentTimeoutMs?: number;
		forkSubagent?: boolean;
		confineSubagentBash?: boolean;
		maxSubagentDepth?: number;
		maxConcurrentSubagents?: number;
		provider?: Provider;
		mode?: ConnectionMode;
		apiKey?: string;
		baseUrl?: string;
		modelId?: string;
		api?: ConnectionProtocol;
	}): Promise<Snapshot>;
	testConnection(input: ConnectionInput): Promise<ConnectionTestResult>;
	exportConversation(): Promise<string | null>;
	onEvent(listener: (event: DesktopEvent) => void): () => void;
}
export type { RpcSessionState, SessionStats, RpcExtensionUIRequest, RpcExtensionUIResponse };
declare global {
	interface Window {
		pi: DesktopAPI;
	}
}
