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
import type { DesktopAgentsAPI, ModelRouting } from "./agent-types.ts";
import type { DesktopMcpAPI } from "./mcp-types.ts";
import type { DesktopHooksAPI } from "./hook-types.ts";
import type { ContextBreakdown, ContextMemorySource } from "./context-inspector.ts";
import type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
import type { DraftPullRequest } from "./review-service.ts";
import type { CodeIntelligence, CodePosition } from "./language-service.ts";
import type { PreviewCheck } from "./preview-check.ts";
import type { TodoCreateInput, TodoEvent, TodoRecord, TodoUpdateInput } from "./todo-types.ts";
import type { MonitorEvent, MonitorRecord } from "./monitor-types.ts";
import type { CronCreateInput, CronEvent, CronJobRecord } from "./cron-types.ts";
import type { TeamEvent, TeamRecord } from "./team-types.ts";
import type { WorkflowApprovalDecision, WorkflowEvent, WorkflowRecord, WorkflowRunInput } from "./workflow-types.ts";
export type { CodeIntelligence, CodePosition } from "./language-service.ts";
export type { PreviewCheck } from "./preview-check.ts";
export type * from "./todo-types.ts";
export type * from "./monitor-types.ts";
export type * from "./cron-types.ts";
export type * from "./team-types.ts";
export type * from "./workflow-types.ts";
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

