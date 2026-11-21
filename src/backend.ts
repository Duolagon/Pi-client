import { createDraftPullRequest, readPullRequest, type DraftPullRequest } from "./review-service.ts";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, realpath, stat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentProcess } from "./rpc.ts";
import { GitSnapshots } from "./git-snapshots.ts";
import { TerminalService } from "./terminal-service.ts";
import { WorktreeService } from "./worktree-service.ts";
import { SessionHistoryService } from "./session-history.ts";
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
import type {
	SessionNavigationBridgeRequest,
	SessionNavigationBridgeResponse,
} from "./session-navigation-extension.ts";
import type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
import type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
import type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";
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
	MAX_SEND_MESSAGE,
	MAX_TURN_CALLS,
	PARENT_MESSAGE_PREFIX,
	MAX_AGENT_SYSTEM_PROMPT,
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
	ConnectionInput,
	ConnectionProtocol,
	ConnectionTestResult,
	ProviderBalanceResult,
	ConnectionMode,
} from "./shared.ts";
import { connectionMode, validateEndpoint } from "./model-connections.ts";
import { providerModels, providerPresets } from "./provider-presets.ts";
import { memoryLimit, memoryName, privateMemoryLabel } from "./project-memory.ts";
import { codeIntelligence, type CodePosition } from "./language-service.ts";
import { detectProjectTrustResources } from "./project-trust.ts";
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
import { parseModelRoutingUpdate, sanitizeModelRouting } from "./model-routing.ts";
import { McpRegistry } from "./mcp-registry.ts";
import type { McpRemoveInput, McpSaveInput, McpServerInfo } from "./mcp-types.ts";
import { HooksService } from "./hooks-service.ts";
import type { HookEntry, HookRemoveInput, HookRunResult, HookSaveInput, HookTestInput } from "./hook-types.ts";
import { BUNDLED_SKILLS, SkillRegistry, bundledSkillFile } from "./skill-registry.ts";
import { balanceTarget, fetchBalance, type BalanceTarget } from "./provider-balance.ts";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { rootCertificates } from "node:tls";
import type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
import { TodoService } from "./todo-service.ts";
import type { TodoCreateInput, TodoEvent, TodoGetInput, TodoListInput, TodoRecord, TodoUpdateInput } from "./todo-types.ts";
import { MonitorService } from "./monitor-service.ts";
import type { MonitorEvent, MonitorRecord, MonitorStartInput } from "./monitor-types.ts";
import { CronService, parseLoopCommandArgs } from "./cron-service.ts";
import { cronToolNames, type CronCreateInput, type CronEvent, type CronJobRecord, type ScheduleWakeupInput } from "./cron-types.ts";
import { TeamsService } from "./teams-service.ts";
import type { TeamEvent, TeamMessageType, TeamRecord } from "./team-types.ts";
import { WorkflowService } from "./workflow-service.ts";
import { validateJsonSchema } from "./workflow-schema.ts";
import type { WorkflowApprovalDecision, WorkflowEvent, WorkflowRecord, WorkflowRunInput } from "./workflow-types.ts";
import { buildContextReport, deleteProjectMemoryRule, writeProjectMemoryFile, type ContextBreakdown, type ContextMemorySource } from "./context-inspector.ts";
import { buildSeatbeltProfile, probeSeatbeltSupport, resolveGitWorktreeWritablePaths } from "./sandbox.ts";
import { readClaudeProjectPermissionsDetailed, writeClaudeProjectPermissions } from "./claude-settings-sync.ts";
import { createForkedSessionSnapshot, findSessionFileById } from "./session-fork.ts";
import type { BtwResult, ClaudePermissionsSyncResult, PlanFileState, SandboxStatus } from "./shared.ts";
import { ExternalAgents } from "./external-agents.ts";
import { CodexAdapter } from "./external-codex.ts";
import { ClaudeAdapter } from "./external-claude.ts";
import { KimiAdapter } from "./external-kimi.ts";
import type { ExternalAdapter, ExternalApprovalResponse, ExternalEvent, ExternalExecutorInput, ExternalProvider, ExternalTask, ExternalTaskSendInput, ExternalTaskStartInput } from "./external-types.ts";
import type { DeliverCustomType, DesktopToolInvocation, NotificationDelivery, NotificationDisposition, NotificationUsage, ToolHostContext } from "./tool-control-types.ts";
import { formatTaskNotification, notificationStatus, TASK_NOTIFICATION_TYPE, type TaskNotificationDetails } from "./delegation-format.ts";
import { TaskWaiters } from "./task-waiters.ts";
import type { ExternalNotification } from "./external-agents.ts";
import type { RpcExtensionUIResponse, SessionStats } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "./shared.ts";

