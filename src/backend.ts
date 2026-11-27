import { draftPrompt, mergeDrafts, type ComposerDraft, type Prompt } from "./composer-draft.ts";
import { QueuedPrompts, type NativeQueue } from "./queued-prompts.ts";
import type { DesktopPromptResult, FileReferenceAvailability, QueueActionResult, QueuedPromptGroups, SessionContentSearchResult } from "./shared.ts";
import { searchWorkspaceFiles } from "./workspace-file-search.ts";
import { isDesktopWorkspaceContext, isReferenceablePath, visiblePromptText } from "./file-references.ts";
import { createDraftPullRequest, readPullRequest, readPullRequestComments, setPullRequestAutoMerge, type DraftPullRequest } from "./review-service.ts";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, writeFile, rename, realpath, stat, readdir, readlink, rm, symlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { summarizeEngineError, tildify } from "./desktop-log.ts";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentProcess } from "./rpc.ts";
import type { PiTracing } from "./langfuse-tracing.ts";
import { GitSnapshots, MAX_CHECKPOINT_FILE_BYTES } from "./git-snapshots.ts";
import {
	annotateDiff,
	buildBlindPrompt,
	buildComparisonPrompt,
	gradeVerdict,
	parseBlindSolution,
	parseComparison,
	parseDiffLines,
	parseGrailModelUpdate,
	runObjectiveChecks,
	scanDistortions,
	scriptEnvironment,
	skipObjectiveChecks,
	validGrailMaxCost,
	validGrailTimeout,
} from "./grail-judge.ts";
import { TerminalService } from "./terminal-service.ts";
import { WorktreeService } from "./worktree-service.ts";
import { SessionHistoryService } from "./session-history.ts";
import { maximumSearchSessions, type SessionHistorySearchCandidate } from "./session-history-types.ts";
import { applyLiveEvent, type LiveTranscript } from "./transcript.ts";
import type {
	SessionCopyInput,
	SessionCopyResult,
	SessionForkInput,
	SessionEntriesInput,
	SessionEntriesResult,
	SessionTreeResult,
	SessionNavigateInput,
	SessionNavigateResult,
	SessionHistoryInput,
	SessionHistoryImportInput,
	SessionHistoryImportResult,
} from "./session-types.ts";
import {
	tagComposerPrompt,
	type SessionNavigationBridgeRequest,
	type SessionNavigationBridgeResponse,
} from "./session-navigation-extension.ts";
import type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
import type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
import type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveOptions, WorktreeRemoveResult } from "./worktree-types.ts";
import type { ChildApprovalRequest, DesktopTask, TaskEvent, TaskPendingApproval, TaskProgress, TaskProgressActivity, TaskSendInput, TaskSendResult, TaskStartInput, TaskStopReason } from "./task-types.ts";
import { sanitizeStoredTasks } from "./task-validation.ts";
import {
	CHILD_RUNTIME_IDLE_MS,
	CHILD_RUNTIME_REAP_INTERVAL_MS,
	DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS,
	DEFAULT_MAX_BORROWED_SLOTS,
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_MAX_SUBAGENT_DEPTH,
	MAX_AGENT_OUTPUT,
	MAX_AGENT_SKILLS,
	MAX_CONCURRENT_SUBAGENTS_LIMIT,
	MAX_DELEGATION_DEPTH,
	MAX_HOOK_ADDITIONAL_CONTEXT,
	MAX_IDLE_CHILD_RUNTIMES,
	MAX_RECENT_TASK_ACTIVITIES,
	MAX_TASK_READ_PATHS,
	MAX_SEND_MESSAGE,
	MAX_TURN_CALLS,
	PARENT_MESSAGE_PREFIX,
	MAX_AGENT_SYSTEM_PROMPT,
	isTaskReadPath,
	MAX_AGENT_TURNS,
	MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS,
	TASK_PROGRESS_PERSIST_MS,
	TASK_PROGRESS_THROTTLE_MS,
	exceedsLength,
	MAX_MODEL_ID,
	MAX_MODEL_PROVIDER,
	MAX_TASK_ERROR,
	MAX_TASK_MESSAGE,
	MAX_TOOL_LIST,
	TOOL_NAME_PATTERN,
	truncateText,
} from "./delegation-limits.ts";
import type {
	BashResult,
	Command,
	Conversation,
	DesktopEvent,
	FileEntry,
	GitCommitDraft,
	GitCommitResult,
	MemoryFileEntry,
	Message,
	Model,
	PermissionMode,
	Project,
	ProjectTrustDecision,
	ProjectTrustState,
	Provider,
	RpcExtensionUIRequest,
	RpcSessionState,
	Settings,
	Snapshot,
	ThinkingLevel,
	Workspace,
	GitDiscardInput,
	GitDiscardResult,
	ConnectionInput,
	ConnectionProtocol,
	ConnectionTestResult,
	ProviderBalanceResult,
	ConnectionMode,
	GrailEvent,
	GrailObjectiveResult,
	GrailState,
	GrailStep,
	GrailStepResults,
	GrailVerdict,
} from "./shared.ts";
import { connectionMode, validateEndpoint } from "./model-connections.ts";
import { providerModels, providerPresets } from "./provider-presets.ts";
import { memoryLimit, memoryName, privateMemoryLabel, readProjectText } from "./project-memory.ts";
import { LanguageService, buildWorkspaceOutline, formatCodeIntelligence, formatLspDiagnostics, isLspSupportedFile, type CodeIntelligenceOperation, type CodePosition } from "./language-service.ts";
import { buildGoalInitialPrompt, DEFAULT_GOAL_MAX_TURNS, evaluateGoalContinuation, MAX_GOAL_TURNS, type GoalState } from "./goal-mode.ts";
import { planRelativePath } from "./plan-path.ts";
import { buildLaunchShellCommand, launchConfigUrl, readLaunchConfigurations, validateLocalPreviewUrl } from "./launch-config.ts";
import { DEFAULT_LOCAL_PREVIEW_URL, formatPreviewInspectSummary, type PreviewInspectInput, type PreviewInspectResult, type PreviewInteraction } from "./preview-check-types.ts";
import { detectProjectTrustResources } from "./project-trust.ts";
import { DEFAULT_OUTPUT_STYLE, discoverOutputStyles, findOutputStyle, outputStylePromptSection, validOutputStyleName } from "./output-styles.ts";
import { EDITOR_CHOICES, type EditorChoice } from "./editor-open.ts";
import { UsageStatsCollector } from "./usage-stats.ts";
import { ToolSettingsStore } from "./tool-settings.ts";
import { evaluatePermission, validatePermissionRule } from "./permission-policy.ts";
import type { PermissionRule, RuntimePermissionPolicy } from "./permission-types.ts";
import type { ToolToggleInput, ControlEvent, PermissionSettings, PermissionCheckInput } from "./control-types.ts";
import { delegatingToolNames, type DesktopToolInfo } from "./tool-control-types.ts";
import { ToolHostServer } from "./tool-host-server.ts";
import { ModelDelegation, runToolUsage } from "./model-delegation.ts";
import { finalAssistantText, type DelegationMetadata, type ResumeOptions } from "./delegation-types.ts";
import { AgentRegistry } from "./agent-definitions.ts";
import { buildAgentListing } from "./agent-listing.ts";
import type { AgentDefinition, AgentModelAlias, AgentPermissionMode, AgentRemoveInput, AgentSaveInput, ModelRouting, ModelRoutingRole } from "./agent-types.ts";
import { FALLBACK_MESSAGE_TYPE, parseFallbackModelUpdate, parseModelRoutingUpdate, sanitizeFallbackModel, sanitizeModelRouting, temporaryModelNotice } from "./model-routing.ts";
import { McpRegistry } from "./mcp-registry.ts";
import type { McpRemoveInput, McpSaveInput, McpServerInfo } from "./mcp-types.ts";
import { HooksService, type HookRunContext } from "./hooks-service.ts";
import type { HookEntry, HookRemoveInput, HookRunResult, HookSaveInput, HookTestInput } from "./hook-types.ts";
import { BUNDLED_SKILLS, SkillRegistry, bundledSkillFile, formatForkedSkillPrompt, parseSkillInvocation } from "./skill-registry.ts";
import { balanceTarget, fetchBalance, type BalanceTarget } from "./provider-balance.ts";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { rootCertificates } from "node:tls";
import type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
import { TodoService } from "./todo-service.ts";
import type { TodoCreateInput, TodoEvent, TodoGetInput, TodoListInput, TodoRecord, TodoUpdateInput } from "./todo-types.ts";
import { MonitorService, shellStatus } from "./monitor-service.ts";
import type { MonitorEvent, MonitorRecord, MonitorStartInput } from "./monitor-types.ts";
import { CronService, parseLoopCommandArgs } from "./cron-service.ts";
import { cronToolNames, type CronCreateInput, type CronEvent, type CronJobRecord, type ScheduleWakeupInput } from "./cron-types.ts";
import { TeamsService } from "./teams-service.ts";
import type { TeamEvent, TeamMessageType, TeamRecord } from "./team-types.ts";
import { WorkflowService } from "./workflow-service.ts";
import { RemoteJobsService } from "./remote-jobs.ts";
import type { RemoteJobRecord } from "./remote-job-types.ts";
import { createKaggleRemoteJobQuery } from "./kaggle-remote-jobs.ts";
import { validateJsonSchema } from "./workflow-schema.ts";
import type { WorkflowApprovalDecision, WorkflowEvent, WorkflowRecord, WorkflowRunInput } from "./workflow-types.ts";
import { buildContextReport, deleteProjectMemoryRule, writeProjectMemoryFile, type ContextBreakdown, type ContextMemorySource } from "./context-inspector.ts";
import { buildSeatbeltProfile, probeSeatbeltSupport, resolveGitWorktreeWritablePaths } from "./sandbox.ts";
import { readClaudeProjectPermissionsDetailed, writeClaudeProjectPermissions } from "./claude-settings-sync.ts";
import { createForkedSessionSnapshot, findSessionFileById } from "./session-fork.ts";
import type { BtwResult, ClaudePermissionsSyncResult, ConversationMetaPatch, DoctorCheck, DoctorReport, OutputStyleInfo, PlanFileState, PullRequestMergeMethod, SandboxStatus, UsageStatsReport } from "./shared.ts";
import { ExternalAgents } from "./external-agents.ts";
import { readToolOutputPage, toolOutputDirectory } from "./tool-output-archive.ts";
import { CodexAdapter } from "./external-codex.ts";
import { ClaudeAdapter } from "./external-claude.ts";
import { KimiAdapter } from "./external-kimi.ts";
import { AntigravityAdapter } from "./external-antigravity.ts";
import type { ExternalAdapter, ExternalApprovalResponse, ExternalEvent, ExternalExecutorInput, ExternalProvider, ExternalTask, ExternalTaskSendInput, ExternalTaskStartInput } from "./external-types.ts";
import type { DeliverCustomType, DesktopToolInvocation, KaggleComputerUseAction, NotificationDelivery, NotificationDisposition, NotificationUsage, ToolHostContext } from "./tool-control-types.ts";
import { formatTaskNotification, notificationStatus, TASK_NOTIFICATION_TYPE, type TaskNotificationDetails } from "./delegation-format.ts";
import { TaskWaiters } from "./task-waiters.ts";
import type { ExternalNotification } from "./external-agents.ts";
import type { RpcExtensionUIResponse, SessionStats } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "./shared.ts";

const exec = promisify(execFile);
const DOCTOR_CHECK_TIMEOUT_MS = 4000;
const providers: Provider[] = ["anthropic", "openai", "google", "openrouter", "deepseek"];
const permissionModes = new Set<unknown>(["ask", "acceptEdits", "read", "auto", "plan", "dontAsk"]);
const piBuiltinTools = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
const explicitCliToolFlags = new Set(["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt"]);

/** An explicit empty result means deny all built-in tools, not "unset". */
export function piToolAllowlist(tools: string[] | undefined): string[] | undefined {
	return tools?.filter((name) => piBuiltinTools.has(name));
}
/** Pi `--tools` arguments for a session; task tool lists are validated before they get here. */
export function piToolArgs(
	task: Pick<DesktopTask, "allowedTools" | "disallowedTools"> | undefined,
	policyMode: RuntimePermissionPolicy["mode"],
	options?: { canDelegate?: boolean },
): string[] {
	const disallowed = new Set(task?.disallowedTools ?? []);
	const definedTools = piToolAllowlist(task?.allowedTools)?.filter((name) => !disallowed.has(name));
	const delegationTools = options?.canDelegate
		? ["Agent", "SendMessage", "AgentSend", "TaskOutput", "TaskStop", "TaskList", "WorktreeList"].filter((name) => !disallowed.has(name))
		: [];
	const planTools = policyMode === "plan" && !disallowed.has("ExitPlanMode") &&
		(!task?.allowedTools || task.allowedTools.includes("ExitPlanMode")) ? ["ExitPlanMode"] : [];
	if (definedTools !== undefined) {
		// An explicit empty allowlist must deny all built-in tools instead of
		// falling back to Pi's unrestricted default.
		const list = [...definedTools, ...planTools, ...(definedTools.length > 0 ? delegationTools : [])];
		return ["--tools", list.join(","), ...(policyMode === "read" || policyMode === "plan" ? ["--exclude-tools", "mcp__*"] : [])];
	}
	if (policyMode === "read") return ["--tools", ["read", "grep", "find", "ls", ...delegationTools].join(","), "--exclude-tools", "mcp__*"];
	if (policyMode === "plan") return ["--tools", ["read", "grep", "find", "ls", "write", "edit", ...planTools, ...delegationTools].join(","), "--exclude-tools", "mcp__*"];
	return [];
}
function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function stopActiveGoal(conversation: Conversation, reason: string): boolean {
	if (!conversation.goal?.active) return false;
	conversation.goal = { ...conversation.goal, active: false, status: "stopped", finishedAt: Date.now(), stopReason: reason };
	return true;
}
function statTokens(value: Partial<SessionStats["tokens"]> | undefined): SessionStats["tokens"] {
	return {
		input: finiteCount(value?.input), output: finiteCount(value?.output), cacheRead: finiteCount(value?.cacheRead),
		cacheWrite: finiteCount(value?.cacheWrite), total: finiteCount(value?.total),
	};
}
/** The APPEND_SYSTEM.md Pi would discover itself: the trusted project's first, then the agent directory's. */
async function appendSystemPromptFile(project: string, trusted: boolean, agentDir: string): Promise<string | undefined> {
	const candidates = [...(trusted ? [join(project, ".pi", "APPEND_SYSTEM.md")] : []), join(agentDir, "APPEND_SYSTEM.md")];
	for (const candidate of candidates) if (await stat(candidate).then((info) => info.isFile(), () => false)) return candidate;
	return undefined;
}
interface StoredState {
	projects: Project[];
	conversations: Conversation[];
	activeId?: string;
	settings: Omit<Settings, "configuredProviders">;
	keys: Partial<Record<Provider, string>>;
	/** Encrypted JSON of each connection's custom request headers. */
	headerKeys?: Partial<Record<Provider, string>>;
	/** Encrypted DeepSeek Search API key for WebSearch. */
	webSearchApiKey?: string;
	tasks: DesktopTask[];
	taskPolicies?: Record<string, RuntimePermissionPolicy>;
	/** Canonical project path to the user's explicit trust decision. */
	projectTrust?: Record<string, ProjectTrustDecision>;
}
const DEFAULT_GRAIL_MAX_COST = 2;
const DEFAULT_GRAIL_TIMEOUT_SEC = 900;
/** Desktop-side record of a conversation's wishes; stored in <dataDir>/grail, never in the Pi session. */
interface GrailRecord {
	version: 1;
	/** Seal times; wish N starts after sealedAt[N - 1]. */
	sealedAt: number[];
	verdicts: GrailVerdict[];
}
interface GrailRun {
	id: string;
	controller: AbortController;
	step: GrailStep;
	startedAt: number;
	deadline: number;
	committing: boolean;
	finished: Promise<void>;
}
interface SessionRuntime {
	conversationId: string;
	/** The latest native agent run, retained while its managed shells can still be stopped. */
	workingTurn?: WorkingTurn;
	liveTranscript: LiveTranscript;
	eventSequence: number;
	transcriptRevision: number;
	agent?: AgentProcess;
	state?: RpcSessionState;
	/** Last physical entry already observed by saveSessionLeaf, for lightweight live cursor reads. */
	historyTailId?: string;
	models: Model[];
	engineStatus: Snapshot["engineStatus"];
	engineError?: string;
	busy: boolean;
	bashBusy: boolean;
	pendingUI: Map<string, RpcExtensionUIRequest>;
	/** Recently answered UI request ids in this runtime, so duplicate replies are idempotent. */
	answeredUI: Set<string>;
	checkpointId?: string;
	checkpointStarting?: Promise<void>;
	costLimitFile?: string;
	releaseCostReservation?: () => Promise<void>;
	checkpointUserAnchor?: { previousEntryId: string | null; observedPrompt: boolean };
	settling?: Promise<void>;
	userQueue?: QueuedPrompts;
	loading?: Promise<void>;
	lastError?: string;
	stopping: boolean;
	replacing?: boolean;
	stopHookRanThisTurn?: boolean;
	/** Set once SessionStart fired, so only a started runtime reports SessionEnd. */
	sessionStarted?: boolean;
	/** Last policy written to the runtime, reported by its lifecycle hooks. */
	sessionPermissionMode?: string;
	navigation?: { directory: string; token: string; command: string };
	controls?: { directory: string; token: string; command: string; hostToken: string; operation: Promise<void> };
	policyFile?: string;
	sandboxProfileFile?: string;
	escalationFile?: string;
	/** Environment of the Pi child, reused for its background shells. */
	shellEnv?: NodeJS.ProcessEnv;
	/** Output style prompt read by the permission extension each turn; main conversations only. */
	outputStyleFile?: string;
	metaWritten?: boolean;
	controlWrites?: Promise<void>;
	/**
	 * Background results this Pi process holds as `nextTurn` messages. They count as
	 * delivered once the parent's next run starts and are re-queued after a restart.
	 */
	queuedNotifications?: Map<string, OutboxItem>;
	/** Resolved once the next run has taken the queued results. */
	queueConsumers?: Set<() => void>;
	/** Last event or user attention; an idle finished child is reaped after CHILD_RUNTIME_IDLE_MS. */
	lastActivity: number;
	/** Running task progress accumulator, throttled to task_progress events. */
	progress?: {
		taskId: string;
		turn: number;
		toolUses: number;
		lastToolName?: string;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		cost: number;
		startedAt: number;
		recentActivities: TaskProgressActivity[];
		readPaths: Set<string>;
		emitTimer?: ReturnType<typeof setTimeout>;
		lastEmitAt: number;
		lastPersistAt: number;
	};
}
interface WorkingTurn {
	id: string;
	active: boolean;
	stopRequested?: boolean;
	stopOperation?: Promise<{ stoppedShells: string[]; foregroundStopped: boolean }>;
}
/** One undelivered background result, rebuilt from the task record on every flush. */
interface OutboxItem {
	key: string;
	source: "pi" | "external";
	taskId: string;
	turn: number;
	content: string;
	details: TaskNotificationDetails;
	updatedAt: number;
	/** The child's run usage; counted into the parent session when it receives the result. */
	usage?: NotificationUsage;
}
/**
 * After this many consecutive failed deliveries the automatic backoff stops. The result is
 * tried again when the parent's run settles (or its runtime restarts), or on "立即交付".
 */
const MAX_NOTIFY_ATTEMPTS = 5;
/** Matches the hooks-service per-hook timeout ceiling. */
const SESSION_END_HOOK_WAIT_MS = 60000;
type FlushMode = "auto" | "settled" | "startup" | "now";
export interface ServiceOptions {
	dataDir: string;
	tracing?: PiTracing;
	runtimeDir?: string;
	executable: string;
	entry?: string;
	permissionExtension?: string;
	env?: NodeJS.ProcessEnv;
	initialProject?: string;
	args?: string[];
	providerBaseUrls?: Partial<Record<Provider, string>>;
	/** Loopback origin that replaces every official balance host (tests only). */
	balanceOrigin?: string;
	ptyHelperPath?: string;
	/** Moves a deleted conversation's session file to the OS Trash (defaults to dataDir/trash). */
	trashItem?: (filePath: string) => Promise<void>;
	/** Headless Electron browser verification handler for the PreviewCheck model tool. */
	inspectPreview?: (input: PreviewInspectInput) => Promise<PreviewInspectResult>;
	/** The host owns the dedicated window and the native Run All approval. */
	kaggleComputerUse?: (input: {
		conversationId: string;
		action: KaggleComputerUseAction;
		signal: AbortSignal;
		recheckRun: () => Promise<void>;
	}) => Promise<unknown>;
	archiveEntry?: string;
	historyEntry?: string;
	navigationExtension?: string;
	toolControlExtension?: string;
	workflowWorker?: string;
	externalAdapters?: Record<ExternalProvider, ExternalAdapter>;
	claudeHelperPath?: string;
	maxConcurrentTasks?: number;
	/** Hard cap on extra concurrent processes allowed for slot borrowing across foreground ancestor chains. */
	maxBorrowedSlots?: number;
	/** Idle time before a finished child's process is stopped; it restarts on demand. */
	childRuntimeIdleMs?: number;
	/** Reaper period; 0 disables the timer (tests call reapIdleChildRuntimes directly). */
	childRuntimeReapIntervalMs?: number;
	encrypt?: (value: string) => string;
	decrypt?: (value: string) => string;
	/** Local log directory shown by /doctor; the main process owns the log file. */
	logDir?: string;
	/** Receives content-free engine failure records for the local diagnostic log. */
	onDiagnostic?: (level: "warn" | "error", event: string, details: Record<string, string>) => void;
	/** The desktop confirms known remote mutations explicitly submitted through its command runner. */
	confirmRemoteCommand?: (input: { command: string; reason: string }) => Promise<boolean>;
}

/** Desktop session owner. Runtime injection keeps the real subprocess usable in isolated tests. */
export class DesktopService {
	private options: ServiceOptions;
	private store: StoredState = {
		projects: [],
		conversations: [],
		settings: { permission: "ask", theme: "light", connections: {} },
		keys: {},
		tasks: [],
		projectTrust: {},
	};
	private runtimes = new Map<string, SessionRuntime>();
	private git: GitSnapshots;
	private terminals: TerminalService;
	private worktrees: WorktreeService;
	private history: SessionHistoryService;
	private historyAvailable = false;
	private searchAbort?: AbortController;
	private readonly usage = new UsageStatsCollector();
	private connectionCheck?: { agent: AgentProcess; cancel: (error: Error) => void };
	private connectionTestOperation: Promise<void> = Promise.resolve();
	private grailListeners = new Set<(event: GrailEvent) => void>();
	private grailRuns = new Map<string, GrailRun>();
	private grailWrites = new Map<string, Promise<void>>();
	private engineError?: string;
	private closed = false;
	private listeners = new Set<(event: DesktopEvent) => void>();
	private taskListeners = new Set<(event: TaskEvent) => void>();
	private progressListeners = new Map<string, Set<(progress: TaskProgress) => void>>();
	private userBackgroundedTasks = new Set<string>();
	private scheduling = false;
	private launches = new Map<string, number>();
	private commands = new Set<Promise<unknown>>();
	/** SessionEnd hooks still running; close() waits for them up to the hook timeout cap. */
	private sessionEndHooks = new Set<Promise<unknown>>();
	private operation: Promise<void> = Promise.resolve();
	private persistence: Promise<void> = Promise.resolve();
	private eventSequence = 0;
	private toolSettings: ToolSettingsStore;
	private toolHost: ToolHostServer;
	private delegation: ModelDelegation;
	private agents: AgentRegistry;
	private languages: LanguageService;
	private agentWatcher?: { key: string; stop: () => void };
	private mcp: McpRegistry;
	private hooks: HooksService;
	private skills: SkillRegistry;
	private todos: TodoService;
	private monitors: MonitorService;
	private cron: CronService;
	private teams: TeamsService;
	private workflows: WorkflowService;
	/** Last global value sent through set_auto_retry (Pi may still be writing it); project settings override it. */
	private autoRetryGlobal?: { agentDir: string; enabled: boolean };
	private controlListeners = new Set<(event: ControlEvent) => void>();
	private worktreeOperationOwner?: string;
	private external: ExternalAgents;
	private remoteJobs: RemoteJobsService;
	private remoteJobListeners = new Set<(job: RemoteJobRecord | undefined, previous?: RemoteJobRecord) => void>();
	private waiters = new TaskWaiters();
	/** Workflow steps waiting for a free subagent slot; woken on every task status change. */
	private slotWaiters = new Set<() => void>();
	/** Slots claimed by workflow steps whose task is not yet in the store, per parent conversation. */
	private reservedSlots = new Map<string, number>();
	/** Consecutive delivery failures per outbox key; memory only, reset by a manual delivery. */
	private notifyAttempts = new Map<string, number>();
	private notifyTimers = new Map<string, NodeJS.Timeout>();
	private notifyChains = new Map<string, Promise<void>>();
	private notificationCounts = new Map<string, number>();
	/** Conversations the renderer shows outside the active one (e.g. a task detail view). */
	private viewing = new Set<string>();
	/** Running preview dev servers started via PreviewCheck(start_server), keyed by monitor shell ID. */
	private previewServers = new Map<string, { serverId: string; name: string; url?: string; rootConversationId: string }>();
	private reapTimer?: NodeJS.Timeout;

	constructor(options: ServiceOptions) {
		this.options = options;
		this.languages = new LanguageService(options.env);
		this.toolSettings = new ToolSettingsStore(options.dataDir);
		this.agents = new AgentRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.mcp = new McpRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.hooks = new HooksService({
			agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir(),
			disabled: () => this.store.settings.disableAllHooks === true,
		});
		this.skills = new SkillRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.todos = new TodoService({ dataDir: () => this.options.dataDir });
		this.monitors = new MonitorService({ deliver: (id, params) => this.deliverToConversation(id, params) });
		this.remoteJobs = new RemoteJobsService({
			statePath: join(options.dataDir, "remote-jobs.json"),
			canQuery: () => process.env.PI_OFFLINE !== "1" && !this.store.settings.sandboxOffline,
			query: createKaggleRemoteJobQuery({
				env: options.env,
				fetch: undiciFetch as unknown as typeof fetch,
				dispatcher: () => this.balanceDispatcher(),
			}),
			onChange: (id, previous) => {
				const job = this.remoteJobs.list().find((record) => record.id === id);
				for (const listener of this.remoteJobListeners) listener(job, previous);
			},
		});
		this.cron = new CronService({
			dataDir: () => this.options.dataDir,
			deliver: (id, params, project) => this.deliverCronWakeup(id, params, project),
			isEnabled: () => this.store.settings.cronEnabled !== false,
			isProjectTrusted: (project) => this.isProjectTrusted(project),
		});
		this.teams = new TeamsService({
			dataDir: () => this.options.dataDir,
			deliver: (id, params) => this.deliverTeamWakeup(id, params),
			isEnabled: () => this.store.settings.agentTeams === true,
		});
		this.toolHost = new ToolHostServer({
			handle: async (request, context) => {
				const decision = await evaluatePermission(this.permissionPolicy(context.conversationId), { toolName: request.tool, input: request.input });
				if (decision.action === "deny") throw new Error(decision.reason);
				return this.modelTool(request, context);
			},
			handleHook: async (request, context) => {
				if (request.phase === "max_turns") {
					// Only an active delegated child with a turn limit can mark its own limit stop.
					const task = this.store.tasks.find((item) => item.conversationId === context.conversationId && item.parentConversationId);
					if (task?.maxTurns && ["running", "waiting_for_input"].includes(task.status)) {
						task.stopReason = "max_turns";
						await this.persist();
					}
					return { blocked: false };
				}
				const conv = this.conversation(context.conversationId);
				const meta = await this.hookContextFor(context.conversationId);
				const trusted = this.isProjectTrusted(conv.project);
				const project = this.trustProjectFor(conv.project);
				const permissionMode = this.hookPermissionMode(context.conversationId);
				if (request.phase === "compact") {
					return this.hooks.run("PreCompact", {
						project,
						projectTrusted: trusted,
						conversationId: context.conversationId,
						permissionMode,
						trigger: request.trigger ?? "manual",
						prompt: request.customInstructions,
						agentId: meta.agentId,
						agentType: meta.agentType,
						extraHooks: meta.extraHooks,
						env: this.options.env,
					});
				}
				if (request.phase === "stop") {
					const runtime = this.runtimes.get(context.conversationId);
					if (runtime) runtime.stopHookRanThisTurn = true;
					return this.runStopOrSubagentStopHook({
						conversationId: context.conversationId,
						meta,
						stopHookActive: request.stopHookActive,
						lastAssistantMessage: request.lastAssistantMessage,
					});
				}
				const eventName =
					request.phase === "pre"
						? "PreToolUse"
						: request.phase === "permission"
							? "PermissionRequest"
							: request.isError
								? "PostToolUseFailure"
								: "PostToolUse";
				return this.hooks.run(eventName, {
					project,
					projectTrusted: trusted,
					conversationId: context.conversationId,
					permissionMode,
					toolName: request.toolName,
					toolCallId: request.toolCallId,
					toolInput: request.toolInput,
					toolResponse: request.toolResponse,
					error: request.error,
					agentId: meta.agentId,
					agentType: meta.agentType,
					extraHooks: meta.extraHooks,
					env: this.options.env,
				});
			},
			handlePlanExit: async (request, context) => {
				if (this.permissionPolicy(context.conversationId).mode !== "plan") throw new Error("请先进入计划模式，再提交计划。");
				if (typeof request.plan === "string" && request.plan.trim()) {
					const saved = await this.writePlan(
						request.title ? `# ${request.title}\n\n${request.plan}` : request.plan,
						context.conversationId,
					);
					return { saved: true, planFile: saved.relativePath, content: saved.content };
				}
				const current = await this.readPlan(context.conversationId);
				if (!current.content.trim())
					throw new Error(`计划正文为空。请将正文传入 ExitPlanMode 的 plan 参数，或先写入 ${current.relativePath}。`);
				return { saved: true, planFile: current.relativePath, content: current.content };
			},
		});
		this.delegation = new ModelDelegation({
			getConversation: (id) => this.conversation(id),
			getSelection: async (id) => {
				const runtime = await this.ensureRuntime(this.conversation(id));
				return { model: runtime.state?.model ? { provider: runtime.state.model.provider, id: runtime.state.model.id } : undefined, thinkingLevel: runtime.state?.thinkingLevel };
			},
			resolveAgent: (project, name) => this.agents.resolve(this.trustProjectFor(project), name, this.projectTrusted(this.trustProjectFor(project))),
			resolveModelAlias: (parentId, alias, strict) => this.resolveAgentModelAlias(parentId, alias, strict),
			routedModel: (parentId, role) => this.routedModel(parentId, role),
			listAgentNames: async (project) => (await this.agents.list(this.trustProjectFor(project), this.projectTrusted(this.trustProjectFor(project)))).map((agent) => agent.name),
			defaultBackground: () => this.store.settings.subagentDefaultBackground !== false,
			foregroundTimeoutMs: () => this.store.settings.foregroundSubagentTimeoutMs ?? DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS,
			forkSubagentEnabled: () => this.store.settings.forkSubagent !== false,
			confineSubagentBash: () => this.store.settings.confineSubagentBash !== false,
			seatbeltSupport: () => probeSeatbeltSupport(),
			maxSubagentDepth: () => this.store.settings.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
			maxConcurrentSubagents: () => this.store.settings.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
			teamsEnabled: () => this.store.settings.agentTeams === true,
			prepareAgentContext: (project, definition) => this.prepareCustomAgentContext(this.trustProjectFor(project), definition),
			listTasks: () => this.listTasks(),
			startTask: (input, metadata) => this.startTask(input, metadata),
			cancelTask: (id, reason) => this.cancelTask(id, reason),
			resumeTask: (id, message, options) => this.resumeTask(id, message, options),
			pendingApprovalCount: (id) => this.runtimes.get(this.task(id).conversationId)?.pendingUI.size ?? 0,
			peekOutput: (id) => this.peekTaskOutput(id),
			listWorktrees: (project) => this.listWorktrees(project),
			createWorktree: (input) => this.createWorktree(input),
			removeWorktree: (id, owner, callId) => this.modelWorktreeMutation("remove", id, owner, callId),
			mergeWorktree: (id, owner, callId) => this.modelWorktreeMutation("merge", id, owner, callId),
			isGit: async (project) => {
				try { await exec("git", ["rev-parse", "--show-toplevel"], { cwd: project }); return true; } catch { return false; }
			},
			// Writable shared work runs only in the foreground and only outside Git: the parent
			// waits on the call, and no Git checkpoint of the parent's run spans the child's edits.
			canRunShared: async (owner, readOnly, foreground) => {
				if (readOnly) return true;
				if (!foreground) return false;
				try { await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.conversation(owner).project }); return false; } catch { return true; }
			},
			isPlanMode: (id) => this.permissionPolicy(id).mode === "plan",
			waitForTask: (id, predicate, signal, timeout) => this.waiters.wait(
				id,
				() => { const task = this.store.tasks.find((item) => item.id === id); return task && structuredClone(task); },
				predicate, signal, timeout,
			),
			detachTask: (id) => this.detachTask(id),
			subscribeTaskProgress: (id, listener) => this.subscribeTaskProgress(id, listener),
			isUserBackgrounded: (id) => this.userBackgroundedTasks.has(id),
			flushNotifications: (owner) => this.flushNotifications(owner, "auto"),
		});
		this.git = new GitSnapshots(join(options.dataDir, "checkpoints"));
		const runtimeDir =
			options.runtimeDir ?? (options.entry ? dirname(dirname(dirname(options.entry))) : options.dataDir);
		this.workflows = new WorkflowService({
			dataDir: () => this.options.dataDir,
			callbacks: {
				workerPath: () => this.options.workflowWorker ?? join(runtimeDir, "workflow-worker-entry.mjs"),
				permissionMode: (conversationId) => this.hookPermissionMode(conversationId),
				deliver: (id, params) => this.deliverToConversation(id, params),
				cancelWorkflowTasks: async (workflowId) => {
					await this.operation;
					const matching = this.store.tasks.filter(
						(item) => item.workflowId === workflowId && ["queued", "running", "waiting_for_input"].includes(item.status),
					);
					await Promise.all(matching.map((t) => this.cancelTask(t.id, "parent_abort").catch(() => {})));
				},
				runAgentStep: async (req, signal) => {
					const conv = this.conversation(req.conversationId);
					// Wait for a free slot instead of failing, so parallel() wider than the
					// concurrency cap runs in waves rather than erroring.
					await this.acquireSubagentSlot(conv.id, signal);
					let slotHeld = true;
					const releaseSlot = () => {
						if (!slotHeld) return;
						slotHeld = false;
						const left = (this.reservedSlots.get(conv.id) ?? 1) - 1;
						if (left > 0) this.reservedSlots.set(conv.id, left);
						else this.reservedSlots.delete(conv.id);
						this.wakeSlotWaiters();
					};
					try {
					const trustProj = this.trustProjectFor(conv.project);
					const definition = req.subagentType
						? await this.agents.resolve(trustProj, req.subagentType, this.projectTrusted(trustProj)).catch(() => undefined)
						: undefined;
					const readOnly = definition?.readOnly ?? (req.subagentType !== undefined && req.subagentType !== "general-purpose");
					let isGitRepo = false;
					try {
						await exec("git", ["rev-parse", "--show-toplevel"], { cwd: conv.project });
						isGitRepo = true;
					} catch {}
					const isolation = readOnly ? "shared" : (req.isolation ?? (isGitRepo ? "worktree" : "shared"));
					const model = req.model && ["sonnet", "opus", "haiku", "fable", "inherit"].includes(req.model)
						? await this.resolveAgentModelAlias(conv.id, req.model as AgentModelAlias, true)
						: undefined;
					const schemaHint = req.schema !== undefined
						? `You MUST return valid JSON conforming to this schema by calling the StructuredOutput tool with {"data": <JSON>}:\n${JSON.stringify(req.schema)}`
						: undefined;
					const combinedSystem = [definition?.prompt?.trim(), schemaHint].filter(Boolean).join("\n\n---\n\n");
					signal.throwIfAborted();
					const task = await this.startTask(
						{
							project: conv.project,
							message: req.prompt,
							title: req.description,
							isolation,
							...(model ? { model } : {}),
							...(definition?.tools ? { allowedTools: definition.tools } : {}),
							...(definition?.disallowedTools?.length ? { disallowedTools: definition.disallowedTools } : {}),
							...(definition?.permissionMode ? { permissionMode: definition.permissionMode } : {}),
							...(combinedSystem ? { systemPrompt: combinedSystem } : {}),
							...(req.schema !== undefined ? { structuredOutputSchema: req.schema } : {}),
						},
						{
							parentConversationId: conv.id,
							parentToolCallId: `wf_${req.workflowId}_${req.stepKey}`,
							subagentType: definition?.name ?? req.subagentType ?? "general-purpose",
							delegationDepth: 1,
							readOnly,
							runInBackground: true,
							notifySuppressed: true,
							workflowId: req.workflowId,
							...(req.isolation !== "shared" ? { workflowWorkspace: req.workspaceKey } : {}),
						},
						signal,
					);
					// The task is now in the store and counts toward the cap by its own status.
					releaseSlot();
					const finished = await this.waitTaskSettled(
						task.id,
						(t) => !["queued", "running", "waiting_for_input"].includes(t.status),
						signal,
					);
					if (!finished) throw new Error(`Workflow task ${task.id} disappeared`);
					if (finished.status === "failed" || finished.status === "cancelled" || finished.status === "interrupted") {
						throw new Error(finished.error || `Workflow child task ended with status ${finished.status}`);
					}
					const output = finished.result?.text ?? "";
					return {
						taskId: finished.id,
						worktreeId: finished.worktreeId,
						workingDirectory: finished.workingDirectory,
						output,
						...(finished.structuredOutput !== undefined ? { structuredOutput: finished.structuredOutput } : {}),
						...(finished.stats ? { usage: { totalTokens: finished.stats.tokens.total, cost: finished.stats.cost } } : {}),
					};
					} finally {
						releaseSlot();
					}
				},
				resumeStructuredStep: async (taskId, feedback, signal) => {
					signal.throwIfAborted();
					const existing = this.task(taskId);
					delete existing.structuredOutput;
					const expectedTurn = (existing.turn ?? 1) + 1;
					await this.resumeTask(taskId, feedback, { source: "model", background: true });
					const finished = await this.waitTaskSettled(
						taskId,
						(t) => (t.turn ?? 1) >= expectedTurn && !["queued", "running", "waiting_for_input"].includes(t.status),
						signal,
					);
					if (!finished) throw new Error(`Workflow task ${taskId} disappeared`);
					return {
						taskId: finished.id,
						worktreeId: finished.worktreeId,
						workingDirectory: finished.workingDirectory,
						output: finished.result?.text ?? "",
						...(finished.structuredOutput !== undefined ? { structuredOutput: finished.structuredOutput } : {}),
						...(finished.stats ? { usage: { totalTokens: finished.stats.tokens.total, cost: finished.stats.cost } } : {}),
					};
				},
			},
		});
		this.history = new SessionHistoryService({
			dataDir: options.dataDir,
			executable: options.executable,
			entry: options.historyEntry ?? join(runtimeDir, "session-history-entry.mjs"),
			env: options.env,
		});
		this.terminals = new TerminalService({
			helperPath:
				options.ptyHelperPath ??
				join(
					options.runtimeDir ?? (options.entry ? dirname(dirname(dirname(options.entry))) : options.dataDir),
					"native/pty-host",
				),
			env: options.env,
		});
		this.worktrees = new WorktreeService({
			dataDir: join(options.dataDir, "worktrees"),
			isActive: (item) => this.pathActive(item.path, this.worktreeOperationOwner) || this.pathActive(item.repository, this.worktreeOperationOwner),
		});
		this.external = new ExternalAgents({
			dataDir: options.dataDir, env: { ...process.env, ...options.env }, nodeExecutable: options.executable,
			networkEnv: () => networkEnvironment(this.store.settings),
			claudeHelperPath: options.claudeHelperPath ?? join(runtimeDir, "external-claude-helper.mjs"),
			adapters: options.externalAdapters ?? { codex: new CodexAdapter(), claude: new ClaudeAdapter(), kimi: new KimiAdapter(), antigravity: new AntigravityAdapter() },
			maxConcurrent: options.maxConcurrentTasks ?? 4,
			project: (id) => this.conversation(id).project,
			isProjectTrusted: (project) => this.isProjectTrusted(project),
			policy: (id) => this.permissionPolicy(id),
			delegated: (id) => this.store.tasks.some((task) => task.conversationId === id && task.parentConversationId),
			createWorktree: (input) => this.createWorktree(input), listWorktrees: () => this.listWorktrees(),
			capacity: () => (options.maxConcurrentTasks ?? 4) - this.store.tasks.filter((task) => ["running", "waiting_for_input"].includes(task.status) && !this.isSlotBorrower(task)).length,
			canStart: (task) => {
				if (task.readOnly) return true;
				try { this.assertPathAvailable(task.workingDirectory, undefined, task.id); return true; } catch { return false; }
			},
			beginCheckpoint: async (task) => {
				const checkpoint = await this.git.begin(task.workingDirectory, task.id, `${task.title} · 第 ${task.turn} 轮`);
				return async () => { await this.git.finish(task.workingDirectory, checkpoint.id, { conversationId: task.id }); };
			},
			checkBudget: (executor) => {
				if (this.store.settings.minBalance)
					throw new Error("外部执行器使用独立账号，无法核对 Pi 设置的最低余额。");
				if (this.store.settings.maxCostUsd && executor !== "claude")
					throw new Error("此外部执行器无法执行其账号的美元费用上限。");
			},
			reserveBudget: (task) => this.reserveChildCost(task.parentConversationId, task.id),
			flushNotifications: (owner) => { void this.flushNotifications(owner, "auto"); },
			onActivityChange: () => { void this.scheduleTasks(); },
		});
	}

	async initialize(): Promise<Snapshot> {
		await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
		await this.toolSettings.initialize();
		await this.external.initialize();
		const runtimeDir =
			this.options.runtimeDir ??
			(this.options.entry ? dirname(dirname(dirname(this.options.entry))) : this.options.dataDir);
		this.historyAvailable = await stat(this.options.historyEntry ?? join(runtimeDir, "session-history-entry.mjs")).then(
			(info) => info.isFile(),
			() => false,
		);
		try {
			// App metadata is a disk trust boundary; malformed or newer shapes must not reach process args.
			const stored: unknown = JSON.parse(await readFile(join(this.options.dataDir, "desktop.json"), "utf8"));
			const { state, dropped } = validateStore(stored, join(this.options.dataDir, "agent-prompts"));
			this.store = state;
			if (dropped.length)
				this.engineError = `已丢弃或隔离 ${dropped.length} 条格式无效的后台任务记录：${dropped.slice(0, 3).join("；")}${dropped.length > 3 ? "……" : ""}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.engineError = `无法读取桌面配置：${error instanceof Error ? error.message : String(error)}`;
		}
		for (const conversation of this.store.conversations)
			stopActiveGoal(conversation, "应用已重启，目标模式已停止。");
		const interrupted: DesktopTask[] = [];
		for (const task of this.store.tasks) {
			if (["queued", "running", "waiting_for_input"].includes(task.status)) {
				task.status = "interrupted";
				task.error = task.parentConversationId ? "应用已重启；可用 SendMessage 继续。" : "应用已重启，任务未自动重新执行。";
				task.stopReason = "restart";
				// A resumed message that never reached the child is not replayed by itself.
				delete task.pendingMessage;
				task.updatedAt = Date.now();
				interrupted.push(task);
			}
		}
		// A child that died with the app never settled, so its result was never recorded.
		// Read its partial work from the saved transcript; this starts no runtime.
		for (const task of interrupted) {
			if (!task.parentConversationId || task.result) continue;
			const text = await this.savedFinalText(task.conversationId).catch(() => undefined);
			if (text !== undefined)
				task.result = { text: truncateText(text, MAX_AGENT_OUTPUT), truncated: text.length > MAX_AGENT_OUTPUT, partial: true };
		}
		await this.worktrees.initialize();
		await this.cron.loadGlobal();
		await this.workflows.initialize();
		await this.remoteJobs.start().catch(() => {
			this.options.onDiagnostic?.("warn", "remote_jobs_load_failed", {});
		});
		if (this.store.settings.sandbox === undefined && process.env.PI_DESKTOP_NO_AUTO_SANDBOX !== "1") {
			const seatbelt = await probeSeatbeltSupport();
			if (seatbelt.supported) this.store.settings.sandbox = true;
		}
		await this.persist();
		const reapInterval = this.options.childRuntimeReapIntervalMs ?? CHILD_RUNTIME_REAP_INTERVAL_MS;
		if (reapInterval > 0 && !this.reapTimer) {
			this.reapTimer = setInterval(() => { void this.reapIdleRuntimes().catch(() => {}); }, reapInterval);
			this.reapTimer.unref?.();
		}
		if (this.options.initialProject) return this.selectProject(this.options.initialProject);
		const active = this.active();
		if (active) await this.activate(active);
		return this.buildSnapshot();
	}

	subscribe(listener: (event: DesktopEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private costReservations = new Map<string, { owner: string; amount: number }>();
	private costOperation: Promise<unknown> = Promise.resolve();

	private serializeCost<T>(action: () => Promise<T>): Promise<T> {
		const result = this.costOperation.catch(() => {}).then(action);
		this.costOperation = result;
		return result;
	}

	/** The root's Pi session already includes usage from subagents that reported back. */
	private rootCostLimit(owner: string): number {
		const cap = this.store.settings.maxCostUsd ?? 0;
		const reserved = [...this.costReservations.values()]
			.filter((reservation) => reservation.owner === owner)
			.reduce((sum, reservation) => sum + reservation.amount, 0);
		const undelivered = this.store.tasks.filter((task) => task.parentConversationId && task.runInBackground &&
			this.rootConversationId(task.conversationId) === owner && !this.costReservations.has(task.id) &&
			!["queued", "running", "waiting_for_input"].includes(task.status) && task.notifiedTurn !== (task.turn ?? 1))
			.reduce((sum, task) => sum + finiteCount(task.stats?.cost), 0);
		return Math.max(0, cap - reserved - undelivered - this.external.measuredCostUsd(owner));
	}

	private async refreshRootCostLimit(owner: string): Promise<void> {
		const file = this.runtimes.get(owner)?.costLimitFile;
		if (file) await this.atomicFile(file, String(this.rootCostLimit(owner)));
	}

	private reserveChildCost(parent: string, taskId: string): Promise<{ maxBudgetUsd: number; release(): Promise<void> } | undefined> {
		if (!this.store.settings.maxCostUsd) return Promise.resolve(undefined);
		const owner = this.rootConversationId(parent);
		return this.serializeCost(async () => {
			if (!this.store.settings.maxCostUsd) return undefined;
			const root = this.runtimes.get(owner) ?? await this.ensureRuntime(this.conversation(owner));
			const spent = finiteCount((await this.requireAgent(root).request<SessionStats>({ type: "get_session_stats" })).cost);
			const remaining = this.rootCostLimit(owner) - spent;
			if (remaining <= 0) throw new Error("父会话的费用额度已用完或被运行中的任务预留。");
			const usedSlots = [...this.costReservations.values()].filter((reservation) => reservation.owner === owner).length;
			const slots = Math.max(2, (this.options.maxConcurrentTasks ?? 4) + 1 - usedSlots);
			const amount = remaining / slots;
			const reservation = { owner, amount };
			this.costReservations.set(taskId, reservation);
			try { await this.refreshRootCostLimit(owner); }
			catch (error) { this.costReservations.delete(taskId); throw error; }
			return { maxBudgetUsd: amount, release: () => this.serializeCost(async () => {
				if (this.costReservations.get(taskId) !== reservation) return;
				this.costReservations.delete(taskId);
				await this.refreshRootCostLimit(owner);
			}) };
		});
	}

	private providerAuthenticated(provider: Provider): boolean {
		return Boolean(this.store.keys[provider] || this.store.settings.connections[provider]?.keyCommand);
	}

	private connectionHeaders(provider: Provider): Record<string, string> | undefined {
		const encrypted = this.store.headerKeys?.[provider];
		if (!encrypted || !this.options.decrypt) return undefined;
		try {
			return validateHeaders(JSON.parse(this.options.decrypt(encrypted)));
		} catch {
			return undefined;
		}
	}

	/**
	 * Puts each provider's key, key command and headers in `env` and returns the
	 * connection descriptors the permission extension registers. Secrets travel
	 * only in environment variables named PI_DESKTOP_KEY_*.
	 */
	private connectionEnvironment(env: NodeJS.ProcessEnv, strict = false): Record<string, object> {
		const connections: Record<string, object> = {};
		for (const provider of providers) {
			const connection = this.store.settings.connections[provider];
			const encrypted = this.store.keys[provider];
			const envKey = `PI_DESKTOP_KEY_${provider.toUpperCase()}`;
			if (encrypted) {
				if (!this.options.decrypt) {
					if (strict) throw new Error("无法读取系统安全存储中的 API Key。");
				} else env[envKey] = this.options.decrypt(encrypted);
			}
			if (!connection) continue;
			const keyCommand = !encrypted ? connection.keyCommand : undefined;
			if (keyCommand) env[`${envKey}_COMMAND`] = keyCommand;
			const headers = this.connectionHeaders(provider);
			if (headers && Object.keys(headers).length) env[`${envKey}_HEADERS`] = JSON.stringify(headers);
			const { headerNames: _names, keyCommand: _command, ...rest } = connection;
			connections[provider] = {
				...rest,
				envKey: encrypted && env[envKey] ? envKey : undefined,
				keyCommandEnv: keyCommand ? `${envKey}_COMMAND` : undefined,
				headersEnv: headers && Object.keys(headers).length ? `${envKey}_HEADERS` : undefined,
				presetBaseUrl: this.options.providerBaseUrls?.[provider],
				balance: this.balanceTargetFor(provider, connection.mode, connection.baseUrl),
			};
		}
		return connections;
	}

	private balanceTargetFor(provider: Provider, mode: ConnectionMode | undefined, baseUrl: string | undefined): BalanceTarget | undefined {
		return balanceTarget(provider, mode ?? "preset", baseUrl, this.options.balanceOrigin);
	}

	/**
	 * Asks the provider for the account balance with the given or saved credentials.
	 * The request uses the configured proxy and CA file; the key goes only to the
	 * provider's official host and never appears in errors.
	 */
	async providerBalance(input: ConnectionInput): Promise<ProviderBalanceResult> {
		// Read-only: it reads one snapshot of the store and never waits for, or blocks, other operations.
		if (this.closed) throw new Error("桌面服务已关闭。");
		const stored = this.store.settings.connections[input.provider];
		const mode = connectionMode(input, stored);
		const baseUrl = mode === "custom" ? validateEndpoint(input.baseUrl ?? stored?.baseUrl ?? "") : undefined;
		const target = this.balanceTargetFor(input.provider, mode, baseUrl);
		if (!target) return { supported: false, message: "这个连接的服务商没有可用的余额查询接口。" };
		// Saved credentials belong to the saved endpoint; an edited form that points elsewhere needs its own key.
		const savedTarget = stored ? this.balanceTargetFor(input.provider, stored.mode ?? "preset", stored.baseUrl) : undefined;
		const savedUsable = savedTarget?.url === target.url;
		let key = input.apiKey?.trim();
		const encrypted = this.store.keys[input.provider];
		if (!key && savedUsable && encrypted && this.options.decrypt) key = this.options.decrypt(encrypted);
		const command = key
			? undefined
			: input.keyCommand !== undefined
				? validateKeyCommand(input.keyCommand)
				: savedUsable
					? stored?.keyCommand
					: undefined;
		try {
			if (!key && command) key = await this.runKeyCommand(command);
			if (!key)
				return {
					supported: true,
					success: false,
					message: savedUsable || !stored
						? "请填写 API Key 或取 Key 命令，或先保存此服务商的密钥。"
						: "接口地址已改动，已保存的密钥不会发给新地址。请填写这个地址的 API Key。",
				};
			const dispatcher = await this.balanceDispatcher();
			try {
				const result = await fetchBalance(target, key, {
					fetch: undiciFetch as unknown as typeof fetch,
					dispatcher,
				});
				return { supported: true, success: true, ...result, checkedAt: Date.now() };
			} finally {
				await dispatcher?.close().catch(() => {});
			}
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			if (key && key.length >= 4) message = message.replaceAll(key, "[已隐藏密钥]");
			return { supported: true, success: false, message: message.slice(0, 600) };
		}
	}

	private async runKeyCommand(command: string): Promise<string | undefined> {
		const { stdout } = await exec("/bin/sh", ["-c", command], {
			env: { ...process.env, ...this.options.env },
			timeout: 10000,
			maxBuffer: 64 * 1024,
		}).catch(() => {
			throw new Error("取 Key 命令执行失败或超时。");
		});
		return stdout.trim() || undefined;
	}

	/** A proxy- and CA-aware dispatcher for balance queries; undefined means a direct connection. */
	private async balanceDispatcher(): Promise<EnvHttpProxyAgent | undefined> {
		const env = { ...process.env, ...this.options.env, ...networkEnvironment(this.store.settings) };
		const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
		const httpProxy = env.HTTP_PROXY || env.http_proxy;
		const noProxy = env.NO_PROXY || env.no_proxy;
		const caFile = this.store.settings.caFile ?? env.NODE_EXTRA_CA_CERTS;
		let ca: string[] | undefined;
		if (caFile) {
			const path = caFile.startsWith("~/") ? join(homedir(), caFile.slice(2)) : caFile;
			ca = [...rootCertificates, await readFile(path, "utf8").catch(() => { throw new Error("无法读取自定义 CA 证书文件。"); })];
		}
		if (!httpsProxy && !httpProxy && !ca) return undefined;
		return new EnvHttpProxyAgent({
			...(httpProxy ? { httpProxy } : {}),
			...(httpsProxy ? { httpsProxy } : {}),
			...(noProxy ? { noProxy } : {}),
			...(ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {}),
		});
	}

	/** Approval and question prompts waiting across every running conversation. */
	pendingApprovalCount(): number {
		let count = this.external.pendingApprovalCount();
		for (const runtime of this.runtimes.values()) count += runtime.pendingUI.size;
		return count;
	}

	async snapshot(): Promise<Snapshot> {
		await this.operation;
		return this.buildSnapshot();
	}

	selectProject(path: string): Promise<Snapshot> {
		return this.serialize(async () => {
			const projectPath = await realpath(path);
			if (!(await stat(projectPath)).isDirectory()) throw new Error("请选择项目文件夹。");
			if (!this.store.projects.some((project) => project.path === projectPath))
				this.store.projects.push({ path: projectPath, name: basename(projectPath) });
			const recent = this.store.conversations
				.filter((conversation) => conversation.project === projectPath)
				.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			const conversation = recent ?? this.createConversation(projectPath);
			await this.cron.loadProject(projectPath);
			await this.activate(conversation);
			return this.buildSnapshot();
		});
	}

	setProjectTrust(input: { project: string; decision: ProjectTrustDecision }): Promise<Snapshot> {
		return this.serialize(async () => {
			if (!isAbsolute(input.project)) throw new Error("项目路径必须为绝对路径。");
			if (input.decision !== "trusted" && input.decision !== "untrusted")
				throw new Error("项目信任决定无效。");
			const project = await realpath(input.project);
			if (!this.store.projects.some((item) => item.path === project)) throw new Error("项目未打开。");
			const runtimes = [...this.runtimes.values()].filter(
				(runtime) => this.trustProjectFor(this.conversation(runtime.conversationId).project) === project,
			);
			for (const runtime of runtimes) {
				if (runtime.busy || runtime.bashBusy || runtime.pendingUI.size)
					throw new Error("请先停止该项目的任务与审批，再更改项目信任。");
			}
			const changed = (this.store.projectTrust?.[project] ?? undefined) !== input.decision;
			if (changed && this.external.activeClaudeInProject(project))
				throw new Error("请先停止该项目的 Claude 外部任务，再更改项目信任。");
			this.store.projectTrust = { ...(this.store.projectTrust ?? {}), [project]: input.decision };
			await this.persist();
			if (input.decision === "trusted") await this.cron.loadProject(project);
			if (changed) {
				for (const conversation of this.store.conversations) {
					if (this.trustProjectFor(conversation.project) === project) this.languages.closeProject(conversation.project);
				}
				// Pi reads project resources once at startup, so an explicit decision
				// only takes effect after the affected runtimes are recreated.
				for (const runtime of runtimes) await this.stopRuntime(runtime);
				const active = this.active();
				if (active && this.trustProjectFor(active.project) === project) {
					this.ensureAgentWatcher(active.project);
					if (await this.projectAvailable(active)) await this.ensureRuntime(active);
				}
				this.cron.onEnabledChanged();
			}
			return this.buildSnapshot();
		});
	}

	private ensureAgentWatcher(project: string): void {
		if (this.closed) return;
		const trusted = this.isProjectTrusted(project);
		const key = `${project}\0${trusted ? "1" : "0"}`;
		if (this.agentWatcher?.key === key) return;
		this.agentWatcher?.stop();
		this.agentWatcher = {
			key,
			stop: this.agents.watchProject(project, trusted, () => {
				void this.refreshControls("agents_changed").catch(() => {});
			}),
		};
	}

	async listAgents(project?: string): Promise<AgentDefinition[]> {
		await this.operation;
		const target = await this.agentProject(project);
		return this.agents.list(target, this.projectTrusted(target));
	}

	saveAgent(input: AgentSaveInput): Promise<AgentDefinition[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			const agents = await this.agents.save(project, input, this.projectTrusted(project));
			await this.refreshAgentListings();
			return agents;
		});
	}

	removeAgent(input: AgentRemoveInput): Promise<AgentDefinition[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			const agents = await this.agents.remove(project, input, this.projectTrusted(project));
			await this.refreshAgentListings();
			return agents;
		});
	}

	private projectTrusted(project: string): boolean {
		return this.isProjectTrusted(project);
	}

	private async agentProject(project?: string): Promise<string> {
		const target = project ? await realpath(project) : this.requireActive().project;
		if (this.store.projects.some((item) => item.path === target)) return target;
		const task = this.store.tasks.find((item) => item.workingDirectory === target);
		if (task && this.store.projects.some((item) => item.path === task.project)) return task.project;
		throw new Error("项目未打开。");
	}

	async listMcpServers(project?: string): Promise<McpServerInfo[]> {
		await this.operation;
		return this.mcp.list(await this.agentProject(project));
	}

	saveMcpServer(input: McpSaveInput): Promise<McpServerInfo[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			this.assertProjectRestartable(project);
			await this.mcp.save(project, input);
			await this.restartProject(project);
			return this.mcp.list(project);
		});
	}

	removeMcpServer(input: McpRemoveInput): Promise<McpServerInfo[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			this.assertProjectRestartable(project);
			await this.mcp.remove(project, input);
			await this.restartProject(project);
			return this.mcp.list(project);
		});
	}

	private discoverStyles(project: string | undefined) {
		return discoverOutputStyles({
			home: this.options.env?.HOME ?? homedir(),
			project: project ? this.trustProjectFor(project) : undefined,
			trusted: project ? this.isProjectTrusted(project) : false,
		});
	}

	/** Built-in plus custom output styles visible to the active project. */
	async outputStyles(): Promise<OutputStyleInfo[]> {
		const styles = await this.discoverStyles(this.active()?.project);
		return styles.map(({ name, description, source }) => ({ name, description, source }));
	}

	/** Writes the resolved style prompt (empty for default or a missing style) for a main conversation. */
	private async writeOutputStyle(runtime: SessionRuntime): Promise<void> {
		if (!runtime.outputStyleFile) return;
		const name = this.store.settings.outputStyle;
		const project = this.store.conversations.find((item) => item.id === runtime.conversationId)?.project;
		const style = name ? findOutputStyle(await this.discoverStyles(project), name) : undefined;
		const temporary = `${runtime.outputStyleFile}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(temporary, outputStylePromptSection(style), { mode: 0o600 });
		await rename(temporary, runtime.outputStyleFile);
	}

	editorSetting(): EditorChoice | undefined {
		return this.store.settings.editor;
	}

	/** Absolute directories whose files may be opened in an external editor. */
	async editorRoots(): Promise<string[]> {
		const worktrees = await this.worktrees.list().catch(() => []);
		return [...new Set([
			...this.store.projects.map((project) => project.path),
			...this.store.conversations.map((conversation) => conversation.project),
			...worktrees.map((tree) => tree.path),
		])];
	}

	private isProjectTrusted(project: string): boolean {
		return this.store.projectTrust?.[this.trustProjectFor(project)] === "trusted";
	}

	/**
	 * Pi only discovers skills and prompt templates under `.pi` and `.agents`.
	 * Pass Claude Code's `.claude/skills` (SKILL.md) and `.claude/commands`
	 * (Markdown with `$ARGUMENTS`) explicitly so the resources listed in
	 * `/skills` are also callable in the conversation. Project directories are
	 * only loaded after an explicit trust decision.
	 */
	private async claudeResourceArgs(project: string, trusted: boolean): Promise<string[]> {
		const home = this.options.env?.HOME ?? homedir();
		const roots = [join(home, ".claude"), ...(trusted ? [join(project, ".claude")] : [])];
		const isDirectory = (path: string) => stat(path).then((info) => info.isDirectory(), () => false);
		const args: string[] = [];
		for (const root of roots) {
			const skills = join(root, "skills");
			if (await isDirectory(skills)) args.push("--skill", skills);
			const commands = join(root, "commands");
			if (!(await isDirectory(commands))) continue;
			args.push("--prompt-template", commands);
			// Pi scans template directories non-recursively; Claude namespaces
			// commands by one level of subdirectory.
			const entries = await readdir(commands, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith(".")) args.push("--prompt-template", join(commands, entry.name));
			}
		}
		args.push(...(await this.bundledSkillArgs()));
		return args;
	}

	private bundledSkillsReady?: Promise<string[]>;

	/**
	 * Bundled skills are written under the data directory and passed last, so a
	 * user or project skill with the same name loads first and wins.
	 */
	private bundledSkillArgs(): Promise<string[]> {
		this.bundledSkillsReady ??= (async () => {
			const root = join(this.options.dataDir, "bundled-skills");
			const args: string[] = [];
			for (const skill of BUNDLED_SKILLS) {
				if (skill.name === "batch") continue;
				const dir = join(root, skill.name);
				await mkdir(dir, { recursive: true, mode: 0o700 });
				const file = join(dir, "SKILL.md");
				const content = bundledSkillFile(skill);
				const current = await readFile(file, "utf8").catch(() => "");
				if (current !== content) await writeFile(file, content, { mode: 0o600 });
				args.push("--skill", file);
			}
			return args;
		})().catch((error) => {
			this.bundledSkillsReady = undefined;
			this.engineError = `无法写入内置 Skills：${error instanceof Error ? error.message : String(error)}`;
			return [];
		});
		return this.bundledSkillsReady;
	}

	private isReadRestricted(conversationId?: string): boolean {
		const id = conversationId ?? this.store.activeId;
		const mode = id ? this.permissionPolicy(id).mode : this.store.settings.permission;
		return mode === "read" || mode === "plan";
	}

	private assertWritableMode(actionLabel: string, conversationId?: string): void {
		const id = conversationId ?? this.store.activeId;
		const mode = id ? this.permissionPolicy(id).mode : this.store.settings.permission;
		if (mode === "read") throw new Error(`只读模式下不可${actionLabel}。`);
		if (mode === "plan") throw new Error(`Plan 模式下不可${actionLabel}。`);
	}

	async listHooks(project?: string): Promise<HookEntry[]> {
		await this.operation;
		const resolved = project || this.active() ? await this.agentProject(project) : undefined;
		return this.hooks.list(resolved, true);
	}

	saveHook(input: HookSaveInput): Promise<HookEntry[]> {
		return this.serialize(async () => {
			const project = input.scope === "project" || input.project ? await this.agentProject(input.project) : undefined;
			return this.hooks.save({ ...input, project });
		});
	}

	removeHook(input: HookRemoveInput): Promise<HookEntry[]> {
		return this.serialize(async () => {
			const project = input.scope === "project" || input.project ? await this.agentProject(input.project) : undefined;
			return this.hooks.remove({ ...input, project });
		});
	}

	async testHook(input: HookTestInput): Promise<HookRunResult> {
		await this.operation;
		const project = input.project || this.active() ? await this.agentProject(input.project) : undefined;
		const trusted = project ? this.isProjectTrusted(project) : false;
		const agentDef = input.agentType && project ? await this.agents.resolve(project, input.agentType, trusted).catch(() => undefined) : undefined;
		return this.hooks.run(input.event, {
			project,
			projectTrusted: trusted,
			conversationId: this.active()?.id,
			toolName: input.toolName,
			toolInput: input.toolInput,
			prompt: input.prompt,
			error: input.error,
			agentType: input.agentType,
			trigger: input.trigger,
			notificationType: input.notificationType,
			extraHooks: agentDef?.hooks,
			env: this.options.env,
		});
	}

	private async hookContextFor(conversationId: string): Promise<{
		agentId?: string;
		agentType?: string;
		parentConversationId?: string;
		project?: string;
		extraHooks?: HookEntry[];
	}> {
		const task = this.store.tasks.find((item) => item.conversationId === conversationId && item.parentConversationId);
		if (!task) return {};
		const def = task.subagentType
			? await this.agents.resolve(task.project, task.subagentType, this.isProjectTrusted(task.project)).catch(() => undefined)
			: undefined;
		return {
			agentId: task.id,
			agentType: task.subagentType,
			parentConversationId: task.parentConversationId,
			project: task.project,
			extraHooks: def?.hooks,
		};
	}

	private async runStopOrSubagentStopHook(params: {
		conversationId: string;
		meta: {
			agentId?: string;
			agentType?: string;
			parentConversationId?: string;
			project?: string;
			extraHooks?: HookEntry[];
		};
		stopHookActive?: boolean;
		lastAssistantMessage?: string;
	}) {
		const { conversationId, meta, stopHookActive, lastAssistantMessage } = params;
		if (meta.agentId) {
			const project = meta.project ?? this.trustProjectFor(this.conversation(conversationId).project);
			// Claude Code converts subagent frontmatter Stop hooks to SubagentStop events.
			const extraHooks = meta.extraHooks?.map((entry) =>
				entry.event === "Stop" ? { ...entry, event: "SubagentStop" as const } : entry,
			);
			const conv = this.store.conversations.find((item) => item.id === conversationId);
			const sessionDir = join(this.options.dataDir, "sessions");
			const transcriptPath =
				conv?.sessionFile ??
				this.runtimes.get(conversationId)?.state?.sessionFile ??
				(await findSessionFileById(sessionDir, conversationId).catch(() => undefined)) ??
				join(sessionDir, conversationId);
			return this.hooks.run("SubagentStop", {
				project,
				projectTrusted: this.isProjectTrusted(project),
				conversationId: meta.parentConversationId ?? conversationId,
				permissionMode: this.hookPermissionMode(conversationId),
				agentId: meta.agentId,
				agentType: meta.agentType,
				transcriptPath,
				stopHookActive,
				lastAssistantMessage,
				extraHooks,
				env: this.options.env,
			});
		}
		const conv = this.conversation(conversationId);
		return this.hooks.run("Stop", {
			project: this.trustProjectFor(conv.project),
			projectTrusted: this.isProjectTrusted(conv.project),
			conversationId: conv.id,
			permissionMode: this.hookPermissionMode(conv.id),
			stopHookActive,
			lastAssistantMessage,
			extraHooks: meta.extraHooks,
			env: this.options.env,
		});
	}

	/** The routed model for a built-in child role, only when the parent conversation can reach it. */
	private async routedModel(parentConversationId: string, role: ModelRoutingRole): Promise<{ provider: string; id: string } | undefined> {
		const configured = this.store.settings.modelRouting?.[role];
		if (!configured) return undefined;
		const runtime = await this.ensureRuntime(this.conversation(parentConversationId));
		return runtime.models.some((m) => m.provider === configured.provider && m.id === configured.id) ? { ...configured } : undefined;
	}

	/** `strict` (an explicit Agent `model`) returns undefined instead of the parent's model when nothing matches. */
	private async resolveAgentModelAlias(
		parentConversationId: string,
		alias: AgentModelAlias,
		strict = false,
	): Promise<{ provider: string; id: string } | undefined> {
		const runtime = await this.ensureRuntime(this.conversation(parentConversationId));
		const current = runtime.state?.model
			? { provider: runtime.state.model.provider, id: runtime.state.model.id }
			: undefined;
		if (alias === "inherit") return current;
		const family = alias.toLowerCase();
		const sameProvider = current
			? runtime.models.find(
					(m) => m.provider === current.provider && (m.id.toLowerCase().includes(family) || m.name.toLowerCase().includes(family)),
				)
			: undefined;
		const anyProvider = runtime.models.find(
			(m) => m.id.toLowerCase().includes(family) || m.name.toLowerCase().includes(family),
		);
		const picked = sameProvider ?? anyProvider;
		return picked ? { provider: picked.provider, id: picked.id } : strict ? undefined : current;
	}

	private async prepareCustomAgentContext(project: string, definition: AgentDefinition): Promise<string | undefined> {
		const sections: string[] = [];
		const trusted = this.isProjectTrusted(project);
		if (definition.skills?.length) {
			if (definition.skills.length > MAX_AGENT_SKILLS) {
				throw new Error(`Agent ${definition.name} 引用的 Skills 超过上限 (${MAX_AGENT_SKILLS})。`);
			}
			const available = await this.skills.list(project, trusted);
			let skillBytes = 0;
			const matched: string[] = [];
			for (const reqName of definition.skills) {
				const found = available.find((s) => s.name.toLowerCase() === reqName.toLowerCase());
				if (!found) continue;
				if (found.disableModelInvocation) {
					throw new Error(`Skill /${found.name} 禁止模型自动调用（disable-model-invocation），不能预加载到子 Agent。`);
				}
				if (!found.body.trim()) continue;
				const block = `## Skill /${found.name}\n${found.body.trim()}`;
				const bytes = Buffer.byteLength(block, "utf8");
				if (skillBytes + bytes > 48 * 1024) break;
				skillBytes += bytes;
				matched.push(block);
			}
			if (matched.length) sections.push(`# Preloaded Agent Skills\n\n${matched.join("\n\n")}`);
		}
		if (definition.memory && (definition.memory === "user" || trusted)) {
			const baseDir =
				definition.memory === "user"
					? this.store.settings.agentDir ?? this.defaultAgentDir()
					: project;
			const segments =
				definition.memory === "user"
					? ["agent-memory", definition.name]
					: definition.memory === "project"
						? [".claude", "agent-memory", definition.name]
						: [".claude", "agent-memory-local", definition.name];
			const memoryFile = await managedFile(baseDir, segments, "MEMORY.md", false).catch(() => undefined);
			if (memoryFile) {
				try {
					const raw = await readFile(memoryFile, "utf8");
					if (raw.trim()) {
						sections.push(`# Persistent Agent Memory (${definition.memory})\nFile: ${memoryFile}\n\n${raw.slice(0, 24 * 1024)}`);
					}
				} catch {
					// Memory file is optional until written.
				}
			}
		}
		return sections.length ? sections.join("\n\n") : undefined;
	}

	private buildChildTaskPolicy(
		parentPolicy: RuntimePermissionPolicy,
		disallowedTools: string[] | undefined,
		requestedMode: AgentPermissionMode | undefined,
		readOnly: boolean,
		allowedMcpServers?: string[],
	): RuntimePermissionPolicy {
		const disabled = new Set(parentPolicy.disabledTools);
		for (const tool of disallowedTools ?? []) disabled.add(tool);
		let mode: RuntimePermissionPolicy["mode"] = parentPolicy.mode;
		let dontAsk = parentPolicy.dontAsk;

		if (readOnly || parentPolicy.mode === "read" || requestedMode === "read") {
			mode = "read";
		} else if (parentPolicy.mode === "plan" || requestedMode === "plan") {
			mode = "plan";
		} else if (requestedMode === "acceptEdits") {
			mode = "acceptEdits";
		} else if (requestedMode === "default") {
			mode = "ask";
		} else if (requestedMode === "dontAsk") {
			dontAsk = true;
		} else if (requestedMode === "bypassPermissions" && parentPolicy.mode === "auto") {
			mode = "auto";
		}
		const mergedMcp =
			parentPolicy.allowedMcpServers !== undefined && allowedMcpServers !== undefined
				? parentPolicy.allowedMcpServers.filter((name) => allowedMcpServers.includes(name))
				: (allowedMcpServers ?? parentPolicy.allowedMcpServers);
		return {
			...parentPolicy,
			mode,
			...(dontAsk ? { dontAsk: true } : {}),
			disabledTools: [...disabled],
			...(mergedMcp !== undefined ? { allowedMcpServers: mergedMcp } : {}),
		};
	}

	async listSkills(project?: string): Promise<SkillDefinitionEntry[]> {
		await this.operation;
		const resolved = project || this.active() ? await this.agentProject(project) : undefined;
		return this.skills.list(resolved, resolved ? true : false);
	}

	saveSkill(input: SkillSaveInput): Promise<SkillDefinitionEntry[]> {
		return this.serialize(async () => {
			const project = input.scope === "project" || input.project ? await this.agentProject(input.project) : undefined;
			return this.skills.save({ ...input, project });
		});
	}

	removeSkill(input: SkillRemoveInput): Promise<SkillDefinitionEntry[]> {
		return this.serialize(async () => {
			const project = input.scope === "project" || input.project ? await this.agentProject(input.project) : undefined;
			return this.skills.remove({ ...input, project });
		});
	}

	async contextReport(conversationId?: string): Promise<ContextBreakdown> {
		await this.operation;
		const conv = this.conversation(conversationId);
		const runtime = this.runtimes.get(conv.id);
		const snapshot = await this.buildSnapshot(conv.id);
		const context = runtime?.controls && runtime.engineStatus === "ready"
			? await this.controlCall(runtime, { operation: "context" }).catch(() => undefined)
			: undefined;
		const tools = Array.isArray(context?.tools) ? context.tools as DesktopToolInfo[] : [];
		const compaction = context?.compaction as { provider?: unknown; model?: unknown; reserveTokens?: unknown } | undefined;
		const model = snapshot.state?.model;
		const reserve = compaction && model && compaction.provider === model.provider && compaction.model === model.id
			? compaction.reserveTokens : undefined;
		const autoRetryEnabled = await this.readAutoRetrySetting(conv.project);
		return buildContextReport({
			project: conv.project,
			privateMemory: this.privateMemoryPath(this.trustProjectFor(conv.project)),
			agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(),
			home: this.options.env?.HOME,
			projectTrusted: this.projectTrusted(this.trustProjectFor(conv.project)),
			stats: snapshot.stats,
			state: snapshot.state ? ({ ...snapshot.state, autoRetryEnabled } as typeof snapshot.state) : snapshot.state,
			compactionReserveTokens: typeof reserve === "number" && Number.isSafeInteger(reserve) && reserve >= 0 ? reserve : undefined,
			tools,
			messages: snapshot.messages,
		});
	}

	/** Mirror Pi's SettingsManager: project `.pi/settings.json` (trusted) overrides the agent directory. */
	private async readAutoRetrySetting(project: string): Promise<boolean> {
		const agentDir = this.store.settings.agentDir ?? this.defaultAgentDir();
		const files = this.autoRetryGlobal?.agentDir === agentDir ? [] : [join(agentDir, "settings.json")];
		let enabled = this.autoRetryGlobal?.agentDir === agentDir ? this.autoRetryGlobal.enabled : true;
		if (this.isProjectTrusted(project)) files.push(join(project, ".pi", "settings.json"));
		for (const file of files) {
			try {
				const parsed = JSON.parse(await readFile(file, "utf8")) as { retry?: { enabled?: unknown } };
				if (typeof parsed?.retry?.enabled === "boolean") enabled = parsed.retry.enabled;
			} catch { /* Absent or invalid settings keep Pi's default. */ }
		}
		return enabled;
	}

	private privateMemoryPath(project: string): string {
		return join(this.options.dataDir, "project-memory", memoryName(project));
	}

	async writeMemoryFile(relativePath: string, content: string, conversationId?: string): Promise<ContextMemorySource> {
		await this.operation;
		this.assertWritableMode("修改项目记忆或规则文件", conversationId);
		const conv = this.conversation(conversationId);
		if (relativePath === privateMemoryLabel) {
			if (Buffer.byteLength(content) > memoryLimit) throw new Error("本机项目记忆最多 24 KiB。");
			const project = this.trustProjectFor(conv.project);
			const file = (await managedFile(this.options.dataDir, ["project-memory"], memoryName(project), true))!;
			await writeManagedFile(file, content);
			return (await this.contextReport(conv.id)).sources.find((source) => source.id === privateMemoryLabel)!;
		}
		return writeProjectMemoryFile(conv.project, relativePath, content);
	}

	async deleteMemoryRule(relativePath: string, conversationId?: string): Promise<ContextBreakdown> {
		await this.operation;
		this.assertWritableMode("删除规则文件", conversationId);
		const conv = this.conversation(conversationId);
		await deleteProjectMemoryRule(conv.project, relativePath);
		return this.contextReport(conv.id);
	}

	async readPlan(conversationId?: string): Promise<PlanFileState> {
		await this.operation;
		const conv = this.conversation(conversationId);
		const relativePath = planRelativePath(conv.id);
		const fullPath = resolve(conv.project, relativePath);
		if (!inside(conv.project, fullPath)) throw new Error("计划文件路径超出项目目录。");
		try {
			const real = await realpath(fullPath);
			if (!inside(conv.project, real)) throw new Error("计划文件路径超出项目目录。");
			const content = await readFile(real, "utf8");
			return { path: real, relativePath, content, exists: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { path: fullPath, relativePath, content: "", exists: false };
			}
			throw error;
		}
	}

	async writePlan(content: string, conversationId?: string): Promise<PlanFileState> {
		await this.operation;
		const conv = this.conversation(conversationId);
		if (this.permissionPolicy(conv.id).mode === "read") throw new Error("只读模式下不可写入计划文件。");
		const relativePath = planRelativePath(conv.id);
		const fullPath = (await managedFile(conv.project, [".pi", "plans"], `${conv.id}.md`, true))!;
		await writeManagedFile(fullPath, content);
		return { path: fullPath, relativePath, content, exists: true };
	}

	/** Forwards a content-free failure summary to the main-process log; never throws. */
	private diagnostic(level: "warn" | "error", event: string, conversationId: string, message: string): void {
		try {
			this.options.onDiagnostic?.(level, event, { conversation: conversationId, error: summarizeEngineError(message) });
		} catch {
			/* logging is best effort */
		}
	}

	/**
	 * Token usage and cost by local day and model (/stats). Reads only the session
	 * files of known conversations, delegated child sessions included, inside the
	 * app's own session directory. Read-only; does not wait for other operations.
	 */
	async usageStats(input: { days?: number } = {}): Promise<UsageStatsReport> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const sessionDir = join(this.options.dataDir, "sessions");
		const canonicalDir = await realpath(sessionDir).catch(() => undefined);
		if (!canonicalDir) return this.usage.collect([], input, this.external.usageRecords());
		const byId = new Map<string, string>();
		const names = await readdir(canonicalDir, { withFileTypes: true }).catch(() => []);
		for (const entry of names) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const match = /_([^_]+)\.jsonl$/.exec(entry.name);
			if (match) byId.set(match[1], join(canonicalDir, entry.name));
		}
		const candidates = new Set<string>();
		for (const conversation of this.store.conversations) {
			const path =
				conversation.sessionFile ?? this.runtimes.get(conversation.id)?.state?.sessionFile ?? byId.get(conversation.id);
			if (path) candidates.add(path);
		}
		const files: string[] = [];
		for (const path of candidates) {
			const absolute = resolve(path);
			if (!inside(sessionDir, absolute) && !inside(canonicalDir, absolute)) continue;
			const actual = await realpath(absolute).catch(() => undefined);
			if (actual && inside(canonicalDir, actual) && actual.endsWith(".jsonl")) files.push(actual);
		}
		return this.usage.collect(files, input, this.external.usageRecords());
	}

	/** Local environment checks for /doctor. Reads only local state; no network or model requests. */
	async doctor(): Promise<DoctorReport> {
		const env = { ...process.env, ...this.options.env };
		const settings = this.store.settings;
		const check = async (id: string, label: string, run: () => Promise<Omit<DoctorCheck, "id" | "label">>): Promise<DoctorCheck> => {
			let timer: NodeJS.Timeout | undefined;
			try {
				const result = await Promise.race([
					run(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("检查超时。")), DOCTOR_CHECK_TIMEOUT_MS);
					}),
				]);
				return { id, label, ...result, detail: tildify(result.detail) };
			} catch (error) {
				return { id, label, status: "error", detail: tildify(error instanceof Error ? error.message : String(error)).slice(0, 300) };
			} finally {
				clearTimeout(timer);
			}
		};
		const toolVersion = async (command: string, args: string[]) => {
			const { stdout } = await exec(command, args, { env, timeout: 2000, maxBuffer: 64 * 1024 });
			return stdout.trim().split("\n", 1)[0] ?? "";
		};
		const active = this.active();
		const projectPath = active ? this.trustProjectFor(active.project) : undefined;
		const checks = await Promise.all([
			check("runtime", "Pi 运行时", async () => {
				const runtimeDir = this.options.runtimeDir ?? (this.options.entry ? dirname(dirname(dirname(this.options.entry))) : undefined);
				const version = runtimeDir
					? await readFile(join(runtimeDir, "package.json"), "utf8").then((text) => String((JSON.parse(text) as { version?: unknown }).version ?? ""), () => "")
					: "";
				const host = [
					process.versions.electron ? `Electron ${process.versions.electron}` : undefined,
					`Node ${process.versions.node}`,
					`${process.platform}-${process.arch}`,
				].filter(Boolean).join(" · ");
				return version
					? { status: "ok", detail: `Pi ${version} · ${host}` }
					: { status: "warn", detail: `无法读取 Pi 运行时版本 · ${host}` };
			}),
			check("data-dir", "数据目录可写", async () => {
				const probe = join(this.options.dataDir, `.doctor-${randomBytes(6).toString("hex")}`);
				await writeFile(probe, "ok", { mode: 0o600 });
				await rm(probe, { force: true });
				return { status: "ok", detail: this.options.dataDir };
			}),
			check("model", "模型连接", async () => {
				const runtime = active ? this.runtimes.get(active.id) : undefined;
				const model = runtime?.state?.model ?? settings.defaultModel;
				if (!model?.provider || !model.id) return { status: "warn", detail: "尚未选择模型，请在设置中配置模型连接。" };
				const name = `${model.provider}/${model.id}`;
				const provider = model.provider.startsWith("desktop-") ? (model.provider.slice(8) as Provider) : undefined;
				if (!provider || !providers.includes(provider)) return { status: "ok", detail: `${name}（由 Pi 配置提供）` };
				if (!settings.connections[provider]) return { status: "error", detail: `${name}：桌面端没有此服务商的连接配置。` };
				if (this.store.keys[provider]) return { status: "ok", detail: `${name} · 已保存 API Key` };
				if (settings.connections[provider]?.keyCommand) return { status: "ok", detail: `${name} · 使用取 Key 命令` };
				return { status: "error", detail: `${name}：未保存 API Key 或取 Key 命令。` };
			}),
			check("network", "代理与证书", async () => {
				const proxy = settings.proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
				const noProxy = settings.noProxy || env.NO_PROXY || env.no_proxy;
				const caFile = settings.caFile || env.NODE_EXTRA_CA_CERTS;
				const parts = [
					proxy ? `代理 ${proxyLabel(proxy)}${settings.proxy ? "" : "（来自 shell）"}` : "未使用代理",
					noProxy ? `NO_PROXY ${noProxy.slice(0, 200)}` : undefined,
				];
				if (caFile) {
					const readable = await access(caFile, fsConstants.R_OK).then(() => true, () => false);
					parts.push(`CA 证书 ${caFile}${readable ? "" : "（无法读取）"}`);
					if (!readable) return { status: "error", detail: parts.filter(Boolean).join(" · ") };
				}
				return { status: "ok", detail: parts.filter(Boolean).join(" · ") };
			}),
			check("sandbox", "macOS 命令沙箱", async () => {
				const status = await this.sandboxStatus();
				if (status.supported) return { status: "ok", detail: status.enabled ? "已开启，环境支持 Seatbelt。" : "环境支持 Seatbelt，当前未开启。" };
				return { status: status.enabled ? "error" : "warn", detail: `不可用：${status.reason ?? "未知原因"}` };
			}),
			check("git", "Git", async () => {
				const version = await toolVersion("git", ["--version"]).catch(() => "");
				return version ? { status: "ok", detail: version } : { status: "warn", detail: "未找到 git，检查点和 Worktree 不可用。" };
			}),
			check("gh", "GitHub CLI", async () => {
				const version = await toolVersion("gh", ["--version"]).catch(() => "");
				return version ? { status: "ok", detail: version } : { status: "warn", detail: "未找到 gh，PR 相关功能不可用。" };
			}),
			check("project", "当前项目", async () => {
				if (!active || !projectPath) return { status: "warn", detail: "尚未打开项目。" };
				const exists = await stat(active.project).then((info) => info.isDirectory(), () => false);
				if (!exists) return { status: "error", detail: `${active.project} 不存在或不是文件夹。` };
				const trusted = this.isProjectTrusted(active.project);
				return trusted
					? { status: "ok", detail: `${projectPath} · 已信任` }
					: { status: "warn", detail: `${projectPath} · 未信任，项目级 Hooks、MCP 和配置不会加载。` };
			}),
			check("hooks", "Hooks", async () => {
				const trusted = active ? this.isProjectTrusted(active.project) : false;
				const hooks = await this.hooks.list(projectPath, trusted);
				if (settings.disableAllHooks) return { status: "warn", detail: `共 ${hooks.length} 个，已停用全部 Hooks。` };
				return { status: "ok", detail: hooks.length ? `共 ${hooks.length} 个，均已启用。` : "未配置 Hooks。" };
			}),
			check("mcp", "MCP 服务", async () => {
				if (!projectPath) return { status: "ok", detail: "未打开项目，未统计 MCP 服务。" };
				const servers = await this.mcp.list(projectPath);
				const enabled = servers.filter((server) => server.enabled).length;
				return { status: "ok", detail: `共 ${servers.length} 个，启用 ${enabled} 个。` };
			}),
			check("logs", "本地日志", async () => ({
				status: "ok",
				detail: this.options.logDir ? `${this.options.logDir}（仅保存在本机，不会上传）` : "未启用本地日志。",
			})),
		]);
		return { generatedAt: Date.now(), checks };
	}

	async sandboxStatus(): Promise<SandboxStatus> {
		const probe = await probeSeatbeltSupport();
		return { enabled: Boolean(this.store.settings.sandbox), supported: probe.supported, reason: probe.reason };
	}

	importClaudePermissions(conversationId?: string): Promise<ClaudePermissionsSyncResult> {
		return this.serialize(async () => {
			const conv = this.conversation(conversationId);
			const project = await realpath(conv.project);
			const { rules: parsed, skipped } = await readClaudeProjectPermissionsDetailed(project);
			for (const rule of parsed) await this.toolSettings.upsert(rule);
			await this.refreshControls("permissions_changed");
			return { path: join(project, ".claude", "settings.json"), imported: parsed.length, skipped };
		});
	}

	async exportClaudePermissions(conversationId?: string): Promise<ClaudePermissionsSyncResult> {
		await this.operation;
		const conv = this.conversation(conversationId);
		const project = await realpath(conv.project);
		const rules = this.toolSettings.rules();
		const res = await writeClaudeProjectPermissions(project, rules);
		return { path: res.path, exported: res.count };
	}

	private assertProjectRestartable(project: string): void {
		for (const runtime of this.runtimes.values()) {
			if (this.conversation(runtime.conversationId).project !== project) continue;
			if (runtime.busy || runtime.bashBusy || runtime.pendingUI.size)
				throw new Error("请先停止该项目的任务与审批，再更改 MCP 配置。");
		}
	}

	private async restartProject(project: string): Promise<void> {
		const runtimes = [...this.runtimes.values()].filter(
			(runtime) => this.conversation(runtime.conversationId).project === project,
		);
		for (const runtime of runtimes) await this.stopRuntime(runtime);
		const active = this.active();
		if (active?.project === project && (await this.projectAvailable(active))) await this.ensureRuntime(active);
	}

	newConversation(): Promise<Snapshot> {
		return this.serialize(async () => {
			const active = this.requireActive();
			await this.activate(this.createConversation(active.project));
			return this.buildSnapshot();
		});
	}

	selectConversation(id: string): Promise<Snapshot> {
		return this.serialize(async () => {
			const conversation = this.store.conversations.find((item) => item.id === id);
			if (!conversation) throw new Error("会话不存在。");
			await this.activate(conversation);
			return this.buildSnapshot();
		});
	}

	async renameConversation(id: string, title: string): Promise<Snapshot> {
		await this.operation;
		const conversation = this.store.conversations.find((item) => item.id === id);
		if (!conversation) throw new Error("会话不存在。");
		conversation.title = title.trim().slice(0, 160) || "新会话";
		const agent = this.runtimes.get(id)?.agent;
		if (agent) await agent.request({ type: "set_session_name", name: conversation.title });
		const runtime = this.runtimes.get(id);
		if (runtime) await this.saveSessionLeaf(runtime);
		await this.persist();
		return this.buildSnapshot();
	}

	/** Updates conversation sidebar organization metadata (pin, archive, custom group). */
	updateConversationMeta(id: string, patch: ConversationMetaPatch): Promise<Snapshot> {
		return this.serialize(async () => {
			const conversation = this.conversation(id);
			if (patch.pinned !== undefined) conversation.pinned = patch.pinned ? true : undefined;
			if (patch.archived !== undefined) conversation.archived = patch.archived ? true : undefined;
			if (patch.group !== undefined) {
				const cleaned = patch.group === null ? "" : patch.group.trim().slice(0, 60);
				conversation.group = cleaned || undefined;
			}
			await this.persist();
			return this.buildSnapshot();
		});
	}

	/** Attaches an extra directory to a conversation, granting read/write permission and syncing Seatbelt sandbox rules. */
	addDir(conversationId: string, rawPath: string): Promise<{ snapshot: Snapshot; added: string }> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			const trimmed = rawPath.trim();
			if (!trimmed) throw new Error("请提供要附加的目录路径，例如 /add-dir ../shared-lib。");
			const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
			const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(conversation.project, expanded);
			let info;
			try {
				info = await stat(resolved);
			} catch {
				throw new Error(`目录不存在：${resolved}`);
			}
			if (!info.isDirectory()) throw new Error(`路径不是目录：${resolved}`);
			const canonical = await realpath(resolved);
			const existing = conversation.additionalDirs ?? [];
			if (!existing.includes(canonical)) {
				conversation.additionalDirs = [...existing, canonical];
			}
			await this.persist();
			const runtime = this.runtimes.get(conversation.id);
			if (runtime) await this.writeRuntimeControls(runtime);
			return { snapshot: await this.buildSnapshot(), added: canonical };
		});
	}

	/** Removes an attached directory from a conversation and syncs permission & Seatbelt sandbox rules. */
	removeDir(conversationId: string, rawPath: string): Promise<Snapshot> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			const trimmed = rawPath.trim();
			const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
			const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(conversation.project, expanded);
			const canonical = await realpath(resolved).catch(() => resolved);
			const current = conversation.additionalDirs ?? [];
			const next = current.filter((item) => item !== trimmed && item !== resolved && item !== canonical);
			conversation.additionalDirs = next.length > 0 ? next : undefined;
			await this.persist();
			const runtime = this.runtimes.get(conversation.id);
			if (runtime) await this.writeRuntimeControls(runtime);
			return this.buildSnapshot();
		});
	}

	/** Starts /goal autonomous continuation mode for a conversation. */
	async startGoal(
		conversationId: string,
		input: { objective: string; maxTurns?: number; maxCostUsd?: number },
	): Promise<Snapshot> {
		const { goal, snapshot } = await this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			const objective = input.objective.trim().slice(0, 4000);
			if (!objective) throw new Error("目标描述不能为空。");
			const maxTurns = input.maxTurns ?? DEFAULT_GOAL_MAX_TURNS;
			if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_GOAL_TURNS) {
				throw new Error(`目标轮数上限需为 1–${MAX_GOAL_TURNS} 的整数。`);
			}
			const maxCostUsd = input.maxCostUsd ?? this.store.settings.maxCostUsd;
			if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01)) {
				throw new Error("目标费用上限无效。");
			}
			const runtime = await this.ensureRuntime(conversation);
			this.assertRuntimeIdle(runtime);
			if (runtime.settling) throw new Error("本轮任务正在结算，请稍候再启动目标。");
			let baselineCostUsd: number | undefined;
			if (maxCostUsd !== undefined) {
				const stats = await this.requireAgent(runtime).request<SessionStats>({ type: "get_session_stats" });
				if (!Number.isFinite(stats.cost)) throw new Error("无法读取会话费用，目标模式尚未启动。");
				baselineCostUsd = finiteCount(stats.cost);
				this.assertRuntimeIdle(runtime);
			}
			const goal: GoalState = {
				objective,
				maxTurns,
				turnsUsed: 0,
				maxCostUsd,
				baselineCostUsd,
				active: true,
				status: "running",
				startedAt: Math.max(Date.now(), (conversation.goal?.startedAt ?? 0) + 1),
			};
			conversation.goal = goal;
			await this.persist();
			return { goal, snapshot: await this.buildSnapshot() };
		});
		// Kick off the first turn outside the serialize lock so normal prompt streaming runs cleanly.
		try {
			const current = this.conversation(conversationId).goal;
			if (current?.active && current.startedAt === goal.startedAt)
				await this.command({ type: "prompt", message: buildGoalInitialPrompt(goal) }, conversationId);
		} catch (error) {
			const conversation = this.conversation(conversationId);
			if (conversation.goal?.startedAt === goal.startedAt && stopActiveGoal(conversation, error instanceof Error ? error.message : String(error)))
				await this.persist();
			throw error;
		}
		return snapshot;
	}

	/** Stops an active /goal loop on a conversation and aborts any running turn. */
	stopGoal(conversationId: string): Promise<Snapshot> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			if (!stopActiveGoal(conversation, "用户已手动停止目标模式。")) return this.buildSnapshot();
			await this.persist();
			const runtime = this.runtimes.get(conversation.id);
			if (runtime?.agent && (runtime.busy || runtime.state?.isStreaming)) {
				await runtime.agent.request({ type: "abort" }).catch(() => {});
			}
			return this.buildSnapshot();
		});
	}

	/**
	 * Removes a conversation from the sidebar and moves its Pi session file to Trash
	 * when no other conversation references that file.
	 * Conversations that tasks or sub-agents still reference are refused, because task
	 * lookups expect their conversation to exist.
	 */
	removeConversation(id: string): Promise<Snapshot> {
		return this.serialize(async () => {
			const conversation = this.conversation(id);
			if (this.store.conversations.some((item) => item.parentConversationId === id))
				throw new Error("此会话还有子 Agent 会话，暂不能移除。");
			if (this.store.tasks.some((task) => task.conversationId === id || task.parentConversationId === id))
				throw new Error("此会话关联了后台任务，暂不能移除。");
			const runtime = this.runtimes.get(id);
			if (runtime) {
				this.assertRuntimeIdle(runtime);
				if (runtime.pendingUI.size) throw new Error("请先处理此会话的审批，再移除。");
			}
			if (this.terminals.list(id).some((terminal) => terminal.status !== "exited"))
				throw new Error("请先关闭此会话的终端，再移除。");
			await this.cancelGrail(id);
			await this.monitors.stopForConversation([id], "user_stop", { includeRoot: true });
			for (const job of this.remoteJobs.list(id)) await this.remoteJobs.untrack(job.id);
			for (const job of await this.cron.list(id, conversation.project)) await this.cron.delete(job.id, id);
			if (runtime) await this.stopRuntime(runtime);
			await this.terminals.closeConversation(id);
			this.viewing.delete(id);
			this.store.conversations = this.store.conversations.filter((item) => item.id !== id);
			const sessionFile = conversation.sessionFile;
			if (sessionFile && !this.store.conversations.some((item) => item.sessionFile === sessionFile)) {
				await this.trashSessionFile(sessionFile).catch((error) => {
					this.diagnostic("warn", "session.trash.failed", id, error instanceof Error ? error.message : String(error));
				});
			}
			try { await this.trashSessionFile(this.grailFile(id)); }
			catch (error) {
				this.diagnostic("warn", "grail.trash.failed", id, error instanceof Error ? error.message : String(error));
			}
			try { await this.trashSessionFile(toolOutputDirectory(join(this.options.dataDir, "tool-output"), id)); }
			catch (error) {
				this.diagnostic("warn", "output.trash.failed", id, error instanceof Error ? error.message : String(error));
			}
			if (this.store.activeId === id) {
				const next =
					this.store.conversations.find((item) => item.project === conversation.project && !item.parentConversationId && !item.archived) ??
					this.store.conversations.find((item) => item.project === conversation.project && !item.parentConversationId) ??
					this.createConversation(conversation.project);
				await this.activate(next);
			} else {
				await this.persist();
			}
			return this.buildSnapshot();
		});
	}

	private async trashSessionFile(filePath: string): Promise<void> {
		try {
			await stat(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.moveToTrash(filePath);
	}

	private async moveToTrash(filePath: string): Promise<void> {
		if (this.options.trashItem) {
			await this.options.trashItem(filePath);
			return;
		}
		const trashDir = join(this.options.dataDir, "trash");
		await mkdir(trashDir, { recursive: true });
		const target = join(trashDir, `${randomUUID()}-${basename(filePath)}`);
		await rename(filePath, target);
	}

	forkSession(input: SessionForkInput): Promise<SessionCopyResult> {
		return this.serialize(() => this.copySession(input, input.entryId));
	}

	cloneSession(input: SessionCopyInput = {}): Promise<SessionCopyResult> {
		return this.serialize(() => this.copySession(input));
	}

	async sessionEntries(input: SessionEntriesInput = {}): Promise<SessionEntriesResult> {
		await this.operation;
		const conversation = this.conversation(input.conversationId);
		const runtime = this.runtimes.get(conversation.id);
		if (runtime?.agent) return runtime.agent.request({ type: "get_entries", since: input.since });
		if (!conversation.sessionFile) return { entries: [], leafId: null };
		const result = await this.history.inspect({
			sessionFile: conversation.sessionFile,
			leafId: conversation.sessionLeafId,
		});
		if (input.since === undefined) return { entries: result.entries, leafId: result.leafId };
		const index = result.entries.findIndex((entry) => entry.id === input.since);
		if (index < 0) throw new Error("会话条目不存在。");
		return { entries: result.entries.slice(index + 1), leafId: result.leafId };
	}

	async sessionTree(conversationId?: string): Promise<SessionTreeResult> {
		await this.operation;
		const conversation = this.conversation(conversationId);
		const runtime = this.runtimes.get(conversation.id);
		if (runtime?.agent) return runtime.agent.request({ type: "get_tree" });
		if (!conversation.sessionFile) return { tree: [], leafId: null };
		const { tree, leafId } = await this.history.inspect({
			sessionFile: conversation.sessionFile,
			leafId: conversation.sessionLeafId,
		});
		return { tree, leafId };
	}

	async sessionForkMessages(conversationId?: string): Promise<{ messages: { entryId: string; text: string }[] }> {
		await this.operation;
		const conversation = this.conversation(conversationId);
		const runtime = this.runtimes.get(conversation.id);
		if (runtime?.agent) {
			const { messages } = await runtime.agent.request<{ messages: { entryId: string; text: string }[] }>({ type: "get_fork_messages" });
			return { messages: messages.map((message) => ({ ...message, text: visiblePromptText(message.text) })) };
		}
		if (!conversation.sessionFile) return { messages: [] };
		const { forkMessages } = await this.history.inspect({
			sessionFile: conversation.sessionFile,
			leafId: conversation.sessionLeafId,
		});
		return { messages: forkMessages };
	}

	async searchConversations(rawQuery: string): Promise<SessionContentSearchResult> {
		this.searchAbort?.abort();
		this.searchAbort = undefined;
		const needle = rawQuery.trim();
		if (needle.length < 2 || this.closed) return { matches: [], partial: false };
		if (!this.historyAvailable) return { matches: [], partial: true };
		const controller = new AbortController();
		this.searchAbort = controller;
		try {
			// Navigation serializes its cursor update. Do not search a branch halfway through that change.
			await this.operation;
			controller.signal.throwIfAborted();
			const children = new Set(this.store.tasks.filter((task) => task.parentConversationId).map((task) => task.conversationId));
			const candidates = this.store.conversations
				.filter((conv) => conv.kind !== "subagent" && !children.has(conv.id))
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.flatMap((conv) => {
					const runtime = this.runtimes.get(conv.id);
					const live = runtime && !runtime.replacing && !runtime.stopping ? runtime : undefined;
					const sessionFile = live?.state?.sessionFile ?? conv.sessionFile;
					if (!sessionFile) return [];
					const candidate: SessionHistorySearchCandidate = {
						conversationId: conv.id,
						sessionFile,
						leafId: conv.sessionLeafId,
						unmaterialized: sessionFile !== conv.sessionFile,
					};
					return [{ candidate, live }];
				});
			let partial = candidates.length > maximumSearchSessions;
			const cursorSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]);
			const sessions = (await Promise.all(candidates.slice(0, maximumSearchSessions).map(async ({ candidate, live }) => {
				const agent = live?.agent;
				// Without a saved override, the physical tail already follows every live append.
				if (!agent || candidate.leafId === undefined) return candidate;
				try {
					const cursor = await agent.request<SessionEntriesResult>({ type: "get_entries", since: live.historyTailId }, cursorSignal);
					if (this.runtimes.get(candidate.conversationId) !== live || live.agent !== agent || live.replacing || live.stopping)
						throw new Error("会话在搜索期间切换。");
					return { ...candidate, leafId: cursor.leafId };
				} catch (error) {
					if (controller.signal.aborted) throw error;
					partial = true;
				}
			}))).filter((candidate) => candidate !== undefined);
			const result = await this.history.searchSessions({ query: needle, sessions }, controller.signal);
			controller.signal.throwIfAborted();
			return { matches: result.matches, partial: partial || result.partial };
		} catch {
			return { matches: [], partial: !controller.signal.aborted };
		} finally {
			if (this.searchAbort === controller) this.searchAbort = undefined;
		}
	}

	navigateSession(input: SessionNavigateInput): Promise<SessionNavigateResult> {
		return this.serialize(async () => {
			const conversation = this.conversation(input.conversationId);
			const runtime = await this.sessionMutationRuntime(conversation);
			await this.saveSessionLeaf(runtime);
			let result: SessionNavigationBridgeResponse;
			try {
				result = await this.navigationRequest(runtime, {
					requestId: randomUUID(),
					operation: "navigate",
					targetId: input.targetId,
					label: input.label,
				});
				if (!result.ok) throw new Error(result.error.message);
			} catch (error) {
				await this.stopRuntime(runtime, "preserve");
				await this.persist();
				throw error;
			}
			if (!result.cancelled) {
				await this.saveSessionLeaf(runtime);
				conversation.updatedAt = Date.now();
				await this.syncState(runtime);
				await this.persist();
			}
			return {
				cancelled: result.cancelled,
				leafId: result.leafId,
				editorText: result.operation === "navigate" ? result.editorText : undefined,
				editorDraft: result.operation === "navigate" ? result.editorDraft : undefined,
				snapshot: await this.buildSnapshot(conversation.id),
			};
		});
	}

	async discoverSessionHistory(input: SessionHistoryInput = {}) {
		await this.operation;
		return this.history.discover({ ...input, agentDir: this.store.settings.agentDir ?? this.defaultAgentDir() });
	}

	importSessionHistory(input: SessionHistoryImportInput): Promise<SessionHistoryImportResult> {
		return this.serialize(async () => {
			const imported = await this.history.importSession({ token: input.token });
			let conversation = this.store.conversations.find((item) => item.id === imported.conversationId);
			if (!conversation) {
				conversation = {
					id: imported.conversationId,
					title: imported.title,
					project: imported.project,
					sessionFile: imported.sessionFile,
					origin: "cli",
					sourceSessionId: imported.sourceSessionId,
					updatedAt: Date.now(),
				};
				this.store.conversations.unshift(conversation);
				if (!this.store.projects.some((project) => project.path === conversation!.project))
					this.store.projects.push({ path: conversation.project, name: basename(conversation.project) });
			}
			if (input.activate !== false) await this.activate(conversation);
			await this.persist();
			return {
				...imported,
				conversation: structuredClone(conversation),
				snapshot: await this.buildSnapshot(conversation.id),
			};
		});
	}

	private async sessionMutationRuntime(conversation: Conversation): Promise<SessionRuntime> {
		const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
		if (task && ["queued", "running", "waiting_for_input"].includes(task.status))
			throw new Error("请先停止此会话的后台任务。");
		const runtime = await this.ensureRuntime(conversation);
		await runtime.settling;
		this.assertRuntimeIdle(runtime);
		if (runtime.pendingUI.size || runtime.state?.pendingMessageCount)
			throw new Error("请先处理此会话的确认和排队消息。");
		this.requireAgent(runtime);
		return runtime;
	}

	private async copySession(input: SessionCopyInput, entryId?: string): Promise<SessionCopyResult> {
		const parent = this.conversation(input.conversationId);
		const runtime = await this.sessionMutationRuntime(parent);
		const agent = this.requireAgent(runtime);
		const parentFile = parent.sessionFile;
		await this.saveSessionLeaf(runtime);
		const title = input.title?.trim().slice(0, 160) || `${parent.title} · ${entryId === undefined ? "克隆" : "分支"}`;
		runtime.replacing = true;
		try {
			const result = await agent.request<{ cancelled: boolean; text?: string }>(
				entryId === undefined ? { type: "clone" } : { type: "fork", entryId },
			);
			if (parentFile && this.historyAvailable) {
				const inspection = await this.history.inspect({ sessionFile: parentFile, leafId: parent.sessionLeafId });
				const info = inspection.entries.findLast((entry) => entry.type === "session_info");
				if (info?.type === "session_info") parent.title = info.name?.trim() || "新会话";
			}
			if (result.cancelled) {
				runtime.replacing = false;
				await this.saveSessionLeaf(runtime);
				await this.persist();
				return { cancelled: true, snapshot: await this.buildSnapshot(parent.id) };
			}
			const state = await agent.request<RpcSessionState>({ type: "get_state" });
			if (
				!state.sessionFile ||
				state.sessionId === parent.id ||
				this.store.conversations.some((item) => item.id === state.sessionId)
			)
				throw new Error("Pi 未创建独立会话。");
			const actual = await realpath(state.sessionFile);
			if (!inside(await realpath(join(this.options.dataDir, "sessions")), actual))
				throw new Error("新会话文件超出应用目录。");
			const child: Conversation = {
				id: state.sessionId,
				sessionFile: actual,
				title,
				project: parent.project,
				updatedAt: Date.now(),
				parentConversationId: parent.id,
				forkEntryId: entryId,
				origin: entryId === undefined ? "clone" : "fork",
			};
			this.store.conversations.unshift(child);
			this.runtimes.delete(parent.id);
			runtime.conversationId = child.id;
			this.runtimes.set(child.id, runtime);
			runtime.state = safeState(state);
			runtime.replacing = false;
			// Replacement events carry no session ID. Rebuild state instead of assigning parent hooks to the child.
			runtime.busy = state.isStreaming;
			await agent.request({ type: "set_session_name", name: child.title });
			await this.saveSessionLeaf(runtime);
			await this.writeRuntimeControls(runtime);
			if (runtime.controls) await this.controlRequest(runtime, "apply");
			if (input.activate !== false) await this.activate(child);
			else if (this.store.activeId === parent.id) await this.ensureRuntime(parent);
			await this.persist();
			return {
				cancelled: false,
				conversation: structuredClone(child),
				selectedText: result.text === undefined ? undefined : visiblePromptText(result.text),
				snapshot: await this.buildSnapshot(child.id),
			};
		} catch (error) {
			// A failed native replacement must never leave the parent's identity on a child transcript.
			if (runtime.conversationId === parent.id) {
				await this.stopRuntime(runtime, "preserve");
				parent.sessionFile = parentFile;
			}
			throw error;
		} finally {
			runtime.replacing = false;
		}
	}

	private async navigationRequest(
		runtime: SessionRuntime,
		request: SessionNavigationBridgeRequest,
	): Promise<SessionNavigationBridgeResponse> {
		const bridge = runtime.navigation;
		if (!bridge) throw new Error("会话导航扩展未加载，请重新构建桌面运行时。");
		const agent = this.requireAgent(runtime);
		const { commands } = await agent.request<{ commands: SlashCommand[] }>({ type: "get_commands" });
		if (!commands.some((item) => item.name === bridge.command)) throw new Error("会话导航扩展不可用。");
		const requestFile = join(bridge.directory, "request.json");
		const responseFile = join(bridge.directory, "response.json");
		try {
			await rm(responseFile, { force: true });
			await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
			const result = await agent.request<{ disposition: string }>({
				type: "prompt",
				message: `/${bridge.command} ${bridge.token} ${request.requestId}`,
			});
			if (result.disposition !== "handled") throw new Error("会话导航命令未被处理。");
			// Private extension output is a subprocess wire boundary.
			const response: unknown = JSON.parse(await readFile(responseFile, "utf8"));
			if (
				!response ||
				typeof response !== "object" ||
				!("requestId" in response) ||
				response.requestId !== request.requestId ||
				!("ok" in response) ||
				typeof response.ok !== "boolean"
			)
				throw new Error("会话导航返回格式错误。");
			return response as SessionNavigationBridgeResponse;
		} finally {
			await Promise.all([rm(requestFile, { force: true }), rm(responseFile, { force: true })]);
		}
	}

	private async saveSessionLeaf(runtime: SessionRuntime): Promise<void> {
		const conversation = this.conversation(runtime.conversationId);
		const result = await runtime.agent?.request<SessionEntriesResult>({ type: "get_entries" });
		if (!result) return;
		runtime.historyTailId = result.entries.at(-1)?.id;
		const materialized =
			conversation.sessionFile &&
			(await stat(conversation.sessionFile).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			));
		// Pi keeps empty-session metadata in memory. Ordinary appends already persist their final leaf.
		if (!materialized || runtime.historyTailId === result.leafId) delete conversation.sessionLeafId;
		else conversation.sessionLeafId = result.leafId;
	}

	private isDelegatedChild(conversationId: string): boolean {
		return Boolean(
			this.store.tasks.find((item) => item.conversationId === conversationId && item.parentConversationId) ||
			this.store.conversations.find((item) => item.id === conversationId && item.parentConversationId),
		);
	}

	subscribeCron(listener: (event: CronEvent) => void): () => void { return this.cron.subscribe(listener); }
	async listCron(conversationId?: string): Promise<CronJobRecord[]> {
		await this.operation;
		const conv = conversationId ? this.conversation(conversationId) : this.active();
		return this.cron.list(conversationId ? conv?.id : undefined, conv?.project);
	}
	async createCron(conversationId: string, input: CronCreateInput): Promise<CronJobRecord> {
		await this.operation;
		const conv = this.conversation(conversationId);
		return this.cron.create({ conversationId: conv.id, project: conv.project, source: "tool", input });
	}
	async runLoopCommand(conversationId: string, rawArgs: string): Promise<CronJobRecord> {
		await this.operation;
		const conv = this.conversation(conversationId);
		const parsed = parseLoopCommandArgs(rawArgs);
		return this.cron.create({
			conversationId: conv.id,
			project: conv.project,
			source: "loop",
			input: { ...parsed, recurring: true, durable: this.isProjectTrusted(conv.project) },
		});
	}
	async deleteCron(id: string, conversationId?: string): Promise<boolean> {
		await this.operation;
		return this.cron.delete(id, conversationId ? this.conversation(conversationId).id : undefined);
	}

	subscribeTeams(listener: (event: TeamEvent) => void): () => void { return this.teams.subscribe(listener); }
	async getTeam(conversationId?: string): Promise<TeamRecord | null> {
		await this.operation;
		const id = conversationId ?? this.store.activeId;
		if (!id) return null;
		return this.teams.get(this.rootConversationId(this.conversation(id).id));
	}
	async deleteTeam(conversationId: string, teamName?: string): Promise<{ deleted: boolean; name?: string }> {
		await this.operation;
		const conv = this.conversation(conversationId);
		return this.teams.deleteTeam(this.rootConversationId(conv.id), teamName);
	}

	subscribeWorkflows(listener: (event: WorkflowEvent) => void): () => void { return this.workflows.subscribe(listener); }
	async listWorkflows(conversationId?: string): Promise<WorkflowRecord[]> {
		await this.operation;
		return this.workflows.list(conversationId ? this.conversation(conversationId).id : undefined);
	}
	async startWorkflow(conversationId: string, input: WorkflowRunInput): Promise<WorkflowRecord> {
		await this.operation;
		const conv = this.conversation(conversationId);
		return this.workflows.start({
			conversationId: conv.id,
			rootConversationId: this.rootConversationId(conv.id),
			project: conv.project,
			input,
		});
	}
	async resumeWorkflow(id: string): Promise<WorkflowRecord> {
		await this.operation;
		return this.workflows.resume(id);
	}
	async stopWorkflow(id: string): Promise<WorkflowRecord> {
		await this.operation;
		return this.workflows.stop(id);
	}
	async respondWorkflowApproval(
		workflowId: string,
		requestId: string,
		decision: WorkflowApprovalDecision,
	): Promise<WorkflowRecord> {
		await this.operation;
		return this.workflows.respondApproval(workflowId, requestId, decision);
	}

	private rootConversationId(conversationId: string, followCopies = true): string {
		let cursor = conversationId;
		const visited = new Set<string>();
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor);
			const parent =
				(followCopies ? this.store.conversations.find((item) => item.id === cursor)?.parentConversationId : undefined) ??
				this.store.tasks.find((item) => item.conversationId === cursor && item.parentConversationId)?.parentConversationId;
			if (!parent) break;
			cursor = parent;
		}
		return cursor;
	}

	subscribeTodos(listener: (event: TodoEvent) => void): () => void {
		return this.todos.subscribe(listener);
	}

	async listTodos(conversationId?: string): Promise<TodoRecord[]> {
		await this.operation;
		const id = conversationId ?? this.store.activeId;
		if (!id) return [];
		const conv = this.conversation(id);
		return this.todos.list(this.rootConversationId(conv.id));
	}

	async createTodo(conversationId: string, input: TodoCreateInput): Promise<TodoRecord> {
		await this.operation;
		const conv = this.conversation(conversationId);
		return this.todos.create(this.rootConversationId(conv.id), input);
	}

	async updateTodo(conversationId: string, input: TodoUpdateInput): Promise<TodoRecord> {
		await this.operation;
		const conv = this.conversation(conversationId);
		return this.todos.update(this.rootConversationId(conv.id), input);
	}

	private async probeLocalUrl(url: string, timeoutMs = 1500): Promise<boolean> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
			return true;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	async defaultPreviewUrl(conversationId: string): Promise<string> {
		await this.operation;
		const conversation = this.conversation(conversationId);
		const root = this.rootConversationId(conversationId);
		const embeddable = (url: string | undefined): url is string => Boolean(url && validateLocalPreviewUrl(url).hostname !== "[::1]");
		for (const server of this.previewServers.values()) {
			if (server.rootConversationId === root && this.monitors.get(server.serverId)?.status === "running" && embeddable(server.url))
				return server.url;
		}
		const path = await realpath(join(conversation.project, ".claude", "launch.json")).catch(() => undefined);
		if (path && inside(conversation.project, path)) {
			const config = await readLaunchConfigurations(conversation.project).catch(() => undefined);
			const first = config?.configurations.map(launchConfigUrl).find(embeddable);
			if (first) return first;
		}
		return DEFAULT_LOCAL_PREVIEW_URL;
	}

	private async handlePreviewCheckTool(input: Record<string, unknown>, context: ToolHostContext): Promise<unknown> {
		const conv = this.conversation(context.conversationId);
		const rootId = this.rootConversationId(conv.id);
		const action = (typeof input.action === "string" ? input.action : "check") as
			| "list_configs"
			| "start_server"
			| "stop_server"
			| "server_logs"
			| "check";

		const activeServers = () => {
			const list: Array<{ server_id: string; name: string; url?: string; status: string }> = [];
			for (const [id, entry] of this.previewServers) {
				if (entry.rootConversationId !== rootId) continue;
				const rec = this.monitors.get(id);
				if (!rec) {
					this.previewServers.delete(id);
					continue;
				}
				list.push({ server_id: id, name: entry.name, url: entry.url, status: shellStatus(rec) });
			}
			return list;
		};

		if (action === "list_configs") {
			const configResult = await readLaunchConfigurations(conv.project);
			const running = activeServers();
			const lines: string[] = [];
			if (!configResult.exists) {
				lines.push("未找到 `.claude/launch.json`。可以直接传入 `url`（如 http://localhost:3000）执行 `PreviewCheck(action=\"check\")`，或创建 `.claude/launch.json` 配置开发服务器。");
			} else if (configResult.configurations.length === 0) {
				lines.push("`.claude/launch.json` 中没有有效的启动配置。");
			} else {
				lines.push("`.claude/launch.json` 可用配置：");
				for (const cfg of configResult.configurations) {
					const u = launchConfigUrl(cfg);
					lines.push(`- ${cfg.name}${u ? ` (${u})` : ""}`);
				}
			}
			if (configResult.warnings.length) {
				lines.push("", "配置警告：", ...configResult.warnings.map((w) => `- ${w}`));
			}
			if (running.length) {
				lines.push("", "当前运行中的预览服务器：", ...running.map((s) => `- ${s.name} [${s.status}] id=${s.server_id}${s.url ? ` ${s.url}` : ""}`));
			}
			return {
				exists: configResult.exists,
				configurations: configResult.configurations.map((c) => ({ name: c.name, url: launchConfigUrl(c), port: c.port })),
				warnings: configResult.warnings,
				runningServers: running,
				text: lines.join("\n"),
			};
		}

		if (action === "start_server") {
			const trusted = this.store.projectTrust?.[this.trustProjectFor(conv.project)] === "trusted";
			if (!trusted) throw new Error("请先信任此项目，再通过 .claude/launch.json 启动开发服务器。");
			const configResult = await readLaunchConfigurations(conv.project);
			if (!configResult.exists || !configResult.configurations.length) {
				throw new Error("未找到可用的 `.claude/launch.json` 启动配置。");
			}
			const wantedName = typeof input.name === "string" ? input.name.trim() : undefined;
			const config = wantedName
				? configResult.configurations.find((c) => c.name === wantedName)
				: configResult.configurations.length === 1
					? configResult.configurations[0]
					: undefined;
			if (!config) {
				const names = configResult.configurations.map((c) => c.name).join("、");
				throw new Error(wantedName ? `未找到名为 "${wantedName}" 的启动配置（可用：${names}）。` : `存在多个启动配置，请指定 name：${names}`);
			}
			const url = launchConfigUrl(config);
			const existing = activeServers().find((s) => s.name === config.name && s.status === "running");
			if (existing) {
				return {
					server_id: existing.server_id,
					name: existing.name,
					url: existing.url,
					ready: existing.url ? await this.probeLocalUrl(existing.url) : true,
					reused: true,
					text: `开发服务器 "${existing.name}" 已在运行中（server_id=${existing.server_id}${existing.url ? `，${existing.url}` : ""}）。`,
				};
			}
			const command = buildLaunchShellCommand(config);
			const task = this.store.tasks.find((item) => item.conversationId === conv.id);
			const runtime = this.runtimes.get(conv.id);
			const ownerRunId = this.shellRunOwner(runtime, context.signal);
			const record = this.monitors.startShell({
				conversationId: conv.id,
				rootConversationId: rootId,
				ownerRunId,
				workingDirectory: config.cwd ?? task?.workingDirectory ?? conv.project,
				env: runtime?.shellEnv ?? this.options.env,
				sandboxProfileFile: runtime?.sandboxProfileFile,
				command,
				description: `Preview server: ${config.name}`,
			});
			this.previewServers.set(record.id, { serverId: record.id, name: config.name, url, rootConversationId: rootId });
			let ready = false;
			const waitMs = typeof input.wait_ms === "number" ? input.wait_ms : 15000;
			if (url) {
				const deadline = Date.now() + waitMs;
				while (Date.now() < deadline) {
					const live = this.monitors.get(record.id);
					if (!live || live.status !== "running") break;
					if (await this.probeLocalUrl(url, 1200)) {
						ready = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 400));
				}
			}
			const current = this.monitors.get(record.id);
			const status = current ? shellStatus(current) : "exited";
			return {
				server_id: record.id,
				name: config.name,
				url,
				status,
				ready,
				text: ready
					? `开发服务器 "${config.name}" 已就绪：${url}（server_id=${record.id}）。`
					: `开发服务器 "${config.name}" 已启动（status=${status}，server_id=${record.id}${url ? `，目标地址 ${url} 暂未响应，可用 server_logs 查看输出` : ""}）。`,
			};
		}

		if (action === "stop_server" || action === "server_logs") {
			const serverIdInput = typeof input.server_id === "string" ? input.server_id.trim() : undefined;
			const nameInput = typeof input.name === "string" ? input.name.trim() : undefined;
			const match = activeServers().find((s) => (serverIdInput ? s.server_id === serverIdInput : nameInput ? s.name === nameInput : true));
			if (!match) throw new Error("未找到运行中的预览开发服务器。");
			if (action === "server_logs") {
				const out = this.monitors.readShell(match.server_id);
				const combined = [out.stdout, out.stderr].filter(Boolean).join("\n").trim();
				return {
					server_id: match.server_id,
					name: match.name,
					...out,
					text: `[Preview Server "${match.name}" (${out.status})]\n${combined || "(暂无新输出)"}`,
				};
			}
			await this.monitors.stop(match.server_id, undefined, "model_stop");
			this.previewServers.delete(match.server_id);
			return {
				server_id: match.server_id,
				name: match.name,
				status: "killed",
				text: `已停止开发服务器 "${match.name}"（server_id=${match.server_id}）。`,
			};
		}

		// action === "check"
		let targetUrl = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
		if (!targetUrl) {
			const serverIdInput = typeof input.server_id === "string" ? input.server_id.trim() : undefined;
			const nameInput = typeof input.name === "string" ? input.name.trim() : undefined;
			const running = activeServers().find((s) => (serverIdInput ? s.server_id === serverIdInput : nameInput ? s.name === nameInput : true));
			if (running?.url) targetUrl = running.url;
			else if (nameInput) {
				const cfg = (await readLaunchConfigurations(conv.project)).configurations.find((c) => c.name === nameInput);
				if (cfg) targetUrl = launchConfigUrl(cfg);
			}
		}
		if (!targetUrl) throw new Error("请提供本机预览地址 `url`（例如 http://localhost:3000），或先通过 start_server 启动开发服务器。");
		const validated = validateLocalPreviewUrl(targetUrl).href;
		if (!this.options.inspectPreview) {
			throw new Error("当前运行环境不支持无头浏览器预览检查（需在 Electron 桌面应用中运行）。");
		}
		const result = await this.options.inspectPreview({
			url: validated,
			mobile: input.mobile === true,
			actions: Array.isArray(input.actions) ? (input.actions as PreviewInteraction[]) : undefined,
			selector: typeof input.selector === "string" ? input.selector : undefined,
			readDom: input.read_dom !== false,
			screenshot: input.screenshot === true,
			screenshotDir: join(this.options.dataDir, "preview-screenshots"),
		});
		return {
			...result,
			text: formatPreviewInspectSummary(result),
		};
	}

	private assertKaggleBrowserOwner(conversationId: string, signal: AbortSignal): void {
		signal.throwIfAborted();
		if (this.closed || this.active()?.id !== conversationId ||
			this.store.tasks.some((task) => task.conversationId === conversationId))
			throw new Error("请在打开 Kaggle Notebook 的前台会话操作浏览器。");
		if (this.runtimes.get(conversationId)?.workingTurn?.stopRequested)
			throw new Error("当前回合已停止。");
	}

	private async modelTool(request: DesktopToolInvocation, context: ToolHostContext): Promise<unknown> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const input = request.input;
		if (request.tool === "PreviewCheck") {
			return this.handlePreviewCheckTool(input, context);
		}
		if (request.tool === "KaggleComputerUse") {
			const { conversationId, signal } = context;
			const action = input.action;
			if (action !== "inspect" && action !== "run_all") throw new Error("未知的 Kaggle 浏览器操作。");
			if (!this.options.kaggleComputerUse) throw new Error("当前运行环境没有 Kaggle 浏览器。");
			this.assertKaggleBrowserOwner(conversationId, signal);
			const recheckRun = async () => {
				this.assertKaggleBrowserOwner(conversationId, signal);
				if (this.store.settings.sandboxOffline) throw new Error("命令沙箱处于离线模式，无法启动 Kaggle Notebook。");
				const latest = await evaluatePermission(this.permissionPolicy(conversationId), { toolName: request.tool, input });
				if (latest.action === "deny") throw new Error(latest.reason);
				this.assertKaggleBrowserOwner(conversationId, signal);
			};
			if (action === "run_all") await recheckRun();
			return this.options.kaggleComputerUse({ conversationId, action, signal, recheckRun });
		}
		if (request.tool === "LSP") {
			const conv = this.conversation(context.conversationId);
			const operation = String(input.operation) as CodeIntelligenceOperation;
			const filePath = String(input.filePath);
			const silent = input.silent === true;
			if (operation === "workspaceOutline") {
				const policy = this.permissionPolicy(context.conversationId);
				const outline = await buildWorkspaceOutline(
					conv.project,
					filePath,
					async (relPath) =>
						(await evaluatePermission(policy, { toolName: "read", input: { path: relPath } }).catch(() => undefined))?.action === "allow",
					context.signal,
				);
				return {
					server: "outline",
					filePath,
					operation,
					diagnostics: [],
					symbols: outline.files.flatMap((f) => f.symbols.map((s) => ({ name: `${f.path}#${s.name}`, line: s.line, column: 1 }))),
					definitions: [],
					files: outline.files,
					scannedFiles: outline.scannedFiles,
					truncated: outline.truncated,
					formatted: outline.formatted,
					text: outline.formatted,
				};
			}
			const trusted = this.store.projectTrust?.[this.trustProjectFor(conv.project)] === "trusted";
			if (!trusted) {
				if (silent) return { skipped: true, diagnostics: [] };
				throw new Error("请先在项目菜单中信任此项目，再使用 LSP 语言服务器。");
			}
			if (!isLspSupportedFile(filePath)) {
				if (silent) return { skipped: true, diagnostics: [] };
				throw new Error("LSP 语言服务支持 JS、TS、Python、Go 和 Rust 文件。");
			}
			const at =
				typeof input.line === "number" && typeof input.character === "number"
					? { line: input.line, column: input.character }
					: undefined;
			try {
				const intel = await this.languages.inspect(conv.project, filePath, at, operation, context.signal);
				const formatted = silent
					? formatLspDiagnostics(filePath, intel)
					: formatCodeIntelligence(filePath, intel, operation);
				return {
					server: intel.server,
					filePath,
					operation,
					diagnostics: intel.diagnostics,
					diagnosticsComplete: intel.diagnosticsComplete,
					symbols: operation === "diagnostics" ? [] : intel.symbols,
					definitions: intel.definitions,
					formatted,
					text: formatted,
				};
			} catch (error) {
				if (silent) return { skipped: true, diagnostics: [], error: error instanceof Error ? error.message : String(error) };
				throw error;
			}
		}
		if (request.tool === "TodoCreate") {
			this.conversation(context.conversationId);
			const rootId = this.rootConversationId(context.conversationId);
			const todo = await this.todos.create(rootId, input as unknown as TodoCreateInput);
			return { todo };
		}
		if (request.tool === "TodoGet") {
			this.conversation(context.conversationId);
			const rootId = this.rootConversationId(context.conversationId);
			const todo = await this.todos.get(rootId, input as unknown as TodoGetInput);
			return todo ? { found: true, todo } : { found: false, id: String(input.id ?? "") };
		}
		if (request.tool === "TodoUpdate") {
			this.conversation(context.conversationId);
			const rootId = this.rootConversationId(context.conversationId);
			const todo = await this.todos.update(rootId, input as unknown as TodoUpdateInput);
			return { todo };
		}
		if (request.tool === "TodoList") {
			this.conversation(context.conversationId);
			const rootId = this.rootConversationId(context.conversationId);
			const todos = await this.todos.list(rootId, input as unknown as TodoListInput);
			return { todos, total: todos.length };
		}
		if ((cronToolNames as readonly string[]).includes(request.tool)) {
			const conv = this.conversation(context.conversationId);
			if (this.isDelegatedChild(conv.id)) {
				throw new Error("Cron and ScheduleWakeup tools are disabled for subagents");
			}
			if (request.tool === "ScheduleWakeup") {
				const job = await this.cron.scheduleWakeup({
					conversationId: conv.id,
					project: conv.project,
					input: input as unknown as ScheduleWakeupInput,
				});
				return { job_id: job.id, next_run_at: job.nextRunAt, expires_at: job.expiresAt, notice: "已安排定时唤醒，会在会话空闲时自动触发并消耗模型额度。" };
			}
			if (request.tool === "CronCreate") {
				const job = await this.cron.create({
					conversationId: conv.id,
					project: conv.project,
					source: "tool",
					input: input as unknown as CronCreateInput,
				});
				return { job_id: job.id, next_run_at: job.nextRunAt, expires_at: job.expiresAt, durable: job.durable, notice: "已创建定时任务，会在会话空闲时自动执行并消耗模型额度。" };
			}
			if (request.tool === "CronList") {
				const jobs = await this.cron.list(conv.id, conv.project);
				return { jobs, cron_enabled: this.store.settings.cronEnabled !== false };
			}
			if (request.tool === "CronDelete") {
				const deleted = await this.cron.delete(String(input.id), conv.id);
				return { deleted, id: String(input.id) };
			}
		}
		if (request.tool === "TeamCreate") {
			const conv = this.conversation(context.conversationId);
			if (this.isDelegatedChild(conv.id)) throw new Error("Subagents cannot create teams");
			const team = await this.teams.createTeam({
				rootConversationId: this.rootConversationId(conv.id),
				leaderConversationId: conv.id,
				team_name: String(input.team_name),
				description: typeof input.description === "string" ? input.description : undefined,
			});
			return { team };
		}
		if (request.tool === "TeamDelete") {
			const conv = this.conversation(context.conversationId);
			if (this.isDelegatedChild(conv.id)) throw new Error("Subagents cannot delete teams");
			return this.teams.deleteTeam(
				this.rootConversationId(conv.id),
				typeof input.team_name === "string" ? input.team_name : undefined,
			);
		}
		if (request.tool === "StructuredOutput") {
			const task = this.store.tasks.find(
				(item) => item.conversationId === context.conversationId && item.structuredOutputSchema !== undefined,
			);
			if (!task) throw new Error("StructuredOutput is only enabled on workflow steps with a schema");
			const check = validateJsonSchema(task.structuredOutputSchema, input.data);
			if (!check.valid) {
				throw new Error(`StructuredOutput validation failed: ${check.errors.join("; ")}`);
			}
			task.structuredOutput = input.data;
			await this.persist();
			return { accepted: true, data: input.data };
		}
		if (request.tool === "WorkflowRun") {
			const conv = this.conversation(context.conversationId);
			if (this.isDelegatedChild(conv.id)) throw new Error("Subagents cannot start workflows");
			const wf = await this.workflows.start({
				conversationId: conv.id,
				rootConversationId: this.rootConversationId(conv.id),
				project: conv.project,
				callerSignal: input.run_in_background === true ? undefined : context.signal,
				input: {
					title: typeof input.title === "string" ? input.title : undefined,
					script: String(input.script),
					budget: input.budget as WorkflowRunInput["budget"],
				},
			});
			if (input.run_in_background === true) {
				return { workflow_id: wf.id, status: wf.status };
			}
			const done = await this.workflows.wait(wf.id, context.signal);
			if (done.status === "failed") throw new Error(done.error || "Workflow execution failed");
			return {
				workflow_id: done.id,
				status: done.status,
				result: done.result ?? null,
				phases: done.phases,
				budget: done.budget,
			};
		}
		if (request.tool === "AgentExecutors") return { executors: await this.external.executors() };
		if (request.tool === "Agent" && input.executor && input.executor !== "pi") {
			if (input.scope_paths !== undefined) throw new Error("scope_paths is only available for local Pi subagents");
			if (input.isolation === "remote") throw new Error("isolation 'remote' is not supported by this client; use worktree or shared");
			if (input.subagent_type === "fork" || input.fork) throw new Error("External executors cannot fork this conversation");
			// An explicit model or name must not be dropped silently: the executor picks its own
			// model, and external tasks are addressed by task_id only.
			if (input.model !== undefined && input.model !== "inherit")
				throw new Error(`External executors use their own configured model; omit model (or use "inherit") with executor=${String(input.executor)}`);
			if (input.name !== undefined) throw new Error("External executors cannot be named; address them by their task_id");
			const warnings = (["mode", "team_name"] as const).filter((key) => input[key] !== undefined)
				.map((key) => `Parameter '${key}' is not supported by this client and was ignored.`);
			// External writers always use a worktree, so they follow the background default too.
			const background = (input.run_in_background as boolean | undefined) ?? this.store.settings.subagentDefaultBackground !== false;
			const task = await this.external.start({ executor: input.executor as ExternalProvider,
				description: input.description as string, prompt: input.prompt as string,
				subagent_type: input.subagent_type as ExternalTaskStartInput["subagent_type"], isolation: input.isolation as ExternalTaskStartInput["isolation"],
				worktree_id: input.worktree_id as string | undefined, run_in_background: background }, context.conversationId, context.toolCallId);
			const result = await this.external.awaitModelResult(task.id, context.conversationId, background, context.signal);
			return warnings.length ? { ...result, warnings } : result;
		}
		if (request.tool === "SendMessage" || request.tool === "AgentSend") {
			// External tasks are matched first: they have no names, and a Pi child is addressed by
			// its own id or name. Both paths check that the parent owns the target.
			const to = (request.tool === "SendMessage" ? input.to : input.task_id) as string;
			if (this.external.has(to)) {
				// AgentSend keeps its foreground default; SendMessage follows the background setting.
				const background = (input.run_in_background as boolean | undefined) ??
					(request.tool === "AgentSend" ? false : this.store.settings.subagentDefaultBackground !== false);
				await this.external.send({ taskId: to, message: input.message as string, runInBackground: background }, context.conversationId);
				return this.external.awaitModelResult(to, context.conversationId, background, context.signal);
			}
			if (
				request.tool === "SendMessage" &&
				this.store.settings.agentTeams === true &&
				(to === "*" || to === "team-lead" || input.message_type !== undefined || this.isDelegatedChild(context.conversationId))
			) {
				const rootId = this.rootConversationId(context.conversationId);
				const team = await this.teams.get(rootId);
				if (team) {
					const delivered = await this.teams.sendStructuredMessage({
						rootConversationId: rootId,
						senderConversationId: context.conversationId,
						to,
						message: String(input.message),
						summary: typeof input.summary === "string" ? input.summary : undefined,
						messageType: input.message_type as TeamMessageType | undefined,
						requestId: typeof input.request_id === "string" ? input.request_id : undefined,
						approve: typeof input.approve === "boolean" ? input.approve : undefined,
					});
					if (input.message_type === "shutdown_response" && input.approve === true) {
						const selfTask = this.store.tasks.find((item) => item.conversationId === context.conversationId);
						if (selfTask && ["running", "waiting_for_input", "queued"].includes(selfTask.status)) {
							void this.cancelTask(selfTask.id, "model_stop").catch(() => {});
						}
					}
					return delivered;
				}
			}
			return this.delegation.handle(context, request.tool, input);
		}
		if (request.tool === "BashBackground") {
			const conv = this.conversation(context.conversationId);
			const task = this.store.tasks.find((item) => item.conversationId === conv.id);
			const runtime = this.runtimes.get(conv.id);
			const ownerRunId = this.shellRunOwner(runtime, context.signal);
			const record = this.monitors.startShell({
				conversationId: conv.id,
				rootConversationId: this.rootConversationId(conv.id),
				ownerRunId,
				workingDirectory: task?.workingDirectory ?? conv.project,
				env: runtime?.shellEnv ?? this.options.env,
				sandboxProfileFile: runtime?.sandboxProfileFile,
				command: String(input.command),
				description: typeof input.description === "string" ? input.description : undefined,
				timeout: input.timeout as number | undefined,
			});
			return { shell_id: record.id, status: "running", description: record.description };
		}
		if (request.tool === "BashOutput" || request.tool === "KillShell") {
			const id = String(request.tool === "BashOutput" ? input.bash_id : input.shell_id);
			const record = this.monitors.get(id);
			// Shells are shared within one root conversation (its subagents included), never across roots.
			if (!record || record.kind !== "shell" || record.rootConversationId !== this.rootConversationId(context.conversationId))
				throw new Error(`Background shell not found: ${id}`);
			if (request.tool === "BashOutput")
				return this.monitors.readShell(id, typeof input.filter === "string" ? input.filter : undefined, typeof input.cursor === "number" ? input.cursor : undefined);
			if (record.status === "running") await this.monitors.stop(id, undefined, "model_stop");
			const stopped = this.monitors.get(id)!;
			return { shell_id: id, status: shellStatus(stopped), exit_code: stopped.exitCode ?? null, message: record.status === "running" ? "Background shell stopped" : "Background shell had already finished" };
		}
		if (request.tool === "Monitor") {
			const conv = this.conversation(context.conversationId);
			const task = this.store.tasks.find((item) => item.conversationId === conv.id);
			const workingDirectory = task?.workingDirectory ?? conv.project;
			const record = await this.monitors.start({
				conversationId: conv.id,
				rootConversationId: this.rootConversationId(conv.id),
				workingDirectory,
				env: this.options.env,
				sandboxProfileFile: this.runtimes.get(conv.id)?.sandboxProfileFile,
				input: input as unknown as MonitorStartInput,
			});
			return {
				monitor_id: record.id,
				kind: record.kind,
				status: record.status,
				description: record.description,
				timeout_ms: record.timeoutMs,
			};
		}
		if (request.tool === "TaskOutput" && this.external.has(input.task_id as string))
			return this.external.result(input.task_id as string, { block: input.block as boolean | undefined, timeout: input.timeout as number | undefined }, context.conversationId, context.signal);
		if (request.tool === "TaskStop") {
			const targetId = input.task_id as string;
			if (this.workflows.get(targetId)) {
				const stopped = await this.workflows.stop(targetId);
				return { task_id: stopped.id, status: stopped.status };
			}
			if (this.monitors.has(targetId)) {
				const stopped = await this.monitors.stop(targetId, context.conversationId, "model_stop");
				return { task_id: stopped.id, status: stopped.status, stop_reason: stopped.stopReason };
			}
			if (this.external.has(targetId)) {
				await this.external.cancel(targetId, context.conversationId, "model_stop");
				return this.external.result(targetId, {}, context.conversationId);
			}
			return this.delegation.handle(context, request.tool, input);
		}
		if (request.tool === "TaskList") {
			const pi = await this.delegation.handle(context, request.tool, input) as { tasks: unknown[]; truncated: boolean };
			const external = this.external.list(context.conversationId);
			const monitors = this.monitors.list(context.conversationId).map((m) => ({
				monitor_id: m.id,
				kind: m.kind,
				description: m.description,
				status: m.status,
				event_count: m.eventCount,
			}));
			const remote = this.remoteJobs.list(context.conversationId).slice(0, 50).map((job) => ({
				job_id: job.id,
				target: job.kind === "kaggle-notebook" ? `${job.notebook}/${job.version}` : job.submissionId,
				kind: job.kind,
				status: job.status,
				checked_at: job.checkedAt,
				evidence: job.evidence,
				query_error: job.queryError?.code,
			}));
			return {
				tasks: [
					...pi.tasks,
					...external.slice(0, 128).map((task) => ({
						task_id: task.id, executor: task.executor,
						description: task.title, status: task.status, turn: task.turn, worktree_id: task.worktreeId, pending_approvals: task.pendingApprovals.length,
					})),
				],
				truncated: pi.truncated || external.length > 128,
				...(monitors.length ? { monitors } : {}),
				...(remote.length ? { remote_jobs: remote } : {}),
			};
		}
		if (request.tool === "Agent") {
			const cleanInput = input.executor === "pi" ? (({ executor: _executor, ...args }) => args)(input) : input;
			if (this.store.settings.agentTeams === true && typeof cleanInput.team_name === "string") {
				const rootId = this.rootConversationId(context.conversationId);
				const team = await this.teams.get(rootId);
				if (!team || team.name !== cleanInput.team_name) {
					throw new Error(`未找到团队 "${String(cleanInput.team_name)}"，请先调用 TeamCreate 创建。`);
				}
				const memberName =
					typeof cleanInput.name === "string" ? cleanInput.name : `member-${randomBytes(3).toString("hex")}`;
				return this.delegation.handle(context, request.tool, { ...cleanInput, name: memberName });
			}
			return this.delegation.handle(context, request.tool, cleanInput);
		}
		return this.delegation.handle(context, request.tool, input);
	}

	subscribeMonitors(listener: (event: MonitorEvent) => void): () => void { return this.monitors.subscribe(listener); }
	async listMonitors(conversationId?: string): Promise<MonitorRecord[]> {
		await this.operation;
		const id = conversationId ? this.conversation(conversationId).id : undefined;
		return this.monitors.list(id);
	}
	async stopMonitor(id: string): Promise<MonitorRecord> {
		await this.operation;
		return this.monitors.stop(id, undefined, "user_stop");
	}

	subscribeRemoteJobs(listener: (job: RemoteJobRecord | undefined, previous?: RemoteJobRecord) => void): () => void {
		this.remoteJobListeners.add(listener);
		return () => this.remoteJobListeners.delete(listener);
	}

	async listRemoteJobs(conversationId: string): Promise<RemoteJobRecord[]> {
		await this.operation;
		return this.remoteJobs.list(this.conversation(conversationId).id);
	}

	trackRemoteJob(conversationId: string, input: unknown): Promise<RemoteJobRecord> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("远端任务格式无效。");
			const record = input as Record<string, unknown>;
			const owner = { conversationId, projectDir: this.trustProjectFor(conversation.project) };
			const useProjectCredentials = record.useProjectCredentials === true;
			if (record.kind === "kaggle-notebook" && typeof record.notebook === "string" && typeof record.version === "number")
				return this.remoteJobs.track({ ...owner, kind: record.kind, notebook: record.notebook, version: record.version, useProjectCredentials });
			if (record.kind === "kaggle-submission" && typeof record.competition === "string" && typeof record.submissionId === "string")
				return this.remoteJobs.track({ ...owner, kind: record.kind, competition: record.competition, submissionId: record.submissionId, useProjectCredentials });
			throw new Error("请提供准确的 Kaggle Notebook 版本或比赛提交编号。");
		});
	}

	async refreshRemoteJob(conversationId: string, id: string): Promise<RemoteJobRecord | undefined> {
		const jobs = await this.listRemoteJobs(conversationId);
		if (!jobs.some((job) => job.id === id)) throw new Error("此会话没有该远端任务。");
		return this.remoteJobs.refresh(id);
	}

	untrackRemoteJob(conversationId: string, id: string): Promise<boolean> {
		return this.serialize(async () => {
			if (!this.remoteJobs.list(this.conversation(conversationId).id).some((job) => job.id === id))
				throw new Error("此会话没有该远端任务。");
			return this.remoteJobs.untrack(id);
		});
	}

	private shellRunOwner(runtime: SessionRuntime | undefined, signal: AbortSignal): string | undefined {
		signal.throwIfAborted();
		const turn = runtime?.workingTurn;
		if (turn?.stopRequested) throw new Error("本轮任务已停止，未启动新的后台命令。");
		return turn?.active ? turn.id : undefined;
	}

	private turnSnapshot(runtime: SessionRuntime): NonNullable<Snapshot["turn"]> | undefined {
		const turn = runtime.workingTurn;
		if (!turn) return undefined;
		return { id: turn.id, active: turn.active, runningShells: this.monitors.countRunningShellsForRun(runtime.conversationId, turn.id) };
	}

	/** Stop only the exact run shown to the user, including its still-running background shells. */
	async stopCurrentTurn(conversationId: string, runId: string): Promise<{ stoppedShells: string[]; foregroundStopped: boolean }> {
		await this.operation;
		if (this.closed) throw new Error("桌面服务已关闭。");
		const owner = this.conversation(conversationId).id;
		const runtime = this.runtimes.get(owner);
		const turn = runtime?.workingTurn;
		if (!runtime || !turn || turn.id !== runId) throw new Error("任务已切换，请刷新后重新选择要停止的回合。");
		if (turn.stopOperation) return turn.stopOperation;
		turn.stopRequested = true;
		const agent = runtime.agent;
		const foreground = turn.active && agent ? this.abortForegroundRun(runtime, agent).then(() => true) : Promise.resolve(false);
		const shells = this.monitors.stopShellsForRun(owner, runId);
		const operation = Promise.allSettled([shells, foreground] as const).then(async ([shellResult, foregroundResult]) => {
			await this.monitors.persistRunShellOutcomes(owner, runId);
			if (shellResult.status === "rejected") throw shellResult.reason;
			if (foregroundResult.status === "rejected") throw foregroundResult.reason;
			return { stoppedShells: shellResult.value, foregroundStopped: foregroundResult.value };
		});
		turn.stopOperation = operation;
		return operation.finally(() => { delete turn.stopOperation; });
	}

	private async abortForegroundRun(runtime: SessionRuntime, agent: AgentProcess): Promise<unknown> {
		// Explicitly independent background agents keep running and report back.
		await this.delegation.cancelChildren(runtime.conversationId, { foregroundOnly: true, reason: "parent_abort" });
		await this.external.cancelChildren(runtime.conversationId, { foregroundOnly: true, reason: "parent_abort" });
		await this.cancelDialogs(runtime);
		return agent.request({ type: "abort" });
	}

	subscribeExternal(listener: (event: ExternalEvent) => void): () => void { return this.external.subscribe(listener); }
	externalExecutors() { return this.external.executors(); }
	configureExternal(input: ExternalExecutorInput) { return this.external.configure(input); }
	async startExternal(input: ExternalTaskStartInput) { await this.operation; return this.external.start(input, this.conversation(input.conversationId).id); }
	listExternal(conversationId?: string) { if (conversationId) this.conversation(conversationId); return this.external.list(conversationId); }
	externalSnapshot(id: string) { return this.external.snapshot(id); }
	sendExternal(input: ExternalTaskSendInput) { return this.external.send(input); }
	externalResult(id: string, options?: { block?: boolean; timeout?: number }) { return this.external.result(id, options); }
	cancelExternal(id: string) { return this.external.cancel(id, undefined, "user_stop"); }
	respondExternal(id: string, requestId: string, response: ExternalApprovalResponse) { return this.external.respond(id, requestId, response); }
	replayExternal(id: string, afterSequence?: number) { return this.external.replay(id, afterSequence); }

	command(command: Command, conversationId?: string, launch?: number, draft?: ComposerDraft): Promise<unknown> {
		const result = this.executeCommand(command, conversationId, launch, draft);
		this.commands.add(result);
		void result.then(
			() => this.commands.delete(result),
			() => this.commands.delete(result),
		);
		return result;
	}

	async sendComposerPrompt(conversationId: string, draft: ComposerDraft, streamingBehavior?: Prompt["streamingBehavior"]): Promise<DesktopPromptResult> {
		return await this.command({ ...draftPrompt(draft), streamingBehavior }, conversationId, undefined, draft) as DesktopPromptResult;
	}

	async actOnQueue(conversationId: string, action: "withdraw" | "send"): Promise<QueueActionResult> {
		await this.operation;
		const runtime = this.runtimes.get(this.conversation(conversationId).id);
		if (!runtime) return { drafts: [] };
		const agent = this.requireAgent(runtime);
		const queue = runtime.userQueue ??= new QueuedPrompts();
		const runId = runtime.workingTurn?.id;
		const drafts = await queue.take(() => agent.request<NativeQueue>({ type: "clear_queue" }));
		if (action === "withdraw" || !drafts.length) return { drafts };
		try {
			const draft = mergeDrafts(drafts);
			// Prepare the replacement before interrupting the current run.
			const next = draftPrompt(draft);
			if (runId) await this.stopCurrentTurn(conversationId, runId);
			else await this.command({ type: "abort" }, conversationId);
			await runtime.settling;
			await this.command(next, conversationId, undefined, draft);
			return { drafts: [] };
		} catch (error) {
			return { drafts, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private requestQueuedInput(
		runtime: SessionRuntime,
		agent: AgentProcess,
		command: Prompt | Extract<Command, { type: "steer" | "follow_up" }>,
		draft?: ComposerDraft,
	) {
		const queue = runtime.userQueue ??= new QueuedPrompts();
		const lane = command.type === "follow_up" || (command.type === "prompt" && command.streamingBehavior === "followUp")
			? "followUp" : "steering";
		const original = draft ?? {
			text: command.message,
			attachments: command.images?.map((image, index) => ({ image, name: `图片 ${index + 1}` })) ?? [],
		};
		return queue.send(lane, original, async () => {
			const navigation = runtime.navigation;
			if (!navigation || !draft?.attachments.length) return agent.request<DesktopPromptResult>(command);
			// Keep real slash-command arguments intact. A slash-prefixed literal
			// still goes through the normal prompt path and retains its attachments.
			const slashName = /^\/([^\s]+)/.exec(command.message)?.[1];
			if (slashName) {
				const { commands } = await agent.request<{ commands: SlashCommand[] }>({ type: "get_commands" });
				if (commands.some(({ name }) => name === slashName)) return agent.request<DesktopPromptResult>(command);
			}
			return agent.request<DesktopPromptResult>({
				...command,
				message: tagComposerPrompt(command.message, draft, navigation.token),
			});
		});
	}

	private async executeCommand(command: Command, conversationId?: string, launch?: number, draft?: ComposerDraft): Promise<unknown> {
		await this.operation;
		if (this.closed) throw new Error("桌面服务已关闭。");
		const active = this.conversation(conversationId);
		if (launch !== undefined && this.launches.get(active.id) !== launch) throw new Error("任务已取消。");
		// A message typed into a finished child's own conversation is its next turn: it goes
		// through the task state machine (turn count, usage, notification) like "继续对话".
		if (command.type === "prompt" && launch === undefined && !command.images?.length) {
			const child = this.store.tasks.find((task) => task.conversationId === active.id && task.parentConversationId && !task.quarantined);
			const current = this.runtimes.get(active.id);
			if (child && !["queued", "running", "waiting_for_input"].includes(child.status) && !current?.busy && !current?.state?.isStreaming) {
				const sent = await this.sendToTask({ taskId: child.id, message: command.message });
				return { disposition: "started", task: sent.task };
			}
			const skillCall = parseSkillInvocation(command.message);
			if (skillCall && this.canDelegateFurther(active.id)) {
				const skills = await this.skills.list(active.project, this.isProjectTrusted(active.project));
				const matched = skills.find((entry) => entry.name.toLowerCase() === skillCall.name);
				if (matched?.context === "fork") {
					const prompt = formatForkedSkillPrompt(matched, skillCall.args);
					const delegated = await this.delegation.handle(
						{
							conversationId: active.id,
							toolCallId: `skill-fork-${randomUUID()}`,
							signal: new AbortController().signal,
						},
						"Agent",
						{
							description: `Skill /${matched.name}`,
							prompt,
							subagent_type: matched.agent || "general-purpose",
							run_in_background: true,
						},
					);
					return { disposition: "forked_skill", skill: matched.name, delegated };
				}
			}
		}
		const runtime = await this.ensureRuntime(active);
		await runtime.settling;
		if (launch !== undefined && this.launches.get(active.id) !== launch) throw new Error("任务已取消。");
		const agent = this.requireAgent(runtime);
		const allowed = new Set([
			"prompt",
			"steer",
			"follow_up",
			"abort",
			"abort_bash",
			"abort_retry",
			"clear_queue",
			"get_state",
			"get_messages",
			"get_available_models",
			"set_model",
			"set_thinking_level",
			"get_available_thinking_levels",
			"get_session_stats",
			"get_commands",
			"compact",
			"get_entries",
			"get_tree",
			"get_last_assistant_text",
			"set_auto_compaction",
			"set_auto_retry",
		]);
		if (!allowed.has(command.type) && command.type !== "bash") throw new Error("此命令请通过桌面会话操作执行。");
		if (["set_model", "set_thinking_level", "compact"].includes(command.type)) this.assertRuntimeIdle(runtime);
		if (command.type === "bash") {
			const request = { toolName: "bash", input: { command: command.command } };
			const decision = await evaluatePermission(this.permissionPolicy(active.id), request);
			if (decision.action === "deny") throw new Error(decision.reason);
			if (decision.remoteMutation && decision.action === "ask") {
				if (!(await this.options.confirmRemoteCommand?.({ command: command.command, reason: decision.reason })))
					throw new Error("用户未确认远端写操作，命令未执行。");
				if (this.closed || this.runtimes.get(active.id) !== runtime || runtime.agent !== agent)
					throw new Error("确认时会话已关闭，命令未执行。");
				const latest = await evaluatePermission(this.permissionPolicy(active.id), request);
				if (latest.action === "deny") throw new Error(latest.reason);
			}
			this.assertRuntimeIdle(runtime);
			this.assertPathAvailable(active.project, active.id);
			runtime.bashBusy = true;
			try {
				await this.startCheckpoint(runtime, command.command);
				const sandboxCmd =
					runtime.sandboxProfileFile && (await probeSeatbeltSupport()).supported
						? {
								...command,
								command: `/usr/bin/sandbox-exec -f '${runtime.sandboxProfileFile.replaceAll("'", "'\\''")}' /bin/sh -c '${command.command.replaceAll("'", "'\\''")}'`,
							}
						: command;
				return await agent.request<BashResult>(sandboxCmd);
			} finally {
				runtime.bashBusy = false;
				runtime.settling = this.finishRuntime(runtime, false);
				await runtime.settling;
			}
		}
		if (command.type === "set_auto_retry") {
			const result = await agent.request(command);
			// Pi persists this in the agent directory's settings but get_state never reports it.
			this.autoRetryGlobal = { agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(), enabled: command.enabled };
			return result;
		}
		if (command.type === "abort") {
			return this.abortForegroundRun(runtime, agent);
		}
		if (command.type === "prompt") {
			if (runtime.workingTurn?.stopOperation) await runtime.workingTurn.stopOperation.catch(() => {});
			if (runtime.workingTurn?.active && runtime.workingTurn.stopRequested) throw new Error("本轮正在停止，请稍后重新发送。");
			const alreadyRunning = runtime.busy || Boolean(runtime.state?.isStreaming);
			if (!alreadyRunning) {
				this.assertPathAvailable(active.project, active.id);
				if (runtime.bashBusy) throw new Error("请先停止当前终端命令。");
				runtime.busy = true;
				runtime.workingTurn = { id: randomUUID(), active: true };
				runtime.lastError = undefined;
				if (runtime.state) runtime.state.isStreaming = true;
			}
			try {
				const hook = await this.hooks.run("UserPromptSubmit", {
					project: active.project,
					projectTrusted: this.isProjectTrusted(active.project),
					conversationId: active.id,
					permissionMode: this.hookPermissionMode(active.id),
					prompt: command.message,
					env: this.options.env,
				});
				if (hook.blocked) throw new Error(hook.reason ?? "UserPromptSubmit Hook 阻止了发送。");
				const promptToSend =
					hook.additionalContext && !command.message.includes(hook.additionalContext)
						? { ...command, message: `${command.message}\n\n[Hook Context]\n${hook.additionalContext}` }
						: command;
				if (!alreadyRunning) await this.startCheckpoint(runtime, command.message, true);
				// Definitions edited outside the app take effect on this run's agent listing.
				if (!alreadyRunning) await this.writeAgentListing(runtime).catch(() => {});
				if (this.closed || (launch !== undefined && this.launches.get(active.id) !== launch))
					throw new Error("任务已取消。");
				if (active.title === "新会话") {
					active.title = command.message.trim().split("\n")[0].slice(0, 60) || "新会话";
					await agent.request({ type: "set_session_name", name: active.title });
				}
				active.updatedAt = Date.now();
				await this.persist();
				if (this.closed || (launch !== undefined && this.launches.get(active.id) !== launch))
					throw new Error("任务已取消。");
				if (runtime.workingTurn?.stopRequested) throw new Error("本轮任务已停止。");
				const result = await this.requestQueuedInput(runtime, agent, promptToSend, draft);
				if (result.disposition === "handled") {
					if (!alreadyRunning) {
						runtime.busy = false;
						if (runtime.workingTurn) runtime.workingTurn.active = false;
						runtime.settling = this.finishRuntime(runtime, false);
						await runtime.settling;
					}
				}
				return result;
			} catch (error) {
				if (!alreadyRunning) {
					runtime.busy = false;
					if (runtime.workingTurn) runtime.workingTurn.active = false;
					if (runtime.state) runtime.state.isStreaming = false;
					runtime.settling = this.finishRuntime(runtime, false, error instanceof Error ? error.message : String(error));
					await runtime.settling;
				}
				throw error;
			}
		}
		if (command.type === "steer" || command.type === "follow_up") return this.requestQueuedInput(runtime, agent, command);
		const result = await agent.request(command);
		if (command.type === "set_model" || command.type === "set_thinking_level" || command.type === "compact") {
			await this.syncState(runtime);
			await this.saveSessionLeaf(runtime);
			await this.persist();
		}
		if (command.type === "set_model") {
			if (active.id === this.store.activeId) {
				this.store.settings.defaultModel = { provider: command.provider, id: command.modelId };
				const provider = providers.find((item) => command.provider === `desktop-${item}`);
				if (provider && this.store.settings.connections[provider])
					this.store.settings.connections[provider].modelId = command.modelId;
			}
			const task = this.store.tasks.find((item) => item.conversationId === active.id);
			if (task) task.model = { provider: command.provider, id: command.modelId };
			await this.persist();
		}
		if (command.type === "get_state") return safeState(result as RpcSessionState);
		if (command.type === "set_model") return runtime.state?.model;
		if (command.type === "get_available_models") return { models: runtime.models };
		if (command.type === "get_commands")
			return {
				commands: (result as { commands: SlashCommand[] }).commands.filter(
					(item) => item.name !== runtime.navigation?.command && item.name !== runtime.controls?.command,
				),
			};
		return result;
	}

	async respond(response: RpcExtensionUIResponse, conversationId?: string): Promise<void> {
		const targetConvId = conversationId
			? (this.store.tasks.find((item) => item.id === conversationId)?.conversationId ?? conversationId)
			: undefined;
		let runtime: SessionRuntime | undefined;
		if (targetConvId) {
			runtime = this.runtimes.get(targetConvId);
			if (runtime?.answeredUI.has(response.id)) return;
			if (!runtime?.pendingUI.has(response.id)) throw new Error("此确认请求不属于当前会话或已失效。");
		} else {
			if ([...this.runtimes.values()].some((item) => item.answeredUI.has(response.id))) return;
			runtime = [...this.runtimes.values()].find((item) => item.pendingUI.has(response.id));
			if (!runtime) throw new Error("此确认请求已失效。");
		}
		runtime.pendingUI.delete(response.id);
		runtime.answeredUI.add(response.id);
		while (runtime.answeredUI.size > 128) runtime.answeredUI.delete(runtime.answeredUI.values().next().value!);
		const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
		this.syncTaskPendingApprovals(runtime, task);
		await this.requireAgent(runtime).respond(response);
		if (task && !runtime.pendingUI.size && task.status === "waiting_for_input") {
			this.updateTask(task, "running");
			this.scheduleProgressEmit(runtime, task, true);
		} else if (task) {
			task.revision = (task.revision ?? 0) + 1;
			for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		}
	}

	async createDraftPullRequest(conversationId: string, draft: DraftPullRequest) {
		await this.operation;
		const conv = this.conversation(conversationId);
		this.assertWritableMode("创建 GitHub PR", conv.id);
		this.assertPathAvailable(conv.project, conv.id);
		const runtime = this.runtimes.get(conv.id);
		if (runtime?.busy || runtime?.bashBusy || runtime?.settling) throw new Error("请先等待当前项目操作完成。");
		return createDraftPullRequest(conv.project, draft, this.options.env);
	}

	async pullRequest(conversationId: string, number?: number) {
		await this.operation;
		return readPullRequest(this.conversation(conversationId).project, this.options.env, number);
	}

	async setPullRequestAutoMerge(conversationId: string, number: number, enabled: boolean, method: PullRequestMergeMethod = "squash") {
		await this.operation;
		const conv = this.conversation(conversationId);
		this.assertWritableMode("设置 PR 自动合并", conv.id);
		this.assertPathAvailable(conv.project, conv.id);
		const runtime = this.runtimes.get(conv.id);
		if (runtime?.busy || runtime?.bashBusy || runtime?.settling) throw new Error("请先等待当前项目操作完成。");
		return setPullRequestAutoMerge(conv.project, number, enabled, method, this.options.env);
	}

	async pullRequestComments(conversationId: string, number: number) {
		await this.operation;
		return readPullRequestComments(this.conversation(conversationId).project, number, this.options.env);
	}

	async files(path: string, conversationId?: string): Promise<FileEntry[]> {
		const folder = await this.scopedPath(path, conversationId);
		const entries = await readdir(folder, { withFileTypes: true });
		const root = this.conversation(conversationId).project;
		return entries
			.filter((entry) => ![".git", "node_modules", ".DS_Store"].includes(entry.name))
			.slice(0, 2000)
			.map((entry) => ({
				name: entry.name,
				path: relative(root, join(folder, entry.name)),
				directory: entry.isDirectory(),
			}))
			.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
	}

	async searchFiles(conversationId: string, query: string, preferredDirectory?: string): Promise<FileEntry[]> {
		await this.operation;
		const { project } = this.conversation(conversationId);
		return searchWorkspaceFiles(project, query, this.options.env ?? process.env, preferredDirectory);
	}

	async checkFileReferences(conversationId: string, paths: string[]): Promise<FileReferenceAvailability[]> {
		await this.operation;
		const { project } = this.conversation(conversationId);
		const trustDecision = this.store.projectTrust?.[this.trustProjectFor(project)];
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		if (trustDecision !== "trusted") return paths.map(() => "untrusted");
		if (task?.omitClaudeMd) return paths.map(() => "unavailable");
		const policy = this.permissionPolicy(conversationId);
		return Promise.all(paths.map(async (candidate): Promise<FileReferenceAvailability> => {
			const path = candidate.replace(/^\.\//, "");
			if (!isReferenceablePath(path)) return "unavailable";
			const permission = await evaluatePermission(policy, { toolName: "read", input: { path } }).catch(() => undefined);
			if (permission?.action !== "allow") return "unavailable";
			const content = await readProjectText(project, path);
			return content?.trim() ? "ready" : "unavailable";
		}));
	}

	async inspectCode(conversationId: string, path: string, at?: CodePosition) {
		await this.operation;
		const { project } = this.conversation(conversationId);
		if (this.store.projectTrust?.[this.trustProjectFor(project)] !== "trusted")
			throw new Error("请先在项目菜单中信任此项目，再启动语言服务器。");
		return this.languages.inspect(project, path, at);
	}

	async readToolOutput(conversationId: string, id: string, offset?: number) {
		await this.operation;
		return readToolOutputPage(join(this.options.dataDir, "tool-output"), this.conversation(conversationId).id, id, offset);
	}

	async readFile(path: string, conversationId?: string): Promise<{ path: string; content: string }> {
		const target = await this.scopedPath(path, conversationId);
		const info = await stat(target);
		if (!info.isFile()) throw new Error("请选择文件。");
		if (info.size > 1024 * 1024) throw new Error("文件超过 1 MB，请通过编码工具按需读取。");
		const bytes = await readFile(target);
		if (bytes.includes(0)) throw new Error("此文件为二进制文件，暂不支持文本预览。");
		return { path: relative(this.conversation(conversationId).project, target), content: bytes.toString("utf8") };
	}

	async workspace(conversationId?: string): Promise<Workspace> {
		const cwd = this.conversation(conversationId).project;
		try {
			const [{ stdout: branch }, { stdout: status }, { stdout: gitPrefix }] = await Promise.all([
				exec("git", ["branch", "--show-current"], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 }),
				exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], {
					cwd,
					maxBuffer: 2 * 1024 * 1024,
					timeout: 10000,
				}),
				exec("git", ["rev-parse", "--show-prefix"], { cwd, timeout: 10000 }),
			]);
			// Porcelain uses repository-relative names even when Git runs in a project subdirectory.
			const prefix = gitPrefix.replace(/\r?\n$/, "");
			const fields = status.split("\0");
			const changes: Workspace["changes"] = [];
			for (let index = 0; index < fields.length; index++) {
				const field = fields[index];
				if (!field) continue;
				const code = field.slice(0, 2);
				const path = field.slice(3);
				if (code.includes("R") || code.includes("C")) index++;
				if (!path.startsWith(prefix)) continue;
				const x = code[0] ?? " ";
				const y = code[1] ?? " ";
				changes.push({
					status: code.trim() || "M",
					path: path.slice(prefix.length),
					staged: x !== " " && x !== "?",
					unstaged: y !== " " || code === "??",
				});
			}
			return { branch: branch.trim() || "HEAD", changes, isGit: true };
		} catch (error) {
			if ((error as { stderr?: string }).stderr?.includes("not a git repository"))
				return { branch: "", changes: [], isGit: false };
			throw new Error("无法读取 Git 状态。请确认 Git 已安装且当前目录可访问。");
		}
	}

	async diff(path: string, conversationId?: string): Promise<string> {
		const cwd = this.conversation(conversationId).project;
		// Git paths can name deleted files, so enforce lexical containment before calling Git.
		const absolute = resolve(cwd, path);
		if (!inside(cwd, absolute)) throw new Error("文件路径超出项目目录。");
		const projectPath = relative(cwd, absolute).split(sep).join("/");
		const workspace = await this.workspace(conversationId);
		const change = workspace.changes.find((item) => item.path === projectPath);
		if (!change) return "此文件没有未提交的修改。";
		if (change.status === "??") {
			const file = await this.readFile(projectPath, conversationId);
			return `--- /dev/null\n+++ b/${projectPath}\n@@ -0,0 +1,${file.content.split("\n").length} @@\n${file.content
				.split("\n")
				.map((line) => `+${line}`)
				.join("\n")}`;
		}
		const [{ stdout: unstaged }, { stdout: staged }] = await Promise.all([
			exec("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--", projectPath], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			}),
			exec("git", ["--literal-pathspecs", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--", projectPath], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			}),
		]);
		return (
			[staged && `# 已暂存\n${staged}`, unstaged && `# 未暂存\n${unstaged}`].filter(Boolean).join("\n") ||
			"没有可显示的文本差异。"
		);
	}

	private gitPaths(cwd: string, paths: string[]): string[] {
		return paths.map((p) => {
			if (!p || p.includes("\0")) throw new Error("文件路径格式错误。");
			const abs = resolve(cwd, p);
			if (!inside(cwd, abs)) throw new Error("文件路径超出项目目录。");
			const rel = relative(cwd, abs).split(sep).join("/");
			if (!rel || rel.split("/").some((part) => part.toLowerCase() === ".git"))
				throw new Error("不允许操作 .git 元数据目录。");
			return rel;
		});
	}

	async gitStage(paths?: string[], conversationId?: string): Promise<Workspace> {
		this.assertWritableMode("修改 Git 暂存区", conversationId);
		const cwd = this.conversation(conversationId).project;
		const rels = paths?.length ? this.gitPaths(cwd, paths) : [];
		const args = ["--literal-pathspecs", "add", "-A", "--", ...(rels.length ? rels : ["."])];
		await exec("git", args, { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
		return this.workspace(conversationId);
	}

	async gitUnstage(paths?: string[], conversationId?: string): Promise<Workspace> {
		this.assertWritableMode("修改 Git 暂存区", conversationId);
		const cwd = this.conversation(conversationId).project;
		const rels = paths?.length ? this.gitPaths(cwd, paths) : [];
		const targets = rels.length ? rels : ["."];
		try {
			await exec("git", ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...targets], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			});
		} catch (error) {
			// Unborn repository (no commits yet) has no HEAD; unstage via git rm --cached.
			const stderr = (error as { stderr?: string }).stderr ?? "";
			if (/ambiguous argument 'HEAD'|unknown revision|bad default revision/i.test(stderr)) {
				await exec("git", ["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...targets], {
					cwd,
					maxBuffer: 2 * 1024 * 1024,
					timeout: 10000,
				});
			} else {
				throw error;
			}
		}
		return this.workspace(conversationId);
	}

	async gitDiscardPreview(input: GitDiscardInput): Promise<{ version: string }> {
		await this.operation;
		const { version } = await this.gitDiscardTarget(input);
		return { version };
	}

	private async gitDiscardTarget(input: GitDiscardInput) {
		const { id, project: cwd } = this.conversation(input.conversationId);
		this.assertWritableMode("还原工作区文件", id);
		this.assertProjectIdle(cwd);
		const [path] = this.gitPaths(cwd, [input.path]);
		const workspace = await this.workspace(id);
		const change = workspace.changes.find((item) => item.path === path);
		if (!change?.unstaged || (change.status === "??") !== (input.kind === "untracked"))
			throw new Error("此文件的 Git 状态已改变。请刷新改动列表，再确认操作。");
		const target = resolve(cwd, path);
		// Resolve only ancestors. Moving a symlink must move the link itself.
		const parent = dirname(target);
		const canonicalParent = await realpath(parent).catch((error: NodeJS.ErrnoException) => {
			if (input.kind === "tracked" && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (canonicalParent !== undefined && canonicalParent !== parent)
			throw new Error("文件的父目录已改变。请确认工作区路径后重试。");
		let indexEntry = "";
		let indexedObject: string | undefined;
		if (input.kind === "tracked") {
			if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(change.status))
				throw new Error("请先解决合并冲突，再还原此文件。");
			({ stdout: indexEntry } = await exec("git", ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path], {
				cwd, timeout: 10000,
			}));
			const index = /^([0-7]{6}) ([a-f0-9]{40,64}) 0\t/.exec(indexEntry);
			if (!index || index[1] === "160000") throw new Error("此路径没有可恢复的文件暂存版本。");
			indexedObject = index[2];
		}
		const info = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
			if (input.kind === "tracked" && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error("此操作只能用于单个文件。");
		// Inode and nanosecond metadata distinguish replacements, edits and renames made
		// between confirmation and execution, even if the porcelain status is unchanged.
		const metadata = info ? [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":") : "missing";
		const version = createHash("sha256").update([id, path, input.kind, change.status, indexEntry, metadata].join("\0")).digest("hex");
		return { id, cwd, path, target, indexedObject, version };
	}

	gitDiscard(input: GitDiscardInput & { expectedVersion: string }): Promise<GitDiscardResult> {
		return this.serialize(async () => {
			const current = await this.gitDiscardTarget(input);
			if (current.version !== input.expectedVersion) throw new Error("文件在确认后发生变化，请重新查看并确认。");
			const { id, cwd, path, target, indexedObject } = current;
			if (!indexedObject) {
				await this.moveToTrash(target);
				return { disposition: "trashed", workspace: await this.workspace(id) };
			}
			// The undo snapshot must also be able to verify the replacement against the index.
			const { stdout } = await exec("git", ["cat-file", "-s", indexedObject], { cwd, timeout: 10000 });
			if (Number(stdout.trim()) > MAX_CHECKPOINT_FILE_BYTES)
				throw new Error("暂存版本超过撤销检查点容量。请先备份此文件。");
			const before = await this.git.begin(cwd, id, `还原前备份 · ${path}`, path);
			try {
				if ((await this.gitDiscardTarget(input)).version !== input.expectedVersion)
					throw new Error("文件在确认后发生变化，请重新查看并确认。");
			} catch (error) {
				await this.git.abandonDiscard(cwd, before.id, id).catch(() => {});
				throw error;
			}
			try {
				await exec("git", ["--literal-pathspecs", "checkout", "--", path], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
			} catch (error) {
				// Seal the undo backup even if a Git checkout filter failed after starting a write.
				await this.git.finish(cwd, before.id, { conversationId: id }).catch(() => {});
				throw error;
			}
			const undoCheckpoint = await this.git.finish(cwd, before.id, { conversationId: id });
			return { disposition: "restored", workspace: await this.workspace(id), undoCheckpoint };
		});
	}

	private async stagedGitChanges(cwd: string) {
		const [{ stdout: prefixOutput }, { stdout: raw }] = await Promise.all([
			exec("git", ["rev-parse", "--show-prefix"], { cwd, timeout: 10000 }),
			exec("git", [
				"diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "--no-relative",
				"--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", "-z",
			], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			}),
		]);
		const prefix = prefixOutput.replace(/\r?\n$/, "");
		const fields = raw.split("\0");
		const files: { status: string; path: string }[] = [];
		// The Git commit consumes the whole index. Refuse staged paths absent from this project's panel.
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const [metadata, path] = fields.slice(i, i + 2);
			if (prefix && !path.startsWith(prefix)) {
				throw new Error("仓库其他目录还有已暂存修改。请从仓库根目录打开项目，或取消那些文件的暂存后重试。");
			}
			files.push({ status: metadata.split(" ").at(-1) ?? "", path: path.slice(prefix.length) });
		}
		return { files, version: createHash("sha256").update(raw).digest("hex") };
	}

	private async assertStagedGitVersion(cwd: string, expectedVersion: string) {
		if ((await this.stagedGitChanges(cwd)).version !== expectedVersion)
			throw new Error("Git 暂存内容已变化，请重新拟定提交说明。");
	}

	async gitCommit(message: string, conversationId?: string, expectedStagedVersion?: string): Promise<GitCommitResult> {
		const conv = this.conversation(conversationId);
		this.assertWritableMode("执行 Git 提交", conv.id);
		const trimmed = message.trim();
		if (!trimmed) throw new Error("请输入提交说明。");
		const cwd = conv.project;
		this.assertProjectIdle(cwd);
		if (expectedStagedVersion) await this.assertStagedGitVersion(cwd, expectedStagedVersion);
		else await this.stagedGitChanges(cwd);
		this.assertWritableMode("执行 Git 提交", conv.id);
		this.assertProjectIdle(cwd);
		const { stdout } = await exec("git", ["commit", "-m", trimmed], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			maxBuffer: 2 * 1024 * 1024,
			timeout: 15000,
		});
		const { stdout: hash } = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 });
		return { hash: hash.trim(), summary: stdout.trim(), workspace: await this.workspace(conv.id) };
	}

	async readMemory(conversationId?: string): Promise<MemoryFileEntry[]> {
		const cwd = this.conversation(conversationId).project;
		const names: ("AGENTS.md" | "CLAUDE.md")[] = ["AGENTS.md", "CLAUDE.md"];
		const out: MemoryFileEntry[] = [];
		for (const file of names) {
			const target = resolve(cwd, file);
			try {
				const real = await realpath(target);
				if (!inside(cwd, real)) throw new Error("记忆文件路径超出项目目录。");
				const info = await stat(real);
				if (!info.isFile()) {
					out.push({ file, path: target, content: "", exists: false });
					continue;
				}
				const content = await readFile(real, "utf8");
				out.push({ file, path: target, content, exists: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					out.push({ file, path: target, content: "", exists: false });
				} else {
					throw error;
				}
			}
		}
		return out;
	}

	async writeMemory(file: "AGENTS.md" | "CLAUDE.md", content: string, conversationId?: string): Promise<MemoryFileEntry> {
		this.assertWritableMode("修改项目记忆文件", conversationId);
		if (file !== "AGENTS.md" && file !== "CLAUDE.md") throw new Error("仅支持 AGENTS.md 或 CLAUDE.md。");
		const source = await this.writeMemoryFile(file, content, conversationId);
		return { file, path: source.path, content, exists: true };
	}

	saveSettings(settings: {
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
		grailModel?: { provider: string; id: string } | null;
		grailMaxCost?: number | null;
		grailTimeoutSec?: number | null;
		disableAllHooks?: boolean;
		fallbackModel?: { provider: string; id: string } | null;
		outputStyle?: string | null;
		editor?: EditorChoice;
		statusBalance?: boolean;
		webSearchEnabled?: boolean;
		webSearchApiKey?: string;
		provider?: Provider;
		apiKey?: string;
		keyCommand?: string;
		headers?: Record<string, string>;
		useAsDefault?: boolean;
		baseUrl?: string;
		modelId?: string;
		agentDir?: string;
		api?: ConnectionProtocol;
		mode?: ConnectionMode;
	}): Promise<Snapshot> {
		return this.serialize(async () => {
			const next: StoredState = structuredClone(this.store);
			next.settings.permission = settings.permission;
			next.settings.theme = settings.theme;
			if (settings.sandbox !== undefined) next.settings.sandbox = settings.sandbox;
			if (settings.sandboxOffline !== undefined) next.settings.sandboxOffline = settings.sandboxOffline;
			if (!next.settings.sandbox) next.settings.sandboxOffline = false;
			if (next.settings.sandbox && !(await probeSeatbeltSupport()).supported)
				throw new Error("此系统无法启动命令沙箱，请在设置中关闭沙箱后重试。");
			if (settings.notifications !== undefined) next.settings.notifications = settings.notifications;
			if (settings.subagentDefaultBackground !== undefined) {
				if (typeof settings.subagentDefaultBackground !== "boolean") throw new Error("子 Agent 默认后台设置无效。");
				next.settings.subagentDefaultBackground = settings.subagentDefaultBackground;
			}
			if (settings.foregroundSubagentTimeoutMs !== undefined) {
				const value = settings.foregroundSubagentTimeoutMs;
				if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS)
					throw new Error("前台子 Agent 等待时长无效。");
				next.settings.foregroundSubagentTimeoutMs = value;
			}
			if (settings.forkSubagent !== undefined) {
				if (typeof settings.forkSubagent !== "boolean") throw new Error("子 Agent fork 开关设置无效。");
				next.settings.forkSubagent = settings.forkSubagent;
			}
			if (settings.confineSubagentBash !== undefined) {
				if (typeof settings.confineSubagentBash !== "boolean") throw new Error("子 Agent 沙箱隔离设置无效。");
				next.settings.confineSubagentBash = settings.confineSubagentBash;
			}
			if (settings.maxSubagentDepth !== undefined) {
				const value = settings.maxSubagentDepth;
				if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DELEGATION_DEPTH)
					throw new Error("子 Agent 最大嵌套深度无效。");
				next.settings.maxSubagentDepth = value;
			}
			if (settings.maxConcurrentSubagents !== undefined) {
				const value = settings.maxConcurrentSubagents;
				if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENT_SUBAGENTS_LIMIT)
					throw new Error("最大并发子 Agent 数量无效。");
				next.settings.maxConcurrentSubagents = value;
			}
			if (settings.cronEnabled !== undefined) {
				if (typeof settings.cronEnabled !== "boolean") throw new Error("定时唤醒开关设置无效。");
				next.settings.cronEnabled = settings.cronEnabled;
			}
			if (settings.agentTeams !== undefined) {
				if (typeof settings.agentTeams !== "boolean") throw new Error("实验性 Agent Teams 开关设置无效。");
				next.settings.agentTeams = settings.agentTeams;
			}
			if (settings.modelRouting !== undefined) {
				const routing = parseModelRoutingUpdate(settings.modelRouting);
				if (Object.keys(routing).length) next.settings.modelRouting = routing;
				else delete next.settings.modelRouting;
			}
			if (settings.maxCostUsd !== undefined) {
				const value = settings.maxCostUsd;
				if (value === null) delete next.settings.maxCostUsd;
				else if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > 100000)
					throw new Error("费用上限需为 0.01–100000 美元。");
				else next.settings.maxCostUsd = Math.round(value * 100) / 100;
			}
			if (settings.minBalance !== undefined) {
				const value = settings.minBalance;
				if (value === null) delete next.settings.minBalance;
				else if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > 1000000)
					throw new Error("余额底线需为 0.01–1000000。");
				else next.settings.minBalance = Math.round(value * 100) / 100;
			}
			if (settings.grailModel !== undefined) {
				const ref = parseGrailModelUpdate(settings.grailModel);
				if (ref) next.settings.grailModel = ref;
				else delete next.settings.grailModel;
			}
			if (settings.grailMaxCost !== undefined) {
				const value = settings.grailMaxCost;
				if (value === null) delete next.settings.grailMaxCost;
				else if (!validGrailMaxCost(value)) throw new Error("单次鉴定费用上限需为 0.01–1000 美元。");
				else next.settings.grailMaxCost = Math.round(value * 100) / 100;
			}
			if (settings.grailTimeoutSec !== undefined) {
				const value = settings.grailTimeoutSec;
				if (value === null) delete next.settings.grailTimeoutSec;
				else if (!validGrailTimeout(value)) throw new Error("鉴定超时需为 30–7200 秒的整数。");
				else next.settings.grailTimeoutSec = value;
			}
			if (settings.disableAllHooks !== undefined) {
				if (typeof settings.disableAllHooks !== "boolean") throw new Error("Hooks 开关设置无效。");
				if (settings.disableAllHooks) next.settings.disableAllHooks = true;
				else delete next.settings.disableAllHooks;
			}
			if (settings.fallbackModel !== undefined) {
				const ref = parseFallbackModelUpdate(settings.fallbackModel);
				if (ref) next.settings.fallbackModel = ref;
				else delete next.settings.fallbackModel;
			}
			if (settings.outputStyle !== undefined) {
				if (settings.outputStyle === null) delete next.settings.outputStyle;
				else {
					const name = validOutputStyleName(settings.outputStyle);
					if (!name) throw new Error("输出风格名称无效。");
					if (name.toLowerCase() === DEFAULT_OUTPUT_STYLE) delete next.settings.outputStyle;
					else {
						const style = findOutputStyle(await this.discoverStyles(this.active()?.project), name);
						if (!style) throw new Error(`找不到输出风格：${name.slice(0, 100)}`);
						next.settings.outputStyle = style.name;
					}
				}
			}
			if (settings.editor !== undefined) {
				if (!EDITOR_CHOICES.includes(settings.editor)) throw new Error("编辑器设置无效。");
				next.settings.editor = settings.editor;
			}
			if (settings.statusBalance !== undefined) {
				if (typeof settings.statusBalance !== "boolean") throw new Error("状态栏余额开关设置无效。");
				if (settings.statusBalance) delete next.settings.statusBalance;
				else next.settings.statusBalance = false;
			}
			if (settings.webSearchEnabled !== undefined) {
				if (typeof settings.webSearchEnabled !== "boolean") throw new Error("网络搜索开关设置无效。");
				if (settings.webSearchEnabled) delete next.settings.webSearchEnabled;
				else next.settings.webSearchEnabled = false;
			}
			if (settings.webSearchApiKey !== undefined) {
				const trimmedKey = settings.webSearchApiKey.trim();
				if (!trimmedKey) delete next.webSearchApiKey;
				else {
					if (!this.options.encrypt) throw new Error("系统安全存储不可用，未保存 WebSearch API Key。");
					next.webSearchApiKey = this.options.encrypt(trimmedKey);
				}
			}
			if (settings.proxy !== undefined) {
				const value = validateProxyUrl(settings.proxy);
				if (value) next.settings.proxy = value;
				else delete next.settings.proxy;
			}
			if (settings.noProxy !== undefined) {
				const value = settings.noProxy.trim();
				if (/[\r\n\0]/.test(value) || value.length > 4096) throw new Error("代理例外格式错误。");
				if (value) next.settings.noProxy = value;
				else delete next.settings.noProxy;
			}
			if (settings.caFile !== undefined) {
				const value = settings.caFile.trim();
				if (value) {
					const path = resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
					if (!isAbsolute(value) && !value.startsWith("~/")) throw new Error("CA 证书需填写绝对路径。");
					if (!(await stat(path).then((info) => info.isFile(), () => false))) throw new Error("找不到 CA 证书文件。");
					next.settings.caFile = path;
				} else delete next.settings.caFile;
			}
			if (settings.agentDir !== undefined) {
				const value = settings.agentDir.trim();
				if (value) {
					const path = resolve(
						value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
					);
					if (path !== this.defaultAgentDir()) {
						if (!(await stat(path)).isDirectory()) throw new Error("Pi 配置路径必须是已存在的文件夹。");
						next.settings.agentDir = await realpath(path);
					} else next.settings.agentDir = path;
				} else delete next.settings.agentDir;
			}
			if (settings.provider) {
				const provider = settings.provider;
				const stored = next.settings.connections[provider];
				const mode = connectionMode({ ...settings, provider }, stored);
				const preset = providerPresets.find((item) => item.provider === provider)!;
				let connection: NonNullable<Settings["connections"][Provider]>;
				if (mode === "preset") {
					const candidate = settings.modelId === undefined ? stored?.modelId : settings.modelId.trim();
					const modelId =
						candidate && providerModels[provider].some((model) => model.id === candidate)
							? candidate
							: preset.defaultModelId;
					if (settings.modelId?.trim() && settings.modelId.trim() !== modelId)
						throw new Error("请选择该服务商的内置模型，或切换到自定义连接填写模型 ID。");
					connection = {
						mode,
						modelId,
						...(stored?.keyCommand ? { keyCommand: stored.keyCommand } : {}),
						...(stored?.headerNames ? { headerNames: stored.headerNames } : {}),
					};
				} else {
					connection = { ...stored, mode };
					if (settings.baseUrl !== undefined) connection.baseUrl = validateEndpoint(settings.baseUrl);
					if (settings.api !== undefined) connection.api = settings.api;
					connection.modelId =
						settings.modelId === undefined
							? (stored?.modelId ?? preset.defaultModelId)
							: settings.modelId.trim() || undefined;
				}
				if (settings.apiKey?.trim()) {
					if (!this.options.encrypt) throw new Error("系统安全存储不可用，未保存 API Key。");
					next.keys[provider] = this.options.encrypt(settings.apiKey.trim());
				}
				if (settings.keyCommand !== undefined) {
					const command = validateKeyCommand(settings.keyCommand);
					if (command) connection.keyCommand = command;
					else delete connection.keyCommand;
				}
				if (settings.headers !== undefined) {
					const headers = validateHeaders(settings.headers);
					next.headerKeys ??= {};
					if (Object.keys(headers).length) {
						if (!this.options.encrypt) throw new Error("系统安全存储不可用，未保存请求头。");
						next.headerKeys[provider] = this.options.encrypt(JSON.stringify(headers));
						connection.headerNames = Object.keys(headers);
					} else {
						delete next.headerKeys[provider];
						delete connection.headerNames;
					}
				}
				const authenticated = Boolean(next.keys[provider] || connection.keyCommand);
				if (authenticated && !connection.modelId)
					throw new Error("请填写此连接的模型 ID；留空密钥会保留已保存的认证。");
				next.settings.connections[provider] = connection;
				if (connection.modelId && authenticated && settings.useAsDefault !== false)
					next.settings.defaultModel = { provider: `desktop-${provider}`, id: connection.modelId };
			}
			const permissionChanged = next.settings.permission !== this.store.settings.permission;
			const escalationChanged =
				fallbackKey(next.settings.modelRouting?.plan) !== fallbackKey(this.store.settings.modelRouting?.plan) ||
				fallbackKey(next.settings.modelRouting?.review) !== fallbackKey(this.store.settings.modelRouting?.review);
			const needsRestart =
				Boolean(next.settings.sandbox) !== Boolean(this.store.settings.sandbox) ||
				Boolean(next.settings.sandboxOffline) !== Boolean(this.store.settings.sandboxOffline) ||
				(next.settings.webSearchEnabled !== false) !== (this.store.settings.webSearchEnabled !== false) ||
				next.webSearchApiKey !== this.store.webSearchApiKey ||
				Boolean(next.settings.agentTeams) !== Boolean(this.store.settings.agentTeams) ||
				next.settings.agentDir !== this.store.settings.agentDir ||
				next.settings.proxy !== this.store.settings.proxy ||
				next.settings.noProxy !== this.store.settings.noProxy ||
				next.settings.caFile !== this.store.settings.caFile ||
				next.settings.maxCostUsd !== this.store.settings.maxCostUsd ||
				next.settings.minBalance !== this.store.settings.minBalance ||
				fallbackKey(next.settings.fallbackModel) !== fallbackKey(this.store.settings.fallbackModel) ||
				Boolean(settings.provider);
			if (needsRestart) this.assertIdle();
			const styleChanged = next.settings.outputStyle !== this.store.settings.outputStyle;
			this.store = next;
			this.remoteJobs.reschedule();
			await this.persist();
			if (permissionChanged) await this.closeReadRestrictedTerminals();
			if (settings.cronEnabled !== undefined) this.cron.onEnabledChanged();
			// Running main conversations pick up the new style on their next turn.
			if (styleChanged && !needsRestart)
				for (const runtime of this.runtimes.values()) await this.writeOutputStyle(runtime).catch(() => {});
			if (needsRestart) {
				for (const runtime of [...this.runtimes.values()]) await this.stopRuntime(runtime);
				const active = this.active();
				if (active) await this.activate(active);
				const connection = settings.provider && this.store.settings.connections[settings.provider];
				const runtime = active && this.runtimes.get(active.id);
				if (settings.provider && settings.useAsDefault !== false && connection?.modelId && this.providerAuthenticated(settings.provider) && runtime?.agent) {
					await runtime.agent.request({
						type: "set_model",
						provider: `desktop-${settings.provider}`,
						modelId: connection.modelId,
					});
					await this.syncState(runtime);
				}
			} else if (permissionChanged) await this.refreshControls("permissions_changed");
			else if (escalationChanged) {
				for (const runtime of this.runtimes.values()) {
					if (runtime.escalationFile && !runtime.stopping) await this.writeRuntimeControls(runtime);
				}
			}
			return this.buildSnapshot();
		});
	}

	testConnection(input: ConnectionInput): Promise<ConnectionTestResult> {
		const test = this.connectionTestOperation.then(async () => {
			await this.operation;
			if (this.closed) throw new Error("桌面服务已关闭。");
			const stored = this.store.settings.connections[input.provider];
			const mode = connectionMode(input, stored);
			const preset = providerPresets.find((item) => item.provider === input.provider)!;
			const candidate = input.modelId === undefined ? stored?.modelId : input.modelId.trim();
			const modelId =
				mode === "preset"
					? candidate && providerModels[input.provider].some((model) => model.id === candidate)
						? candidate
						: preset.defaultModelId
					: input.modelId === undefined
						? (stored?.modelId ?? preset.defaultModelId)
						: input.modelId.trim();
			let key = input.apiKey?.trim();
			const encrypted = this.store.keys[input.provider];
			if (!key && encrypted && this.options.decrypt) key = this.options.decrypt(encrypted);
			const keyCommand = key
				? undefined
				: input.keyCommand !== undefined
					? validateKeyCommand(input.keyCommand)
					: stored?.keyCommand;
			if (!key && !keyCommand) return { success: false, message: "请填写 API Key 或取 Key 命令，或先保存此服务商的密钥。" };
			const headers = input.headers !== undefined ? validateHeaders(input.headers) : this.connectionHeaders(input.provider);
			if (!modelId) return { success: false, message: "请填写服务商提供的模型 ID。" };
			if (mode === "preset" && input.modelId?.trim() && input.modelId.trim() !== modelId)
				return { success: false, message: "请选择该服务商的内置模型，或切换到自定义连接填写模型 ID。" };
			const baseUrl = mode === "custom" ? validateEndpoint(input.baseUrl ?? stored?.baseUrl ?? "") : undefined;
			const temporary = await mkdtemp(join(this.options.dataDir, "connection-check-"));
			let agent: AgentProcess | undefined;
			let timer: NodeJS.Timeout | undefined;
			const started = Date.now();
			try {
				if (this.closed) throw new Error("桌面服务已关闭。");
				const envKey = `PI_DESKTOP_KEY_${input.provider.toUpperCase()}`;
				const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
				let resultMessage: Extract<Message, { role: "assistant" }> | undefined;
				let settle: () => void = () => {};
				let fail: (error: Error) => void = () => {};
				const completion = new Promise<void>((resolve, reject) => {
					settle = resolve;
					fail = reject;
				});
				const env: NodeJS.ProcessEnv = {
					...process.env,
					...this.options.env,
					PI_CODING_AGENT_DIR: temporary,
					PI_SKIP_VERSION_CHECK: "1",
					PI_OFFLINE: "1",
					PI_DESKTOP_CONNECTION_TEST: "1",
					...networkEnvironment(this.store.settings),
					...(key ? { [envKey]: key } : {}),
					...(keyCommand ? { [`${envKey}_COMMAND`]: keyCommand } : {}),
					...(headers && Object.keys(headers).length ? { [`${envKey}_HEADERS`]: JSON.stringify(headers) } : {}),
					PI_DESKTOP_CONNECTIONS: JSON.stringify({
						[input.provider]: {
							mode,
							baseUrl,
							modelId,
							api: mode === "custom" ? (input.api ?? stored?.api) : undefined,
							envKey: key ? envKey : undefined,
							keyCommandEnv: keyCommand ? `${envKey}_COMMAND` : undefined,
							headersEnv: headers && Object.keys(headers).length ? `${envKey}_HEADERS` : undefined,
							presetBaseUrl: this.options.providerBaseUrls?.[input.provider],
						},
					}),
				};
				agent = new AgentProcess({
					executable: this.options.executable,
					entry: this.options.entry ?? join(runtimeDir, "dist/bundle/rpc-entry.js"),
					cwd: temporary,
					args: [
						"--no-session",
						"--no-tools",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-context-files",
						"--no-approve",
						"--extension",
						this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
						"--provider",
						`desktop-${input.provider}`,
						"--model",
						modelId,
					],
					env,
					onEvent: (event) => {
						if (event.type === "message_end" && event.message.role === "assistant") resultMessage = event.message;
						if (event.type === "agent_settled") settle();
						if (event.type === "desktop_error") fail(new Error(event.message));
					},
				});
				this.connectionCheck = { agent, cancel: fail };
				timer = setTimeout(() => fail(new Error("连接测试超过 30 秒，请检查地址、协议、网络或模型 ID。")), 30000);
				// Subscribe before prompting and race startup against the same deadline.
				const request = agent.request({ type: "prompt", message: "Reply with OK only." });
				await Promise.all([request, completion]);
				if (!resultMessage || resultMessage.stopReason === "error" || resultMessage.stopReason === "aborted")
					throw new Error(resultMessage?.errorMessage ?? "模型未返回有效回复。");
				if (!resultMessage.content.some((block) => block.type === "text" && block.text.trim()))
					throw new Error("模型未返回文本，请检查协议与模型 ID 是否匹配。");
				return {
					success: true,
					message: "连接成功，模型已返回有效回复。",
					model: modelId,
					latencyMs: Date.now() - started,
				};
			} catch (error) {
				let message = error instanceof Error ? error.message : String(error);
				for (const secret of [key, ...Object.values(headers ?? {})])
					if (secret && secret.length >= 4) message = message.replaceAll(secret, "[已隐藏密钥]");
				return { success: false, message: message.slice(0, 1200), latencyMs: Date.now() - started };
			} finally {
				clearTimeout(timer);
				await agent?.stop();
				this.connectionCheck = undefined;
				await rm(temporary, { recursive: true, force: true });
			}
		});
		this.connectionTestOperation = test.then(() => {}, () => {});
		return test;
	}

	async exportConversation(outputPath: string): Promise<string> {
		const runtime = await this.ensureRuntime(this.requireActive());
		const result = await this.requireAgent(runtime).request<{ path: string }>({ type: "export_html", outputPath });
		return result.path;
	}

	subscribeGrail(listener: (event: GrailEvent) => void): () => void {
		this.grailListeners.add(listener);
		return () => this.grailListeners.delete(listener);
	}

	private emitGrail(event: GrailEvent): void {
		for (const listener of this.grailListeners) {
			try { listener(event); }
			catch (error) { this.diagnostic("warn", "grail.event.failed", event.conversationId, error instanceof Error ? error.message : String(error)); }
		}
	}

	private grailFile(conversationId: string): string {
		if (!/^[A-Za-z0-9-]{1,200}$/.test(conversationId)) throw new Error("会话 ID 无效。");
		return join(this.options.dataDir, "grail", `${conversationId}.json`);
	}

	/** Judge records live beside, never inside, the Pi session, so the coding agent cannot see them. */
	private async readGrail(conversationId: string): Promise<GrailRecord> {
		try {
			const value: unknown = JSON.parse(await readFile(this.grailFile(conversationId), "utf8"));
			const record = value as Partial<GrailRecord>;
			if (record?.version === 1 && Array.isArray(record.sealedAt) && Array.isArray(record.verdicts))
				return {
					version: 1,
					sealedAt: record.sealedAt.filter((item): item is number => Number.isFinite(item)),
					verdicts: record.verdicts.filter((item) => item && typeof item === "object" && typeof item.grade === "string"),
				};
			throw new Error("鉴定历史格式无效。");
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error("鉴定历史文件无法解析。", { cause: error });
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return { version: 1, sealedAt: [], verdicts: [] };
	}

	private updateGrail<T>(conversationId: string, change: (record: GrailRecord) => T, beforePublish?: () => void): Promise<T> {
		const run = (this.grailWrites.get(conversationId) ?? Promise.resolve()).then(async () => {
			const record = await this.readGrail(conversationId);
			const result = change(record);
			await mkdir(join(this.options.dataDir, "grail"), { recursive: true, mode: 0o700 });
			await this.atomicJson(this.grailFile(conversationId), record, beforePublish);
			return result;
		});
		const done = run.then(() => {}, () => {});
		this.grailWrites.set(conversationId, done);
		void done.then(() => {
			if (this.grailWrites.get(conversationId) === done) this.grailWrites.delete(conversationId);
		});
		return run;
	}

	/** The wish starts at the conversation start or the last seal; its diff starts at its first checkpoint. */
	private async grailWish(conversation: Conversation, record: GrailRecord) {
		const since = record.sealedAt.at(-1) ?? 0;
		const wish = record.sealedAt.length;
		try {
			const workspace = await this.workspace(conversation.id);
			if (!workspace.isGit) return { wish, since, readiness: "not-git" as const, reason: "当前项目不在 Git 仓库中，无法比较需求开始前后的改动。" };
			const checkpoints = await this.git.list(conversation.project, conversation.id);
			const checkpoint = checkpoints.filter((item) => item.kind !== "discard-undo" && item.createdAt >= since).at(-1);
			if (!checkpoint) return { wish, since, readiness: "no-checkpoint" as const, reason: "当前需求还没有 Git 检查点。请先在 Git 项目中运行一轮编码任务。" };
			return { wish, since, readiness: "ready" as const, checkpoint };
		} catch {
			return { wish, since, readiness: "snapshot-error" as const, reason: "无法读取 Git 状态或检查点。请确认工作目录和检查点可访问。" };
		}
	}

	async grailState(conversationId: string): Promise<GrailState> {
		await this.operation;
		const conversation = this.conversation(conversationId);
		const record = await this.readGrail(conversation.id);
		const scope = await this.grailWish(conversation, record);
		const running = this.grailRuns.get(conversation.id);
		let readiness: GrailState["readiness"] = scope.readiness;
		let readinessReason = scope.reason;
		if (scope.checkpoint && !running) {
			try {
				if (!await this.git.hasWorktreeChanges(conversation.project, scope.checkpoint.id, conversation.id)) {
					readiness = "clean";
					readinessReason = "当前代码与需求开始时的快照一致。";
				}
			} catch {
				readiness = "snapshot-error";
				readinessReason = "无法比较当前代码和 Git 检查点。请确认工作目录和检查点可访问。";
			}
		}
		return {
			conversationId: conversation.id,
			wish: scope.wish,
			running: running && { id: running.id, step: running.step, startedAt: running.startedAt },
			verdicts: record.verdicts,
			hasDiff: readiness === "ready",
			readiness,
			readinessReason,
		};
	}

	/** Read the selected raw session branch. Compaction only affects the model's context. */
	private async grailRequirements(conversation: Conversation, since: number, until: number, signal: AbortSignal): Promise<string[]> {
		const agent = this.runtimes.get(conversation.id)?.agent;
		const history = agent
			? await agent.request<SessionEntriesResult>({ type: "get_entries" }, signal)
			: conversation.sessionFile ? await this.history.inspect({ sessionFile: conversation.sessionFile, leafId: conversation.sessionLeafId }, signal) : undefined;
		signal.throwIfAborted();
		if (!history?.leafId) return [];
		const entries = new Map(history.entries.map((entry) => [entry.id, entry]));
		const requirements: string[] = [];
		let id: string | null = history.leafId;
		while (id) {
			const entry = entries.get(id);
			if (!entry) throw new Error("会话分支的原始记录不完整，无法确认需求范围。");
			entries.delete(id);
			id = entry.parentId;
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const { content, timestamp } = entry.message;
			if (timestamp < since || timestamp > until) continue;
			const text = typeof content === "string" ? visiblePromptText(content) : content
				.flatMap((block) => block.type === "text" && !isDesktopWorkspaceContext(block.text) ? [block.text] : []).join("\n");
			if (text.trim()) requirements.push(text);
		}
		return requirements.reverse();
	}

	async cancelGrail(conversationId: string): Promise<boolean> {
		const run = this.grailRuns.get(conversationId);
		if (!run) return false;
		const cancelled = !run.committing && !run.controller.signal.aborted;
		if (cancelled) run.controller.abort(new DOMException("鉴定已取消。", "AbortError"));
		await run.finished;
		return cancelled;
	}

	sealGrailWish(conversationId: string): Promise<GrailState> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			await this.cancelGrail(conversation.id);
			const wish = await this.updateGrail(conversation.id, (record) => {
				record.sealedAt.push(Math.max(Date.now(), (record.sealedAt.at(-1) ?? 0) + 1));
				return record.sealedAt.length;
			});
			this.emitGrail({ type: "grail_sealed", conversationId: conversation.id, wish });
		}).then(() => this.grailState(conversationId));
	}

	/** User-initiated Grail judgement; progress and the verdict arrive through subscribeGrail. */
	startGrail(conversationId: string): Promise<{ id: string }> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			const existing = this.grailRuns.get(conversation.id);
			if (existing?.controller.signal.aborted) throw new Error("上一次鉴定仍在清理，请稍后重试。");
			if (existing) return { id: existing.id };
			const active = this.runtimes.get(conversation.id);
			if (active?.checkpointId || active?.checkpointStarting) throw new Error("请等待当前任务结束后再发起鉴定。");
			if (active) this.assertRuntimeIdle(active);
			const startedAt = Date.now();
			const run: GrailRun = {
				id: randomUUID(), controller: new AbortController(), step: "diff", startedAt,
				deadline: startedAt + (this.store.settings.grailTimeoutSec ?? DEFAULT_GRAIL_TIMEOUT_SEC) * 1000,
				committing: false,
				finished: Promise.resolve().then(() => this.finishGrail(conversation, run)),
			};
			this.grailRuns.set(conversation.id, run);
			return { id: run.id };
		});
	}

	private async finishGrail(conversation: Conversation, run: GrailRun): Promise<void> {
		const { signal } = run.controller;
		const timeout = new DOMException("鉴定超时。", "TimeoutError");
		const timer = setTimeout(() => {
			if (!run.committing) run.controller.abort(timeout);
		}, Math.max(0, run.deadline - Date.now()));
		let terminal: GrailEvent;
		try {
			const verdict = await this.runGrail(conversation, run);
			signal.throwIfAborted();
			await this.updateGrail(conversation.id, (record) => {
				verdict.previousGrade = record.verdicts.filter((item) => item.wish === verdict.wish).at(-1)?.grade;
				record.verdicts.push(verdict);
				record.verdicts.splice(0, Math.max(0, record.verdicts.length - 200));
			}, () => {
				signal.throwIfAborted();
				if (Date.now() >= run.deadline) throw timeout;
				// Once the atomic rename is submitted, cancelling cannot retract the report.
				run.committing = true;
			});
			terminal = { type: "grail_verdict", conversationId: conversation.id, verdict };
		} catch (error) {
			const reason: unknown = signal.aborted ? signal.reason : error;
			terminal = {
				type: "grail_failed", conversationId: conversation.id, id: run.id,
				error: reason instanceof Error ? reason.message : String(reason),
				cancelled: signal.aborted && reason instanceof Error && reason.name === "AbortError",
			};
		} finally {
			clearTimeout(timer);
			this.grailRuns.delete(conversation.id);
		}
		this.emitGrail(terminal);
	}

	private async runGrail(conversation: Conversation, run: GrailRun): Promise<GrailVerdict> {
		run.controller.signal.throwIfAborted();
		const scratch = await mkdtemp(join(tmpdir(), "pi-grail-review-"));
		try {
			run.controller.signal.throwIfAborted();
			return await this.reviewGrailSnapshot(conversation, run, scratch);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	private async reviewGrailSnapshot(
		conversation: Conversation,
		run: GrailRun,
		scratch: string,
	): Promise<GrailVerdict> {
		const signal = run.controller.signal;
		const settings = this.store.settings;
		const deadline = run.deadline;
		const budget = { spent: 0, max: settings.grailMaxCost ?? DEFAULT_GRAIL_MAX_COST };
		const step = (name: GrailStep) => {
			if (signal.aborted) throw new Error("鉴定已取消。");
			run.step = name;
			this.emitGrail({ type: "grail_progress", conversationId: conversation.id, id: run.id, step: name });
		};
		const record = await this.readGrail(conversation.id);
		const { wish, since, checkpoint, reason } = await this.grailWish(conversation, record);
		const runtime = this.runtimes.get(conversation.id);
		const model = settings.grailModel ?? runtime?.state?.model ?? settings.defaultModel;
		const requirement = checkpoint ? await this.grailRequirements(conversation, since, run.startedAt, signal) : [];
		const steps: GrailStepResults = {};
		let files: GrailVerdict["files"] = [];
		let evidence: GrailVerdict["evidence"];
		const finish = (): GrailVerdict => ({
			id: run.id,
			conversationId: conversation.id,
			wish,
			startedAt: run.startedAt,
			finishedAt: Date.now(),
			...gradeVerdict(steps),
			steps,
			evidence,
			requirement,
			files,
			model: model ? { provider: model.provider, id: model.id } : undefined,
			costUsd: Math.round(budget.spent * 10000) / 10000,
		});
		step("diff");
		const unjudgeable = (reason: string): GrailVerdict => {
			steps.objective = skipObjectiveChecks(reason);
			return { ...finish(), grade: "unjudgeable", reasons: [reason] };
		};
		if (!checkpoint) return unjudgeable(reason ?? "当前需求没有 Git 检查点。");
		if (!requirement.length) return unjudgeable("这个愿望里没有用户需求消息。");
		if (requirement.reduce((size, message) => size + message.length, 0) > 200_000) return unjudgeable("需求原文过长，无法完整鉴定。请封存并用更小的需求范围重新鉴定。");
		const workspace = join(scratch, "selected");
		const objectiveRoot = join(scratch, "objective");
		const trusted = this.store.projectTrust?.[this.trustProjectFor(conversation.project)] !== "untrusted";
		const diff = await this.git.diffToWorktree(conversation.project, checkpoint.id, {
			selected: workspace, objective: trusted ? objectiveRoot : undefined,
		}, signal);
		signal.throwIfAborted();
		if (diff.evidence) evidence = { source: diff.evidence };
		files = diff.files.map((file) => ({ path: file.path, status: file.status }));
		if (diff.excludedFiles) return unjudgeable("有文件超出 Git 快照容量，无法完整鉴定改动。");
		if (!diff.files.length) return unjudgeable("这个愿望没有代码改动。");
		const truncatedFile = diff.files.find((file) => file.truncated);
		if (truncatedFile) return unjudgeable(`文件差异超出单文件鉴定容量，无法完整鉴定：${truncatedFile.path}。`);
		const annotated = annotateDiff(diff.files);
		if (annotated.truncated) return unjudgeable("改动超出一次鉴定可评审的容量，无法完整鉴定。");
		const lines = parseDiffLines(diff.files);
		const changedTextFiles = new Set(lines.map((line) => line.file));
		const nonTextFile = diff.files.find((file) =>
			!changedTextFiles.has(file.path) || file.binary || file.status === "type-changed" ||
			file.beforeKind === "symlink" || file.afterKind === "symlink" ||
			(file.beforeMode !== undefined && file.afterMode !== undefined && file.beforeMode !== file.afterMode),
		);
		if (nonTextFile) return unjudgeable(`存在无法完整引用的非文本改动：${nonTextFile.path}。`);

		step("objective");
		if (!trusted)
			steps.objective = skipObjectiveChecks("项目被标记为不信任，不执行项目脚本。");
		else if (diff.objective && "project" in diff.objective)
			steps.objective = await this.grailObjective(diff.objective, objectiveRoot, scratch, deadline, signal);
		else steps.objective = skipObjectiveChecks(diff.objective?.reason ?? "客观检查工作区不可用。");
		signal.throwIfAborted();
		if (steps.objective.status !== "pass") return finish();

		step("distortion");
		steps.distortion = { hits: scanDistortions(lines) };
		if (steps.distortion.hits.some((hit) => !hit.review)) return finish();

		if (!model?.provider || !model.id) {
			steps.blind = { status: "unavailable", reason: "没有可用的评审模型。" };
			return finish();
		}
		step("blind");
		// The blind reviewer reads the repository as it was before this wish, never the agent's code.
		const before = await mkdtemp(join(tmpdir(), "pi-grail-blind-"));
		try {
			await this.git.materializeBefore(conversation.project, checkpoint.id, before, signal);
			signal.throwIfAborted();
			const output = await this.grailModelRun(before, model, buildBlindPrompt(requirement), budget, deadline, signal, conversation.id);
			steps.blind = parseBlindSolution(output);
		} catch (error) {
			if (signal.aborted) throw error;
			steps.blind = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			await rm(before, { recursive: true, force: true });
		}
		if (steps.blind.status !== "ok") return finish();

		step("comparison");
		try {
			const prompt = buildComparisonPrompt(requirement, steps.blind.solution!, annotated.text, steps.objective);
			steps.comparison = parseComparison(await this.grailModelRun(workspace, model, prompt, budget, deadline, signal, conversation.id), lines);
		} catch (error) {
			if (signal.aborted) throw error;
			steps.comparison = { status: "unavailable", reason: error instanceof Error ? error.message : String(error), findings: [], dropped: 0 };
		}
		return finish();
	}

	private async grailObjective(
		source: { repository: string; project: string }, objectiveRoot: string, scratch: string, deadline: number, signal: AbortSignal,
	): Promise<GrailObjectiveResult> {
		signal.throwIfAborted();
		const { repository, project } = source;
		let manifest: unknown;
		try {
			manifest = JSON.parse(await readFile(join(project, "package.json"), { encoding: "utf8", signal }));
		} catch (error) {
			signal.throwIfAborted();
			const reason = (error as NodeJS.ErrnoException).code === "ENOENT"
				? "第一版只支持 Node/TypeScript 项目：项目根目录没有 package.json。"
				: "package.json 无法解析。";
			return skipObjectiveChecks(reason);
		}
		try {
			let files: string[] = [];
			const inheritedManifests: unknown[] = [];
			const lockfiles = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
			for (let directory = project; ; directory = dirname(directory)) {
				signal.throwIfAborted();
				const sourceModules = join(repository, relative(objectiveRoot, directory), "node_modules");
				const frozenModules = join(directory, "node_modules");
				const directoryFiles = await readdir(directory);
				if (!files.length) files = directoryFiles.filter((name) => lockfiles.has(name));
				if (directory !== project && directoryFiles.includes("package.json")) {
					const inherited: unknown = await readFile(join(directory, "package.json"), { encoding: "utf8", signal })
						.then((content) => JSON.parse(content)).catch(() => undefined);
					signal.throwIfAborted();
					inheritedManifests.push(inherited);
				}
				if (await lstat(sourceModules).then((entry) => entry.isDirectory(), () => false))
					await cp(sourceModules, frozenModules, {
						recursive: true,
						force: false,
						verbatimSymlinks: true,
						mode: fsConstants.COPYFILE_FICLONE,
						filter: async (path, destination) => {
							signal.throwIfAborted();
							if (!(await lstat(path)).isSymbolicLink()) return true;
							const link = await readlink(path);
							const absolute = isAbsolute(link);
							const linked = absolute ? await realpath(link).catch(() => link) : resolve(dirname(path), link);
							if (!inside(repository, linked)) return false;
							if (!absolute) return true;
							const target = join(objectiveRoot, relative(repository, linked));
							await symlink(relative(dirname(destination), target) || ".", destination).catch((error) => {
								if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
							});
							return false;
						},
					});
				if (directory === objectiveRoot) break;
			}
			signal.throwIfAborted();
			let sandboxProfile: string | undefined;
			if (this.store.settings.sandbox && (await probeSeatbeltSupport()).supported) {
				sandboxProfile = join(scratch, "grail.sb");
				await writeFile(sandboxProfile, buildSeatbeltProfile(objectiveRoot, [], true), { mode: 0o600 });
			}
			return await runObjectiveChecks({
				project,
				manifest,
				inheritedManifests,
				files,
				env: scriptEnvironment({ ...process.env, ...this.options.env }, join(scratch, "npm-cache")),
				sandboxProfile,
				deadline,
				signal,
			});
		} catch (error) {
			signal.throwIfAborted();
			return skipObjectiveChecks(`无法准备客观检查环境：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** One reviewer run outside the conversation, like /btw; the blind solve may only read the repository. */
	private async grailModelRun(
		cwd: string,
		model: { provider: string; id: string },
		prompt: string,
		budget: { spent: number; max: number },
		deadline: number,
		signal: AbortSignal,
		conversationId: string,
	): Promise<string> {
		const assertCanReview = () => {
			signal.throwIfAborted();
			if (Date.now() >= deadline) throw new DOMException("鉴定超时。", "TimeoutError");
			if (budget.spent >= budget.max) throw new Error(`鉴定费用额度已用完（上限 $${budget.max}）。`);
		};
		assertCanReview();
		const traceId = this.options.tracing ? randomUUID() : "";
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...this.options.env,
			PI_SKIP_VERSION_CHECK: "1",
			PI_DESKTOP_CONNECTION_TEST: "0",
			PI_DESKTOP_GRAIL_REVIEW: "1",
			PI_DESKTOP_PERMISSION_MODE: "read",
			// Reuse the extension's before-provider-request budget check for follow-up tool turns.
			PI_DESKTOP_MAX_COST: String(budget.max - budget.spent),
			...networkEnvironment(this.store.settings),
		};
		delete env.PI_DESKTOP_MAX_COST_FILE;
		delete env.PI_DESKTOP_POLICY_FILE;
		delete env.PI_DESKTOP_SANDBOX_PROFILE;
		if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
		env.PI_DESKTOP_CONNECTIONS = JSON.stringify(this.connectionEnvironment(env));
		const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
		let agent: AgentProcess | undefined;
		let onAbort: (() => void) | undefined;
		let outcome: "success" | "error" = "error";
		const controls = await mkdtemp(join(tmpdir(), "pi-grail-controls-"));
		try {
			env.PI_DESKTOP_POLICY_FILE = join(controls, "permission.json");
			await this.atomicJson(env.PI_DESKTOP_POLICY_FILE, {
				version: 1, mode: "read", sandbox: true, rules: [], disabledTools: [], project: await realpath(cwd),
			} satisfies RuntimePermissionPolicy);
			assertCanReview();
			const priceFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
			let pricing: NonNullable<RpcSessionState["model"]>["cost"] | undefined;
			let last: Extract<Message, { role: "assistant" }> | undefined;
			let settle!: () => void;
			let fail!: (error: Error) => void;
			const completion = new Promise<void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
			agent = new AgentProcess({
				executable: this.options.executable,
				entry: this.options.entry ?? join(runtimeDir, "dist/bundle/rpc-entry.js"),
				cwd,
				args: [
					"--no-session",
					"--tools", "read,grep,find,ls",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-approve",
					"--extension",
					this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
					"--provider",
					model.provider,
					"--model",
					model.id,
				],
				env,
				onEvent: (event) => {
					// The host determines the outcome after checking budget and validating the response.
					if (event.type !== "agent_settled" && event.type !== "desktop_error")
						this.options.tracing?.observe(traceId, event, conversationId, undefined, undefined, "grail");
					if (event.type === "message_end" && event.message.role === "assistant") {
						last = event.message;
						const usage = last.usage;
						const cost = usage?.cost?.total;
						const activePricing = pricing;
						if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
							fail(new Error("评审模型没有返回有效的费用用量，鉴定已停止。"));
						} else if (cost === 0 && activePricing && priceFields.some((field) => activePricing[field] > 0 && usage[field] > 0)) {
							fail(new Error("评审模型消耗了计费 Token，却未报告费用，鉴定已停止。"));
						} else {
							budget.spent += cost;
							if (budget.spent > budget.max) fail(new Error(`鉴定费用超过上限 $${budget.max}。`));
							else if (budget.spent === budget.max && last.stopReason === "toolUse")
								fail(new Error(`鉴定费用额度已用完（上限 $${budget.max}）。`));
						}
					}
					// Nobody answers dialogs for the reviewer; anything needing approval is refused.
					if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method))
						void agent?.respond({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(() => {});
					if (event.type === "agent_settled") settle();
					if (event.type === "desktop_error") fail(new Error(event.message));
				},
			});
			onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("鉴定已取消。"));
			signal.addEventListener("abort", onAbort, { once: true });
			await Promise.all([(async () => {
				const state = await agent.request<RpcSessionState>({ type: "get_state" }, signal);
				const active = state.model;
				if (active?.provider !== model.provider || active.id !== model.id)
					throw new Error("无法加载指定的评审模型，请检查模型和连接设置。");
				const activePricing = active.cost;
				const provider = providers.find((item) => model.provider === item || model.provider === `desktop-${item}`);
				const catalogModel = provider && providerModels[provider].find((item) => item.id === model.id);
				const connection = provider && this.store.settings.connections[provider];
				const custom = model.provider.startsWith("desktop-") && provider && connection && connectionMode({ ...connection, provider }) === "custom";
				const freeCatalogModel = !custom && catalogModel && priceFields.every((field) => catalogModel.cost[field] === 0);
				if (!activePricing || !priceFields.every((field) => Number.isFinite(activePricing[field]) && activePricing[field] >= 0)
					|| (!freeCatalogModel && priceFields.every((field) => activePricing[field] === 0)))
					throw new Error("评审模型缺少可核算的价格，无法执行费用上限。请选择有价格信息的模型。");
				pricing = activePricing;
				assertCanReview();
				await agent.request({ type: "prompt", message: prompt }, signal);
			})(), completion]);
			signal.throwIfAborted();
			if (!last || last.stopReason === "error" || last.stopReason === "aborted")
				throw new Error(last?.errorMessage ?? "评审模型没有返回有效回复。");
			outcome = "success";
			return last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
			await agent?.stop();
			this.options.tracing?.finishRun(traceId, signal.reason?.name === "AbortError" ? "aborted" : signal.aborted ? "error" : outcome);
			await rm(controls, { recursive: true, force: true });
		}
	}

	async askBtw(question: string, conversationId?: string): Promise<BtwResult> {
		await this.operation;
		const q = question.trim();
		if (!q || q.length > 32768 || q.includes("\0")) throw new Error("请输入有效的侧问问题（/btw）。");
		const conv = this.conversation(conversationId);
		const runtime = this.runtimes.get(conv.id);
		const activeModel = runtime?.state?.model ?? this.store.settings.defaultModel;
		if (!activeModel?.provider || !activeModel?.id) throw new Error("当前会话未连接模型，无法发起 /btw 侧问。");
		const snapshot = await this.buildSnapshot(conv.id);
		const summaryTurns = snapshot.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.slice(-8)
			.map((m) => {
				const raw = typeof m.content === "string"
					? m.content
					: m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
				return `${m.role === "user" ? "User" : "Assistant"}: ${raw.slice(0, 800)}`;
			})
			.join("\n");
		const prompt = summaryTurns
			? `You are answering an ephemeral side question (/btw) that must NOT assume edits or tool calls. Here is the recent conversation excerpt for context:\n\n${summaryTurns}\n\n---\nSide question:\n${q}\n\nAnswer concisely and accurately in the same language.`
			: q;
		const temporary = await mkdtemp(join(this.options.dataDir, "btw-"));
		const traceId = this.options.tracing ? randomUUID() : "";
		let agent: AgentProcess | undefined;
		let timer: NodeJS.Timeout | undefined;
		const started = Date.now();
		try {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...this.options.env,
				PI_SKIP_VERSION_CHECK: "1",
				PI_DESKTOP_CONNECTION_TEST: "1",
				...networkEnvironment(this.store.settings),
			};
			if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
			env.PI_DESKTOP_CONNECTIONS = JSON.stringify(this.connectionEnvironment(env));
			const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
			let resultMessage: Extract<Message, { role: "assistant" }> | undefined;
			let settle!: () => void;
			let fail!: (error: Error) => void;
			const completion = new Promise<void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
			agent = new AgentProcess({
				executable: this.options.executable,
				entry: this.options.entry ?? join(runtimeDir, "dist/bundle/rpc-entry.js"),
				cwd: conv.project,
				args: [
					"--no-session",
					"--no-tools",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-approve",
					"--extension",
					this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
					"--provider",
					activeModel.provider,
					"--model",
					activeModel.id,
				],
				env,
				onEvent: (event) => {
					this.options.tracing?.observe(traceId, event, conv.id, undefined, resultMessage?.stopReason === "error", "btw", q);
					if (event.type === "message_end" && event.message.role === "assistant") resultMessage = event.message;
					if (event.type === "agent_settled") settle();
					if (event.type === "desktop_error") fail(new Error(event.message));
				},
			});
			timer = setTimeout(() => fail(new Error("/btw 请求超时（45 秒）。")), 45000);
			await Promise.all([agent.request({ type: "prompt", message: prompt }), completion]);
			if (!resultMessage || resultMessage.stopReason === "error" || resultMessage.stopReason === "aborted")
				throw new Error(resultMessage?.errorMessage ?? "侧问未返回有效回复。");
			const answer = resultMessage.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			return { question: q, answer, model: activeModel.id, latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
			await agent?.stop();
			this.options.tracing?.finishRun(traceId, "error");
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async draftCommitMessage(conversationId?: string): Promise<GitCommitDraft> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const conv = this.conversation(conversationId);
		const cwd = conv.project;
		const staged = await this.stagedGitChanges(cwd);
		if (!staged.files.length) throw new Error("请先暂存修改后再生成提交说明。");
		const fallback = (reason: NonNullable<GitCommitDraft["fallbackReason"]>): GitCommitDraft => {
			const allAdded = staged.files.every((file) => file.status === "A");
			const allDeleted = staged.files.every((file) => file.status === "D");
			const verb = allAdded ? "feat: 新增" : allDeleted ? "chore: 移除" : "chore: 更新";
			const names = staged.files.map((file) => basename(file.path).replace(/[\r\n\t]+/g, " "));
			const summary = names.length <= 3 ? names.join("、") : `${names.slice(0, 2).join("、")} 等 ${names.length} 个文件`;
			return { message: `${verb} ${summary}`, source: "fallback", fallbackReason: reason, stagedVersion: staged.version };
		};
		const runtime = this.runtimes.get(conv.id);
		const activeModel = runtime?.state?.model ?? this.store.settings.defaultModel;
		if (!activeModel?.provider || !activeModel?.id) {
			return fallback("no_model");
		}
		let statText: string;
		let cachedDiff: string;
		const diffArgs = [
			"--literal-pathspecs", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none",
		];
		try {
			[{ stdout: statText }, { stdout: cachedDiff }] = await Promise.all([
				exec("git", [...diffArgs, "--stat", "--", "."], { cwd, maxBuffer: 1024 * 1024, timeout: 10000 }),
				exec("git", [...diffArgs, "--", "."], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 }),
			]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
			await this.assertStagedGitVersion(cwd, staged.version);
			return fallback("large_diff");
		}
		await this.assertStagedGitVersion(cwd, staged.version);
		const prompt = [
			"你是资深工程师。请严格根据下方 `git diff --cached`（仅已暂存变更），拟定一条精炼准确的中文 Conventional Commit 提交说明（单行，不超过 60 字，使用 feat/fix/refactor/perf/docs/test/chore 前缀）。",
			"只输出这一行提交说明本身，禁止包含引号、Markdown 代码块或多行解释。",
			"",
			"### 暂存统计",
			statText.trim().slice(0, 1500),
			"",
			"### 暂存差异摘要",
			cachedDiff.slice(0, 10000),
		].join("\n");
		let agent: AgentProcess | undefined;
		let timer: NodeJS.Timeout | undefined;
		let firstLine: string | undefined;
		try {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...this.options.env,
				PI_SKIP_VERSION_CHECK: "1",
				PI_DESKTOP_CONNECTION_TEST: "1",
				...networkEnvironment(this.store.settings),
			};
			if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
			env.PI_DESKTOP_CONNECTIONS = JSON.stringify(this.connectionEnvironment(env));
			const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
			let resultMessage: Extract<Message, { role: "assistant" }> | undefined;
			let settle!: () => void;
			let fail!: (error: Error) => void;
			const completion = new Promise<void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
			agent = new AgentProcess({
				executable: this.options.executable,
				entry: this.options.entry ?? join(runtimeDir, "dist/bundle/rpc-entry.js"),
				cwd,
				args: [
					"--no-session",
					"--no-tools",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-approve",
					"--extension",
					this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
					"--provider",
					activeModel.provider,
					"--model",
					activeModel.id,
				],
				env,
				onEvent: (event) => {
					if (event.type === "message_end" && event.message.role === "assistant") resultMessage = event.message;
					if (event.type === "agent_settled") settle();
					if (event.type === "desktop_error") fail(new Error(event.message));
				},
			});
			timer = setTimeout(() => fail(new Error("生成提交说明超时。")), 30000);
			await Promise.all([agent.request({ type: "prompt", message: prompt }), completion]);
			if (resultMessage && resultMessage.stopReason !== "error" && resultMessage.stopReason !== "aborted") {
				firstLine = resultMessage.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.replace(/^```[^\n]*\n?/g, "")
					.replace(/```$/g, "")
					.split("\n")
					.map((line) => line.trim().replace(/^["'`]+|["'`]+$/g, ""))
					.find(Boolean);
			}
		} catch {
			// A connection failure or timeout can use the staged filenames instead.
		} finally {
			clearTimeout(timer);
			await agent?.stop();
		}
		await this.assertStagedGitVersion(cwd, staged.version);
		return firstLine ? { message: firstLine, source: "model", stagedVersion: staged.version } : fallback("model_unavailable");
	}

	/** Wait until a task satisfies `predicate` with no overall deadline; `TaskWaiters.wait` with timeout 0 returns at once. */
	private async waitTaskSettled(
		id: string,
		predicate: (task: DesktopTask) => boolean,
		signal?: AbortSignal,
	): Promise<DesktopTask | undefined> {
		const read = () => {
			const item = this.store.tasks.find((t) => t.id === id);
			return item && structuredClone(item);
		};
		for (;;) {
			const task = await this.waiters.wait(id, read, predicate, signal, 60000);
			if (!task || predicate(task) || this.closed) return task;
		}
	}

	private wakeSlotWaiters(): void {
		for (const wake of [...this.slotWaiters]) wake();
	}

	/** Reserve one subagent slot for `conversationId`, waiting while the concurrency cap is reached. */
	private async acquireSubagentSlot(conversationId: string, signal?: AbortSignal): Promise<void> {
		for (;;) {
			signal?.throwIfAborted();
			if (this.closed) throw new Error("桌面服务已关闭。");
			const maxConcurrent = this.store.settings.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
			const active = this.store.tasks.filter(
				(item) => item.parentConversationId === conversationId && ["queued", "running", "waiting_for_input"].includes(item.status),
			).length;
			const reserved = this.reservedSlots.get(conversationId) ?? 0;
			if (active + reserved < maxConcurrent) {
				this.reservedSlots.set(conversationId, reserved + 1);
				return;
			}
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					this.slotWaiters.delete(wake);
					signal?.removeEventListener("abort", aborted);
				};
				const wake = () => { done(); resolve(); };
				const aborted = () => { done(); reject(signal!.reason ?? new Error("aborted")); };
				this.slotWaiters.add(wake);
				signal?.addEventListener("abort", aborted, { once: true });
			});
		}
	}

	subscribeTasks(listener: (event: TaskEvent) => void): () => void {
		this.taskListeners.add(listener);
		return () => this.taskListeners.delete(listener);
	}

	subscribeControls(listener: (event: ControlEvent) => void): () => void {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	async listTools(conversationId?: string): Promise<DesktopToolInfo[]> {
		await this.operation;
		const runtime = await this.ensureRuntime(this.conversation(conversationId));
		return this.controlRequest(runtime, "list");
	}

	setToolEnabled(input: ToolToggleInput): Promise<DesktopToolInfo[]> {
		return this.serialize(async () => {
			const conversation = this.conversation(input.conversationId);
			const runtime = await this.ensureRuntime(conversation);
			const tools = await this.controlRequest(runtime, "list");
			if (!tools.some((tool) => tool.name === input.name)) throw new Error("工具未在此会话注册。");
			const scope = input.scope ?? "conversation";
			if (input.project !== undefined && !isAbsolute(input.project)) throw new Error("项目目录需要绝对路径。");
			const project = scope === "project" ? await realpath(input.project ?? conversation.project) : undefined;
			await this.toolSettings.toggle({ name: input.name, enabled: input.enabled, scope, project,
				conversationId: scope === "conversation" ? conversation.id : undefined });
			await this.refreshControls("tools_changed");
			return this.controlRequest(runtime, "list");
		});
	}

	async permissionSettings(conversationId?: string): Promise<PermissionSettings> {
		await this.operation;
		return { rules: this.toolSettings.rules(), effective: this.permissionPolicy(this.conversation(conversationId).id) };
	}

	setProjectLocalCompute(conversationId: string, blocked: unknown): Promise<PermissionSettings> {
		return this.serialize(async () => {
			if (typeof blocked !== "boolean") throw new Error("项目本机推理设置无效。");
			const conversation = this.conversation(conversationId);
			const projectPath = this.trustProjectFor(conversation.project);
			const project = this.store.projects.find((item) => item.path === projectPath);
			if (!project) throw new Error("项目未打开。");
			if (Boolean(project.blockLocalCompute) !== blocked) {
				if (blocked) project.blockLocalCompute = true;
				else delete project.blockLocalCompute;
				await this.persist();
				await this.refreshControls("permissions_changed");
			}
			return { rules: this.toolSettings.rules(), effective: this.permissionPolicy(conversation.id) };
		});
	}

	upsertPermission(input: PermissionRule): Promise<PermissionSettings> {
		return this.serialize(async () => {
			let rule = validatePermissionRule(input);
			if (rule.scope === "project") rule = { ...rule, project: await realpath(rule.project!) };
			if (rule.scope === "conversation") this.conversation(rule.conversationId);
			await this.toolSettings.upsert(rule);
			await this.refreshControls("permissions_changed");
			return { rules: this.toolSettings.rules(), effective: this.permissionPolicy(this.requireActive().id) };
		});
	}

	removePermission(id: string): Promise<PermissionSettings> {
		return this.serialize(async () => {
			await this.toolSettings.remove(id);
			await this.refreshControls("permissions_changed");
			return { rules: this.toolSettings.rules(), effective: this.permissionPolicy(this.requireActive().id) };
		});
	}

	async checkPermission(input: PermissionCheckInput) {
		await this.operation;
		return evaluatePermission(this.permissionPolicy(this.conversation(input.conversationId).id), input);
	}

	async delegatedTaskResult(id: string, options: { block?: boolean; timeout?: number } = {}) {
		await this.operation;
		const task = this.task(id);
		if (!task.parentConversationId) throw new Error("此任务不是模型委派任务。");
		return this.delegation.result(task.parentConversationId, { task_id: id, ...options });
	}

	private canDelegateFurther(conversationId: string): boolean {
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		if (!task) return true;
		if (task.quarantined || task.isFork || task.scopePaths) return false;
		const depth = task.delegationDepth ?? 1;
		const maxDepth = this.store.settings.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
		return Boolean(task.parentConversationId) && depth < maxDepth;
	}

	private permissionPolicy(conversationId: string): RuntimePermissionPolicy {
		const conversation = this.conversation(conversationId);
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		const isDelegatedChild = Boolean(task?.parentConversationId);
		const own = this.toolSettings.effective(conversation.project, conversationId);
		// A root conversation's `delegatedOnly` rules apply only to its delegated descendants,
		// never relaxing the root conversation itself.
		const ownRules = isDelegatedChild ? own.rules : own.rules.filter((rule) => !rule.delegatedOnly);
		const inherited = this.store.taskPolicies?.[conversationId];
		const parent = task?.parentConversationId ? this.permissionPolicy(task.parentConversationId) : undefined;
		const translateFrom = (sourceProject: string | undefined, rules: PermissionRule[] | undefined): PermissionRule[] =>
			(rules ?? []).map((rule) => {
				if (!rule.path || !sourceProject || !isAbsolute(rule.path) || !inside(sourceProject, rule.path)) return rule;
				return { ...rule, path: join(conversation.project, relative(sourceProject, rule.path)) };
			});
		const translate = (policy: RuntimePermissionPolicy | undefined): PermissionRule[] =>
			translateFrom(policy?.project, policy?.rules);
		const delegatedTreeRules: PermissionRule[] = [];
		if (isDelegatedChild) {
			let cursor = task?.parentConversationId;
			const visited = new Set<string>([conversationId]);
			while (cursor && !visited.has(cursor)) {
				visited.add(cursor);
				const ancestorConv = this.store.conversations.find((item) => item.id === cursor);
				if (ancestorConv) {
					const treeOnly = this.toolSettings
						.effective(ancestorConv.project, ancestorConv.id)
						.rules.filter((rule) => rule.delegatedOnly === true);
					delegatedTreeRules.push(...translateFrom(ancestorConv.project, treeOnly));
				}
				cursor = this.store.tasks.find((item) => item.conversationId === cursor)?.parentConversationId;
			}
		}
		// A child keeps its spawn ceiling and also receives later parent revocations and delegation-tree rules.
		const unique = new Map<string, PermissionRule>();
		for (const rule of [...translate(inherited), ...translate(parent), ...delegatedTreeRules, ...ownRules]) {
			const signature = JSON.stringify(rule);
			if (!unique.has(signature)) unique.set(signature, rule);
		}
		const ids = new Set<string>();
		const rules = [...unique.values()].map((rule) => {
			const result = ids.has(rule.id) ? { ...rule, id: `${rule.id.slice(0, 170)}.${createHash("sha256").update(JSON.stringify(rule)).digest("hex").slice(0, 16)}` } : rule;
			ids.add(result.id);
			return result;
		});
		const disabledTools = new Set(Object.entries(this.toolOverrides(conversationId)).filter(([, enabled]) => !enabled).map(([name]) => name));
		for (const name of inherited?.disabledTools ?? []) disabledTools.add(name);
		for (const name of parent?.disabledTools ?? []) disabledTools.add(name);
		if (!this.canDelegateFurther(conversationId)) for (const name of delegatingToolNames) disabledTools.add(name);
		if (isDelegatedChild || task?.quarantined) {
			for (const name of ["WorktreeCreate", "WorktreeMerge", "WorktreeRemove"]) disabledTools.add(name);
		}
		// Global "dontAsk" is the ask policy with every remaining prompt turned into a denial.
		const requested = conversation.permissionMode ?? parent?.mode ?? this.store.settings.permission;
		const globalDontAsk = requested === "dontAsk";
		const globalMode: RuntimePermissionPolicy["mode"] = globalDontAsk ? "ask" : (requested as RuntimePermissionPolicy["mode"]);
		const dontAsk = Boolean(globalDontAsk || inherited?.dontAsk || parent?.dontAsk);
		const parentCeiling = parent?.mode ?? globalMode;
		let mode: RuntimePermissionPolicy["mode"];
		if (task?.readOnly || task?.quarantined || parentCeiling === "read" || inherited?.mode === "read" || task?.permissionMode === "read") {
			mode = "read";
		} else if (parentCeiling === "plan" || inherited?.mode === "plan" || task?.permissionMode === "plan") {
			mode = "plan";
		} else if (task?.permissionMode === "acceptEdits") {
			mode = "acceptEdits";
		} else if (task?.permissionMode === "default") {
			mode = "ask";
		} else {
			const modes = [globalMode, inherited?.mode, parent?.mode].filter(
				(item): item is RuntimePermissionPolicy["mode"] => Boolean(item),
			);
			mode = modes.includes("ask") ? "ask" : modes.includes("acceptEdits") ? "acceptEdits" : "auto";
		}
		const serverLists = [inherited?.allowedMcpServers, parent?.allowedMcpServers, task?.mcpServers].filter(
			(list): list is string[] => list !== undefined,
		);
		const allowedMcpServers = serverLists.length
			? serverLists.reduce((acc, list) => acc.filter((name) => list.includes(name)))
			: undefined;
		const additionalDirs = Array.from(new Set([...(parent?.additionalDirs ?? []), ...(conversation.additionalDirs ?? [])]));
		const projectPath = this.trustProjectFor(conversation.project);
		const blockLocalCompute = parent?.blockLocalCompute ||
			this.store.projects.some((item) => item.path === projectPath && item.blockLocalCompute);
		return {
			version: 1,
			mode,
			...(blockLocalCompute ? { blockLocalCompute: true } : {}),
			...(dontAsk ? { dontAsk: true } : {}),
			...(this.store.settings.sandbox || inherited?.sandbox || parent?.sandbox || this.runtimes.get(conversationId)?.sandboxProfileFile
				? { sandbox: true }
				: {}),
			rules,
			disabledTools: [...disabledTools],
			...(allowedMcpServers !== undefined ? { allowedMcpServers } : {}),
			project: conversation.project,
			...(additionalDirs.length > 0 ? { additionalDirs } : {}),
			...(task?.scopePaths ? { readScope: task.scopePaths } : {}),
		};
	}

	private toolOverrides(conversationId: string): Record<string, boolean> {
		const conversation = this.conversation(conversationId);
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		const own = this.toolSettings.effective(conversation.project, conversationId).overrides;
		if (task?.quarantined && !task.parentConversationId) {
			return { ...own, Agent: false, SendMessage: false, AgentSend: false, WorktreeCreate: false, WorktreeMerge: false, WorktreeRemove: false };
		}
		if (!task?.parentConversationId) return own;
		const parent = this.conversation(task.parentConversationId);
		const inherited = this.toolSettings.effective(parent.project, parent.id).overrides;
		const canDelegate = this.canDelegateFurther(conversationId);
		const combined: Record<string, boolean> = {
			...inherited,
			...own,
			...(!canDelegate && !task.isFork ? { Agent: false, SendMessage: false, AgentSend: false } : {}),
			...(!task.isFork ? { WorktreeCreate: false, WorktreeMerge: false, WorktreeRemove: false } : {}),
		};
		for (const [name, enabled] of Object.entries(inherited)) if (!enabled) combined[name] = false;
		for (const name of this.store.taskPolicies?.[conversationId]?.disabledTools ?? []) {
			if (task.isFork && delegatingToolNames.includes(name as typeof delegatingToolNames[number])) continue;
			combined[name] = false;
		}
		return combined;
	}

	private writeRuntimeControls(runtime: SessionRuntime): Promise<void> {
		const write = (runtime.controlWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
			const policy = this.permissionPolicy(runtime.conversationId);
			if (runtime.policyFile) await this.atomicJson(runtime.policyFile, policy);
			if (runtime.escalationFile) {
				const { plan, review } = this.store.settings.modelRouting ?? {};
				await this.atomicJson(runtime.escalationFile, [plan, review].filter(Boolean));
			}
			runtime.sessionPermissionMode = policy.dontAsk ? "dontAsk" : policy.mode;
			if (runtime.sandboxProfileFile) {
				const conversation = this.store.conversations.find((item) => item.id === runtime.conversationId);
				if (conversation) {
					const worktreePaths = await resolveGitWorktreeWritablePaths(conversation.project);
					const extraWritable = [...worktreePaths, ...(policy.additionalDirs ?? [])];
					const profile = buildSeatbeltProfile(conversation.project, extraWritable, this.store.settings.sandboxOffline);
					const tmp = `${runtime.sandboxProfileFile}.tmp`;
					await writeFile(tmp, profile, { mode: 0o600 });
					await rename(tmp, runtime.sandboxProfileFile);
				}
			}
			if (runtime.controls) await this.atomicJson(join(runtime.controls.directory, "tools.json"), { overrides: this.toolOverrides(runtime.conversationId) });
			if (runtime.controls) await this.writeAgentListing(runtime).catch(() => {});
		});
		runtime.controlWrites = write;
		return write;
	}

	/**
	 * Agent types the conversation's model may delegate to, read by its tool-control
	 * extension before each run. Children cannot delegate, so they receive an empty list.
	 * Only trusted scopes are listed: an untrusted project contributes no project agents.
	 */
	private async writeAgentListing(runtime: SessionRuntime): Promise<void> {
		if (!runtime.controls) return;
		const conversation = this.conversation(runtime.conversationId);
		const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
		const delegating = this.canDelegateFurther(conversation.id) || Boolean(task?.isFork);
		const project = this.trustProjectFor(conversation.project);
		const definitions = delegating ? await this.agents.list(project, this.projectTrusted(project)) : [];
		await this.atomicJson(join(runtime.controls.directory, "agents.json"), buildAgentListing(definitions));
	}

	/** Rewrite every runtime's agent listing after definitions changed; takes effect next turn. */
	private async refreshAgentListings(): Promise<void> {
		for (const runtime of [...this.runtimes.values()].filter((item) => !item.stopping && item.controls))
			await this.writeRuntimeControls(runtime).catch(() => {});
	}

	private async atomicFile(path: string, content: string): Promise<void> {
		const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, content, { mode: 0o600 });
			await rename(temporary, path);
		} finally { await rm(temporary, { force: true }); }
	}

	private async atomicJson(path: string, value: unknown, beforePublish?: () => void): Promise<void> {
		const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
			beforePublish?.();
			await rename(temporary, path);
		} finally { await rm(temporary, { force: true }); }
	}

	private async refreshControls(type: ControlEvent["type"]): Promise<void> {
		const runtimes = [...this.runtimes.values()].filter((runtime) => !runtime.stopping);
		// Write all guards before attempting to refresh model-visible tool declarations.
		for (const runtime of runtimes) await this.writeRuntimeControls(runtime);
		await this.external.invalidatePolicies();
		const updates = await Promise.allSettled(runtimes.filter((runtime) => runtime.controls && runtime.engineStatus === "ready").map((runtime) => this.controlRequest(runtime, "apply")));
		for (const listener of this.controlListeners) listener({ type, conversationIds: runtimes.map((runtime) => runtime.conversationId) });
		const failed = updates.find((update) => update.status === "rejected");
		if (failed?.status === "rejected") throw new Error(`设置已保存，工具声明刷新失败，请重开会话：${String(failed.reason)}`);
	}

	setConversationPermission(conversationId: string, input: unknown): Promise<Snapshot> {
		return this.serialize(async () => {
			if (!permissionModes.has(input)) throw new Error("无效的会话权限模式。");
			const conversation = this.conversation(conversationId);
			// Fork and clone lineage tracks history, while only delegated tasks inherit permissions.
			if (this.rootConversationId(conversationId, false) !== conversationId) throw new Error("请在主会话调整权限。");
			conversation.permissionMode = input as PermissionMode;
			await this.persist();
			await this.closeReadRestrictedTerminals(conversationId);
			const runtimes = [...this.runtimes.values()].filter((runtime) =>
				!runtime.stopping && this.rootConversationId(runtime.conversationId, false) === conversationId,
			);
			for (const runtime of runtimes) await this.writeRuntimeControls(runtime);
			await this.external.invalidatePolicies();
			for (const runtime of runtimes) {
				if (runtime.controls && runtime.engineStatus === "ready" && !runtime.busy && !runtime.pendingUI.size)
					await this.controlRequest(runtime, "apply");
			}
			for (const listener of this.controlListeners)
				listener({ type: "permissions_changed", conversationIds: runtimes.map((runtime) => runtime.conversationId) });
			return this.buildSnapshot();
		});
	}

	private async controlRequest(runtime: SessionRuntime, operation: "list" | "apply"): Promise<DesktopToolInfo[]> {
		const data = await this.controlCall(runtime, { operation });
		if (!Array.isArray(data.tools)) throw new Error("工具清单格式错误。");
		return data.tools as DesktopToolInfo[];
	}
	/**
	 * Run one private control operation in the runtime's extension. Requests share the
	 * bridge's operation lock, so a notification never interleaves with list/apply.
	 */
	private controlCall(runtime: SessionRuntime, body: Record<string, unknown> & { operation: string }): Promise<Record<string, unknown>> {
		const bridge = runtime.controls;
		if (!bridge) return Promise.reject(new Error("工具管理扩展未加载，请重新构建桌面运行时。"));
		const action = bridge.operation.then(async () => {
			const requestId = randomUUID();
			const requestFile = join(bridge.directory, "request.json");
			const responseFile = join(bridge.directory, "response.json");
			try {
				await rm(responseFile, { force: true });
				await this.atomicJson(requestFile, { requestId, ...body });
				const response = await this.requireAgent(runtime).request<{ disposition: string }>({ type: "prompt", message: `/${bridge.command} ${bridge.token} ${requestId}` });
				if (response.disposition !== "handled") throw new Error("工具管理命令未被处理。");
				const data = JSON.parse(await readFile(responseFile, "utf8"));
				if (data?.requestId !== requestId || typeof data.ok !== "boolean") throw new Error("工具管理返回格式错误。");
				if (!data.ok) throw new Error(String(data.error));
				return data as Record<string, unknown>;
			} finally { await Promise.all([rm(requestFile, { force: true }), rm(responseFile, { force: true })]); }
		});
		bridge.operation = action.then(() => {}, () => {});
		return action;
	}

	private async deliverOnRuntime(
		runtime: SessionRuntime,
		params: {
			customType: DeliverCustomType;
			key?: string;
			content: string;
			details: Record<string, unknown>;
			deliverAs: NotificationDelivery;
			triggerTurn: boolean;
			display?: boolean;
			usage?: NotificationUsage;
		},
	): Promise<NotificationDisposition | undefined> {
		const deliver = async () => {
			const data = await this.controlCall(runtime, {
				operation: "deliver",
				customType: params.customType,
				...(params.key ? { key: params.key } : {}),
				content: params.content,
				details: params.details,
				deliverAs: params.deliverAs,
				triggerTurn: params.triggerTurn,
				...(params.display !== undefined ? { display: params.display } : {}),
				...(params.usage ? { usage: params.usage } : {}),
			});
			return data.delivery as NotificationDisposition | undefined;
		};
		return params.triggerTurn && params.deliverAs === "followUp"
			? this.checkpointWakeup(runtime, deliver)
			: deliver();
	}

	private async checkpointWakeup(
		runtime: SessionRuntime,
		send: () => Promise<NotificationDisposition | undefined>,
	): Promise<NotificationDisposition | undefined> {
		if (runtime.busy || runtime.bashBusy || runtime.state?.isStreaming || runtime.state?.isCompacting) return "deferred";
		const conversation = this.conversation(runtime.conversationId);
		if (!this.isReadRestricted(conversation.id)) {
			try { this.assertPathAvailable(conversation.project, conversation.id); } catch { return "deferred"; }
		}
		const existing = Boolean(runtime.checkpointId || runtime.checkpointStarting);
		await this.startCheckpoint(runtime, "后台唤醒");
		const prepared = existing ? undefined : runtime.checkpointId;
		let delivery: NotificationDisposition | undefined;
		try {
			delivery = await send();
			return delivery;
		} finally {
			if (prepared && delivery !== "sent" && runtime.checkpointId === prepared && !runtime.busy && !runtime.state?.isStreaming) {
				runtime.checkpointId = undefined;
				runtime.checkpointUserAnchor = undefined;
				const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
				if (task?.checkpointId === prepared) delete task.checkpointId;
				await this.git.abandonPending(conversation.project, prepared, conversation.id).catch(() => {});
			}
		}
	}

	async deliverToConversation(
		conversationId: string,
		params: {
			customType: DeliverCustomType;
			key?: string;
			content: string;
			details: Record<string, unknown>;
			deliverAs?: NotificationDelivery;
			triggerTurn?: boolean;
			display?: boolean;
			usage?: NotificationUsage;
			idleOnly?: boolean;
		},
	): Promise<NotificationDisposition | "unavailable"> {
		if (this.closed) return "unavailable";
		let runtime = this.runtimes.get(conversationId);
		if (runtime?.settling) await runtime.settling.catch(() => {});
		runtime = this.runtimes.get(conversationId);
		if (this.closed || !runtime?.agent || !runtime.controls || runtime.engineStatus !== "ready" || runtime.stopping) {
			return "unavailable";
		}
		if (params.idleOnly && (runtime.busy || runtime.state?.isStreaming)) return "deferred";
		const deliverAs = params.deliverAs ?? "followUp";
		const triggerTurn = params.triggerTurn ?? (deliverAs === "followUp");
		if (triggerTurn && !runtime.busy && !runtime.state?.isStreaming) {
			const conversation = this.store.conversations.find((item) => item.id === conversationId);
			if (!conversation) return "unavailable";
			try {
				this.assertPathAvailable(conversation.project, conversation.id);
			} catch {
				return "deferred";
			}
		}
		const disposition = await this.deliverOnRuntime(runtime, {
			customType: params.customType,
			key: params.key,
			content: params.content,
			details: params.details,
			deliverAs,
			triggerTurn,
			display: params.display,
			usage: params.usage,
		});
		return disposition ?? "sent";
	}

	private async deliverCronWakeup(
		conversationId: string,
		params: Parameters<DesktopService["deliverToConversation"]>[1],
		project?: string,
	): Promise<NotificationDisposition | "unavailable"> {
		if (this.closed) return "unavailable";
		const conversation = this.store.conversations.find((item) => item.id === conversationId);
		if (!conversation || this.isDelegatedChild(conversationId)) return "unavailable";
		if (project && conversation.project !== project) return "unavailable";
		try {
			this.assertPathAvailable(conversation.project, conversation.id);
		} catch {
			// Busy with another session: retry as temporarily unavailable for a one-shot
			// job, since the target session itself has no settling event to wake the job.
			return "unavailable";
		}
		const runtime = await this.ensureRuntime(conversation).catch(() => undefined);
		if (!runtime) return "unavailable";
		return this.deliverToConversation(conversationId, params);
	}

	private async deliverTeamWakeup(
		conversationId: string,
		params: Parameters<DesktopService["deliverToConversation"]>[1],
	): Promise<NotificationDisposition | "unavailable"> {
		if (this.closed || this.store.settings.agentTeams !== true) return "unavailable";
		const conversation = this.store.conversations.find((item) => item.id === conversationId);
		if (!conversation || !(await this.projectAvailable(conversation))) return "unavailable";
		const task = this.store.tasks.find((item) => item.conversationId === conversationId && item.parentConversationId);
		if (task && (task.quarantined || ["cancelled", "failed", "interrupted"].includes(task.status))) return "unavailable";
		if (task && (["queued", "running", "waiting_for_input"].includes(task.status) || this.piOutboxItem(task))) return "deferred";
		try { this.assertPathAvailable(conversation.project, conversation.id); } catch { return "deferred"; }
		const runtime = await this.ensureRuntime(conversation).catch(() => undefined);
		if (!runtime) return "unavailable";
		if (runtime.busy || runtime.state?.isStreaming || runtime.stopping) return "deferred";
		const prior = task ? { turn: task.turn, stats: task.stats, baseline: task.statsAtTurnStart } : undefined;
		let disposition: NotificationDisposition | "unavailable" = "unavailable";
		try {
			if (task) {
				await this.prepareTaskUsage(runtime, task);
				task.turn = (task.turn ?? 1) + 1;
			}
			disposition = await this.deliverToConversation(conversationId, { ...params, idleOnly: true });
			return disposition;
		} finally {
			if (task && prior && disposition !== "sent" && !runtime.busy && !runtime.state?.isStreaming) {
				task.turn = prior.turn;
				task.stats = prior.stats;
				task.statsAtTurnStart = prior.baseline;
				await this.releaseRuntimeCost(runtime);
			}
		}
	}

	subscribeTerminals(listener: (event: TerminalEvent) => void): () => void {
		return this.terminals.subscribe(listener);
	}

	async listTasks(): Promise<DesktopTask[]> {
		await this.operation;
		return structuredClone(this.store.tasks);
	}

	startTask(input: TaskStartInput, delegation?: DelegationMetadata, signal?: AbortSignal): Promise<DesktopTask> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("桌面服务已关闭。");
			signal?.throwIfAborted();
			if (!input.message.trim()) throw new Error("请输入任务内容。");
			if (input.message.length > MAX_TASK_MESSAGE) throw new Error("任务内容过长。");
			const validateToolNames = (list: string[] | undefined, label: string) => {
				if (list === undefined) return;
				if (!Array.isArray(list) || list.length > MAX_TOOL_LIST) throw new Error(`${label}无效。`);
				for (const name of list)
					if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name))
						throw new Error(`${label}名称无效。`);
			};
			validateToolNames(input.allowedTools, "Agent 工具列表");
			validateToolNames(input.disallowedTools, "Agent 禁用工具列表");
			if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > MAX_AGENT_TURNS))
				throw new Error("Agent 最大轮次无效。");
			if (input.systemPrompt !== undefined && (!delegation || typeof input.systemPrompt !== "string" || input.systemPrompt.includes("\0") || exceedsLength(input.systemPrompt, MAX_AGENT_SYSTEM_PROMPT)))
				throw new Error("Agent 系统提示词无效。");
			// Every persisted field stays within the limits the store loader accepts.
			if (
				input.model !== undefined &&
				(typeof input.model.provider !== "string" || !input.model.provider || input.model.provider.length > MAX_MODEL_PROVIDER ||
					typeof input.model.id !== "string" || !input.model.id || input.model.id.length > MAX_MODEL_ID)
			)
				throw new Error("任务模型无效。");
			// Resolve reuse under the task creation lock so simultaneous requests in one workflow
			// scope see the same worktree, including when a previous attempt failed after editing it.
			const previousWorkflowTask = delegation?.workflowId && delegation.workflowWorkspace
				? this.store.tasks.find((task) =>
					task.workflowId === delegation.workflowId && task.workflowWorkspace === delegation.workflowWorkspace &&
					task.parentConversationId === delegation.parentConversationId && task.worktreeId && !task.quarantined)
				: undefined;
			const worktreeId = input.worktreeId ?? previousWorkflowTask?.worktreeId;
			const existing = worktreeId
				? (await this.worktrees.list()).find((item) => item.id === worktreeId)
				: undefined;
			if (worktreeId && (!existing || existing.status !== "ready")) throw new Error("指定的 Worktree 不可用。");
			if (existing && input.baseRef !== undefined) throw new Error("已有 Worktree 不能重新指定 Git 基准。");
			const project = await realpath(input.project ?? existing?.repository ?? this.requireActive().project);
			if (!(await stat(project)).isDirectory()) throw new Error("项目目录不存在。");
			const rootProject = delegation ? this.trustProjectFor(project) : project;
			const trusted = this.isProjectTrusted(rootProject);
			const agentDef = delegation?.subagentType
				? await this.agents.resolve(rootProject, delegation.subagentType, trusted).catch(() => undefined)
				: undefined;
			let hookAdditionalContext: string | undefined;
			const agentId = delegation ? randomUUID() : undefined;
			if (delegation) {
				const startHook = await this.hooks.run("SubagentStart", {
					project: rootProject,
					projectTrusted: trusted,
					conversationId: delegation.parentConversationId,
					permissionMode: this.hookPermissionMode(delegation.parentConversationId),
					agentId,
					agentType: delegation.subagentType,
					prompt: input.message,
					extraHooks: agentDef?.hooks,
					env: this.options.env,
				});
				if (startHook.blocked) throw new Error(startHook.reason ?? "SubagentStart Hook 阻止启动子 Agent。");
				if (startHook.additionalContext?.trim()) {
					hookAdditionalContext = truncateText(startHook.additionalContext.trim(), MAX_HOOK_ADDITIONAL_CONTEXT);
				}
			}
			signal?.throwIfAborted();
			const isolated = input.isolation !== "shared";
			if (isolated && !existing && this.isReadRestricted(delegation?.parentConversationId))
				throw new Error("只读模式请使用 shared 隔离方式，不能创建 Worktree。");
			const worktree =
				existing ?? (isolated ? await this.worktrees.create({ project, baseRef: input.baseRef }) : undefined);
			if (worktree && !inside(worktree.repository, project)) throw new Error("项目目录不属于此 Worktree 的源仓库。");
			let directory = project;
			try {
				if (worktree) directory = await realpath(join(worktree.path, relative(worktree.repository, project)));
				signal?.throwIfAborted();
			} catch (error) {
				if (worktree && !existing) await this.worktrees.remove(worktree.id).catch(() => {});
				throw error;
			}
			if (!delegation && !this.store.projects.some((item) => item.path === rootProject))
				this.store.projects.push({ path: rootProject, name: basename(rootProject) });
			const conversation: Conversation = agentId
				? { id: agentId, title: "新会话", project: directory, updatedAt: Date.now() }
				: this.createConversation(directory);
			if (agentId) this.store.conversations.unshift(conversation);
			conversation.title = input.title?.trim().slice(0, 160) || input.message.trim().split("\n")[0].slice(0, 60);
			if (input.forkParentConversationId) {
				// A requested fork must inherit the parent's history or fail visibly. Silently
				// starting a fresh child would contradict what the caller asked for.
				try {
					const parentConv = this.conversation(input.forkParentConversationId);
					const sessionDir = join(this.options.dataDir, "sessions");
					await mkdir(sessionDir, { recursive: true, mode: 0o700 });
					const sourceSessionFile =
						parentConv.sessionFile ??
						this.runtimes.get(parentConv.id)?.state?.sessionFile ??
						(await findSessionFileById(sessionDir, parentConv.id));
					if (!sourceSessionFile) throw new Error("父会话尚无可复制的记录");
					const forkedFile = await createForkedSessionSnapshot({
						sourceSessionFile,
						leafId: parentConv.sessionLeafId,
						childSessionId: conversation.id,
						childCwd: conversation.project,
						targetDir: sessionDir,
					});
					if (!forkedFile) throw new Error("父会话没有可继承的消息");
					conversation.sessionFile = forkedFile;
					conversation.parentConversationId = parentConv.id;
					conversation.origin = "fork";
				} catch (error) {
					this.store.conversations = this.store.conversations.filter((item) => item.id !== conversation.id);
					if (worktree && !existing) await this.worktrees.remove(worktree.id).catch(() => {});
					throw new Error(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (worktree) await this.worktrees.bindConversation(worktree.id, conversation.id);
			// The definition body becomes part of the child's system prompt through a private
			// file; the task message (its first user message) carries only the task itself.
			const combinedPrompt = [
				input.systemPrompt?.trim(),
				hookAdditionalContext ? `<!-- SubagentStart Hook Additional Context -->\n${hookAdditionalContext}` : undefined,
			].filter(Boolean).join("\n\n---\n\n");
			let systemPromptFile: string | undefined;
			if (delegation && combinedPrompt) {
				const directory = join(this.options.dataDir, "agent-prompts");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				systemPromptFile = join(directory, `${conversation.id}.md`);
				try {
					await this.atomicFile(systemPromptFile, combinedPrompt);
				} catch (error) {
					this.store.conversations = this.store.conversations.filter((item) => item.id !== conversation.id);
					if (worktree && !existing) await this.worktrees.remove(worktree.id).catch(() => {});
					throw error;
				}
			}
			const task: DesktopTask = {
				id: conversation.id,
				conversationId: conversation.id,
				project: rootProject,
				workingDirectory: conversation.project,
				worktreeId: worktree?.id,
				title: conversation.title,
				prompt: input.message,
				status: "queued",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revision: 0,
				turn: 1,
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				allowedTools: input.allowedTools,
				...(input.disallowedTools?.length ? { disallowedTools: input.disallowedTools } : {}),
				...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
				...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
				...(input.isFork ? { isFork: true } : {}),
				...(input.omitClaudeMd ? { omitClaudeMd: true } : {}),
				...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
				...delegation,
				...(input.structuredOutputSchema !== undefined ? { structuredOutputSchema: input.structuredOutputSchema } : {}),
				...(systemPromptFile ? { systemPromptFile } : {}),
			};
			if (delegation) {
				const inherited = this.permissionPolicy(delegation.parentConversationId);
				this.store.taskPolicies ??= {};
				this.store.taskPolicies[task.id] = this.buildChildTaskPolicy(
					inherited,
					input.disallowedTools,
					input.permissionMode,
					delegation.readOnly,
					input.mcpServers,
				);
			}
			if (task.teamName && task.parentConversationId && task.name) {
				try {
					await this.teams.registerMember({
						rootConversationId: this.rootConversationId(task.parentConversationId),
						teamName: task.teamName,
						memberName: task.name,
						agentId: task.id,
						conversationId: task.conversationId,
						subagentType: task.subagentType,
					});
				} catch (error) {
					this.store.conversations = this.store.conversations.filter((item) => item.id !== conversation.id);
					if (this.store.taskPolicies) delete this.store.taskPolicies[task.id];
					if (systemPromptFile) await rm(systemPromptFile, { force: true }).catch(() => {});
					if (worktree && !existing) await this.worktrees.remove(worktree.id).catch(() => {});
					throw error;
				}
			}
			this.store.tasks.unshift(task);
			if (delegation && conversation.sessionFile) {
				await this.writeSubagentMeta(task, conversation, conversation.sessionFile, worktree).catch(() => {});
			}
			this.updateTask(task, "queued");
			await this.persist();
			void this.scheduleTasks();
			return structuredClone(task);
		});
	}

	private async writeSubagentMeta(
		task: DesktopTask,
		conversation: Conversation,
		sessionFile?: string,
		knownWorktree?: WorktreeInfo,
	): Promise<void> {
		const sessionDir = join(this.options.dataDir, "sessions");
		const file =
			sessionFile ??
			conversation.sessionFile ??
			this.runtimes.get(conversation.id)?.state?.sessionFile ??
			(await findSessionFileById(sessionDir, conversation.id).catch(() => undefined));
		if (!file || !file.endsWith(".jsonl")) return;
		const tree =
			knownWorktree ??
			(task.worktreeId ? (await this.worktrees.list().catch(() => [])).find((item) => item.id === task.worktreeId) : undefined);
		const meta = {
			agentId: task.id,
			type: task.subagentType ?? "general-purpose",
			parent: task.parentConversationId,
			description: task.title,
			model: task.model ? `${task.model.provider}/${task.model.id}` : undefined,
			depth: task.delegationDepth ?? 1,
			...(task.worktreeId
				? {
					worktree: {
						id: task.worktreeId,
						path: task.workingDirectory,
						...(tree ? { branch: tree.branch, baseRef: tree.baseRef } : {}),
					},
				}
				: {}),
		};
		await this.atomicFile(file.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
	}

	async taskSnapshot(id: string): Promise<Snapshot> {
		await this.operation;
		const task = this.task(id);
		const conversation = this.conversation(task.conversationId);
		// Viewing a finished child whose process was reaped reads its saved transcript; only
		// a message to it (or an approval) needs the process again.
		const reaped = !this.runtimes.has(conversation.id) && Boolean(task.parentConversationId) &&
			!["queued", "running", "waiting_for_input"].includes(task.status) && this.historyAvailable && Boolean(conversation.sessionFile);
		if (!reaped && (await this.projectAvailable(conversation))) {
			const runtime = await this.ensureRuntime(conversation);
			await runtime.settling;
		}
		return this.buildSnapshot(task.conversationId);
	}

	/** Latest assistant text of an active child, read only from an already-running process. */
	private async peekTaskOutput(id: string): Promise<string | undefined> {
		const runtime = this.runtimes.get(this.task(id).conversationId);
		if (!runtime?.agent || runtime.engineStatus !== "ready" || runtime.stopping) return undefined;
		const { messages } = await runtime.agent.request<{ messages: Message[] }>({ type: "get_messages" });
		return finalAssistantText(messages);
	}

	/** Final assistant text from the live process, or from the saved transcript once it has exited. */
	private async childFinalText(runtime: SessionRuntime): Promise<string | undefined> {
		if (runtime.agent && runtime.engineStatus === "ready") {
			const { messages } = await runtime.agent.request<{ messages: Message[] }>({ type: "get_messages" });
			return finalAssistantText(messages);
		}
		const conversation = this.conversation(runtime.conversationId);
		const sessionFile = conversation.sessionFile ?? runtime.state?.sessionFile;
		if (!sessionFile || !this.historyAvailable) return undefined;
		const { messages } = await this.history.inspect({ sessionFile, leafId: conversation.sessionLeafId });
		return finalAssistantText(messages);
	}

	/** Final assistant text read only from a conversation's saved transcript. */
	private async savedFinalText(conversationId: string): Promise<string | undefined> {
		if (!this.historyAvailable) return undefined;
		const conversation = this.store.conversations.find((item) => item.id === conversationId);
		if (!conversation) return undefined;
		const sessionFile =
			conversation.sessionFile ?? (await findSessionFileById(join(this.options.dataDir, "sessions"), conversation.id));
		if (!sessionFile) return undefined;
		const { messages } = await this.history.inspect({ sessionFile, leafId: conversation.sessionLeafId });
		return finalAssistantText(messages);
	}

	/** A finished background turn the parent has not received; null when nothing is owed. */
	private piOutboxItem(task: DesktopTask): OutboxItem | undefined {
		const turn = task.turn ?? 1;
		if (!task.parentConversationId || !task.runInBackground || task.notifySuppressed || task.notifiedTurn === turn) return undefined;
		if (["queued", "running", "waiting_for_input"].includes(task.status)) return undefined;
		// A stopped child records its partial output only once its run has settled; deliver
		// after that, so the parent receives what the child did instead of an empty result.
		if (["cancelled", "interrupted"].includes(task.status) && !this.childSettled(task)) return undefined;
		const { content, details } = formatTaskNotification({
			taskId: task.id,
			toolUseId: task.parentToolCallId,
			status: notificationStatus(task),
			description: task.title,
			subagentType: task.subagentType,
			turn,
			result: task.result?.text ?? "",
			readPaths: task.result?.readPaths,
			truncated: task.result?.truncated,
			partial: task.status === "completed" && task.result?.partial,
			error: task.error,
			stopReason: task.stopReason,
			durationMs: task.stats?.durationMs ?? task.updatedAt - task.createdAt,
			...(task.stats ? { totalTokens: task.stats.tokens.total, toolUses: task.stats.toolUses } : {}),
		});
		const usage: NotificationUsage | undefined = task.stats
			? { provider: task.stats.model?.provider ?? "desktop", model: task.stats.model?.id ?? "subagent", usage: runToolUsage(task.stats) }
			: undefined;
		return { key: `${task.id}:${turn}`, source: "pi", taskId: task.id, turn, content, details, updatedAt: task.updatedAt, ...(usage ? { usage } : {}) };
	}
	/** Whether a stopped child's own runtime has finished recording its result. */
	private childSettled(task: DesktopTask): boolean {
		const runtime = this.runtimes.get(task.conversationId);
		return !runtime || !(runtime.busy || runtime.settling || runtime.stopping);
	}
	private externalOutboxItem({ task, stopReason }: ExternalNotification): OutboxItem {
		const { content, details } = formatTaskNotification({
			taskId: task.id,
			toolUseId: task.parentToolCallId,
			status: notificationStatus(task),
			description: task.title,
			subagentType: task.subagentType,
			executor: task.executor,
			turn: task.turn,
			result: task.output,
			truncated: task.truncated,
			error: task.error,
			stopReason,
			durationMs: task.updatedAt - task.createdAt,
		});
		return { key: `${task.id}:${task.turn}`, source: "external", taskId: task.id, turn: task.turn, content, details, updatedAt: task.updatedAt };
	}
	/** Every undelivered background result of a parent, oldest first; derived from task records only. */
	private outbox(owner: string): OutboxItem[] {
		const items = this.store.tasks.filter((task) => task.parentConversationId === owner).flatMap((task) => this.piOutboxItem(task) ?? []);
		for (const pending of this.external.pendingNotifications(owner)) items.push(this.externalOutboxItem(pending));
		return items.sort((left, right) => left.updatedAt - right.updatedAt);
	}
	/** Results the parent holds without delivery: queued for its next turn, failed, or without a live runtime. */
	private heldNotificationCount(owner: string): number {
		const items = this.outbox(owner);
		const runtime = this.runtimes.get(owner);
		if (!runtime || runtime.engineStatus !== "ready" || runtime.stopping) return items.length;
		return items.filter((item) => runtime.queuedNotifications?.has(item.key) || (this.notifyAttempts.get(item.key) ?? 0) >= MAX_NOTIFY_ATTEMPTS).length;
	}
	private emitNotificationCount(owner: string): void {
		const pending = this.heldNotificationCount(owner);
		if ((this.notificationCounts.get(owner) ?? 0) === pending) return;
		if (pending) this.notificationCounts.set(owner, pending);
		else this.notificationCounts.delete(owner);
		for (const listener of this.taskListeners) listener({ type: "task_notifications", conversationId: owner, pending });
	}
	private async markNotified(item: OutboxItem): Promise<void> {
		this.notifyAttempts.delete(item.key);
		if (item.source === "external") {
			await this.external.markNotified(item.taskId, item.turn);
			return;
		}
		const task = this.store.tasks.find((entry) => entry.id === item.taskId);
		if (!task || (task.turn ?? 1) !== item.turn) return;
		task.notifiedTurn = item.turn;
		task.revision = (task.revision ?? 0) + 1;
		for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		await this.persist();
		if (this.store.settings.maxCostUsd) await this.serializeCost(() => this.refreshRootCostLimit(this.rootConversationId(task.conversationId)));
	}
	/**
	 * Deliver a parent's pending background results through its Pi extension.
	 * - `auto`: a live parent receives each result natively (followUp + triggerTurn).
	 *   Results already queued for the next turn are left alone: a stopped parent is never woken.
	 *   While the parent is mid-run the extension defers them; they are sent once the run settles,
	 *   never parked in Pi's in-memory follow-up queue where an abort would strand them.
	 * - `settled`: like `auto`, after the parent's run settled; also retries results whose
	 *   automatic backoff was exhausted.
	 * - `startup`: a parent runtime that was not running queues them as `nextTurn`, without a run.
	 * - `now`: the user's "立即交付" delivers everything and starts a run.
	 * A parent without a runtime keeps its results; nothing here starts one.
	 */
	private flushNotifications(owner: string, mode: FlushMode): Promise<void> {
		const previous = this.notifyChains.get(owner) ?? Promise.resolve();
		const next = previous.then(() => this.flushOutbox(owner, mode)).catch(() => {});
		this.notifyChains.set(owner, next);
		void next.finally(() => { if (this.notifyChains.get(owner) === next) this.notifyChains.delete(owner); });
		return next;
	}
	private async flushOutbox(owner: string, mode: FlushMode): Promise<void> {
		if (this.closed) return;
		let runtime = this.runtimes.get(owner);
		if (runtime?.settling) await runtime.settling.catch(() => {});
		runtime = this.runtimes.get(owner);
		if (this.closed || !runtime?.agent || !runtime.controls || runtime.engineStatus !== "ready" || runtime.stopping) {
			this.emitNotificationCount(owner);
			return;
		}
		const queued = (runtime.queuedNotifications ??= new Map());
		let started = false;
		let failed = 0;
		for (const item of this.outbox(owner)) {
			if (queued.has(item.key)) continue;
			if (mode === "auto" && (this.notifyAttempts.get(item.key) ?? 0) >= MAX_NOTIFY_ATTEMPTS) continue;
			const deliverAs: NotificationDelivery = mode === "startup" ? "nextTurn" : "followUp";
			try {
				const delivery = await this.deliverOnRuntime(runtime, {
					customType: TASK_NOTIFICATION_TYPE,
					key: item.key,
					content: item.content,
					details: item.details as unknown as Record<string, unknown>,
					deliverAs,
					triggerTurn: deliverAs === "followUp",
					...(item.usage ? { usage: item.usage } : {}),
				});
				if (delivery === "queued") {
					queued.set(item.key, item);
					this.notifyAttempts.delete(item.key);
				} else if (delivery === "deferred") {
					// The parent is mid-run; the flush after its settlement sends this result.
					this.notifyAttempts.delete(item.key);
				} else {
					if (delivery === "sent") started = true;
					await this.markNotified(item);
				}
			} catch {
				if (this.closed || runtime.stopping || this.runtimes.get(owner) !== runtime) return;
				this.notifyAttempts.set(item.key, (this.notifyAttempts.get(item.key) ?? 0) + 1);
				failed = Math.max(failed, this.notifyAttempts.get(item.key)!);
			}
		}
		// Results queued for the next turn need a run; only the user's "立即交付" starts one.
		if (mode === "now" && queued.size) {
			const consumed = new Promise<void>((resolve) => {
				const consumers = (runtime.queueConsumers ??= new Set());
				const done = () => { clearTimeout(timer); consumers.delete(done); resolve(); };
				const timer = setTimeout(done, 10000);
				timer.unref?.();
				consumers.add(done);
			});
			if (!started && !runtime.busy && !runtime.state?.isStreaming)
				await this.checkpointWakeup(runtime, async () => {
					const reply = await this.controlCall(runtime, { operation: "wake", count: queued.size });
					return reply.delivery as NotificationDisposition | undefined;
				}).catch(() => {});
			// Report the count after the run has taken them, not while the run is starting.
			if (started || !runtime.busy) await consumed;
		}
		if (failed && failed < MAX_NOTIFY_ATTEMPTS && !this.notifyTimers.has(owner)) {
			const timer = setTimeout(() => {
				this.notifyTimers.delete(owner);
				void this.flushNotifications(owner, "auto");
			}, 1000 * 2 ** (failed - 1));
			timer.unref?.();
			this.notifyTimers.set(owner, timer);
		}
		this.emitNotificationCount(owner);
	}
	/** A queued `nextTurn` result is part of the run that just started. */
	private consumeQueuedNotifications(runtime: SessionRuntime): void {
		const queued = runtime.queuedNotifications;
		if (!queued?.size) return;
		const items = [...queued.values()];
		queued.clear();
		void Promise.all(items.map((item) => this.markNotified(item)))
			.catch(() => {})
			.finally(() => {
				for (const consumer of [...(runtime.queueConsumers ?? [])]) consumer();
				this.emitNotificationCount(runtime.conversationId);
			});
	}
	/** A foreground child the parent stopped waiting for now reports back like a background child. */
	private async detachTask(id: string, userInitiated = false): Promise<void> {
		const task = this.store.tasks.find((item) => item.id === id);
		if (!task || task.runInBackground) return;
		if (userInitiated) this.userBackgroundedTasks.add(task.id);
		task.runInBackground = true;
		task.revision = (task.revision ?? 0) + 1;
		for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		this.waiters.notify(task.id);
		this.wakeSlotWaiters();
		await this.persist();
		if (task.parentConversationId && !["queued", "running", "waiting_for_input"].includes(task.status)) {
			void this.flushNotifications(task.parentConversationId, "auto");
		}
	}

	/**
	 * User-initiated "转到后台" (Ctrl+B or ToolCard button): detaches a foreground child
	 * so the parent immediately receives an async_launched-style response and the child's
	 * final result arrives later through the persisted outbox.
	 */
	async backgroundTask(id: string): Promise<DesktopTask> {
		await this.operation;
		if (this.closed) throw new Error("桌面服务已关闭。");
		const task = this.task(id);
		if (!["queued", "running", "waiting_for_input"].includes(task.status) || task.runInBackground) {
			return structuredClone(task);
		}
		if (task.parentConversationId && !task.readOnly && !task.worktreeId) {
			throw new Error("共享目录的可写子 Agent 无法转到后台运行，以免与主会话同时修改文件。");
		}
		await this.detachTask(task.id, true);
		return structuredClone(task);
	}

	/** Number of background results the conversation holds without delivery. */
	pendingTaskNotifications(conversationId: string): number {
		return this.heldNotificationCount(this.conversation(conversationId).id);
	}

	/**
	 * The user's "立即交付": deliver every held background result of this conversation
	 * now and start a run for them. Starting the runtime here is an explicit user action.
	 */
	async deliverTaskNotifications(conversationId: string): Promise<{ pending: number }> {
		await this.operation;
		if (this.closed) throw new Error("桌面服务已关闭。");
		const conversation = this.conversation(conversationId);
		if (this.store.tasks.some((task) => task.conversationId === conversation.id && task.parentConversationId))
			throw new Error("子 Agent 会话不接收后台结果。");
		const runtime = await this.ensureRuntime(conversation);
		this.requireAgent(runtime);
		for (const item of this.outbox(conversation.id)) this.notifyAttempts.delete(item.key);
		await this.flushNotifications(conversation.id, "now");
		return { pending: this.heldNotificationCount(conversation.id) };
	}

	/**
	 * The user's "停止全部后台子 Agent" for one conversation: stops only that conversation's
	 * own background children (Pi and external). Each reports back as stopped.
	 */
	async stopAllTasks(conversationId: string): Promise<{ stopped: number }> {
		await this.operation;
		if (this.closed) throw new Error("桌面服务已关闭。");
		const owner = this.conversation(conversationId).id;
		const pi = await this.delegation.cancelChildren(owner, { backgroundOnly: true, reason: "user_stop" });
		const external = await this.external.cancelChildren(owner, { backgroundOnly: true, reason: "user_stop" });
		const monitors = await this.monitors.stopForConversation([owner], "user_stop", { includeRoot: true });
		return { stopped: pi.length + external.length + monitors };
	}

	/**
	 * Send a message to an existing task. A running task is steered (the message arrives
	 * before its next model call); a finished, stopped or interrupted one starts its next
	 * run (`turn + 1`) with its whole history. The task keeps its permission snapshot,
	 * tools and maxTurns, and the parent's live policy still applies on top of it.
	 */
	resumeTask(id: string, message: string, options: ResumeOptions): Promise<TaskSendResult> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("桌面服务已关闭。");
			const task = this.task(id);
			if (typeof message !== "string" || !message.trim() || message.includes("\0") || exceedsLength(message, MAX_SEND_MESSAGE))
				throw new Error("消息内容无效。");
			if (task.quarantined) throw new Error("任务记录已损坏，不能继续对话。");
			const fromModel = options.source === "model";
			// The parent model's message is a user message to the child; the prefix says it is not.
			const text = fromModel ? `${PARENT_MESSAGE_PREFIX}\n\n${message}` : message;
			const remember = () => {
				if (options.toolCallId)
					task.turnCalls = [...(task.turnCalls ?? []).filter((call) => call !== options.toolCallId), options.toolCallId].slice(-MAX_TURN_CALLS);
			};
			if (["queued", "running", "waiting_for_input"].includes(task.status)) {
				const runtime = this.runtimes.get(task.conversationId);
				if (task.status === "queued" || !runtime?.agent || runtime.engineStatus !== "ready" || runtime.stopping || !(runtime.busy || runtime.state?.isStreaming))
					throw new Error(fromModel ? "The agent has not started its run yet; try again shortly, or stop it with TaskStop" : "子 Agent 尚未开始运行，请稍后再发送。");
				// RPC steer refuses extension commands; a user's slash command cannot steer a run.
				if (text.trimStart().startsWith("/")) throw new Error("运行中的子 Agent 不接受斜杠命令。");
				await runtime.agent.request({ type: "steer", message: text });
				remember();
				task.revision = (task.revision ?? 0) + 1;
				for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
				await this.persist();
				return { status: "delivered_to_running_agent", task: structuredClone(task) };
			}
			const conversation = this.conversation(task.conversationId);
			if (!(await this.projectAvailable(conversation))) throw new Error("工作目录已移除，不能继续此任务。");
			if (task.worktreeId) {
				const tree = (await this.worktrees.list()).find((item) => item.id === task.worktreeId);
				if (!tree || tree.status !== "ready") throw new Error("任务的 Worktree 已不可用，不能继续对话。");
			}
			const runtime = this.runtimes.get(task.conversationId);
			if (runtime?.settling) await runtime.settling.catch(() => {});
			if (runtime && (runtime.busy || runtime.bashBusy || runtime.state?.isStreaming)) throw new Error("此任务的会话仍在运行，请稍后再发送。");
			task.turn = (task.turn ?? 1) + 1;
			task.pendingMessage = text;
			delete task.result;
			delete task.stopReason;
			delete task.stats;
			this.userBackgroundedTasks.delete(task.id);
			if (task.parentConversationId) {
				// The model chooses whether it waits; a user's message never blocks the parent,
				// and reaches the parent only when the user asked for it.
				task.runInBackground = fromModel ? options.background ?? true : true;
				if ((fromModel || options.notifyParent) && !task.workflowId) delete task.notifySuppressed;
				else task.notifySuppressed = true;
			}
			remember();
			this.updateTask(task, "queued");
			await this.persist();
			void this.scheduleTasks();
			return { status: "resumed", task: structuredClone(task) };
		});
	}

	/** The user's "继续对话" (TasksDrawer, or a message typed into a finished child's conversation). */
	async sendToTask(input: TaskSendInput): Promise<TaskSendResult> {
		await this.operation;
		const task = this.task(input.taskId);
		return this.resumeTask(task.id, input.message, { source: "user", notifyParent: input.notifyParent === true });
	}

	/**
	 * The renderer reports conversations it shows besides the active one (a task detail
	 * view). A viewed child keeps its process: reaping it would interrupt the user.
	 */
	setConversationViewing(conversationId: string, viewing: boolean): void {
		const id = this.conversation(conversationId).id;
		this.viewing.delete(id);
		if (!viewing) return;
		this.viewing.add(id);
		// One window shows a handful of conversations; forget the oldest beyond that.
		while (this.viewing.size > 16) this.viewing.delete(this.viewing.values().next().value!);
		const runtime = this.runtimes.get(id);
		if (runtime) runtime.lastActivity = Date.now();
	}

	/**
	 * Stop the processes of finished children nobody needs: the run ended, its result was
	 * delivered (or is suppressed), no approval is open, the renderer does not show it, it
	 * has no active children and it has been idle for `idleMs`. Beyond MAX_IDLE_CHILD_RUNTIMES
	 * idle ones, the least recently active are stopped regardless of idle time. The session
	 * leaf is saved; a later message restarts the child with `--session` transparently.
	 */
	reapIdleChildRuntimes(options: { idleMs?: number } = {}): Promise<number> {
		return this.reapIdleRuntimes(options.idleMs, "child");
	}

	private reapIdleRuntimes(
		idleMs = this.options.childRuntimeIdleMs ?? CHILD_RUNTIME_IDLE_MS,
		scope: "all" | "child" = "all",
	): Promise<number> {
		if (this.closed) return Promise.resolve(0);
		return this.serialize(async () => {
			const now = Date.now();
			const candidates = [...this.runtimes.values()].filter((runtime) => this.reapable(runtime, scope)).sort((left, right) => left.lastActivity - right.lastActivity);
			const excess = Math.max(0, candidates.length - MAX_IDLE_CHILD_RUNTIMES);
			let reaped = 0;
			for (const [index, runtime] of candidates.entries()) {
				if (index >= excess && now - runtime.lastActivity < idleMs) continue;
				// Stop hooks run while the run settles; wait for them before stopping.
				if (runtime.settling) await runtime.settling.catch(() => {});
				if (this.closed || !this.reapable(runtime, scope)) continue;
				await this.stopRuntime(runtime, "capture");
				reaped++;
			}
			if (reaped) await this.persist();
			return reaped;
		});
	}
	private hasActiveDescendant(parentId: string, visited = new Set<string>([parentId])): boolean {
		const active = (status: string) => ["queued", "running", "waiting_for_input"].includes(status);
		for (const item of this.store.tasks) {
			if (item.parentConversationId !== parentId || visited.has(item.conversationId)) continue;
			visited.add(item.conversationId);
			if (active(item.status) || this.hasActiveDescendant(item.conversationId, visited)) return true;
		}
		return false;
	}

	private reapable(runtime: SessionRuntime, scope: "all" | "child" | "switch"): boolean {
		const id = runtime.conversationId;
		const task = this.store.tasks.find((item) => item.conversationId === id);
		const active = (status: string) => ["queued", "running", "waiting_for_input"].includes(status);
		if ((scope === "child" && !task?.parentConversationId) || this.runtimes.get(id) !== runtime) return false;
		// A main turn can finish streaming moments before its host cleanup updates the
		// task row. Navigation can park it immediately; stopRuntime waits for the cleanup.
		const parkingSettledTurn = scope === "switch" && !task?.parentConversationId && Boolean(runtime.settling);
		if (task && ((active(task.status) && !parkingSettledTurn) || (task.runInBackground && !task.notifySuppressed && task.notifiedTurn !== (task.turn ?? 1))))
			return false;
		return (
			!runtime.stopping && !runtime.busy && !runtime.bashBusy && (!runtime.settling || parkingSettledTurn) &&
			runtime.engineStatus !== "starting" && !runtime.pendingUI.size &&
			!runtime.state?.isStreaming && !runtime.state?.isCompacting &&
			id !== this.store.activeId && !this.viewing.has(id) &&
			!this.store.conversations.find((conversation) => conversation.id === id)?.goal?.active &&
			!this.monitors.hasActivity(id) &&
			// Switching can park an idle parent. Its independent children report their
			// results in the outbox when the parent is reopened.
			(scope === "switch" || !this.hasActiveDescendant(id)) &&
			!this.external.list(id).some((item) => active(item.status)) &&
			!this.terminals.list().some((terminal) => terminal.conversationId === id && terminal.status !== "exited")
		);
	}

	/** `reason` records who stopped the task; renderer cancellation is always a user stop. */
	async cancelTask(id: string, reason: TaskStopReason = "user_stop"): Promise<DesktopTask> {
		await this.operation;
		const task = this.task(id);
		await this.monitors.stopForConversation([task.conversationId], reason);
		await this.delegation.cancelChildren(task.conversationId);
		await this.external.cancelChildren(task.conversationId);
		if (!["queued", "running", "waiting_for_input"].includes(task.status)) return structuredClone(task);
		this.updateTask(task, "cancelled", undefined, reason);
		this.launches.set(task.conversationId, (this.launches.get(task.conversationId) ?? 0) + 1);
		const runtime = this.runtimes.get(task.conversationId);
		if (runtime?.agent && (runtime.busy || runtime.pendingUI.size)) {
			await this.cancelDialogs(runtime);
			await runtime.agent.request({ type: "abort" });
		} else if (runtime) {
			await this.stopRuntime(runtime);
		}
		await this.persist();
		// A stopped child is delivered once its runtime has settled and recorded its output.
		if (task.parentConversationId && task.runInBackground) void this.flushNotifications(task.parentConversationId, "auto");
		void this.scheduleTasks();
		return structuredClone(task);
	}

	createTerminal(
		input: Omit<TerminalCreateInput, "project" | "conversationId"> & { conversationId?: string },
	): Promise<TerminalInfo> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("桌面服务已关闭。");
			const conversation = this.conversation(input.conversationId);
			if (this.isReadRestricted(conversation.id)) throw new Error("只读或 Plan 模式禁止创建交互终端。");
			return this.terminals.create({ ...input, conversationId: conversation.id, project: conversation.project });
		});
	}

	startSsh(conversationId: string, host: string, startPi: boolean): Promise<TerminalInfo> {
		return this.serialize(async () => {
			if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/.test(host))
				throw new Error("SSH 地址应为主机名、配置别名或 user@host。");
			const conversation = this.conversation(conversationId);
			this.assertWritableMode("启动 SSH 终端", conversation.id);
			const args = ["-a", "-x", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-t", "--", host];
			if (startPi) args.push("pi");
			return this.terminals.create({ conversationId, project: conversation.project }, { program: "/usr/bin/ssh", args, label: startPi ? `Pi · ${host}` : `SSH · ${host}` });
		});
	}

	private openPiCli(conversationId: string, cwd: string, args: string[], label: string): Promise<TerminalInfo> {
		const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
		return this.terminals.create({ conversationId, project: cwd }, {
			program: this.options.executable,
			args: [join(runtimeDir, "dist/bundle/cli.js"), ...args],
			label,
			env: { PI_CODING_AGENT_DIR: this.store.settings.agentDir ?? this.defaultAgentDir(), ELECTRON_RUN_AS_NODE: "1" },
		});
	}

	startPiPackages(conversationId: string, action: "list" | "install" | "update" | "remove", source?: string): Promise<TerminalInfo> {
		return this.serialize(async () => {
			const conv = this.conversation(conversationId);
			this.assertWritableMode("启动 Pi 扩展管理终端", conv.id);
			if (action === "list") return this.openPiCli(conv.id, this.options.dataDir, ["list"], "Pi 扩展");
			if (!source || !/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(source))
				throw new Error("填写 npm: 包名，可附加明确的版本或标签。");
			return this.openPiCli(conv.id, this.options.dataDir, [action, source], `Pi 扩展 · ${action}`);
		});
	}

	startMcpOAuth(conversationId: string, name: string): Promise<TerminalInfo> {
		return this.serialize(async () => {
			if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("MCP 服务器名称无效。");
			const conversation = this.conversation(conversationId);
			this.assertWritableMode("启动 MCP 授权", conversation.id);
			const server = (await this.mcp.list(conversation.project)).find((item) => item.name === name);
			if (server?.transport !== "http" || !server.enabled) throw new Error("请选择已启用的 HTTP MCP 服务器。");
			const projectScoped = server.scope === "project" && !server.overridden;
			if (server.scope === "project" && this.store.projectTrust?.[this.trustProjectFor(conversation.project)] !== "trusted")
				throw new Error("请先信任此项目，再登录项目 MCP。");
			const cwd = projectScoped ? conversation.project : this.options.dataDir;
			return this.openPiCli(conversationId, cwd, ["mcp", "login", name, ...(projectScoped ? ["-l"] : [])], `MCP · ${name}`);
		});
	}

	listTerminals(conversationId?: string): TerminalInfo[] {
		if (conversationId) this.conversation(conversationId);
		return this.terminals.list(conversationId);
	}

	private async closeReadRestrictedTerminals(permissionRoot?: string): Promise<void> {
		const restricted = this.terminals.list().filter((terminal) =>
			terminal.status !== "exited" &&
			(!permissionRoot || this.rootConversationId(terminal.conversationId, false) === permissionRoot) &&
			this.isReadRestricted(terminal.conversationId),
		);
		await Promise.all(restricted.map((terminal) => this.terminals.close(terminal.id)));
	}

	async writeTerminal(id: string, data: string): Promise<void> {
		const terminal = this.terminals.list().find((item) => item.id === id);
		if (this.closed || !terminal || this.isReadRestricted(terminal.conversationId)) throw new Error("当前不可向终端输入。");
		await this.terminals.write(id, data);
	}

	async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
		await this.terminals.resize(id, cols, rows);
	}

	async closeTerminal(id: string): Promise<void> {
		await this.terminals.close(id);
	}

	terminalReplay(id: string, afterSequence?: number): TerminalReplay {
		return this.terminals.replay(id, afterSequence);
	}

	beginCheckpoint(conversationId?: string, label?: string): Promise<GitCheckpoint> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			this.assertProjectIdle(conversation.project);
			return this.git.begin(conversation.project, conversation.id, label);
		});
	}

	finishCheckpoint(id: string, conversationId?: string): Promise<GitCheckpoint> {
		return this.serialize(async () => {
			const conversation = this.conversation(conversationId);
			this.assertProjectIdle(conversation.project);
			return this.git.finish(conversation.project, id, { conversationId: conversation.id });
		});
	}

	async listCheckpoints(conversationId?: string): Promise<GitCheckpoint[]> {
		await this.operation;
		const scope = this.checkpointScope(conversationId);
		return this.git.list(scope.project, scope.id);
	}

	async checkpointDiff(id: string, conversationId?: string, path?: string): Promise<GitCheckpointDiff> {
		await this.operation;
		const scope = this.checkpointScope(conversationId);
		return this.git.diff(scope.project, id, path, scope.id);
	}

	async restoreCheckpoint(id: string, conversationId?: string, paths?: string[]): Promise<GitRestoreResult> {
		return this.serialize(async () => {
			const scope = this.checkpointScope(conversationId);
			if (this.isReadRestricted(scope.parentId ?? scope.id)) throw new Error("只读或 Plan 模式禁止恢复文件。");
			this.assertProjectIdle(scope.project);
			if (
				this.terminals
					.list()
					.some((terminal) => terminal.status !== "exited" && overlaps(terminal.project, scope.project))
			)
				throw new Error("请先关闭此项目的交互终端，再恢复文件。");
			return this.git.restore(scope.project, id, paths, scope.id);
		});
	}

	private checkpointScope(conversationId?: string): { project: string; id: string; parentId?: string } {
		if (conversationId && this.external.has(conversationId)) {
			const task = this.external.snapshot(conversationId);
			return { id: task.id, project: task.workingDirectory, parentId: task.parentConversationId };
		}
		return this.conversation(conversationId);
	}

	async listWorktrees(project?: string): Promise<WorktreeInfo[]> {
		await this.operation;
		return this.worktrees.list(project);
	}

	createWorktree(input: WorktreeCreateInput): Promise<WorktreeInfo> {
		return this.serialize(async () => {
			if (this.isReadRestricted(input.conversationId)) throw new Error("只读或 Plan 模式禁止创建 Worktree。");
			if (input.conversationId) this.conversation(input.conversationId);
			return this.worktrees.create(input);
		});
	}

	removeWorktree(id: string, options?: WorktreeRemoveOptions): Promise<WorktreeRemoveResult> {
		return this.serialize(async () => {
			if (this.isReadRestricted()) throw new Error("只读或 Plan 模式禁止删除 Worktree。");
			const item = (await this.worktrees.list()).find((tree) => tree.id === id);
			if (!item) throw new Error("Worktree 不存在。");
			if (this.store.conversations.some((conversation) => overlaps(item.path, conversation.project) && this.monitors.hasActivity(conversation.id)))
				throw new Error("Worktree 中仍有活动的后台命令或监听，请先停止。");
			if (item.conversationId) {
				const runtime = this.runtimes.get(item.conversationId);
				if (runtime) {
					this.assertRuntimeIdle(runtime);
					await this.stopRuntime(runtime);
				}
			}
			return this.worktrees.remove(id, options);
		});
	}

	mergeWorktree(id: string): Promise<WorktreeMergeResult> {
		return this.serialize(() => {
			if (this.isReadRestricted()) throw new Error("只读或 Plan 模式禁止合并 Worktree。");
			return this.worktrees.merge(id);
		});
	}

	private modelWorktreeMutation(operation: "merge", id: string, owner: string, callId: string): Promise<WorktreeMergeResult>;
	private modelWorktreeMutation(operation: "remove", id: string, owner: string, callId: string): Promise<WorktreeRemoveResult>;
	private modelWorktreeMutation(operation: "merge" | "remove", id: string, owner: string, callId: string): Promise<WorktreeMergeResult | WorktreeRemoveResult> {
		return this.serialize(async () => {
			const runtime = this.runtimes.get(owner);
			const tool = operation === "merge" ? "WorktreeMerge" : "WorktreeRemove";
			const calls = Object.values(runtime?.liveTranscript.tools ?? {});
			if (!runtime || runtime.stopping || runtime.bashBusy || calls.length !== 1 || calls[0].id !== callId || calls[0].name !== tool)
				throw new Error("Worktree 操作必须是该会话唯一执行中的工具。");
			const decision = await evaluatePermission(this.permissionPolicy(owner), { toolName: tool, input: { worktree_id: id } });
			if (decision.action === "deny") throw new Error(decision.reason);
			const item = (await this.worktrees.list()).find((tree) => tree.id === id);
			if (!item) throw new Error("Worktree 不存在。");
			if (operation === "remove" && item.conversationId && item.conversationId !== owner) {
				const child = this.runtimes.get(item.conversationId);
				if (child) { this.assertRuntimeIdle(child); await this.stopRuntime(child); }
			}
			// Exempt only the waiting tool's owner. Every other task, shell and PTY still blocks.
			this.worktreeOperationOwner = owner;
			try { return operation === "merge" ? await this.worktrees.merge(id) : await this.worktrees.remove(id); }
			finally { this.worktreeOperationOwner = undefined; }
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.searchAbort?.abort();
		this.remoteJobs.dispose();
		this.languages.close();
		this.agentWatcher?.stop();
		this.agentWatcher = undefined;
		if (this.reapTimer) clearInterval(this.reapTimer);
		this.reapTimer = undefined;
		this.delegation.dispose();
		this.waiters.close();
		this.wakeSlotWaiters();
		for (const timer of this.notifyTimers.values()) clearTimeout(timer);
		this.notifyTimers.clear();
		await this.toolHost.close();
		this.connectionCheck?.cancel(new Error("桌面服务已关闭，连接测试已取消。"));
		await Promise.all([...this.grailRuns.keys()].map((conversationId) => this.cancelGrail(conversationId)));
		await this.operation;
		await this.external.close();
		await this.monitors.close();
		await this.cron.close();
		await this.workflows.close();
		await this.terminals.dispose();
		for (const task of this.store.tasks) {
			if (["queued", "running", "waiting_for_input"].includes(task.status))
				this.updateTask(task, "interrupted", task.parentConversationId ? "应用已关闭；可用 SendMessage 继续。" : "应用已关闭，任务未自动重新执行。", "restart");
		}
		for (const runtime of [...this.runtimes.values()]) {
			await this.stopRuntime(runtime);
		}
		await Promise.allSettled([...this.commands]);
		if (this.sessionEndHooks.size) {
			// Shutdown waits for SessionEnd hooks no longer than the maximum hook timeout.
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.allSettled([...this.sessionEndHooks]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, SESSION_END_HOOK_WAIT_MS);
					timer.unref?.();
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		await this.persist();
		await this.persistence;
		await this.options.tracing?.close().catch(() => this.options.onDiagnostic?.("warn", "tracing_flush_failed", {}));
		this.listeners.clear();
		this.taskListeners.clear();
		this.controlListeners.clear();
	}

	private active(): Conversation | undefined {
		return this.store.conversations.find((item) => item.id === this.store.activeId);
	}
	grailWatchProject(conversationId: string): string | undefined {
		const active = this.active();
		return active?.id === conversationId ? active.project : undefined;
	}
	private requireActive(): Conversation {
		const active = this.active();
		if (!active) throw new Error("请先打开一个项目文件夹。");
		return active;
	}
	private conversation(id?: string): Conversation {
		if (!id) return this.requireActive();
		const conversation = this.store.conversations.find((item) => item.id === id);
		if (!conversation) throw new Error("会话不存在。");
		return conversation;
	}
	private requireAgent(runtime: SessionRuntime): AgentProcess {
		if (!runtime.agent || runtime.engineStatus !== "ready")
			throw new Error(runtime.engineError ?? "Pi 尚未就绪，请重新打开项目。");
		return runtime.agent;
	}
	private assertIdle(): void {
		if (this.external.list().some((task) => ["queued", "running", "waiting_for_input"].includes(task.status))) throw new Error("请先停止外部 Agent，再修改全局设置。");
		for (const runtime of this.runtimes.values()) this.assertRuntimeIdle(runtime);
		if (this.store.tasks.some((item) => ["queued", "running", "waiting_for_input"].includes(item.status)))
			throw new Error("请先停止后台任务，再修改全局设置。");
	}
	private assertRuntimeIdle(runtime: SessionRuntime): void {
		if (
			runtime.engineStatus === "starting" ||
			runtime.busy ||
			runtime.bashBusy ||
			runtime.state?.isStreaming ||
			runtime.state?.isCompacting
		)
			throw new Error("请先停止当前任务，再执行此操作。");
	}
	private task(id: string): DesktopTask {
		const task = this.store.tasks.find((item) => item.id === id);
		if (!task) throw new Error("后台任务不存在。");
		return task;
	}
	private updateTask(task: DesktopTask, status: DesktopTask["status"], error?: string, stopReason?: TaskStopReason): void {
		task.status = status;
		// Hook stderr and provider errors can be large; never persist a value the loader would reject.
		task.error = error === undefined ? undefined : truncateText(error, MAX_TASK_ERROR);
		if (stopReason) task.stopReason = stopReason;
		// The parent model already knows about its own TaskStop, and a stopped parent must
		// not be woken by the children its abort cancelled.
		if (status === "cancelled" && (stopReason === "model_stop" || stopReason === "parent_abort")) task.notifySuppressed = true;
		if (task.teamName && this.store.settings.agentTeams === true) {
			const memberStatus = status === "completed" ? "idle" :
				["cancelled", "failed", "interrupted"].includes(status) ? "shutdown" : "active";
			void this.teams.setMemberStatus(this.rootConversationId(task.conversationId), task.conversationId, memberStatus).catch(() => {});
		}
		task.updatedAt = Date.now();
		task.revision = (task.revision ?? 0) + 1;
		for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		void this.persist().catch(() => {});
		this.waiters.notify(task.id);
		this.wakeSlotWaiters();
		this.delegation.observeTask(task);
		this.external?.pump();
	}
	private pathActive(path: string, exceptId?: string): boolean {
		return (
			Boolean(this.external?.activeInPath(path)) ||
			[...this.runtimes.values()].some(
				(runtime) =>
					runtime.conversationId !== exceptId && (runtime.engineStatus === "starting" ||
						runtime.busy ||
						runtime.bashBusy ||
						Boolean(runtime.settling) ||
						Boolean(runtime.state?.isCompacting)) &&
					overlaps(path, this.conversation(runtime.conversationId).project),
			) ||
			this.store.tasks.some(
				(task) =>
					task.conversationId !== exceptId && ["queued", "running", "waiting_for_input"].includes(task.status) && overlaps(path, task.workingDirectory),
			) ||
			this.terminals.list().some((terminal) => terminal.status !== "exited" && overlaps(path, terminal.project))
		);
	}
	/**
	 * The parent a foreground shared writer yields to: while the parent waits on the Agent
	 * or WorkflowRun call it does not write, so its busy runtime must not block the child it waits for.
	 */
	private yieldingParent(conversationId?: string): string | undefined {
		const task = conversationId ? this.store.tasks.find((item) => item.conversationId === conversationId) : undefined;
		if (!task?.parentConversationId || task.readOnly || task.quarantined || task.worktreeId || !this.hasWaitingParent(task)) return undefined;
		return ["queued", "running", "waiting_for_input"].includes(task.status) ? task.parentConversationId : undefined;
	}

	private hasWaitingParent(task: DesktopTask): boolean {
		if (!task.parentConversationId) return false;
		return task.workflowId
			? this.workflows.hasWaitingCaller(task.workflowId, task.parentConversationId)
			: !task.runInBackground;
	}
	private assertPathAvailable(project: string, exceptId?: string, externalExceptId?: string): void {
		// Explore/Plan have a host-enforced read-only ceiling and never write checkpoints.
		if (exceptId && this.store.tasks.some((task) => task.conversationId === exceptId && task.parentConversationId && task.readOnly)) return;
		if (this.external?.conflicts(project, externalExceptId)) throw new Error("此目录有运行中的外部 Agent，请使用独立 Worktree。");
		const yielding = this.yieldingParent(exceptId);
		for (const runtime of this.runtimes.values()) {
			if (runtime.conversationId === exceptId || runtime.conversationId === yielding) continue;
			if (
				(runtime.engineStatus === "starting" ||
					runtime.busy ||
					runtime.bashBusy ||
					runtime.settling ||
					runtime.state?.isCompacting) &&
				overlaps(project, this.conversation(runtime.conversationId).project)
			)
				throw new Error("此工作目录已有运行中的任务，请使用独立 Worktree 或等待任务结束。");
		}
		if (
			this.store.tasks.some(
				(task) =>
					task.conversationId !== exceptId && task.conversationId !== yielding &&
					["running", "waiting_for_input"].includes(task.status) &&
					overlaps(project, task.workingDirectory),
			)
		)
			throw new Error("此工作目录已有启动中的后台任务，请使用独立 Worktree。");
	}
	private assertProjectIdle(project: string): void {
		this.assertPathAvailable(project);
	}
	private async startCheckpoint(runtime: SessionRuntime, label: string, trackPrompt = false): Promise<void> {
		if (this.isReadRestricted(runtime.conversationId) || this.store.tasks.some((task) => task.conversationId === runtime.conversationId && task.readOnly)) return;
		if (runtime.checkpointId) return;
		if (runtime.checkpointStarting) return runtime.checkpointStarting;
		const starting = this.captureCheckpoint(runtime, label, trackPrompt);
		runtime.checkpointStarting = starting;
		try { await starting; } finally { delete runtime.checkpointStarting; }
	}
	private async captureCheckpoint(runtime: SessionRuntime, label: string, trackPrompt: boolean): Promise<void> {
		const workspace = await this.workspace(runtime.conversationId);
		if (!workspace.isGit) return;
		const conversation = this.conversation(runtime.conversationId);
		const checkpoint = await this.git.begin(conversation.project, conversation.id, label.slice(0, 160));
		runtime.checkpointId = checkpoint.id;
		if (trackPrompt) {
			const before = await runtime.agent?.request<{ messages: { entryId: string }[] }>({ type: "get_fork_messages" })
				.catch(() => undefined);
			if (before) runtime.checkpointUserAnchor = { previousEntryId: before.messages.at(-1)?.entryId ?? null, observedPrompt: false };
		}
		const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
		if (task) task.checkpointId = checkpoint.id;
	}
	private goalWaitsForChildren(runtime: SessionRuntime, goal: GoalState): boolean {
		const owner = runtime.conversationId;
		return this.store.tasks.some((task) => task.parentConversationId === owner && task.runInBackground && !task.notifySuppressed &&
			task.createdAt >= goal.startedAt && ["queued", "running", "waiting_for_input"].includes(task.status)) ||
			this.external.hasActiveBackgroundChildren(owner, goal.startedAt) ||
			this.outbox(owner).some((item) => item.updatedAt >= goal.startedAt && !runtime.queuedNotifications?.has(item.key));
	}

	private async settleGoal(runtime: SessionRuntime, aborted: boolean, error?: string): Promise<void> {
		const conversation = this.store.conversations.find((item) => item.id === runtime.conversationId);
		if (!conversation) return;
		const goal = conversation.goal;
		if (!goal?.active) return;
		if (aborted || error || runtime.stopping || this.closed) {
			stopActiveGoal(conversation, error ? `发生错误：${error}` : "目标模式已停止。");
			await this.persist();
			return;
		}
		const latestText = (await this.childFinalText(runtime).catch(() => "")) ?? "";
		const stats = goal.maxCostUsd !== undefined && runtime.agent && runtime.engineStatus === "ready"
			? await runtime.agent.request<SessionStats>({ type: "get_session_stats" }).catch(() => undefined)
			: undefined;
		const live = this.store.conversations.find((item) => item.id === runtime.conversationId);
		if (!live) return;
		const current = live.goal;
		if (!current?.active || current.startedAt !== goal.startedAt || this.closed || runtime.stopping) return;
		if (current.maxCostUsd !== undefined && !Number.isFinite(stats?.cost)) {
			stopActiveGoal(live, "无法读取本轮费用，已停止自动继续。");
			await this.persist();
			return;
		}
		const evaluation = evaluateGoalContinuation(current, latestText, finiteCount(stats?.cost));
		live.goal = evaluation.next;
		await this.persist();
		const nextPrompt = evaluation.continuePrompt;
		// Active children will wake the parent through their ordinary result delivery.
		if (!evaluation.shouldContinue || !nextPrompt || this.goalWaitsForChildren(runtime, current)) return;
		setImmediate(() => {
			const owner = this.store.conversations.find((item) => item.id === runtime.conversationId);
			if (this.closed || !owner?.goal?.active || owner.goal.startedAt !== current.startedAt ||
				owner.goal.turnsUsed !== evaluation.next.turnsUsed || runtime.stopping || runtime.busy ||
				this.goalWaitsForChildren(runtime, current)) return;
			void this.command({ type: "prompt", message: nextPrompt }, owner.id).catch((cause) => {
				const latest = this.store.conversations.find((item) => item.id === owner.id);
				if (latest?.goal?.startedAt === current.startedAt && stopActiveGoal(latest, cause instanceof Error ? cause.message : String(cause)))
					void this.persist().catch(() => {});
			});
		});
	}

	private async finishRuntime(runtime: SessionRuntime, aborted: boolean, error?: string): Promise<void> {
		this.clearTaskProgressTimer(runtime);
		try {
			if (runtime.checkpointId) {
				const checkpointId = runtime.checkpointId;
				const anchor = runtime.checkpointUserAnchor;
				runtime.checkpointId = undefined;
				runtime.checkpointUserAnchor = undefined;
				let userEntryId: string | undefined;
				if (anchor?.observedPrompt) {
					const after = await runtime.agent?.request<{ messages: { entryId: string }[] }>({ type: "get_fork_messages" })
						.catch(() => undefined);
					if (after) {
						const index = after.messages.findIndex((entry) => entry.entryId === anchor.previousEntryId);
						// The first native entry after the pre-run cursor started this checkpoint.
						// A missing cursor after a session change does not identify any prompt.
						if (index >= 0 || anchor.previousEntryId === null) userEntryId = after.messages[index + 1]?.entryId;
					}
				}
				const conversation = this.conversation(runtime.conversationId);
				await this.git.finish(conversation.project, checkpointId, { conversationId: conversation.id, userEntryId });
			}
			await this.syncState(runtime).catch(() => {});
			await this.saveSessionLeaf(runtime).catch(() => {});
			this.conversation(runtime.conversationId).updatedAt = Date.now();
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task?.parentConversationId && !runtime.metaWritten) {
				const conv = this.conversation(runtime.conversationId);
				await this.writeSubagentMeta(task, conv, conv.sessionFile).catch(() => {});
				runtime.metaWritten = true;
			}
			// A maxTurns stop aborts the run but is a completed, partial result, not a cancellation.
			const limitStop = task?.stopReason === "max_turns" && ["running", "waiting_for_input"].includes(task.status);
			if (task) {
				await this.recordRunStats(runtime, task).catch(() => {});
				this.userBackgroundedTasks.delete(task.id);
			}
			if (task?.parentConversationId) {
				// Record the result even when the process is already gone, so reading it later
				// never needs to start the child again.
				const text = await this.childFinalText(runtime).catch(() => undefined);
				const progress = runtime.progress;
				const readPaths = progress?.taskId === task.id && progress.turn === (task.turn ?? 1)
					? [...progress.readPaths]
					: [];
				if (text !== undefined)
					task.result = {
						text: text.slice(0, MAX_AGENT_OUTPUT),
						truncated: text.length > MAX_AGENT_OUTPUT,
						...(readPaths.length ? { readPaths } : {}),
						...(limitStop ? { partial: true } : {}),
					};
				else if (limitStop && task.result) task.result.partial = true;
			}
			if (task && ["running", "waiting_for_input"].includes(task.status)) {
				if (error) this.updateTask(task, "failed", error, "error");
				else if (aborted && !limitStop) this.updateTask(task, "cancelled", undefined, task.stopReason ?? "user_stop");
				else this.updateTask(task, "completed");
			}
			await this.persist();
			if (!task?.parentConversationId) await this.settleGoal(runtime, aborted, error);
			if (!runtime.stopping && !this.closed && !runtime.stopHookRanThisTurn) {
				if (task?.parentConversationId) {
					const meta = await this.hookContextFor(runtime.conversationId);
					await this.runStopOrSubagentStopHook({
						conversationId: runtime.conversationId,
						meta,
						lastAssistantMessage: task.result?.text,
					}).catch(() => {});
				} else if (!aborted) {
					await this.runStopOrSubagentStopHook({
						conversationId: runtime.conversationId,
						meta: {},
					}).catch(() => {});
				}
			}
		} catch (failure) {
			const message = `无法完成 Git 恢复点：${failure instanceof Error ? failure.message : String(failure)}`;
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "failed", message, "error");
			this.emit({ conversationId: runtime.conversationId, event: { type: "desktop_error", message } });
		} finally {
			await this.releaseRuntimeCost(runtime);
			runtime.settling = undefined;
			// A stopped child's partial output is recorded now; its parent may receive it.
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task?.parentConversationId && !["queued", "running", "waiting_for_input"].includes(task.status)) {
				void this.monitors.stopForConversation([runtime.conversationId], "child_finished");
			}
			if (task?.parentConversationId && task.runInBackground && !["queued", "running", "waiting_for_input"].includes(task.status))
				void this.flushNotifications(task.parentConversationId, "auto");
			if (this.store.settings.agentTeams === true && !this.closed)
				void this.teams.retryPending(this.rootConversationId(runtime.conversationId)).catch(() => {});
			void this.scheduleTasks();
			this.external?.pump();
		}
	}
	/** Store this run's usage (difference to the baseline taken when it started) on the task. */
	private async recordRunStats(runtime: SessionRuntime, task: DesktopTask): Promise<void> {
		const baseline = task.statsAtTurnStart;
		if (!baseline || !runtime.agent || runtime.engineStatus !== "ready") return;
		const stats = await runtime.agent.request<SessionStats>({ type: "get_session_stats" });
		const now = statTokens(stats.tokens);
		const delta = (key: keyof typeof now) => Math.max(0, now[key] - baseline.tokens[key]);
		const model = runtime.state?.model ? { provider: runtime.state.model.provider, id: runtime.state.model.id } : task.model;
		task.stats = {
			tokens: { input: delta("input"), output: delta("output"), cacheRead: delta("cacheRead"), cacheWrite: delta("cacheWrite"), total: delta("total") },
			cost: Math.max(0, finiteCount(stats.cost) - baseline.cost),
			toolUses: Math.max(0, finiteCount(stats.toolCalls) - baseline.toolCalls),
			startedAt: baseline.startedAt,
			durationMs: Math.max(0, Date.now() - baseline.startedAt),
			...(model ? { model } : {}),
		};
	}
	private async stopRuntime(runtime: SessionRuntime, cursor: "capture" | "preserve" = "capture"): Promise<void> {
		const endContext =
			runtime.sessionStarted && !runtime.stopping
				? this.sessionEndContext(runtime.conversationId, runtime.sessionPermissionMode)
				: undefined;
		runtime.sessionStarted = false;
		runtime.stopping = true;
		this.clearTaskProgressTimer(runtime);
		if (cursor === "capture" && runtime.agent && runtime.engineStatus === "ready") {
			try {
				if (runtime.busy || runtime.state?.isStreaming || runtime.state?.isCompacting || runtime.pendingUI.size) {
					await this.cancelDialogs(runtime);
					await runtime.agent.request({ type: "abort" });
				}
				if (runtime.bashBusy) await runtime.agent.request({ type: "abort_bash" });
				await this.saveSessionLeaf(runtime);
			} catch {
				// A stopped run may have appended entries after the last persisted navigation cursor.
				if (runtime.busy || runtime.bashBusy) delete this.conversation(runtime.conversationId).sessionLeafId;
			}
		}
		await runtime.agent?.stop();
		await runtime.loading;
		await runtime.agent?.stop();
		this.options.tracing?.finishRun(runtime.conversationId, "aborted");
		runtime.agent = undefined;
		// Background shells end with the runtime that started them (they use its sandbox profile).
		await this.monitors.stopShellsForConversation(runtime.conversationId, "runtime_stop");
		await this.monitors.stopForConversation([runtime.conversationId], "runtime_stop");
		runtime.shellEnv = undefined;
		if (runtime.settling) await runtime.settling;
		if (runtime.checkpointId) await this.finishRuntime(runtime, true);
		runtime.pendingUI.clear();
		const stoppedTask = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
		if (stoppedTask) delete stoppedTask.pendingApprovals;
		if (runtime.navigation) await rm(runtime.navigation.directory, { recursive: true, force: true });
		if (runtime.controls) {
			this.toolHost.revoke(runtime.controls.hostToken);
			await rm(runtime.controls.directory, { recursive: true, force: true });
		}
		if (runtime.policyFile) await rm(runtime.policyFile, { force: true });
		if (runtime.sandboxProfileFile) await rm(runtime.sandboxProfileFile, { force: true });
		if (runtime.escalationFile) await rm(runtime.escalationFile, { force: true });
		if (runtime.outputStyleFile) await rm(runtime.outputStyleFile, { force: true });
		await this.releaseRuntimeCost(runtime);
		if (runtime.costLimitFile) await this.serializeCost(() => rm(runtime.costLimitFile!, { force: true }));
		if (this.runtimes.get(runtime.conversationId) === runtime) this.runtimes.delete(runtime.conversationId);
		if (endContext) this.fireSessionEnd(endContext);
	}

	/** PostCompact mirrors PreCompact's context; it never blocks the event stream. */
	private firePostCompact(conversationId: string, reason: string, summary: string | undefined): void {
		void (async () => {
			const conversation = this.conversation(conversationId);
			const meta = await this.hookContextFor(conversationId);
			await this.hooks.run("PostCompact", {
				project: this.trustProjectFor(conversation.project),
				projectTrusted: this.isProjectTrusted(conversation.project),
				conversationId,
				permissionMode: this.hookPermissionMode(conversationId),
				trigger: reason === "manual" ? "manual" : "auto",
				...(typeof summary === "string" ? { compactSummary: summary.slice(0, 16384) } : {}),
				agentId: meta.agentId,
				agentType: meta.agentType,
				extraHooks: meta.extraHooks,
				env: this.options.env,
			});
		})().catch(() => {});
	}

	/** Capture hook context before the runtime goes away; a removed conversation yields nothing. */
	private sessionEndContext(conversationId: string, permissionMode?: string): HookRunContext | undefined {
		try {
			const conversation = this.conversation(conversationId);
			return {
				project: this.trustProjectFor(conversation.project),
				projectTrusted: this.isProjectTrusted(conversation.project),
				conversationId,
				permissionMode: permissionMode ?? this.hookPermissionMode(conversationId),
				env: this.options.env,
			};
		} catch {
			return undefined;
		}
	}

	/** Fire-and-forget SessionEnd; "close" when the app is quitting, otherwise "other". */
	private fireSessionEnd(context: HookRunContext): void {
		const run = this.hooks
			.run("SessionEnd", { ...context, reason: this.closed ? "close" : "other" })
			.catch(() => undefined);
		this.sessionEndHooks.add(run);
		void run.finally(() => this.sessionEndHooks.delete(run));
	}

	/** Claude-compatible permission_mode for hooks: dontAsk is reported by name. */
	private hookPermissionMode(conversationId: string): string {
		const policy = this.permissionPolicy(conversationId);
		return policy.dontAsk ? "dontAsk" : policy.mode;
	}

	private isSlotBorrower(task: DesktopTask): boolean {
		if (!this.hasWaitingParent(task)) return false;
		const active = new Set(["running", "waiting_for_input"]);
		const seen = new Set<string>([task.conversationId]);
		let cursor: string | undefined = task.parentConversationId;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const ancestor = this.store.tasks.find((item) => item.conversationId === cursor);
			if (!ancestor) return false;
			if (active.has(ancestor.status)) return true;
			if (ancestor.runInBackground) return false;
			cursor = ancestor.parentConversationId;
		}
		return false;
	}

	private async scheduleTasks(): Promise<void> {
		if (this.scheduling || this.closed) return;
		this.scheduling = true;
		try {
			await this.operation;
			const maxBase = this.options.maxConcurrentTasks ?? 4;
			const maxBorrowed = this.options.maxBorrowedSlots ?? DEFAULT_MAX_BORROWED_SLOTS;
			const runningTasks = this.store.tasks.filter((task) => ["running", "waiting_for_input"].includes(task.status));
			let baseActive = runningTasks.filter((task) => !this.isSlotBorrower(task)).length + this.external.countRunning();
			let borrowedActive = runningTasks.filter((task) => this.isSlotBorrower(task)).length;
			for (const task of this.store.tasks.filter((item) => item.status === "queued").reverse()) {
				if (this.closed) break;
				const borrow = this.isSlotBorrower(task);
				if (borrow ? borrowedActive >= maxBorrowed : baseActive >= maxBase) continue;
				try {
					this.assertPathAvailable(task.workingDirectory, task.conversationId);
				} catch {
					continue;
				}
				this.updateTask(task, "running");
				const launch = (this.launches.get(task.conversationId) ?? 0) + 1;
				this.launches.set(task.conversationId, launch);
				if (borrow) borrowedActive++;
				else baseActive++;
				void this.runTask(task, launch);
			}
		} finally {
			this.scheduling = false;
			this.external?.pump();
		}
	}
	private async runTask(task: DesktopTask, launch: number): Promise<void> {
		try {
			const runtime = await this.ensureRuntime(this.conversation(task.conversationId));
			if (
				this.closed ||
				this.launches.get(task.conversationId) !== launch ||
				task.status === "cancelled" ||
				task.status === "interrupted"
			) {
				await this.stopRuntime(runtime);
				return;
			}
			const agent = this.requireAgent(runtime);
			// A resumed task keeps the model and thinking level its session already has.
			const resumed = (task.turn ?? 1) > 1;
			const message = resumed ? task.pendingMessage : task.prompt;
			if (!message?.trim()) throw new Error("没有可发送给子 Agent 的消息。");
			if (!resumed && task.model) await agent.request({ type: "set_model", provider: task.model.provider, modelId: task.model.id });
			if (this.closed || this.launches.get(task.conversationId) !== launch) return;
			if (!resumed && task.thinkingLevel) await agent.request({ type: "set_thinking_level", level: task.thinkingLevel });
			if (this.closed || this.launches.get(task.conversationId) !== launch) return;
			await this.prepareTaskUsage(runtime, task);
			if (this.closed || this.launches.get(task.conversationId) !== launch) {
				await this.releaseRuntimeCost(runtime);
				return;
			}
			await this.command({ type: "prompt", message }, task.conversationId, launch);
			// Pi accepted the message; it is part of the child's session now.
			if (resumed && task.pendingMessage === message) {
				delete task.pendingMessage;
				await this.persist();
			}
		} catch (error) {
			const runtime = this.runtimes.get(task.conversationId);
			if (runtime) await this.releaseRuntimeCost(runtime);
			if (!this.closed && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "failed", error instanceof Error ? error.message : String(error), "error");
			void this.scheduleTasks();
		}
	}

	private async prepareTaskUsage(runtime: SessionRuntime, task: DesktopTask): Promise<void> {
		// A forked child starts with its parent's history. Each run measures usage from its own baseline.
		const baseline = await this.requireAgent(runtime).request<SessionStats>({ type: "get_session_stats" }).catch(() => undefined);
		if (task.parentConversationId && runtime.costLimitFile) {
			if (!baseline) throw new Error("无法读取子任务费用基线。");
			const reservation = await this.reserveChildCost(task.parentConversationId, task.id);
			if (!reservation) throw new Error("任务费用设置已更改，请重新发起任务。");
			runtime.releaseCostReservation = reservation.release;
			await this.atomicFile(runtime.costLimitFile, String(finiteCount(baseline.cost) + reservation.maxBudgetUsd));
		}
		task.statsAtTurnStart = {
			tokens: statTokens(baseline?.tokens),
			cost: finiteCount(baseline?.cost),
			toolCalls: finiteCount(baseline?.toolCalls),
			startedAt: Date.now(),
		};
		delete task.stats;
	}

	private async releaseRuntimeCost(runtime: SessionRuntime): Promise<void> {
		const release = runtime.releaseCostReservation;
		delete runtime.releaseCostReservation;
		if (release && runtime.costLimitFile) await this.atomicFile(runtime.costLimitFile, "0").catch(() => {});
		await release?.().catch(() => {});
	}
	private createConversation(project: string): Conversation {
		const conversation = { id: randomUUID(), title: "新会话", project, updatedAt: Date.now() };
		this.store.conversations.unshift(conversation);
		return conversation;
	}
	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operation.then(() => {
			if (this.closed) throw new Error("桌面服务已关闭。");
			return action();
		});
		this.operation = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async activate(conversation: Conversation): Promise<void> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const previous = this.store.activeId && this.runtimes.get(this.store.activeId);
		this.store.activeId = conversation.id;
		if (
			previous &&
			previous.conversationId !== conversation.id &&
			this.reapable(previous, "switch")
		) {
			await this.stopRuntime(previous);
		}
		await this.persist();
		this.ensureAgentWatcher(conversation.project);
		if (await this.projectAvailable(conversation)) await this.ensureRuntime(conversation);
	}

	private async ensureRuntime(conversation: Conversation): Promise<SessionRuntime> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		if (!(await this.projectAvailable(conversation))) throw new Error("工作目录已移除，仅可查看会话存档。");
		let runtime = this.runtimes.get(conversation.id);
		if (runtime?.engineStatus === "error" && !runtime.busy && !runtime.bashBusy) {
			await this.stopRuntime(runtime);
			runtime = undefined;
		}
		if (!runtime) {
			runtime = {
				conversationId: conversation.id,
				liveTranscript: { tools: {} },
				eventSequence: this.eventSequence,
				transcriptRevision: 0,
				models: [],
				engineStatus: "starting",
				busy: false,
				bashBusy: false,
				pendingUI: new Map(),
				answeredUI: new Set(),
				stopping: false,
				lastActivity: Date.now(),
			};
			this.runtimes.set(conversation.id, runtime);
			runtime.loading = this.startRuntime(runtime, conversation);
		}
		await runtime.loading;
		return runtime;
	}

	private async startRuntime(runtime: SessionRuntime, conversation: Conversation): Promise<void> {
		try {
			if (!(await this.projectAvailable(conversation)))
				throw new Error("工作目录已移除，仅可查看会话存档，无法继续执行任务。");
			const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
			const sessionDir = join(this.options.dataDir, "sessions");
			await mkdir(sessionDir, { recursive: true, mode: 0o700 });
			const canonicalSessionDir = await realpath(sessionDir);
			let sessionFile: string | undefined;
			if (conversation.sessionFile) {
				if (
					!inside(sessionDir, resolve(conversation.sessionFile)) &&
					!inside(canonicalSessionDir, resolve(conversation.sessionFile))
				)
					throw new Error("会话文件超出应用目录。");
				try {
					sessionFile = await realpath(conversation.sessionFile);
					if (!inside(canonicalSessionDir, sessionFile)) throw new Error("会话文件超出应用目录。");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || conversation.sessionLeafId) throw error;
				}
			}
			if (runtime.stopping || this.closed) throw new Error("会话已关闭。");
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...this.options.env,
				PI_SKIP_VERSION_CHECK: "1",
				PI_DESKTOP_PERMISSION_MODE: this.store.settings.permission,
				...networkEnvironment(this.store.settings),
			};
			if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
			env.PI_DESKTOP_CONNECTIONS = JSON.stringify(this.connectionEnvironment(env, true));
			delete env.PI_DESKTOP_MAX_COST;
			delete env.PI_DESKTOP_MIN_BALANCE;
			delete env.PI_DESKTOP_FALLBACK_MODEL;
			delete env.PI_DESKTOP_ESCALATION_MODEL;
			delete env.PI_DESKTOP_ESCALATION_FILE;
			if (this.store.settings.fallbackModel) env.PI_DESKTOP_FALLBACK_MODEL = JSON.stringify(this.store.settings.fallbackModel);
			if (this.store.settings.minBalance) env.PI_DESKTOP_MIN_BALANCE = String(this.store.settings.minBalance);
			const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
			const delegated = task?.parentConversationId ? task : undefined;
			env.PI_DESKTOP_TOOL_OUTPUT_ROOT = join(this.options.dataDir, "tool-output");
			env.PI_DESKTOP_TOOL_OUTPUT_OWNER = conversation.id;
			const scopedRead = Boolean(delegated?.scopePaths);
			const webSearchEnabled = this.store.settings.webSearchEnabled !== false && !scopedRead;
			env.PI_DESKTOP_WEB_SEARCH_ENABLED = webSearchEnabled ? "1" : "0";
			delete env.PI_DESKTOP_WEB_SEARCH_KEY;
			if (webSearchEnabled) {
				const rawSearchKey = this.store.webSearchApiKey ?? this.store.keys.deepseek;
				if (rawSearchKey && this.options.decrypt) {
					try {
						const decrypted = this.options.decrypt(rawSearchKey).trim();
						if (decrypted) env.PI_DESKTOP_WEB_SEARCH_KEY = decrypted;
					} catch {
						// Ignore undecryptable key; WebSearch tool will prompt to reconfigure.
					}
				}
			}
			runtime.policyFile = join(this.options.dataDir, `policy-${conversation.id}-${randomBytes(8).toString("hex")}.json`);
			env.PI_DESKTOP_POLICY_FILE = runtime.policyFile;
			if (!delegated) {
				runtime.escalationFile = runtime.policyFile + ".verification";
				env.PI_DESKTOP_ESCALATION_FILE = runtime.escalationFile;
			}
			delete env.PI_DESKTOP_SANDBOX_PROFILE;
			const shouldConfineWorktreeChild = Boolean(
				delegated && !delegated.readOnly && delegated.worktreeId && this.store.settings.confineSubagentBash !== false,
			);
			const initialExtraDirs = this.permissionPolicy(conversation.id).additionalDirs ?? [];
			if (this.store.settings.sandbox) {
				if (!(await probeSeatbeltSupport()).supported) throw new Error("无法启动命令沙箱。请在支持的环境中运行，或在设置中关闭沙箱。");
				const extraWritable = [...(await resolveGitWorktreeWritablePaths(conversation.project)), ...initialExtraDirs];
				runtime.sandboxProfileFile = join(this.options.dataDir, `sandbox-${conversation.id}-${randomBytes(8).toString("hex")}.sb`);
				await writeFile(runtime.sandboxProfileFile, buildSeatbeltProfile(conversation.project, extraWritable, this.store.settings.sandboxOffline), { mode: 0o600 });
				env.PI_DESKTOP_SANDBOX_PROFILE = runtime.sandboxProfileFile;
			} else if (shouldConfineWorktreeChild && (await probeSeatbeltSupport()).supported) {
				const extraWritable = [...(await resolveGitWorktreeWritablePaths(conversation.project)), ...initialExtraDirs];
				runtime.sandboxProfileFile = join(this.options.dataDir, `sandbox-${conversation.id}-${randomBytes(8).toString("hex")}.sb`);
				await writeFile(runtime.sandboxProfileFile, buildSeatbeltProfile(conversation.project, extraWritable, this.store.settings.sandboxOffline), { mode: 0o600 });
				env.PI_DESKTOP_SANDBOX_PROFILE = runtime.sandboxProfileFile;
			}
			// Set these explicitly so an inherited shell environment cannot change a session's role.
			env.PI_DESKTOP_CHILD = delegated ? "1" : "0";
			delete env.PI_DESKTOP_OUTPUT_STYLE_FILE;
			if (!delegated) {
				runtime.outputStyleFile = join(this.options.dataDir, `style-${conversation.id}-${randomBytes(8).toString("hex")}.md`);
				await this.writeOutputStyle(runtime);
				env.PI_DESKTOP_OUTPUT_STYLE_FILE = runtime.outputStyleFile;
			}
			delete env.PI_DESKTOP_MAX_COST;
			delete env.PI_DESKTOP_MAX_COST_FILE;
			if (this.store.settings.maxCostUsd) {
				runtime.costLimitFile = join(this.options.dataDir, `cost-${conversation.id}-${randomBytes(8).toString("hex")}.txt`);
				await this.atomicFile(runtime.costLimitFile, String(delegated ? 0 : this.rootCostLimit(conversation.id)));
				env.PI_DESKTOP_MAX_COST_FILE = runtime.costLimitFile;
			}
			env.PI_DESKTOP_READ_ONLY_CHILD = delegated?.readOnly ? "1" : "0";
			env.PI_DESKTOP_AGENT_SCOPED = scopedRead ? "1" : "0";
			env.PI_DESKTOP_FORK_CHILD = delegated?.isFork ? "1" : "0";
			env.PI_DESKTOP_DELEGATION_DEPTH = String(delegated ? (delegated.delegationDepth ?? 1) : 0);
			env.PI_DESKTOP_MAX_DEPTH = String(this.store.settings.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH);
			env.PI_DESKTOP_AGENT_TEAMS = this.store.settings.agentTeams === true ? "1" : "0";
			env.PI_DESKTOP_TEAM_MEMBER = delegated?.teamName ? "1" : "0";
			env.PI_DESKTOP_STRUCTURED_OUTPUT = delegated?.structuredOutputSchema !== undefined ? "1" : "0";
			env.PI_DESKTOP_HOOK_FASTPATH = "1";
			env.PI_DESKTOP_HOOK_HOME = homedir();
			env.PI_DESKTOP_TRUST_PROJECT = this.trustProjectFor(conversation.project);
			env.PI_DESKTOP_HOOK_PROJECT_TRUSTED = this.isProjectTrusted(conversation.project) ? "1" : "0";
			env.PI_DESKTOP_AGENT_HOOK_TYPE = delegated?.subagentType;
			env.PI_DESKTOP_AGENT_HOOK_PROJECT = delegated?.project;
			env.PI_DESKTOP_AGENT_HOOK_PROJECT_TRUSTED = delegated ? this.isProjectTrusted(delegated.project) ? "1" : "0" : undefined;
			if (delegated?.maxTurns) env.PI_DESKTOP_MAX_TURNS = String(delegated.maxTurns);
			else delete env.PI_DESKTOP_MAX_TURNS;
			const toolExtension = this.options.toolControlExtension ?? join(runtimeDir, "tool-control-extension.mjs");
			const toolsInstalled = await stat(toolExtension).then((info) => info.isFile(), (error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			});
			if (toolsInstalled) {
				await this.toolHost.start();
				const host = this.toolHost.register(conversation.id);
				runtime.controls = { directory: await mkdtemp(join(this.options.dataDir, "tools-")), token: randomBytes(32).toString("hex"), command: `desktop-tools-${randomBytes(16).toString("hex")}`, hostToken: host.token, operation: Promise.resolve() };
				env.PI_DESKTOP_TOOLS_DIR = runtime.controls.directory;
				env.PI_DESKTOP_TOOLS_TOKEN = runtime.controls.token;
				env.PI_DESKTOP_TOOLS_COMMAND = runtime.controls.command;
				env.PI_DESKTOP_TOOLS_FILE = join(runtime.controls.directory, "tools.json");
				env.PI_DESKTOP_TOOLS_BASELINE_FILE = join(this.options.dataDir, `tool-baseline-${conversation.id}.json`);
				env.PI_DESKTOP_HOST_URL = host.url;
				env.PI_DESKTOP_HOST_TOKEN = host.token;
			}
			await this.writeRuntimeControls(runtime);
			const navigationExtension =
				this.options.navigationExtension ?? join(runtimeDir, "session-navigation-extension.mjs");
			const navigationInstalled = await stat(navigationExtension).then(
				(info) => info.isFile(),
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			);
			if (navigationInstalled) {
				runtime.navigation = {
					directory: await mkdtemp(join(this.options.dataDir, "navigation-")),
					token: randomBytes(32).toString("hex"),
					command: `desktop-navigate-${randomBytes(16).toString("hex")}`,
				};
				env.PI_DESKTOP_NAVIGATION_DIR = runtime.navigation.directory;
				env.PI_DESKTOP_NAVIGATION_TOKEN = runtime.navigation.token;
				env.PI_DESKTOP_NAVIGATION_COMMAND = runtime.navigation.command;
			}
			// Pi reads protected project resources once at startup. Pass an explicit
			// decision so RPC mode never silently falls back to its "ask" default.
			const trustResources = await detectProjectTrustResources(conversation.project);
			const trustProject = this.trustProjectFor(conversation.project);
			const trustDecision = this.store.projectTrust?.[trustProject];
			if (task?.omitClaudeMd || scopedRead) {
				env.PI_DESKTOP_MEMORY_ROOT = "";
				env.PI_DESKTOP_MEMORY_FILE = "";
				env.PI_DESKTOP_USER_MEMORY_FILE = "";
			} else {
				env.PI_DESKTOP_MEMORY_ROOT = trustDecision === "trusted" ? conversation.project : "";
				env.PI_DESKTOP_MEMORY_FILE = trustDecision === "trusted" ? this.privateMemoryPath(trustProject) : "";
				const userMemory = join(this.options.env?.HOME ?? homedir(), ".claude", "CLAUDE.md");
				env.PI_DESKTOP_USER_MEMORY_FILE = await realpath(userMemory).then(
					(path) => path,
					() => "",
				);
			}
			const args = [
				"--session-dir",
				sessionDir,
				...(sessionFile ? ["--session", sessionFile] : ["--session-id", conversation.id]),
				...(task?.omitClaudeMd || scopedRead ? ["--no-context-files"] : []),
				...(scopedRead ? ["--no-skills", "--no-prompt-templates"] : []),
				"--extension",
				this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
				...(navigationInstalled ? ["--extension", navigationExtension] : []),
				...(toolsInstalled ? ["--extension", toolExtension] : []),
				...(trustResources.length ? [trustDecision === "trusted" ? "--approve" : "--no-approve"] : []),
				...(scopedRead ? [] : await this.claudeResourceArgs(conversation.project, trustDecision === "trusted")),
				...(this.options.args ?? []),
			];
			if (!sessionFile && this.store.settings.defaultModel) {
				const model = this.store.settings.defaultModel;
				args.push("--provider", model.provider, "--model", model.id);
			}
			const policy = this.permissionPolicy(conversation.id);
			const policyMode = policy.mode;
			const dynamicPermissions = toolsInstalled && !delegated;
			if (dynamicPermissions) env.PI_DESKTOP_DYNAMIC_PERMISSION = "1";
			else delete env.PI_DESKTOP_DYNAMIC_PERMISSION;
			const toolArgs = piToolArgs(task, dynamicPermissions ? "ask" : policyMode, { canDelegate: this.canDelegateFurther(conversation.id) });
			// Pi's coding defaults omit ls; add it without replacing the configured tool set.
			if (!task && toolArgs.length === 0 && !this.options.args?.some((arg) => explicitCliToolFlags.has(arg)))
				toolArgs.push("--tools", "+ls");
			args.push(...toolArgs);
			if (task?.parentConversationId && task.systemPromptFile && !task.quarantined) {
				// An explicit --append-system-prompt replaces Pi's APPEND_SYSTEM.md discovery;
				// pass the file Pi would have found first so the child keeps it.
				const discovered = await appendSystemPromptFile(conversation.project, !scopedRead && trustDecision === "trusted", this.store.settings.agentDir ?? this.defaultAgentDir());
				const own = await stat(task.systemPromptFile).then((info) => info.isFile(), () => false);
				if (own) args.push(...(discovered ? ["--append-system-prompt", discovered] : []), "--append-system-prompt", task.systemPromptFile);
			}
			// Background shells get the environment foreground bash inherits from this child.
			runtime.shellEnv = env;
			const agent = new AgentProcess({
				executable: this.options.executable,
				entry: this.options.entry ?? join(runtimeDir, "dist/bundle/rpc-entry.js"),
				cwd: conversation.project,
				args,
				env,
				onEvent: (event) => {
					if (this.runtimes.get(runtime.conversationId) !== runtime || runtime.stopping) return;
					if (runtime.replacing && event.type !== "extension_ui_request") return;
					this.onEvent(runtime, event);
				},
			});
			runtime.agent = agent;
			await this.syncState(runtime);
			const result = await agent.request<{ models: Model[] }>({ type: "get_available_models" });
			runtime.models = result.models.map(({ id, name, provider, contextWindow, reasoning }) => ({
				id,
				name,
				provider,
				contextWindow,
				reasoning,
			}));
			runtime.engineStatus = "ready";
			runtime.sessionStarted = true;
			void this.hooks.run("SessionStart", {
				project: this.trustProjectFor(conversation.project),
				projectTrusted: this.isProjectTrusted(conversation.project),
				conversationId: conversation.id,
				permissionMode: runtime.sessionPermissionMode ?? this.hookPermissionMode(conversation.id),
				source: sessionFile ? "resume" : "startup",
				env: this.options.env,
			}).catch(() => {});
			if (conversation.sessionLeafId !== undefined) {
				const cursor = await agent.request<SessionTreeResult>({ type: "get_tree" });
				if (cursor.leafId !== conversation.sessionLeafId) {
					const restored = await this.navigationRequest(runtime, {
						requestId: randomUUID(),
						operation: "restore",
						leafId: conversation.sessionLeafId,
					});
					if (!restored.ok) throw new Error(restored.error.message);
					if (restored.cancelled || restored.leafId !== conversation.sessionLeafId)
						throw new Error("无法恢复所选会话分支，扩展取消了导航。");
					await this.syncState(runtime);
				}
			}
			// Results that finished while this parent was not running wait for its next turn
			// (or the user's "立即交付"); starting the runtime never starts a run for them.
			if (runtime.controls && this.outbox(conversation.id).length) await this.flushNotifications(conversation.id, "startup");
		} catch (error) {
			runtime.engineStatus = "error";
			runtime.engineError = error instanceof Error ? error.message : String(error);
			this.diagnostic("error", "engine_start_failed", runtime.conversationId, runtime.engineError);
			await runtime.agent?.stop();
			runtime.agent = undefined;
		}
	}

	private initTaskProgress(runtime: SessionRuntime, task: DesktopTask): void {
		this.clearTaskProgressTimer(runtime);
		const now = Date.now();
		runtime.progress = {
			taskId: task.id,
			turn: task.turn ?? 1,
			toolUses: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			startedAt: task.statsAtTurnStart?.startedAt ?? now,
			recentActivities: [],
			readPaths: new Set(),
			lastEmitAt: 0,
			lastPersistAt: now,
		};
	}

	private clearTaskProgressTimer(runtime: SessionRuntime): void {
		if (runtime.progress?.emitTimer) {
			clearTimeout(runtime.progress.emitTimer);
			runtime.progress.emitTimer = undefined;
		}
	}

	private buildTaskProgress(runtime: SessionRuntime, task: DesktopTask): TaskProgress | undefined {
		const p = runtime.progress;
		if (!p || p.taskId !== task.id) return undefined;
		const now = Date.now();
		return {
			taskId: task.id,
			status: task.status,
			turn: p.turn,
			toolUses: p.toolUses,
			...(p.lastToolName ? { lastToolName: p.lastToolName } : {}),
			tokens: { ...p.tokens },
			cost: p.cost,
			startedAt: p.startedAt,
			durationMs: Math.max(0, now - p.startedAt),
			...(runtime.pendingUI.size > 0 || task.status === "waiting_for_input" ? { waitingForApproval: true } : {}),
			recentActivities: p.recentActivities.map((item) => ({ ...item })),
		};
	}

	private emitTaskProgress(runtime: SessionRuntime, task: DesktopTask): void {
		const p = runtime.progress;
		if (!p || p.taskId !== task.id || this.closed) return;
		const now = Date.now();
		p.lastEmitAt = now;
		const progress = this.buildTaskProgress(runtime, task);
		if (!progress) return;
		for (const listener of this.taskListeners) listener({ type: "task_progress", taskId: task.id, progress });
		const direct = this.progressListeners.get(task.id);
		if (direct) for (const listener of direct) listener(progress);
		// Progress events never persist on every tick; flush running stats to disk at most every 5s.
		if (now - p.lastPersistAt >= TASK_PROGRESS_PERSIST_MS && ["running", "waiting_for_input"].includes(task.status)) {
			p.lastPersistAt = now;
			const model = runtime.state?.model ? { provider: runtime.state.model.provider, id: runtime.state.model.id } : task.model;
			task.stats = {
				tokens: { ...p.tokens },
				cost: p.cost,
				toolUses: p.toolUses,
				startedAt: p.startedAt,
				durationMs: progress.durationMs,
				...(model ? { model } : {}),
			};
			void this.persist().catch(() => {});
		}
	}

	private scheduleProgressEmit(runtime: SessionRuntime, task: DesktopTask, immediate = false): void {
		const p = runtime.progress;
		if (!p || p.taskId !== task.id) return;
		const elapsed = Date.now() - p.lastEmitAt;
		if (immediate || elapsed >= TASK_PROGRESS_THROTTLE_MS) {
			this.clearTaskProgressTimer(runtime);
			this.emitTaskProgress(runtime, task);
			return;
		}
		if (p.emitTimer) return;
		p.emitTimer = setTimeout(() => {
			if (runtime.progress) runtime.progress.emitTimer = undefined;
			const latest = this.store.tasks.find((item) => item.id === task.id);
			if (latest) this.emitTaskProgress(runtime, latest);
		}, TASK_PROGRESS_THROTTLE_MS - elapsed);
	}

	private subscribeTaskProgress(taskId: string, listener: (progress: TaskProgress) => void): () => void {
		let listeners = this.progressListeners.get(taskId);
		if (!listeners) {
			listeners = new Set();
			this.progressListeners.set(taskId, listeners);
		}
		listeners.add(listener);
		const task = this.store.tasks.find((item) => item.id === taskId);
		const runtime = task ? this.runtimes.get(task.conversationId) : undefined;
		if (task && runtime) {
			const current = this.buildTaskProgress(runtime, task);
			if (current) listener(current);
		}
		return () => {
			listeners?.delete(listener);
			if (listeners && !listeners.size) this.progressListeners.delete(taskId);
		};
	}

	private syncTaskPendingApprovals(runtime: SessionRuntime, task: DesktopTask | undefined): void {
		if (!task) return;
		const approvals: TaskPendingApproval[] = [];
		for (const req of runtime.pendingUI.values()) {
			if (!["confirm", "select", "input", "editor"].includes(req.method)) continue;
			approvals.push({
				id: req.id,
				method: req.method as TaskPendingApproval["method"],
				title: truncateText("title" in req && typeof req.title === "string" ? req.title : "Pi 需要你的输入", 500),
				...("message" in req && typeof req.message === "string" ? { message: truncateText(req.message, 4096) } : {}),
				...("options" in req && Array.isArray(req.options)
					? { options: req.options.slice(0, 50).map((item) => truncateText(String(item), 500)) }
					: {}),
				...("placeholder" in req && typeof req.placeholder === "string"
					? { placeholder: truncateText(req.placeholder, 4096) }
					: {}),
				...("prefill" in req && typeof req.prefill === "string" ? { prefill: truncateText(req.prefill, 4096) } : {}),
				...("timeout" in req && typeof req.timeout === "number" ? { timeout: req.timeout } : {}),
			});
		}
		if (approvals.length > 0) task.pendingApprovals = approvals;
		else delete task.pendingApprovals;
	}

	/** Recursively collect open interactive requests from all descendant tasks of `conversationId`. */
	private collectChildApprovals(conversationId: string): ChildApprovalRequest[] {
		const results: ChildApprovalRequest[] = [];
		const visited = new Set<string>([conversationId]);
		const walk = (parentId: string, depth: number) => {
			for (const task of this.store.tasks) {
				if (task.parentConversationId !== parentId || visited.has(task.conversationId)) continue;
				visited.add(task.conversationId);
				const runtime = this.runtimes.get(task.conversationId);
				if (runtime) this.syncTaskPendingApprovals(runtime, task);
				for (const req of task.pendingApprovals ?? []) {
					results.push({
						taskId: task.id,
						conversationId: task.conversationId,
						description: task.title || task.subagentType || task.id,
						...(task.name ? { name: task.name } : {}),
						...(task.subagentType ? { subagentType: task.subagentType } : {}),
						depth,
						request: { ...req, ...(req.options ? { options: [...req.options] } : {}) },
					});
				}
				walk(task.conversationId, depth + 1);
			}
		};
		walk(conversationId, 1);
		return results;
	}

	private onEvent(runtime: SessionRuntime, event: DesktopEvent["event"]): void {
		const conversationId = runtime.conversationId;
		const sequence = ++this.eventSequence;
		runtime.eventSequence = sequence;
		runtime.lastActivity = Date.now();
		runtime.liveTranscript = applyLiveEvent(runtime.liveTranscript, event);
		let queuedPromptGroups: QueuedPromptGroups | undefined;
		if (event.type === "queue_update") {
			const queue = runtime.userQueue ??= new QueuedPrompts();
			queue.update(event);
			queuedPromptGroups = queue.groups();
			if (runtime.state) runtime.state.pendingMessageCount = event.steering.length + event.followUp.length;
		}
		if (event.type === "message_end" && event.message.role === "user" && runtime.checkpointUserAnchor)
			runtime.checkpointUserAnchor.observedPrompt = true;
		// Deltas change the live projection, but not the finalized get_messages list.
		if (
			[
				"message_start",
				"message_end",
				"agent_start",
				"agent_settled",
				"compaction_start",
				"compaction_end",
				"desktop_error",
			].includes(event.type)
		)
			runtime.transcriptRevision++;
		const modelNotice = temporaryModelNotice(event);
		if (modelNotice) {
			if (event.type === "entry_appended") runtime.transcriptRevision++;
			if (modelNotice === FALLBACK_MESSAGE_TYPE) runtime.lastError = undefined;
			void this.syncState(runtime).catch(() => {});
		}
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		if (this.options.tracing) {
			const sessionId = event.type === "agent_start" ? this.rootConversationId(conversationId, false) : conversationId;
			this.options.tracing.observe(conversationId, event, sessionId, task?.parentConversationId, !!runtime.lastError);
		}
		if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
			runtime.pendingUI.set(event.id, event);
			this.syncTaskPendingApprovals(runtime, task);
			if (task && task.status !== "cancelled" && task.status !== "interrupted") {
				this.updateTask(task, "waiting_for_input");
				this.scheduleProgressEmit(runtime, task, true);
			}
			const conv = this.conversation(conversationId);
			void this.hooks.run("Notification", {
				project: this.trustProjectFor(conv.project),
				projectTrusted: this.isProjectTrusted(conv.project),
				conversationId,
				permissionMode: this.hookPermissionMode(conversationId),
				notificationType: event.method === "confirm" ? "permission_prompt" : "elicitation_dialog",
				title: "title" in event ? event.title : undefined,
				message: "message" in event ? event.message : undefined,
				env: this.options.env,
			}).catch(() => {});
		}
		if (event.type === "agent_start") {
			runtime.busy = true;
			if (!runtime.workingTurn?.active && !runtime.workingTurn?.stopOperation)
				runtime.workingTurn = { id: randomUUID(), active: true };
			runtime.stopHookRanThisTurn = false;
			this.consumeQueuedNotifications(runtime);
			if (runtime.state) runtime.state.isStreaming = true;
			if (runtime.workingTurn?.stopRequested || (task && (task.status === "cancelled" || task.status === "interrupted"))) {
				void runtime.agent?.request({ type: "abort" }).catch(() => {});
			} else if (task) {
				// A new run starts without the previous run's stop reason or result; while it
				// runs, readers see the live output and the new result is recorded when it settles.
				delete task.stopReason;
				delete task.result;
				this.updateTask(task, "running");
				this.initTaskProgress(runtime, task);
				this.scheduleProgressEmit(runtime, task, true);
			}
		}
		if (event.type === "tool_execution_start" && task && ["running", "waiting_for_input"].includes(task.status)) {
			if (!runtime.progress || runtime.progress.taskId !== task.id) this.initTaskProgress(runtime, task);
			const p = runtime.progress!;
			p.toolUses++;
			p.lastToolName = event.toolName;
			p.recentActivities.push({
				toolName: event.toolName,
				summary: summarizeToolActivity(event.toolName, event.args),
				startedAt: Date.now(),
			});
			if (p.recentActivities.length > MAX_RECENT_TASK_ACTIVITIES) {
				p.recentActivities.splice(0, p.recentActivities.length - MAX_RECENT_TASK_ACTIVITIES);
			}
			this.scheduleProgressEmit(runtime, task);
		}
		if (event.type === "tool_execution_end" && event.toolName === "read" && !event.isError && event.durationMs !== undefined &&
			task?.parentConversationId && task.readOnly && runtime.progress?.taskId === task.id && runtime.progress.turn === (task.turn ?? 1)) {
			const path = event.result?.details?.desktopReadPath;
			if (isTaskReadPath(path) && runtime.progress.readPaths.size < MAX_TASK_READ_PATHS)
				runtime.progress.readPaths.add(path);
		}
		if (event.type === "compaction_start" && runtime.state) runtime.state.isCompacting = true;
		if (event.type === "compaction_end" && runtime.state) runtime.state.isCompacting = false;
		if (event.type === "compaction_end" && event.result && !event.aborted) this.firePostCompact(conversationId, event.reason, event.result.summary);
		// Results deferred while an idle parent compacted are sent once compaction ends.
		if (event.type === "compaction_end" && !runtime.busy) void this.flushNotifications(conversationId, "auto");
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "error")
				runtime.lastError = event.message.errorMessage ?? "模型请求失败。";
			if (task && ["running", "waiting_for_input"].includes(task.status) && event.message.usage) {
				if (!runtime.progress || runtime.progress.taskId !== task.id) this.initTaskProgress(runtime, task);
				const p = runtime.progress!;
				const usage = event.message.usage;
				const input = finiteCount(usage.input);
				const output = finiteCount(usage.output);
				const cacheRead = finiteCount(usage.cacheRead);
				const cacheWrite = finiteCount(usage.cacheWrite);
				const total = finiteCount(usage.totalTokens) || input + output + cacheRead + cacheWrite;
				p.tokens.input += input;
				p.tokens.output += output;
				p.tokens.cacheRead += cacheRead;
				p.tokens.cacheWrite += cacheWrite;
				p.tokens.total += total;
				p.cost += finiteCount(usage.cost?.total);
				this.scheduleProgressEmit(runtime, task);
			}
		}
		if (event.type === "agent_settled") {
			runtime.busy = false;
			if (runtime.workingTurn) runtime.workingTurn.active = false;
			if (runtime.state) runtime.state.isStreaming = false;
			runtime.pendingUI.clear();
			this.syncTaskPendingApprovals(runtime, task);
			runtime.settling = this.finishRuntime(runtime, event.aborted, runtime.lastError);
			// Settlement is emitted after host cleanup; allocate its delivery sequence at that point.
			const turn = this.turnSnapshot(runtime);
			void runtime.settling.finally(() => {
				this.emit({ conversationId, event, turn });
				// A live parent receives results that could not be delivered during its run,
				// including results whose automatic retries were exhausted.
				void this.flushNotifications(conversationId, "settled");
				this.monitors.onConversationSettled(conversationId);
				this.cron.onConversationSettled(conversationId);
			});
			return;
		}
		if (event.type === "desktop_error") {
			runtime.busy = false;
			if (runtime.workingTurn) runtime.workingTurn.active = false;
			runtime.bashBusy = false;
			runtime.engineStatus = "error";
			runtime.engineError = event.message;
			this.diagnostic("error", /^Pi 进程已退出/.test(event.message) ? "pi_process_exited" : "engine_error", conversationId, event.message);
			runtime.pendingUI.clear();
			this.syncTaskPendingApprovals(runtime, task);
			runtime.settling = this.finishRuntime(runtime, false, event.message);
		}
		if (event.type === "session_info_changed") {
			const conversation = this.conversation(conversationId);
			if (conversation && event.name) conversation.title = event.name;
		}
		this.emit({ conversationId, event, sequence, ...(queuedPromptGroups ? { queuedPromptGroups } : {}) });
	}

	private emit(event: DesktopEvent): void {
		const runtime = this.runtimes.get(event.conversationId);
		if (runtime && !event.turn && ["agent_start", "message_start", "desktop_error"].includes(event.event.type)) {
			event = { ...event, turn: this.turnSnapshot(runtime) };
		}
		if (event.sequence === undefined && runtime) {
			runtime.eventSequence = ++this.eventSequence;
			event = { ...event, sequence: runtime.eventSequence };
		}
		for (const listener of this.listeners) listener(event);
	}

	private async syncState(runtime: SessionRuntime): Promise<void> {
		const agent = runtime.agent;
		if (!agent) return;
		const state = await agent.request<RpcSessionState>({ type: "get_state" });
		if (agent !== runtime.agent) return;
		runtime.state = safeState(state);
		const sessionFile = runtime.state.sessionFile;
		const conv = this.conversation(runtime.conversationId);
		conv.sessionFile = sessionFile
			? await stat(sessionFile).then(
					() => sessionFile,
					(error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					},
				)
			: undefined;
		if (conv.sessionFile && !runtime.metaWritten) {
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId && item.parentConversationId);
			if (task) {
				runtime.metaWritten = true;
				await this.writeSubagentMeta(task, conv, conv.sessionFile).catch(() => {});
			}
		}
	}

	private async buildSnapshot(conversationId = this.store.activeId): Promise<Snapshot> {
		const runtime = conversationId ? this.runtimes.get(conversationId) : undefined;
		let messages: Message[] = [];
		let stats: SessionStats | undefined;
		let thinkingLevels: ThinkingLevel[] = [];
		let commands: SlashCommand[] = [];
		let liveTranscript: LiveTranscript | undefined;
		let eventSequence: number | undefined;
		const conversation = conversationId ? this.conversation(conversationId) : undefined;
		const archived = Boolean(conversation && !(await this.projectAvailable(conversation)));
		if (runtime && runtime.agent && runtime.engineStatus === "ready") {
			const agent = runtime.agent;
			try {
				const [usage, levels, slash] = await Promise.all([
					agent.request<SessionStats>({ type: "get_session_stats" }),
					agent.request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }),
					agent.request<{ commands: SlashCommand[] }>({ type: "get_commands" }),
				]);
				let state: RpcSessionState;
				let transcript: { messages: Message[] };
				// Retry only when messages are appended/replaced, never for ordinary token deltas.
				for (;;) {
					const revision = runtime.transcriptRevision;
					[state, transcript] = await Promise.all([
						agent.request<RpcSessionState>({ type: "get_state" }),
						agent.request<{ messages: Message[] }>({ type: "get_messages" }),
					]);
					if (revision === runtime.transcriptRevision || agent !== runtime.agent) break;
				}
				if (agent !== runtime.agent) return this.buildSnapshot(conversationId);
				liveTranscript = runtime.liveTranscript;
				eventSequence = runtime.eventSequence;
				runtime.state = safeState(state);
				messages = transcript.messages;
				stats = usage;
				thinkingLevels = levels.levels;
				commands = slash.commands.filter((item) => item.name !== runtime.navigation?.command && item.name !== runtime.controls?.command);
			} catch (error) {
				runtime.engineStatus = "error";
				runtime.engineError = error instanceof Error ? error.message : String(error);
			}
		}
		if ((!runtime?.agent || archived) && conversation?.sessionFile && this.historyAvailable) {
			messages = (
				await this.history.inspect({ sessionFile: conversation.sessionFile, leafId: conversation.sessionLeafId })
			).messages;
		} else if (archived && conversation?.sessionFile) {
			const sessionFile = await realpath(conversation.sessionFile);
			const sessionRoot = await realpath(join(this.options.dataDir, "sessions"));
			if (!inside(sessionRoot, sessionFile)) throw new Error("会话存档超出应用数据目录。");
			const runtimeDir = this.options.runtimeDir ?? dirname(dirname(dirname(this.options.entry!)));
			const { stdout } = await exec(
				this.options.executable,
				[this.options.archiveEntry ?? join(runtimeDir, "archive-entry.mjs"), sessionFile, conversation.project],
				{
					env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: "1", PI_OFFLINE: "1" },
					maxBuffer: 64 * 1024 * 1024,
					timeout: 30000,
				},
			);
			const storedMessages: unknown = JSON.parse(stdout);
			if (!Array.isArray(storedMessages)) throw new Error("会话存档返回格式无效。");
			messages = storedMessages as Message[];
		}
		const trust = conversation ? await this.projectTrustState(conversation.project) : undefined;
		const delegatedParents = new Map<string, string>();
		for (const item of this.store.tasks) {
			if (item.parentConversationId) delegatedParents.set(item.conversationId, item.parentConversationId);
		}
		const annotateConversation = (conv: Conversation): Conversation => {
			const parentId = delegatedParents.get(conv.id);
			if (!parentId) return conv;
			return { ...conv, kind: "subagent", parentConversationId: conv.parentConversationId ?? parentId };
		};
		const conversations = this.store.conversations.map(annotateConversation);
		return {
			eventSequence,
			activitySequence: this.eventSequence,
			activity: Object.fromEntries([...this.runtimes.values()].flatMap<[string, "approval" | "running"]>((item) =>
				item.pendingUI.size ? [[item.conversationId, "approval" as const]]
					: item.busy || item.bashBusy || item.state?.isCompacting ? [[item.conversationId, "running" as const]] : [],
			)),
			bashBusy: runtime?.bashBusy ?? false,
			turn: runtime ? this.turnSnapshot(runtime) : undefined,
			liveTranscript,
			queuedMessages: runtime?.userQueue?.preview(),
			queuedPromptGroups: runtime?.userQueue?.groups(),
			projects: this.store.projects,
			conversations,
			active: conversationId ? annotateConversation(this.conversation(conversationId)) : undefined,
			state: runtime ? runtime.state : undefined,
			models: runtime ? runtime.models : [],
			providerPresets,
			settings: {
				...this.store.settings,
				agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(),
				configuredProviders: providers.filter((provider) => this.providerAuthenticated(provider)),
				webSearchApiKeyConfigured: Boolean(this.store.webSearchApiKey),
			},
			messages,
			stats,
			engineStatus: runtime ? runtime.engineStatus : "ready",
			engineError: runtime ? runtime.engineError : this.engineError,
			pendingUI: runtime ? [...runtime.pendingUI.values()] : [],
			thinkingLevels,
			commands,
			archived,
			trust,
			...(conversationId ? { childApprovals: this.collectChildApprovals(conversationId) } : {}),
			...(conversationId && this.heldNotificationCount(conversationId) ? { pendingTaskNotifications: this.heldNotificationCount(conversationId) } : {}),
		};
	}

	private trustProjectFor(project: string): string {
		if (this.store.projects.some((item) => item.path === project)) return project;
		const task = this.store.tasks.find((item) => item.workingDirectory === project);
		return task?.project ?? project;
	}

	private async projectTrustState(project: string): Promise<ProjectTrustState> {
		const trustProject = this.trustProjectFor(project);
		const resources: string[] = await detectProjectTrustResources(project);
		const memory = await managedFile(this.options.dataDir, ["project-memory"], memoryName(trustProject), false)
			.then((file) => file ? stat(file).then(() => true, () => false) : false, () => false);
		if (memory) resources.push(privateMemoryLabel);
		return {
			project: trustProject,
			resources,
			required: resources.length > 0,
			decision: this.store.projectTrust?.[trustProject],
		};
	}

	private async projectAvailable(conversation: Conversation): Promise<boolean> {
		try {
			return (await stat(conversation.project)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async scopedPath(path: string, conversationId?: string): Promise<string> {
		const root = await realpath(this.conversation(conversationId).project);
		const candidate = resolve(root, path);
		if (!inside(root, candidate)) throw new Error("文件路径超出项目目录。");
		const actual = await realpath(candidate);
		if (!inside(root, actual)) throw new Error("符号链接指向项目目录之外。");
		return actual;
	}

	private defaultAgentDir(): string {
		return this.options.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	}

	private async cancelDialogs(runtime: SessionRuntime): Promise<void> {
		const ids = [...runtime.pendingUI.keys()];
		runtime.pendingUI.clear();
		for (const id of ids) await runtime.agent?.respond({ type: "extension_ui_response", id, cancelled: true });
	}

	private persist(): Promise<void> {
		const serialized = JSON.stringify(this.store, (key, value) => (key === "pendingApprovals" ? undefined : value), 2);
		this.persistence = this.persistence
			.catch(() => {})
			.then(async () => {
				const destination = join(this.options.dataDir, "desktop.json");
				const temporary = `${destination}.tmp`;
				await writeFile(temporary, serialized, { mode: 0o600 });
				await rename(temporary, destination);
			});
		return this.persistence;
	}
}

function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}
function overlaps(left: string, right: string): boolean {
	return inside(left, right) || inside(right, left);
}
function storedText(value: unknown, max: number, absolute = false): string | undefined {
	if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) return undefined;
	return absolute && !isAbsolute(value) ? undefined : value;
}

/** A one-line shell command; Pi runs it with the user's shell and caches the key. */
export function validateKeyCommand(raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("取 Key 命令只能是一行，且不超过 4096 字符。");
	return value;
}

const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const reservedHeaders = new Set(["host", "content-length", "transfer-encoding", "connection"]);

export function validateHeaders(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("请求头格式错误。");
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > 32) throw new Error("自定义请求头最多 32 个。");
	const headers: Record<string, string> = {};
	for (const [name, value] of entries) {
		if (!headerNamePattern.test(name)) throw new Error(`请求头名称无效：${name.slice(0, 40)}`);
		if (reservedHeaders.has(name.toLowerCase())) throw new Error(`不能自定义 ${name} 请求头。`);
		if (typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`请求头 ${name} 的值无效。`);
		headers[name] = value;
	}
	return headers;
}

/** Accepts an http(s) proxy URL; an empty value clears the setting. */
export function validateProxyUrl(raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("代理地址格式错误，例如 http://127.0.0.1:7890。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("代理地址仅支持 http:// 或 https://。");
	if (!url.hostname) throw new Error("代理地址缺少主机名。");
	// Settings are stored in plain JSON; a credentialed proxy belongs in the shell's HTTPS_PROXY.
	if (url.username || url.password)
		throw new Error("代理地址不能包含用户名或密码。需要认证的代理请在终端配置 HTTPS_PROXY，应用会自动读取。");
	return value;
}

/**
 * Proxy and CA variables for an agent process. Settings override what the app
 * inherited from the shell; both upper and lower case are set because undici
 * reads the lower-case names first.
 */
/** Proxy URL without credentials, for display. */
function proxyLabel(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}`;
	} catch {
		return "（格式无法解析）";
	}
}

export function networkEnvironment(settings: Pick<Settings, "proxy" | "noProxy" | "caFile">): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	if (settings.proxy) {
		for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) env[name] = settings.proxy;
	}
	if (settings.noProxy) {
		env.NO_PROXY = settings.noProxy;
		env.no_proxy = settings.noProxy;
	}
	if (settings.caFile) env.NODE_EXTRA_CA_CERTS = settings.caFile;
	return env;
}

function validateStore(input: unknown, promptDir?: string): { state: StoredState; dropped: string[] } {
	if (!input || typeof input !== "object") throw new Error("配置格式错误。");
	const value = input as Partial<StoredState>;
	if (!Array.isArray(value.projects) || !Array.isArray(value.conversations) || !value.settings || !value.keys)
		throw new Error("配置字段缺失。");
	if (
		!value.projects.every(
			(project) => typeof project.path === "string" && isAbsolute(project.path) && typeof project.name === "string",
		)
	)
		throw new Error("项目配置格式错误。");
	if (
		!value.conversations.every(
			(conversation) =>
				typeof conversation.id === "string" &&
				/^[a-zA-Z0-9._-]+$/.test(conversation.id) &&
				typeof conversation.title === "string" &&
				typeof conversation.project === "string" &&
				isAbsolute(conversation.project) &&
				typeof conversation.updatedAt === "number",
		)
	)
		throw new Error("会话配置格式错误。");
	if (
		!["ask", "acceptEdits", "read", "auto", "plan", "dontAsk"].includes(value.settings.permission) ||
		!["light", "dark", "grail", "system"].includes(value.settings.theme)
	)
		throw new Error("设置格式错误。");
	const defaultModel = value.settings.defaultModel;
	if (
		defaultModel !== undefined &&
		(!defaultModel || typeof defaultModel.provider !== "string" || typeof defaultModel.id !== "string")
	)
		throw new Error("默认模型配置格式错误。");
	const projectTrust: Record<string, ProjectTrustDecision> = {};
	if (value.projectTrust !== undefined) {
		if (!value.projectTrust || typeof value.projectTrust !== "object" || Array.isArray(value.projectTrust))
			throw new Error("项目信任配置格式错误。");
		for (const [project, decision] of Object.entries(value.projectTrust)) {
			if (!isAbsolute(project) || (decision !== "trusted" && decision !== "untrusted"))
				throw new Error("项目信任配置格式错误。");
			projectTrust[project] = decision;
		}
	}
	// Tasks are validated field by field: malformed records are dropped instead of
	// rejecting the whole store, and never reach process arguments or ownership checks.
	const { tasks, taskPolicies, dropped } = sanitizeStoredTasks(
		value.tasks,
		new Map(value.conversations.map((conversation) => [conversation.id, conversation.project])),
		value.taskPolicies,
		{ promptDir },
	);
	const state: StoredState = {
		projects: value.projects.map(({ path, name, blockLocalCompute }) => ({
			path,
			name,
			...(blockLocalCompute === true ? { blockLocalCompute: true } : {}),
		})),
		conversations: value.conversations.map((conversation) => ({
			...conversation,
			permissionMode: permissionModes.has(conversation.permissionMode) ? conversation.permissionMode : undefined,
		})),
		activeId: value.activeId,
		settings: {
			permission: value.settings.permission,
			theme: value.settings.theme,
			sandbox: typeof value.settings.sandbox === "boolean" ? value.settings.sandbox : undefined,
			sandboxOffline: value.settings.sandbox === true && value.settings.sandboxOffline === true,
			notifications: typeof value.settings.notifications === "boolean" ? value.settings.notifications : undefined,
			subagentDefaultBackground: typeof value.settings.subagentDefaultBackground === "boolean" ? value.settings.subagentDefaultBackground : undefined,
			foregroundSubagentTimeoutMs:
				Number.isSafeInteger(value.settings.foregroundSubagentTimeoutMs) &&
				(value.settings.foregroundSubagentTimeoutMs as number) >= 0 &&
				(value.settings.foregroundSubagentTimeoutMs as number) <= MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS
					? value.settings.foregroundSubagentTimeoutMs
					: undefined,
			forkSubagent: typeof value.settings.forkSubagent === "boolean" ? value.settings.forkSubagent : undefined,
			confineSubagentBash: typeof value.settings.confineSubagentBash === "boolean" ? value.settings.confineSubagentBash : undefined,
			maxSubagentDepth:
				Number.isSafeInteger(value.settings.maxSubagentDepth) &&
				(value.settings.maxSubagentDepth as number) >= 1 &&
				(value.settings.maxSubagentDepth as number) <= MAX_DELEGATION_DEPTH
					? value.settings.maxSubagentDepth
					: undefined,
			maxConcurrentSubagents:
				Number.isSafeInteger(value.settings.maxConcurrentSubagents) &&
				(value.settings.maxConcurrentSubagents as number) >= 1 &&
				(value.settings.maxConcurrentSubagents as number) <= MAX_CONCURRENT_SUBAGENTS_LIMIT
					? value.settings.maxConcurrentSubagents
					: undefined,
			cronEnabled: typeof value.settings.cronEnabled === "boolean" ? value.settings.cronEnabled : undefined,
			agentTeams: typeof value.settings.agentTeams === "boolean" ? value.settings.agentTeams : undefined,
			modelRouting: sanitizeModelRouting(value.settings.modelRouting),
			maxCostUsd:
				typeof value.settings.maxCostUsd === "number" &&
				Number.isFinite(value.settings.maxCostUsd) &&
				value.settings.maxCostUsd > 0 &&
				value.settings.maxCostUsd <= 100000
					? value.settings.maxCostUsd
					: undefined,
			minBalance:
				typeof value.settings.minBalance === "number" &&
				Number.isFinite(value.settings.minBalance) &&
				value.settings.minBalance > 0 &&
				value.settings.minBalance <= 1000000
					? value.settings.minBalance
					: undefined,
			grailModel: sanitizeFallbackModel(value.settings.grailModel),
			grailMaxCost: validGrailMaxCost(value.settings.grailMaxCost) ? value.settings.grailMaxCost : undefined,
			grailTimeoutSec: validGrailTimeout(value.settings.grailTimeoutSec) ? value.settings.grailTimeoutSec : undefined,
			disableAllHooks: value.settings.disableAllHooks === true ? true : undefined,
			fallbackModel: sanitizeFallbackModel(value.settings.fallbackModel),
			outputStyle: (() => {
				const name = validOutputStyleName(value.settings.outputStyle);
				return name && name.toLowerCase() !== DEFAULT_OUTPUT_STYLE ? name : undefined;
			})(),
			editor: EDITOR_CHOICES.includes(value.settings.editor as EditorChoice) ? value.settings.editor : undefined,
			statusBalance: value.settings.statusBalance === false ? false : undefined,
			webSearchEnabled: value.settings.webSearchEnabled === false ? false : undefined,
			proxy: storedText(value.settings.proxy, 2048),
			noProxy: storedText(value.settings.noProxy, 4096),
			caFile: storedText(value.settings.caFile, 4096, true),
			defaultModel: value.settings.defaultModel,
			connections: value.settings.connections ?? {},
			agentDir: value.settings.agentDir,
		},
		keys: value.keys,
		webSearchApiKey: typeof value.webSearchApiKey === "string" && value.webSearchApiKey ? value.webSearchApiKey : undefined,
		headerKeys:
			value.headerKeys && typeof value.headerKeys === "object" && !Array.isArray(value.headerKeys)
				? Object.fromEntries(
						Object.entries(value.headerKeys).filter(
							([provider, encrypted]) => providers.includes(provider as Provider) && typeof encrypted === "string",
						),
					)
				: undefined,
		tasks,
		taskPolicies,
		projectTrust,
	};
	return { state, dropped };
}

function fallbackKey(ref: { provider: string; id: string } | undefined): string {
	return ref ? `${ref.provider}/${ref.id}` : "";
}

function summarizeToolActivity(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const rec = args as Record<string, unknown>;
	const pick = (keys: string[]): string | undefined => {
		for (const key of keys) {
			const val = rec[key];
			if (typeof val === "string" && val.trim()) return truncateText(val.trim().replace(/\s+/g, " "), 120);
		}
		return undefined;
	};
	if (toolName === "bash" || toolName === "powershell") return pick(["command"]);
	if (toolName === "read" || toolName === "write" || toolName === "edit") return pick(["path", "file_path"]);
	if (toolName === "grep" || toolName === "find") return pick(["pattern", "path", "glob"]);
	return pick(["path", "description", "query", "command", "task_id"]);
}

function safeState(state: RpcSessionState): RpcSessionState {
	if (!state.model) return state;
	const { id, name, provider, api, reasoning, input, contextWindow, maxTokens, cost } = state.model;
	// Pi uses an empty endpoint for its unconfigured placeholder model on first launch.
	const url = URL.canParse(state.model.baseUrl) ? new URL(state.model.baseUrl) : undefined;
	// Model headers, URL credentials and query parameters are runtime-only configuration.
	return {
		...state,
		model: {
			id,
			name,
			provider,
			api,
			reasoning,
			input,
			contextWindow,
			maxTokens,
			cost,
			baseUrl: url ? `${url.origin}${url.pathname}` : "",
		},
	};
}