/** "auto" is shown as 全部放行; "dontAsk" denies anything a rule or safe default would otherwise prompt for. */
export type PermissionMode = "ask" | "acceptEdits" | "auto" | "read" | "plan" | "dontAsk";
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
	/** Shell command that prints the API key (like Claude Code's apiKeyHelper); "" clears it. */
	keyCommand?: string;
	/** Extra request headers; stored encrypted. An empty object clears them. */
	headers?: Record<string, string>;
	baseUrl?: string;
	modelId?: string;
	api?: ConnectionProtocol;
}
export interface ProviderBalanceResult {
	/** False when this connection's provider has no balance API. */
	supported: boolean;
	success?: boolean;
	message?: string;
	available?: boolean;
	balances?: { currency: string; amount: number }[];
	usage?: number;
	note?: string;
	checkedAt?: number;
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
	theme: "light" | "dark" | "grail" | "system";
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
	/** Enable scheduled wakeups / Cron / /loop (consumes quota when idle); absent means true. */
	cronEnabled?: boolean;
	/** Experimental multi-agent Teams collaboration (TeamCreate / TeamDelete); absent means false. */
	agentTeams?: boolean;
	/**
	 * Default model for built-in Explore / Plan / Review children when the call and the
	 * definition name none. A missing role, or a model the parent cannot reach, inherits.
	 */
	modelRouting?: ModelRouting;
	/** HTTP(S) proxy URL for model and web requests; overrides the shell's HTTPS_PROXY. */
	proxy?: string;
	/** Comma-separated hosts that bypass the proxy (NO_PROXY). */
	noProxy?: string;
	/** Absolute path to an extra PEM certificate bundle (NODE_EXTRA_CA_CERTS). */
	caFile?: string;
	configuredProviders: Provider[];
	connections: Partial<
		Record<
			Provider,
			{
				baseUrl?: string;
				modelId?: string;
				api?: ConnectionProtocol;
				mode?: ConnectionMode;
				keyCommand?: string;
				/** Names of the saved custom headers; values stay encrypted in the backend. */
				headerNames?: string[];
			}
		>
	>;
	/** Stop a conversation once its recorded spend reaches this many US dollars; absent means no limit. */
	maxCostUsd?: number;
	/**
	 * Stop a conversation when the provider's account balance falls to this amount
	 * (in the balance's own currency). Only providers with a balance API are checked.
	 */
	minBalance?: number;
	/** Skip every Claude-compatible and Pi hook (like Claude Code's disableAllHooks). */
	disableAllHooks?: boolean;
	/**
	 * Model the conversation switches to once when the primary model stays overloaded,
	 * rate limited or failing after Pi's retries; absent means no fallback.
	 */
	fallbackModel?: { provider: string; id: string };
	/** Output style name for the main conversation (Claude Code compatible); absent means "default". */
	outputStyle?: string;
	/** Editor used by "在编辑器中打开"; absent means "vscode". */
	editor?: EditorChoice;
	/** Show the provider account balance in the composer status line; absent means true. */
	statusBalance?: boolean;
}
export type EditorChoice = "vscode" | "cursor" | "system";
export interface OutputStyleInfo {
	name: string;
	description: string;
	source: "builtin" | "user" | "project";
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
/** Token and cost totals of one day, one model or the whole range (/stats). */
export interface UsageBucket {
	/** Local day "YYYY-MM-DD", "provider/model", or "total". */
	key: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input + output + cacheRead + cacheWrite. */
	tokens: number;
	/** US dollars as reported by Pi (usage.cost.total); 0 when the provider reports no price. */
	cost: number;
	/** Assistant messages counted. */
	messages: number;
}
export interface UsageStatsReport {
	generatedAt: number;
	rangeDays: number;
	/** First local day included, "YYYY-MM-DD". */
	since: string;
	/** Session files read (including cached ones). */
	files: number;
	/** Session files that could not be read. */
	skipped: number;
	totals: Omit<UsageBucket, "key">;
	/** Newest day first; days without usage are omitted. */
	days: UsageBucket[];
	/** Highest cost first. */
	models: UsageBucket[];
}
export type DoctorStatus = "ok" | "warn" | "error";
export interface DoctorCheck {
	id: string;
	label: string;
	status: DoctorStatus;
	detail: string;
}
export interface DoctorReport {
	generatedAt: number;
	checks: DoctorCheck[];
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
export interface DesktopTodosAPI {
	list(conversationId?: string): Promise<TodoRecord[]>;
	create(conversationId: string, input: TodoCreateInput): Promise<TodoRecord>;
	update(conversationId: string, input: TodoUpdateInput): Promise<TodoRecord>;
	onEvent(listener: (event: TodoEvent) => void): () => void;
}
export interface DesktopMonitorsAPI {
	list(conversationId?: string): Promise<MonitorRecord[]>;
	stop(id: string): Promise<MonitorRecord>;
	onEvent(listener: (event: MonitorEvent) => void): () => void;
}
export interface DesktopCronAPI {
	list(conversationId?: string): Promise<CronJobRecord[]>;
	create(conversationId: string, input: CronCreateInput): Promise<CronJobRecord>;
	loop(conversationId: string, args: string): Promise<CronJobRecord>;
	delete(id: string, conversationId?: string): Promise<boolean>;
	onEvent(listener: (event: CronEvent) => void): () => void;
}
export interface DesktopTeamsAPI {
	get(conversationId?: string): Promise<TeamRecord | null>;
	delete(conversationId: string, teamName?: string): Promise<{ deleted: boolean; name?: string }>;
	onEvent(listener: (event: TeamEvent) => void): () => void;
}
export interface DesktopWorkflowAPI {
	list(conversationId?: string): Promise<WorkflowRecord[]>;
	start(conversationId: string, input: WorkflowRunInput): Promise<WorkflowRecord>;
	resume(id: string): Promise<WorkflowRecord>;
	stop(id: string): Promise<WorkflowRecord>;
	respond(workflowId: string, requestId: string, decision: WorkflowApprovalDecision): Promise<WorkflowRecord>;
	onEvent(listener: (event: WorkflowEvent) => void): () => void;
}
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
	todos: DesktopTodosAPI;
	monitors: DesktopMonitorsAPI;
	cron: DesktopCronAPI;
	teams: DesktopTeamsAPI;
	workflow: DesktopWorkflowAPI;
	snapshot(): Promise<Snapshot>;
	openProject(): Promise<Snapshot | null>;
	selectProject(path: string): Promise<Snapshot>;
	setProjectTrust(input: { project: string; decision: ProjectTrustDecision }): Promise<Snapshot>;
	newConversation(): Promise<Snapshot>;
	selectConversation(id: string): Promise<Snapshot>;
	renameConversation(id: string, title: string): Promise<Snapshot>;
	/** Removes the conversation from the list; its Pi session file stays on disk. */
	removeConversation(id: string): Promise<Snapshot>;
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
	/** True when something answers on the local preview address. */
	probePreview(url: string): Promise<boolean>;
	inspectCode(conversationId: string, path: string, at?: CodePosition): Promise<CodeIntelligence>;
	sandboxStatus(): Promise<SandboxStatus>;
	/** Local environment diagnosis (/doctor); no network or model requests. */
	doctor(): Promise<DoctorReport>;
	/** Token usage and cost by local day and model across all desktop sessions (/stats); local files only. */
	usageStats(input?: { days?: number }): Promise<UsageStatsReport>;
	/** Opens the local log directory in the system file manager, creating it if missing. */
	openLogDirectory(): Promise<void>;
	/** Built-in plus discovered custom output styles for the active project. */
	outputStyles(): Promise<OutputStyleInfo[]>;
	/** Opens an absolute path inside a known project or worktree in the configured editor. */
	openInEditor(input: { path: string; line?: number }): Promise<void>;
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
		cronEnabled?: boolean;
		agentTeams?: boolean;
		modelRouting?: ModelRouting;
		proxy?: string;
		noProxy?: string;
		caFile?: string;
		maxCostUsd?: number | null;
		minBalance?: number | null;
		disableAllHooks?: boolean;
		/** null clears the fallback model. */
		fallbackModel?: { provider: string; id: string } | null;
		/** null or "default" clears the style. */
		outputStyle?: string | null;
		editor?: EditorChoice;
		statusBalance?: boolean;
		provider?: Provider;
		mode?: ConnectionMode;
		apiKey?: string;
		keyCommand?: string;
		headers?: Record<string, string>;
		baseUrl?: string;
		modelId?: string;
		api?: ConnectionProtocol;
	}): Promise<Snapshot>;
	testConnection(input: ConnectionInput): Promise<ConnectionTestResult>;
	providerBalance(input: ConnectionInput): Promise<ProviderBalanceResult>;
	exportConversation(): Promise<string | null>;
	onEvent(listener: (event: DesktopEvent) => void): () => void;
}
export type { RpcSessionState, SessionStats, RpcExtensionUIRequest, RpcExtensionUIResponse };
declare global {
	interface Window {
		pi: DesktopAPI;
	}
}