const exec = promisify(execFile);
const providers: Provider[] = ["anthropic", "openai", "google", "openrouter", "deepseek"];
const piBuiltinTools = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);

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
	if (definedTools !== undefined) {
		// An explicit empty allowlist must deny all built-in tools instead of
		// falling back to Pi's unrestricted default.
		const list = definedTools.length > 0 ? [...definedTools, ...delegationTools] : definedTools;
		return ["--tools", list.join(","), ...(policyMode === "read" || policyMode === "plan" ? ["--exclude-tools", "mcp__*"] : [])];
	}
	if (policyMode === "read") return ["--tools", ["read", "grep", "find", "ls", ...delegationTools].join(","), "--exclude-tools", "mcp__*"];
	if (policyMode === "plan") return ["--tools", ["read", "grep", "find", "ls", "write", "edit", ...delegationTools].join(","), "--exclude-tools", "mcp__*"];
	return [];
}
function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
	tasks: DesktopTask[];
	taskPolicies?: Record<string, RuntimePermissionPolicy>;
	/** Canonical project path to the user's explicit trust decision. */
	projectTrust?: Record<string, ProjectTrustDecision>;
}
interface SessionRuntime {
	conversationId: string;
	liveTranscript: LiveTranscript;
	eventSequence: number;
	transcriptRevision: number;
	agent?: AgentProcess;
	state?: RpcSessionState;
	models: Model[];
	engineStatus: Snapshot["engineStatus"];
	engineError?: string;
	busy: boolean;
	bashBusy: boolean;
	pendingUI: Map<string, RpcExtensionUIRequest>;
	/** Recently answered UI request ids in this runtime, so duplicate replies are idempotent. */
	answeredUI: Set<string>;
	checkpointId?: string;
	settling?: Promise<void>;
	loading?: Promise<void>;
	lastError?: string;
	stopping: boolean;
	replacing?: boolean;
	stopHookRanThisTurn?: boolean;
	navigation?: { directory: string; token: string; command: string };
	controls?: { directory: string; token: string; command: string; hostToken: string; operation: Promise<void> };
	policyFile?: string;
	sandboxProfileFile?: string;
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
		emitTimer?: ReturnType<typeof setTimeout>;
		lastEmitAt: number;
		lastPersistAt: number;
	};
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
type FlushMode = "auto" | "settled" | "startup" | "now";
export interface ServiceOptions {
	dataDir: string;
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
	private connectionCheck?: { agent: AgentProcess; cancel: (error: Error) => void };
	private engineError?: string;
	private closed = false;
	private listeners = new Set<(event: DesktopEvent) => void>();
	private taskListeners = new Set<(event: TaskEvent) => void>();
	private progressListeners = new Map<string, Set<(progress: TaskProgress) => void>>();
	private userBackgroundedTasks = new Set<string>();
	private scheduling = false;
	private launches = new Map<string, number>();
	private commands = new Set<Promise<unknown>>();
	private operation: Promise<void> = Promise.resolve();
	private persistence: Promise<void> = Promise.resolve();
	private eventSequence = 0;
	private toolSettings: ToolSettingsStore;
	private toolHost: ToolHostServer;
	private delegation: ModelDelegation;
	private agents: AgentRegistry;
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
	private waiters = new TaskWaiters();
	/** Consecutive delivery failures per outbox key; memory only, reset by a manual delivery. */
	private notifyAttempts = new Map<string, number>();
	private notifyTimers = new Map<string, NodeJS.Timeout>();
	private notifyChains = new Map<string, Promise<void>>();
	private notificationCounts = new Map<string, number>();
	/** Conversations the renderer shows outside the active one (e.g. a task detail view). */
	private viewing = new Set<string>();
	private reapTimer?: NodeJS.Timeout;

	constructor(options: ServiceOptions) {
		this.options = options;
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
		this.cron = new CronService({
			dataDir: () => this.options.dataDir,
			deliver: (id, params) => this.deliverToConversation(id, params),
			isEnabled: () => this.store.settings.cronEnabled !== false,
			isProjectTrusted: (project) => this.isProjectTrusted(project),
		});
		this.teams = new TeamsService({
			dataDir: () => this.options.dataDir,
			deliver: (id, params) => this.deliverToConversation(id, params),
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
				const permissionMode = this.permissionPolicy(context.conversationId).mode;
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
				const conv = this.conversation(context.conversationId);
				if (typeof request.plan === "string" && request.plan.trim()) {
					const saved = await this.writePlan(
						request.title ? `# ${request.title}\n\n${request.plan}` : request.plan,
						context.conversationId,
					);
					return { saved: true, planFile: saved.relativePath, content: saved.content };
				}
				const current = await this.readPlan(context.conversationId);
				return { saved: current.exists, planFile: current.relativePath, content: current.content };
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
				permissionMode: (conversationId) => this.permissionPolicy(conversationId).mode,
				deliver: (id, params) => this.deliverToConversation(id, params),
				cancelWorkflowTasks: async (workflowId) => {
					const matching = this.store.tasks.filter(
						(item) => item.workflowId === workflowId && ["queued", "running", "waiting_for_input"].includes(item.status),
					);
					await Promise.all(matching.map((t) => this.cancelTask(t.id, "parent_abort").catch(() => {})));
				},
				runAgentStep: async (req, signal) => {
					const conv = this.conversation(req.conversationId);
					const maxConcurrent = this.store.settings.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
					const activeCount = this.store.tasks.filter(
						(item) => item.parentConversationId === conv.id && ["queued", "running", "waiting_for_input"].includes(item.status),
					).length;
					if (activeCount >= maxConcurrent) {
						throw new Error(`Concurrent subagent limit reached (${activeCount}/${maxConcurrent})`);
					}
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
						},
					);
					const finished = await this.waiters.wait(
						task.id,
						() => {
							const item = this.store.tasks.find((t) => t.id === task.id);
							return item && structuredClone(item);
						},
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
						output,
						...(finished.structuredOutput !== undefined ? { structuredOutput: finished.structuredOutput } : {}),
						...(finished.stats ? { usage: { totalTokens: finished.stats.tokens.total, cost: finished.stats.cost } } : {}),
					};
				},
				resumeStructuredStep: async (taskId, feedback, signal) => {
					const existing = this.task(taskId);
					delete existing.structuredOutput;
					const expectedTurn = (existing.turn ?? 1) + 1;
					await this.resumeTask(taskId, feedback, { source: "model", background: true });
					const finished = await this.waiters.wait(
						taskId,
						() => {
							const item = this.store.tasks.find((t) => t.id === taskId);
							return item && structuredClone(item);
						},
						(t) => (t.turn ?? 1) >= expectedTurn && !["queued", "running", "waiting_for_input"].includes(t.status),
						signal,
					);
					if (!finished) throw new Error(`Workflow task ${taskId} disappeared`);
					return {
						taskId: finished.id,
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
			claudeHelperPath: options.claudeHelperPath ?? join(runtimeDir, "external-claude-helper.mjs"),
			adapters: options.externalAdapters ?? { codex: new CodexAdapter(), claude: new ClaudeAdapter(), kimi: new KimiAdapter() },
			maxConcurrent: options.maxConcurrentTasks ?? 4,
			project: (id) => this.conversation(id).project,
			policy: (id) => this.permissionPolicy(id),
			delegated: (id) => this.store.tasks.some((task) => task.conversationId === id && task.parentConversationId),
			createWorktree: (input) => this.createWorktree(input), listWorktrees: () => this.listWorktrees(),
			capacity: () => (options.maxConcurrentTasks ?? 4) - this.store.tasks.filter((task) => ["running", "waiting_for_input"].includes(task.status) && !this.isSlotBorrower(task)).length,
			canStart: (task) => {
				if (task.readOnly) return true;
				try { this.assertPathAvailable(task.workingDirectory, undefined, task.id); return true; } catch { return false; }
			},
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
		if (this.store.settings.sandbox === undefined && process.env.PI_DESKTOP_NO_AUTO_SANDBOX !== "1") {
			const seatbelt = await probeSeatbeltSupport();
			if (seatbelt.supported) this.store.settings.sandbox = true;
		}
		await this.persist();
		const reapInterval = this.options.childRuntimeReapIntervalMs ?? CHILD_RUNTIME_REAP_INTERVAL_MS;
		if (reapInterval > 0 && !this.reapTimer) {
			this.reapTimer = setInterval(() => { void this.reapIdleChildRuntimes().catch(() => {}); }, reapInterval);
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

	/**
	 * Spend limit for a session process. A delegated child gets what the root
	 * conversation has left, so subagents cannot run past the cap on their own.
	 * A fork copies the parent's history, and its own entries already include
	 * the parent's spend, so it gets the whole cap.
	 */
	private async costCapFor(conversationId: string, delegated?: DesktopTask): Promise<number | undefined> {
		const cap = this.store.settings.maxCostUsd;
		if (!cap) return undefined;
		if (!delegated || delegated.isFork) return cap;
		const rootId = this.rootConversationId(conversationId);
		const root = rootId === conversationId ? undefined : this.runtimes.get(rootId);
		const stats = await root?.agent
			?.request<SessionStats>({ type: "get_session_stats" })
			.catch(() => undefined);
		const spent = finiteCount(stats?.cost);
		// A small positive remainder keeps the child's limit active instead of unlimited.
		return Math.max(0.0001, cap - spent);
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
		let count = 0;
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
			this.store.projectTrust = { ...(this.store.projectTrust ?? {}), [project]: input.decision };
			await this.persist();
			if (input.decision === "trusted") await this.cron.loadProject(project);
			if (changed) {
				// Pi reads project resources once at startup, so an explicit decision
				// only takes effect after the affected runtimes are recreated.
				for (const runtime of runtimes) await this.stopRuntime(runtime);
				const active = this.active();
				if (active && this.trustProjectFor(active.project) === project) {
					this.ensureAgentWatcher(active.project);
					if (await this.projectAvailable(active)) await this.ensureRuntime(active);
				}
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
		const mode = conversationId ? this.permissionPolicy(conversationId).mode : this.store.settings.permission;
		return mode === "read" || mode === "plan";
	}

	private assertWritableMode(actionLabel: string, conversationId?: string): void {
		const mode = conversationId ? this.permissionPolicy(conversationId).mode : this.store.settings.permission;
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
				permissionMode: this.permissionPolicy(conversationId).mode,
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
			permissionMode: this.permissionPolicy(conv.id).mode,
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
		const tools = runtime?.controls && runtime.engineStatus === "ready"
			? await this.controlRequest(runtime, "list").catch(() => [])
			: [];
		const snapshot = await this.buildSnapshot(conv.id);
		const autoRetryEnabled = await this.readAutoRetrySetting(conv.project);
		return buildContextReport({
			project: conv.project,
			privateMemory: this.privateMemoryPath(this.trustProjectFor(conv.project)),
			agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(),
			stats: snapshot.stats,
			state: snapshot.state ? ({ ...snapshot.state, autoRetryEnabled } as typeof snapshot.state) : snapshot.state,
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

	private planRelativePath(conversationId: string): string {
		if (!/^[a-zA-Z0-9._-]+$/.test(conversationId)) throw new Error("会话标识无效。");
		return join(".pi", "plans", `${conversationId}.md`).replaceAll("\\", "/");
	}

	async readPlan(conversationId?: string): Promise<PlanFileState> {
		await this.operation;
		const conv = this.conversation(conversationId);
		const relativePath = this.planRelativePath(conv.id);
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
		const relativePath = this.planRelativePath(conv.id);
		const fullPath = (await managedFile(conv.project, [".pi", "plans"], `${conv.id}.md`, true))!;
		await writeManagedFile(fullPath, content);
		return { path: fullPath, relativePath, content, exists: true };
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

	/**
	 * Removes a conversation from the sidebar. The Pi session file stays on disk.
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
			await this.monitors.stopForConversation([id], "user_stop", { includeRoot: true });
			for (const job of await this.cron.list(id, conversation.project)) await this.cron.delete(job.id, id);
			if (runtime) await this.stopRuntime(runtime);
			await this.terminals.closeConversation(id);
			this.viewing.delete(id);
			this.store.conversations = this.store.conversations.filter((item) => item.id !== id);
			if (this.store.activeId === id) {
				const next =
					this.store.conversations.find((item) => item.project === conversation.project && !item.parentConversationId) ??
					this.createConversation(conversation.project);
				await this.activate(next);
			} else {
				await this.persist();
			}
			return this.buildSnapshot();
		});
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
		if (runtime?.agent) return runtime.agent.request({ type: "get_fork_messages" });
		if (!conversation.sessionFile) return { messages: [] };
		const { forkMessages } = await this.history.inspect({
			sessionFile: conversation.sessionFile,
			leafId: conversation.sessionLeafId,
		});
		return { messages: forkMessages };
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
			if (input.activate !== false) await this.activate(child);
			else if (this.store.activeId === parent.id) await this.ensureRuntime(parent);
			await this.persist();
			return {
				cancelled: false,
				conversation: structuredClone(child),
				selectedText: result.text,
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
		if (!materialized || result.entries.at(-1)?.id === result.leafId) delete conversation.sessionLeafId;
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

	private rootConversationId(conversationId: string): string {
		let cursor = conversationId;
		const visited = new Set<string>();
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor);
			const parent =
				this.store.conversations.find((item) => item.id === cursor)?.parentConversationId ??
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

	private async modelTool(request: DesktopToolInvocation, context: ToolHostContext): Promise<unknown> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const input = request.input;
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
				const result = await this.delegation.handle(context, request.tool, { ...cleanInput, name: memberName });
				const details = (result as { details?: { task_id?: string; conversation_id?: string; subagent_type?: string } })?.details;
				if (details?.task_id && details.conversation_id) {
					await this.teams.registerMember({
						rootConversationId: rootId,
						teamName: cleanInput.team_name,
						memberName,
						agentId: details.task_id,
						conversationId: details.conversation_id,
						subagentType: details.subagent_type,
					});
				}
				return result;
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

	command(command: Command, conversationId?: string, launch?: number): Promise<unknown> {
		const result = this.executeCommand(command, conversationId, launch);
		this.commands.add(result);
		void result.then(
			() => this.commands.delete(result),
			() => this.commands.delete(result),
		);
		return result;
	}

	private async executeCommand(command: Command, conversationId?: string, launch?: number): Promise<unknown> {
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
			const decision = await evaluatePermission(this.permissionPolicy(active.id), { toolName: "bash", input: { command: command.command } });
			if (decision.action === "deny") throw new Error(decision.reason);
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
			// Esc stops only the children this run is waiting on. Background children keep
			// running and report back; "停止全部后台子 Agent" (stopAllTasks) stops them.
			await this.delegation.cancelChildren(active.id, { foregroundOnly: true, reason: "parent_abort" });
			await this.external.cancelChildren(active.id, { foregroundOnly: true, reason: "parent_abort" });
			await this.cancelDialogs(runtime);
			const result = await agent.request(command);
			return result;
		}
		if (command.type === "prompt") {
			const alreadyRunning = runtime.busy || Boolean(runtime.state?.isStreaming);
			if (!alreadyRunning) {
				this.assertPathAvailable(active.project, active.id);
				if (runtime.bashBusy) throw new Error("请先停止当前终端命令。");
				runtime.busy = true;
				runtime.lastError = undefined;
				if (runtime.state) runtime.state.isStreaming = true;
			}
			try {
				const hook = await this.hooks.run("UserPromptSubmit", {
					project: active.project,
					projectTrusted: this.isProjectTrusted(active.project),
					conversationId: active.id,
					prompt: command.message,
					env: this.options.env,
				});
				if (hook.blocked) throw new Error(hook.reason ?? "UserPromptSubmit Hook 阻止了发送。");
				const promptToSend =
					hook.additionalContext && !command.message.includes(hook.additionalContext)
						? { ...command, message: `${command.message}\n\n[Hook Context]\n${hook.additionalContext}` }
						: command;
				if (!alreadyRunning) await this.startCheckpoint(runtime, command.message);
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
				const result = await agent.request<{ disposition: string }>(promptToSend);
				if (result.disposition === "handled") {
					if (!alreadyRunning) {
						runtime.busy = false;
						runtime.settling = this.finishRuntime(runtime, false);
						await runtime.settling;
					}
				}
				return result;
			} catch (error) {
				if (!alreadyRunning) {
					runtime.busy = false;
					if (runtime.state) runtime.state.isStreaming = false;
					runtime.settling = this.finishRuntime(runtime, false, error instanceof Error ? error.message : String(error));
					await runtime.settling;
				}
				throw error;
			}
		}
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

	async inspectCode(conversationId: string, path: string, at?: CodePosition) {
		await this.operation;
		const { project } = this.conversation(conversationId);
		if (this.store.projectTrust?.[this.trustProjectFor(project)] !== "trusted")
			throw new Error("请先在项目菜单中信任此项目，再启动语言服务器。");
		return codeIntelligence(project, path, this.options.env, at);
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
			const [{ stdout: branch }, { stdout: status }] = await Promise.all([
				exec("git", ["branch", "--show-current"], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 }),
				exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
					cwd,
					maxBuffer: 2 * 1024 * 1024,
					timeout: 10000,
				}),
			]);
			const fields = status.split("\0");
			const changes: Workspace["changes"] = [];
			for (let index = 0; index < fields.length; index++) {
				const field = fields[index];
				if (!field) continue;
				const code = field.slice(0, 2);
				const x = code[0] ?? " ";
				const y = code[1] ?? " ";
				changes.push({
					status: code.trim() || "M",
					path: field.slice(3),
					staged: x !== " " && x !== "?",
					unstaged: y !== " " || code === "??",
				});
				if (code.includes("R") || code.includes("C")) index++;
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
		const projectPath = relative(cwd, absolute);
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
			exec("git", ["diff", "--no-ext-diff", "--no-textconv", "--", projectPath], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			}),
			exec("git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", projectPath], {
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
			const rel = relative(cwd, abs);
			if (!rel || rel === ".git" || rel.startsWith(`.git${sep}`) || rel.startsWith(".git/"))
				throw new Error("不允许操作 .git 元数据目录。");
			return rel;
		});
	}

	async gitStage(paths?: string[], conversationId?: string): Promise<Workspace> {
		this.assertWritableMode("修改 Git 暂存区", conversationId);
		const cwd = this.conversation(conversationId).project;
		const rels = paths?.length ? this.gitPaths(cwd, paths) : [];
		const args = rels.length ? ["add", "--", ...rels] : ["add", "-A"];
		await exec("git", args, { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
		return this.workspace(conversationId);
	}

	async gitUnstage(paths?: string[], conversationId?: string): Promise<Workspace> {
		this.assertWritableMode("修改 Git 暂存区", conversationId);
		const cwd = this.conversation(conversationId).project;
		const rels = paths?.length ? this.gitPaths(cwd, paths) : [];
		try {
			await exec("git", rels.length ? ["reset", "-q", "HEAD", "--", ...rels] : ["reset", "-q", "HEAD"], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: 10000,
			});
		} catch (error) {
			// Unborn repository (no commits yet) has no HEAD; unstage via git rm --cached.
			const stderr = (error as { stderr?: string }).stderr ?? "";
			if (/ambiguous argument 'HEAD'|unknown revision|bad default revision/i.test(stderr)) {
				await exec("git", rels.length ? ["rm", "--cached", "-r", "-q", "--", ...rels] : ["rm", "--cached", "-r", "-q", "."], {
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

	async gitDiscard(paths: string[], conversationId?: string): Promise<Workspace> {
		this.assertWritableMode("还原工作区文件", conversationId);
		if (!paths.length) throw new Error("请指定要还原的文件路径。");
		const cwd = this.conversation(conversationId).project;
		this.assertProjectIdle(cwd);
		const rels = this.gitPaths(cwd, paths);
		const ws = await this.workspace(conversationId);
		const untracked = new Set(ws.changes.filter((c) => c.status === "??").map((c) => c.path));
		const toRemove = rels.filter((r) => untracked.has(r));
		const toCheckout = rels.filter((r) => !untracked.has(r));
		for (const item of toRemove) {
			const target = await this.scopedPath(item, conversationId);
			await rm(target, { recursive: true, force: true });
		}
		if (toCheckout.length) {
			await exec("git", ["checkout", "--", ...toCheckout], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
		}
		return this.workspace(conversationId);
	}

	async gitCommit(message: string, conversationId?: string): Promise<GitCommitResult> {
		this.assertWritableMode("执行 Git 提交", conversationId);
		const trimmed = message.trim();
		if (!trimmed) throw new Error("请输入提交说明。");
		const cwd = this.conversation(conversationId).project;
		this.assertProjectIdle(cwd);
		const { stdout } = await exec("git", ["commit", "-m", trimmed], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			maxBuffer: 2 * 1024 * 1024,
			timeout: 15000,
		});
		const { stdout: hash } = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 });
		return { hash: hash.trim(), summary: stdout.trim(), workspace: await this.workspace(conversationId) };
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
		disableAllHooks?: boolean;
		provider?: Provider;
		apiKey?: string;
		keyCommand?: string;
		headers?: Record<string, string>;
		baseUrl?: string;
		modelId?: string;
		agentDir?: string;
		api?: ConnectionProtocol;
		mode?: ConnectionMode;
	}): Promise<Snapshot> {
		return this.serialize(async () => {
			this.assertIdle();
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
			if (settings.disableAllHooks !== undefined) {
				if (typeof settings.disableAllHooks !== "boolean") throw new Error("Hooks 开关设置无效。");
				if (settings.disableAllHooks) next.settings.disableAllHooks = true;
				else delete next.settings.disableAllHooks;
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
				if (connection.modelId && authenticated)
					next.settings.defaultModel = { provider: `desktop-${provider}`, id: connection.modelId };
			}
			const needsRestart =
				next.settings.permission !== this.store.settings.permission ||
				Boolean(next.settings.sandbox) !== Boolean(this.store.settings.sandbox) ||
				Boolean(next.settings.sandboxOffline) !== Boolean(this.store.settings.sandboxOffline) ||
				Boolean(next.settings.agentTeams) !== Boolean(this.store.settings.agentTeams) ||
				next.settings.agentDir !== this.store.settings.agentDir ||
				next.settings.proxy !== this.store.settings.proxy ||
				next.settings.noProxy !== this.store.settings.noProxy ||
				next.settings.caFile !== this.store.settings.caFile ||
				next.settings.maxCostUsd !== this.store.settings.maxCostUsd ||
				next.settings.minBalance !== this.store.settings.minBalance ||
				Boolean(settings.provider);
			this.store = next;
			await this.persist();
			if (settings.cronEnabled !== undefined) this.cron.onEnabledChanged();
			if (needsRestart) {
				for (const runtime of [...this.runtimes.values()]) await this.stopRuntime(runtime);
				if (next.settings.permission === "read" || next.settings.permission === "plan") {
					for (const terminal of this.terminals.list()) await this.terminals.close(terminal.id);
				}
				const active = this.active();
				if (active) await this.activate(active);
				const connection = settings.provider && this.store.settings.connections[settings.provider];
				const runtime = active && this.runtimes.get(active.id);
				if (settings.provider && connection?.modelId && this.providerAuthenticated(settings.provider) && runtime?.agent) {
					await runtime.agent.request({
						type: "set_model",
						provider: `desktop-${settings.provider}`,
						modelId: connection.modelId,
					});
					await this.syncState(runtime);
				}
			}
			return this.buildSnapshot();
		});
	}

	testConnection(input: ConnectionInput): Promise<ConnectionTestResult> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("桌面服务已关闭。");
			this.assertIdle();
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
	}

	async exportConversation(outputPath: string): Promise<string> {
		const runtime = await this.ensureRuntime(this.requireActive());
		const result = await this.requireAgent(runtime).request<{ path: string }>({ type: "export_html", outputPath });
		return result.path;
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
			await rm(temporary, { recursive: true, force: true });
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
		if (task.quarantined || task.isFork) return false;
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
		const dontAsk = Boolean(inherited?.dontAsk || parent?.dontAsk);
		const parentCeiling = parent?.mode ?? this.store.settings.permission;
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
			const modes = [this.store.settings.permission, inherited?.mode, parent?.mode].filter(
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
		return {
			version: 1,
			mode,
			...(dontAsk ? { dontAsk: true } : {}),
			rules,
			disabledTools: [...disabledTools],
			...(allowedMcpServers !== undefined ? { allowedMcpServers } : {}),
			project: conversation.project,
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
			if (runtime.policyFile) await this.atomicJson(runtime.policyFile, this.permissionPolicy(runtime.conversationId));
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

	private async atomicJson(path: string, value: unknown): Promise<void> {
		const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
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

	subscribeTerminals(listener: (event: TerminalEvent) => void): () => void {
		return this.terminals.subscribe(listener);
	}

	async listTasks(): Promise<DesktopTask[]> {
		await this.operation;
		return structuredClone(this.store.tasks);
	}

	startTask(input: TaskStartInput, delegation?: DelegationMetadata): Promise<DesktopTask> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("桌面服务已关闭。");
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
			const existing = input.worktreeId
				? (await this.worktrees.list()).find((item) => item.id === input.worktreeId)
				: undefined;
			if (input.worktreeId && (!existing || existing.status !== "ready")) throw new Error("指定的 Worktree 不可用。");
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
					permissionMode: this.permissionPolicy(delegation.parentConversationId).mode,
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
			const isolated = input.isolation !== "shared";
			if (isolated && !existing && this.store.settings.permission === "read")
				throw new Error("只读模式请使用 shared 隔离方式，不能创建 Worktree。");
			const worktree =
				existing ?? (isolated ? await this.worktrees.create({ project, baseRef: input.baseRef }) : undefined);
			if (worktree && !inside(worktree.repository, project)) throw new Error("项目目录不属于此 Worktree 的源仓库。");
			let directory = project;
			try {
				if (worktree) directory = await realpath(join(worktree.path, relative(worktree.repository, project)));
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
				await this.controlCall(runtime, { operation: "wake", count: queued.size }).catch(() => {});
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
		if (this.closed) return Promise.resolve(0);
		return this.serialize(async () => {
			const idleMs = options.idleMs ?? this.options.childRuntimeIdleMs ?? CHILD_RUNTIME_IDLE_MS;
			const now = Date.now();
			const candidates = [...this.runtimes.values()].filter((runtime) => this.reapable(runtime)).sort((left, right) => left.lastActivity - right.lastActivity);
			const excess = Math.max(0, candidates.length - MAX_IDLE_CHILD_RUNTIMES);
			let reaped = 0;
			for (const [index, runtime] of candidates.entries()) {
				if (index >= excess && now - runtime.lastActivity < idleMs) continue;
				// Stop hooks run while the run settles; wait for them before stopping.
				if (runtime.settling) await runtime.settling.catch(() => {});
				if (this.closed || !this.reapable(runtime)) continue;
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

	private reapable(runtime: SessionRuntime): boolean {
		const id = runtime.conversationId;
		const task = this.store.tasks.find((item) => item.conversationId === id && item.parentConversationId);
		const active = (status: string) => ["queued", "running", "waiting_for_input"].includes(status);
		if (!task || active(task.status) || this.runtimes.get(id) !== runtime) return false;
		const delivered = !task.runInBackground || task.notifySuppressed || task.notifiedTurn === (task.turn ?? 1);
		return (
			delivered &&
			!runtime.stopping && !runtime.busy && !runtime.bashBusy && !runtime.settling &&
			runtime.engineStatus !== "starting" && !runtime.pendingUI.size &&
			!runtime.state?.isStreaming && !runtime.state?.isCompacting &&
			id !== this.store.activeId && !this.viewing.has(id) &&
			!this.hasActiveDescendant(id) &&
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

	async writeTerminal(id: string, data: string): Promise<void> {
		const terminal = this.terminals.list().find((item) => item.id === id);
		if (this.closed || this.isReadRestricted() || (terminal && this.isReadRestricted(terminal.conversationId))) throw new Error("当前不可向终端输入。");
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
			return this.git.finish(conversation.project, id);
		});
	}

	async listCheckpoints(conversationId?: string): Promise<GitCheckpoint[]> {
		await this.operation;
		const conversation = this.conversation(conversationId);
		return this.git.list(conversation.project, conversation.id);
	}

	async checkpointDiff(id: string, conversationId?: string, path?: string): Promise<GitCheckpointDiff> {
		await this.operation;
		return this.git.diff(this.conversation(conversationId).project, id, path);
	}

	async restoreCheckpoint(id: string, conversationId?: string, paths?: string[]): Promise<GitRestoreResult> {
		return this.serialize(async () => {
			if (this.isReadRestricted(conversationId)) throw new Error("只读或 Plan 模式禁止恢复文件。");
			const conversation = this.conversation(conversationId);
			this.assertProjectIdle(conversation.project);
			if (
				this.terminals
					.list()
					.some((terminal) => terminal.status !== "exited" && overlaps(terminal.project, conversation.project))
			)
				throw new Error("请先关闭此项目的交互终端，再恢复文件。");
			return this.git.restore(conversation.project, id, paths);
		});
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

	removeWorktree(id: string): Promise<WorktreeRemoveResult> {
		return this.serialize(async () => {
			if (this.isReadRestricted()) throw new Error("只读或 Plan 模式禁止删除 Worktree。");
			const item = (await this.worktrees.list()).find((tree) => tree.id === id);
			if (!item) throw new Error("Worktree 不存在。");
			if (item.conversationId) {
				const runtime = this.runtimes.get(item.conversationId);
				if (runtime) {
					this.assertRuntimeIdle(runtime);
					await this.stopRuntime(runtime);
				}
			}
			return this.worktrees.remove(id);
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
		this.agentWatcher?.stop();
		this.agentWatcher = undefined;
		if (this.reapTimer) clearInterval(this.reapTimer);
		this.reapTimer = undefined;
		this.delegation.dispose();
		this.waiters.close();
		for (const timer of this.notifyTimers.values()) clearTimeout(timer);
		this.notifyTimers.clear();
		await this.toolHost.close();
		this.connectionCheck?.cancel(new Error("桌面服务已关闭，连接测试已取消。"));
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
		await this.persist();
		await this.persistence;
		this.listeners.clear();
		this.taskListeners.clear();
		this.controlListeners.clear();
	}

	private active(): Conversation | undefined {
		return this.store.conversations.find((item) => item.id === this.store.activeId);
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
		task.updatedAt = Date.now();
		task.revision = (task.revision ?? 0) + 1;
		for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		void this.persist().catch(() => {});
		this.waiters.notify(task.id);
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
	 * call it does not write, so its busy runtime must not block the child it waits for.
	 */
	private yieldingParent(conversationId?: string): string | undefined {
		const task = conversationId ? this.store.tasks.find((item) => item.conversationId === conversationId) : undefined;
		if (!task?.parentConversationId || task.readOnly || task.quarantined || task.runInBackground || task.worktreeId) return undefined;
		return ["queued", "running", "waiting_for_input"].includes(task.status) ? task.parentConversationId : undefined;
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
	private async startCheckpoint(runtime: SessionRuntime, label: string): Promise<void> {
		if (this.store.tasks.some((task) => task.conversationId === runtime.conversationId && task.readOnly)) return;
		if (runtime.checkpointId) return;
		const workspace = await this.workspace(runtime.conversationId);
		if (!workspace.isGit) return;
		const conversation = this.conversation(runtime.conversationId);
		const checkpoint = await this.git.begin(conversation.project, conversation.id, label.slice(0, 160));
		runtime.checkpointId = checkpoint.id;
		const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
		if (task) task.checkpointId = checkpoint.id;
	}
	private async finishRuntime(runtime: SessionRuntime, aborted: boolean, error?: string): Promise<void> {
		this.clearTaskProgressTimer(runtime);
		try {
			if (runtime.checkpointId) {
				await this.git.finish(this.conversation(runtime.conversationId).project, runtime.checkpointId);
				runtime.checkpointId = undefined;
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
				if (text !== undefined)
					task.result = {
						text: text.slice(0, MAX_AGENT_OUTPUT),
						truncated: text.length > MAX_AGENT_OUTPUT,
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
			runtime.settling = undefined;
			// A stopped child's partial output is recorded now; its parent may receive it.
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task?.parentConversationId && !["queued", "running", "waiting_for_input"].includes(task.status)) {
				void this.monitors.stopForConversation([runtime.conversationId], "child_finished");
				if (task.teamName) {
					const teamStatus = task.status === "cancelled" || task.status === "failed" || task.status === "interrupted" ? "shutdown" : "idle";
					void this.teams.setMemberStatus(this.rootConversationId(runtime.conversationId), runtime.conversationId, teamStatus);
				}
			}
			if (task?.parentConversationId && task.runInBackground && !["queued", "running", "waiting_for_input"].includes(task.status))
				void this.flushNotifications(task.parentConversationId, "auto");
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
		runtime.agent = undefined;
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
		if (this.runtimes.get(runtime.conversationId) === runtime) this.runtimes.delete(runtime.conversationId);
	}
	private isSlotBorrower(task: DesktopTask): boolean {
		if (!task.parentConversationId || task.runInBackground) return false;
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
			// A forked child starts with the parent's history; usage is measured from here.
			const baseline = await agent.request<SessionStats>({ type: "get_session_stats" }).catch(() => undefined);
			task.statsAtTurnStart = {
				tokens: statTokens(baseline?.tokens),
				cost: finiteCount(baseline?.cost),
				toolCalls: finiteCount(baseline?.toolCalls),
				startedAt: Date.now(),
			};
			delete task.stats;
			await this.command({ type: "prompt", message }, task.conversationId, launch);
			// Pi accepted the message; it is part of the child's session now.
			if (resumed && task.pendingMessage === message) {
				delete task.pendingMessage;
				await this.persist();
			}
		} catch (error) {
			if (!this.closed && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "failed", error instanceof Error ? error.message : String(error), "error");
			void this.scheduleTasks();
		}
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
			!previous.busy &&
			!previous.bashBusy &&
			!previous.pendingUI.size
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
			if (this.store.settings.minBalance) env.PI_DESKTOP_MIN_BALANCE = String(this.store.settings.minBalance);
			runtime.policyFile = join(this.options.dataDir, `policy-${conversation.id}-${randomBytes(8).toString("hex")}.json`);
			env.PI_DESKTOP_POLICY_FILE = runtime.policyFile;
			const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
			const delegated = task?.parentConversationId ? task : undefined;
			delete env.PI_DESKTOP_SANDBOX_PROFILE;
			const shouldConfineWorktreeChild = Boolean(
				delegated && !delegated.readOnly && delegated.worktreeId && this.store.settings.confineSubagentBash !== false,
			);
			if (this.store.settings.sandbox) {
				if (!(await probeSeatbeltSupport()).supported) throw new Error("无法启动命令沙箱。请在支持的环境中运行，或在设置中关闭沙箱。");
				const extraWritable = await resolveGitWorktreeWritablePaths(conversation.project);
				runtime.sandboxProfileFile = join(this.options.dataDir, `sandbox-${conversation.id}-${randomBytes(8).toString("hex")}.sb`);
				await writeFile(runtime.sandboxProfileFile, buildSeatbeltProfile(conversation.project, extraWritable, this.store.settings.sandboxOffline), { mode: 0o600 });
				env.PI_DESKTOP_SANDBOX_PROFILE = runtime.sandboxProfileFile;
			} else if (shouldConfineWorktreeChild && (await probeSeatbeltSupport()).supported) {
				const extraWritable = await resolveGitWorktreeWritablePaths(conversation.project);
				runtime.sandboxProfileFile = join(this.options.dataDir, `sandbox-${conversation.id}-${randomBytes(8).toString("hex")}.sb`);
				await writeFile(runtime.sandboxProfileFile, buildSeatbeltProfile(conversation.project, extraWritable, this.store.settings.sandboxOffline), { mode: 0o600 });
				env.PI_DESKTOP_SANDBOX_PROFILE = runtime.sandboxProfileFile;
			}
			// Set these explicitly so an inherited shell environment cannot change a session's role.
			env.PI_DESKTOP_CHILD = delegated ? "1" : "0";
			const costCap = await this.costCapFor(conversation.id, delegated);
			if (costCap !== undefined) env.PI_DESKTOP_MAX_COST = String(costCap);
			env.PI_DESKTOP_READ_ONLY_CHILD = delegated?.readOnly ? "1" : "0";
			env.PI_DESKTOP_FORK_CHILD = delegated?.isFork ? "1" : "0";
			env.PI_DESKTOP_DELEGATION_DEPTH = String(delegated ? (delegated.delegationDepth ?? 1) : 0);
			env.PI_DESKTOP_MAX_DEPTH = String(this.store.settings.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH);
			env.PI_DESKTOP_AGENT_TEAMS = this.store.settings.agentTeams === true ? "1" : "0";
			env.PI_DESKTOP_TEAM_MEMBER = delegated?.teamName ? "1" : "0";
			env.PI_DESKTOP_STRUCTURED_OUTPUT = delegated?.structuredOutputSchema !== undefined ? "1" : "0";
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
			if (task?.omitClaudeMd) {
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
				...(task?.omitClaudeMd ? ["--no-context-files"] : []),
				"--extension",
				this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
				...(navigationInstalled ? ["--extension", navigationExtension] : []),
				...(toolsInstalled ? ["--extension", toolExtension] : []),
				...(trustResources.length ? [trustDecision === "trusted" ? "--approve" : "--no-approve"] : []),
				...(await this.claudeResourceArgs(conversation.project, trustDecision === "trusted")),
				...(this.options.args ?? []),
			];
			if (!sessionFile && this.store.settings.defaultModel) {
				const model = this.store.settings.defaultModel;
				args.push("--provider", model.provider, "--model", model.id);
			}
			const policy = this.permissionPolicy(conversation.id);
			const policyMode = policy.mode;
			args.push(...piToolArgs(task, policyMode, { canDelegate: this.canDelegateFurther(conversation.id) }));
			if (task?.parentConversationId && task.systemPromptFile && !task.quarantined) {
				// An explicit --append-system-prompt replaces Pi's APPEND_SYSTEM.md discovery;
				// pass the file Pi would have found first so the child keeps it.
				const discovered = await appendSystemPromptFile(conversation.project, trustDecision === "trusted", this.store.settings.agentDir ?? this.defaultAgentDir());
				const own = await stat(task.systemPromptFile).then((info) => info.isFile(), () => false);
				if (own) args.push(...(discovered ? ["--append-system-prompt", discovered] : []), "--append-system-prompt", task.systemPromptFile);
			}
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
			void this.hooks.run("SessionStart", {
				project: this.trustProjectFor(conversation.project),
				projectTrusted: this.isProjectTrusted(conversation.project),
				conversationId: conversation.id,
				permissionMode: policyMode,
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
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
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
				permissionMode: this.permissionPolicy(conversationId).mode,
				notificationType: event.method === "confirm" ? "permission_prompt" : "elicitation_dialog",
				title: "title" in event ? event.title : undefined,
				message: "message" in event ? event.message : undefined,
				env: this.options.env,
			}).catch(() => {});
		}
		if (event.type === "agent_start") {
			runtime.busy = true;
			runtime.stopHookRanThisTurn = false;
			this.consumeQueuedNotifications(runtime);
			if (runtime.state) runtime.state.isStreaming = true;
			if (task && (task.status === "cancelled" || task.status === "interrupted")) {
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
		if (event.type === "compaction_start" && runtime.state) runtime.state.isCompacting = true;
		if (event.type === "compaction_end" && runtime.state) runtime.state.isCompacting = false;
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
			if (runtime.state) runtime.state.isStreaming = false;
			runtime.pendingUI.clear();
			this.syncTaskPendingApprovals(runtime, task);
			runtime.settling = this.finishRuntime(runtime, event.aborted, runtime.lastError);
			// Settlement is emitted after host cleanup; allocate its delivery sequence at that point.
			void runtime.settling.finally(() => {
				this.emit({ conversationId, event });
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
			runtime.bashBusy = false;
			runtime.engineStatus = "error";
			runtime.engineError = event.message;
			runtime.pendingUI.clear();
			this.syncTaskPendingApprovals(runtime, task);
			runtime.settling = this.finishRuntime(runtime, false, event.message);
		}
		if (event.type === "session_info_changed") {
			const conversation = this.conversation(conversationId);
			if (conversation && event.name) conversation.title = event.name;
		}
		this.emit({ conversationId, event, sequence });
	}

	private emit(event: DesktopEvent): void {
		const runtime = this.runtimes.get(event.conversationId);
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
			liveTranscript,
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
		!["ask", "acceptEdits", "read", "auto", "plan"].includes(value.settings.permission) ||
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
		projects: value.projects,
		conversations: value.conversations,
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
			disableAllHooks: value.settings.disableAllHooks === true ? true : undefined,
			proxy: storedText(value.settings.proxy, 2048),
			noProxy: storedText(value.settings.noProxy, 4096),
			caFile: storedText(value.settings.caFile, 4096, true),
			defaultModel: value.settings.defaultModel,
			connections: value.settings.connections ?? {},
			agentDir: value.settings.agentDir,
		},
		keys: value.keys,
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
