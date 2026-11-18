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
import type { DesktopTask, TaskEvent, TaskStartInput } from "./task-types.ts";
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
	ConnectionMode,
} from "./shared.ts";
import { connectionMode, validateEndpoint } from "./model-connections.ts";
import { providerModels, providerPresets } from "./provider-presets.ts";
import { detectProjectTrustResources } from "./project-trust.ts";
import { ToolSettingsStore } from "./tool-settings.ts";
import { evaluatePermission, validatePermissionRule, validateRuntimePolicy } from "./permission-policy.ts";
import type { PermissionRule, RuntimePermissionPolicy } from "./permission-types.ts";
import type { ToolToggleInput, ControlEvent, PermissionSettings, PermissionCheckInput } from "./control-types.ts";
import type { DesktopToolInfo } from "./tool-control-types.ts";
import { ToolHostServer } from "./tool-host-server.ts";
import { ModelDelegation } from "./model-delegation.ts";
import type { DelegationMetadata } from "./delegation-types.ts";
import { AgentRegistry } from "./agent-definitions.ts";
import type { AgentDefinition, AgentRemoveInput, AgentSaveInput } from "./agent-types.ts";
import { McpRegistry } from "./mcp-registry.ts";
import type { McpRemoveInput, McpSaveInput, McpServerInfo } from "./mcp-types.ts";
import { HooksService } from "./hooks-service.ts";
import type { HookEntry, HookRemoveInput, HookRunResult, HookSaveInput, HookTestInput } from "./hook-types.ts";
import { SkillRegistry } from "./skill-registry.ts";
import type { SkillDefinitionEntry, SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
import { buildContextReport, deleteProjectMemoryRule, writeProjectMemoryFile, type ContextBreakdown, type ContextMemorySource } from "./context-inspector.ts";
import { buildSeatbeltProfile, probeSeatbeltSupport } from "./sandbox.ts";
import { readClaudeProjectPermissions, writeClaudeProjectPermissions } from "./claude-settings-sync.ts";
import type { BtwResult, ClaudePermissionsSyncResult, PlanFileState, SandboxStatus } from "./shared.ts";
import { ExternalAgents } from "./external-agents.ts";
import { CodexAdapter } from "./external-codex.ts";
import { ClaudeAdapter } from "./external-claude.ts";
import { KimiAdapter } from "./external-kimi.ts";
import type { ExternalAdapter, ExternalApprovalResponse, ExternalEvent, ExternalExecutorInput, ExternalProvider, ExternalTask, ExternalTaskSendInput, ExternalTaskStartInput } from "./external-types.ts";
import type { DesktopToolInvocation, ToolHostContext } from "./tool-control-types.ts";
import type { RpcExtensionUIResponse, SessionStats } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "./shared.ts";

const exec = promisify(execFile);
const providers: Provider[] = ["anthropic", "openai", "google", "openrouter", "deepseek"];
const piBuiltinTools = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);

/** An explicit empty result means deny all built-in tools, not "unset". */
export function piToolAllowlist(tools: string[] | undefined): string[] | undefined {
	return tools?.filter((name) => piBuiltinTools.has(name));
}
interface StoredState {
	projects: Project[];
	conversations: Conversation[];
	activeId?: string;
	settings: Omit<Settings, "configuredProviders">;
	keys: Partial<Record<Provider, string>>;
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
	checkpointId?: string;
	settling?: Promise<void>;
	loading?: Promise<void>;
	lastError?: string;
	stopping: boolean;
	replacing?: boolean;
	navigation?: { directory: string; token: string; command: string };
	controls?: { directory: string; token: string; command: string; hostToken: string; operation: Promise<void> };
	policyFile?: string;
	sandboxProfileFile?: string;
	controlWrites?: Promise<void>;
}
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
	ptyHelperPath?: string;
	archiveEntry?: string;
	historyEntry?: string;
	navigationExtension?: string;
	toolControlExtension?: string;
	externalAdapters?: Record<ExternalProvider, ExternalAdapter>;
	claudeHelperPath?: string;
	maxConcurrentTasks?: number;
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
	private mcp: McpRegistry;
	private hooks: HooksService;
	private skills: SkillRegistry;
	private controlListeners = new Set<(event: ControlEvent) => void>();
	private worktreeOperationOwner?: string;
	private external: ExternalAgents;

	constructor(options: ServiceOptions) {
		this.options = options;
		this.toolSettings = new ToolSettingsStore(options.dataDir);
		this.agents = new AgentRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.mcp = new McpRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.hooks = new HooksService({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.skills = new SkillRegistry({ agentDir: () => this.store.settings.agentDir ?? this.defaultAgentDir() });
		this.toolHost = new ToolHostServer({
			handle: async (request, context) => {
				const decision = await evaluatePermission(this.permissionPolicy(context.conversationId), { toolName: request.tool, input: request.input });
				if (decision.action === "deny") throw new Error(decision.reason);
				return this.modelTool(request, context);
			},
			handleHook: async (request, context) => {
				const conv = this.conversation(context.conversationId);
				return this.hooks.run(request.phase === "pre" ? "PreToolUse" : "PostToolUse", {
					project: conv.project,
					projectTrusted: this.isProjectTrusted(conv.project),
					conversationId: context.conversationId,
					toolName: request.toolName,
					toolInput: request.toolInput,
					toolResponse: request.toolResponse,
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
			resolveAgent: (project, name) => this.agents.resolve(project, name, this.projectTrusted(project)),
			listTasks: () => this.listTasks(),
			startTask: (input, metadata) => this.startTask(input, metadata),
			cancelTask: (id) => this.cancelTask(id),
			taskSnapshot: (id) => this.taskSnapshot(id),
			listWorktrees: (project) => this.listWorktrees(project),
			createWorktree: (input) => this.createWorktree(input),
			removeWorktree: (id, owner, callId) => this.modelWorktreeMutation("remove", id, owner, callId),
			mergeWorktree: (id, owner, callId) => this.modelWorktreeMutation("merge", id, owner, callId),
			isGit: async (project) => {
				try { await exec("git", ["rev-parse", "--show-toplevel"], { cwd: project }); return true; } catch { return false; }
			},
			canRunShared: (_owner, readOnly) => readOnly,
			isPlanMode: (id) => this.permissionPolicy(id).mode === "plan",
			notify: async (owner, result) => {
				const runtime = this.runtimes.get(owner);
				if (!runtime?.controls || runtime.stopping || this.closed || ["cancelled", "interrupted"].includes(result.status)) return;
				await runtime.settling;
				await this.controlRequest(runtime, "notify", result);
			},
		});
		this.git = new GitSnapshots(join(options.dataDir, "checkpoints"));
		const runtimeDir =
			options.runtimeDir ?? (options.entry ? dirname(dirname(dirname(options.entry))) : options.dataDir);
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
			capacity: () => (options.maxConcurrentTasks ?? 4) - this.store.tasks.filter((task) => ["running", "waiting_for_input"].includes(task.status)).length,
			canStart: (task) => {
				if (task.readOnly) return true;
				try { this.assertPathAvailable(task.workingDirectory, undefined, task.id); return true; } catch { return false; }
			},
			notify: async (owner, result) => {
				const runtime = this.runtimes.get(owner);
				if (!runtime?.controls || runtime.stopping || this.closed) return;
				await runtime.settling; await this.controlRequest(runtime, "notify", result);
			},
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
			this.store = validateStore(stored);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.engineError = `无法读取桌面配置：${error instanceof Error ? error.message : String(error)}`;
		}
		for (const task of this.store.tasks) {
			if (["queued", "running", "waiting_for_input"].includes(task.status)) {
				task.status = "interrupted";
				task.error = "应用已重启，任务未自动重新执行。";
				task.updatedAt = Date.now();
			}
		}
		await this.worktrees.initialize();
		await this.persist();
		if (this.options.initialProject) return this.selectProject(this.options.initialProject);
		const active = this.active();
		if (active) await this.activate(active);
		return this.buildSnapshot();
	}

	subscribe(listener: (event: DesktopEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
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
				(runtime) => this.conversation(runtime.conversationId).project === project,
			);
			for (const runtime of runtimes) {
				if (runtime.busy || runtime.bashBusy || runtime.pendingUI.size)
					throw new Error("请先停止该项目的任务与审批，再更改项目信任。");
			}
			const changed = (this.store.projectTrust?.[project] ?? undefined) !== input.decision;
			this.store.projectTrust = { ...(this.store.projectTrust ?? {}), [project]: input.decision };
			await this.persist();
			if (changed) {
				// Pi reads project resources once at startup, so an explicit decision
				// only takes effect after the affected runtimes are recreated.
				for (const runtime of runtimes) await this.stopRuntime(runtime);
				const active = this.active();
				if (active?.project === project && (await this.projectAvailable(active))) await this.ensureRuntime(active);
			}
			return this.buildSnapshot();
		});
	}

	async listAgents(project?: string): Promise<AgentDefinition[]> {
		await this.operation;
		const target = await this.agentProject(project);
		return this.agents.list(target, this.projectTrusted(target));
	}

	saveAgent(input: AgentSaveInput): Promise<AgentDefinition[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			return this.agents.save(project, input, this.projectTrusted(project));
		});
	}

	removeAgent(input: AgentRemoveInput): Promise<AgentDefinition[]> {
		return this.serialize(async () => {
			const project = await this.agentProject(input.project);
			return this.agents.remove(project, input, this.projectTrusted(project));
		});
	}

	private projectTrusted(project: string): boolean {
		return this.store.projectTrust?.[project] === "trusted";
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
		return this.store.projectTrust?.[project] === "trusted";
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
		return this.hooks.run(input.event, {
			project,
			projectTrusted: project ? this.isProjectTrusted(project) : false,
			conversationId: this.active()?.id,
			toolName: input.toolName,
			toolInput: input.toolInput,
			prompt: input.prompt,
			env: this.options.env,
		});
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
		return buildContextReport({
			project: conv.project,
			agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(),
			stats: snapshot.stats,
			state: snapshot.state,
			tools,
			messages: snapshot.messages,
		});
	}

	async writeMemoryFile(relativePath: string, content: string, conversationId?: string): Promise<ContextMemorySource> {
		await this.operation;
		this.assertWritableMode("修改项目记忆或规则文件", conversationId);
		const conv = this.conversation(conversationId);
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
		const fullPath = resolve(conv.project, relativePath);
		if (!inside(conv.project, fullPath)) throw new Error("计划文件路径超出项目目录。");
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf8");
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
			const parsed = await readClaudeProjectPermissions(project);
			for (const rule of parsed) await this.toolSettings.upsert(rule);
			await this.refreshControls("permissions_changed");
			return { path: join(project, ".claude", "settings.json"), imported: parsed.length };
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

	private async modelTool(request: DesktopToolInvocation, context: ToolHostContext): Promise<unknown> {
		if (this.closed) throw new Error("桌面服务已关闭。");
		const input = request.input;
		if (request.tool === "AgentExecutors") return { executors: await this.external.executors() };
		if (request.tool === "Agent" && input.executor && input.executor !== "pi") {
			const task = await this.external.start({ executor: input.executor as ExternalProvider,
				description: input.description as string, prompt: input.prompt as string,
				subagent_type: input.subagent_type as ExternalTaskStartInput["subagent_type"], isolation: input.isolation as ExternalTaskStartInput["isolation"],
				worktree_id: input.worktree_id as string | undefined, run_in_background: input.run_in_background as boolean | undefined }, context.conversationId, context.toolCallId);
			return this.external.awaitModelResult(task.id, context.conversationId, Boolean(input.run_in_background), context.signal);
		}
		if (request.tool === "AgentSend") {
			await this.external.send({ taskId: input.task_id as string, message: input.message as string, runInBackground: input.run_in_background as boolean | undefined }, context.conversationId);
			return this.external.awaitModelResult(input.task_id as string, context.conversationId, Boolean(input.run_in_background), context.signal);
		}
		if (request.tool === "TaskOutput" && this.external.has(input.task_id as string))
			return this.external.result(input.task_id as string, { block: input.block as boolean | undefined, timeout: input.timeout as number | undefined }, context.conversationId, context.signal);
		if (request.tool === "TaskStop" && this.external.has(input.task_id as string)) {
			await this.external.cancel(input.task_id as string, context.conversationId);
			return this.external.result(input.task_id as string, {}, context.conversationId);
		}
		if (request.tool === "TaskList") {
			const pi = await this.delegation.handle(context, request.tool, input) as { tasks: unknown[]; truncated: boolean };
			const external = this.external.list(context.conversationId);
			return { tasks: [...pi.tasks, ...external.slice(0, 128).map((task) => ({ task_id: task.id, executor: task.executor,
				description: task.title, status: task.status, turn: task.turn, worktree_id: task.worktreeId, pending_approvals: task.pendingApprovals.length }))], truncated: pi.truncated || external.length > 128 };
		}
		if (request.tool === "Agent" && input.executor === "pi") { const { executor: _executor, ...args } = input; return this.delegation.handle(context, request.tool, args); }
		return this.delegation.handle(context, request.tool, input);
	}

	subscribeExternal(listener: (event: ExternalEvent) => void): () => void { return this.external.subscribe(listener); }
	externalExecutors() { return this.external.executors(); }
	configureExternal(input: ExternalExecutorInput) { return this.external.configure(input); }
	async startExternal(input: ExternalTaskStartInput) { await this.operation; return this.external.start(input, this.conversation(input.conversationId).id); }
	listExternal(conversationId?: string) { if (conversationId) this.conversation(conversationId); return this.external.list(conversationId); }
	externalSnapshot(id: string) { return this.external.snapshot(id); }
	sendExternal(input: ExternalTaskSendInput) { return this.external.send(input); }
	externalResult(id: string, options?: { block?: boolean; timeout?: number }) { return this.external.result(id, options); }
	cancelExternal(id: string) { return this.external.cancel(id); }
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
		if (command.type === "abort") {
			await this.delegation.cancelChildren(active.id);
			await this.external.cancelChildren(active.id);
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
		const runtime = conversationId
			? this.runtimes.get(conversationId)
			: [...this.runtimes.values()].find((item) => item.pendingUI.has(response.id));
		const request = runtime?.pendingUI.get(response.id);
		if (!request) throw new Error("此确认请求已失效。");
		await this.requireAgent(runtime!).respond(response);
		runtime!.pendingUI.delete(response.id);
		const task = this.store.tasks.find((item) => item.conversationId === runtime!.conversationId);
		if (task && !runtime!.pendingUI.size && task.status === "waiting_for_input") this.updateTask(task, "running");
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
		const cwd = this.conversation(conversationId).project;
		const target = resolve(cwd, file);
		try {
			const real = await realpath(target);
			if (!inside(cwd, real)) throw new Error("记忆文件路径超出项目目录。");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await writeFile(target, content, "utf8");
		return { file, path: target, content, exists: true };
	}

	saveSettings(settings: {
		permission: PermissionMode;
		theme: Settings["theme"];
		sandbox?: boolean;
		notifications?: boolean;
		provider?: Provider;
		apiKey?: string;
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
			if (settings.notifications !== undefined) next.settings.notifications = settings.notifications;
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
					connection = { mode, modelId };
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
				if (next.keys[provider] && !connection.modelId)
					throw new Error("请填写此连接的模型 ID；留空密钥会保留已保存的认证。");
				next.settings.connections[provider] = connection;
				if (connection.modelId && next.keys[provider])
					next.settings.defaultModel = { provider: `desktop-${provider}`, id: connection.modelId };
			}
			const needsRestart =
				next.settings.permission !== this.store.settings.permission ||
				Boolean(next.settings.sandbox) !== Boolean(this.store.settings.sandbox) ||
				next.settings.agentDir !== this.store.settings.agentDir ||
				Boolean(settings.provider);
			this.store = next;
			await this.persist();
			if (needsRestart) {
				for (const runtime of [...this.runtimes.values()]) await this.stopRuntime(runtime);
				if (next.settings.permission === "read" || next.settings.permission === "plan") {
					for (const terminal of this.terminals.list()) await this.terminals.close(terminal.id);
				}
				const active = this.active();
				if (active) await this.activate(active);
				const connection = settings.provider && this.store.settings.connections[settings.provider];
				const runtime = active && this.runtimes.get(active.id);
				if (settings.provider && connection?.modelId && this.store.keys[settings.provider] && runtime?.agent) {
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
			if (!key) return { success: false, message: "请填写 API Key，或先保存此服务商的密钥。" };
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
					[envKey]: key,
					PI_DESKTOP_CONNECTIONS: JSON.stringify({
						[input.provider]: {
							mode,
							baseUrl,
							modelId,
							api: mode === "custom" ? (input.api ?? stored?.api) : undefined,
							envKey,
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
				const message = (error instanceof Error ? error.message : String(error)).replaceAll(key, "[已隐藏密钥]");
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
			};
			if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
			const connections: Record<string, { baseUrl?: string; modelId?: string; envKey?: string; api?: ConnectionProtocol; mode?: ConnectionMode; presetBaseUrl?: string }> = {};
			for (const provider of providers) {
				const conn = this.store.settings.connections[provider];
				const encrypted = this.store.keys[provider];
				const envKey = `PI_DESKTOP_KEY_${provider.toUpperCase()}`;
				if (encrypted && this.options.decrypt) env[envKey] = this.options.decrypt(encrypted);
				if (conn) connections[provider] = { ...conn, envKey: encrypted ? envKey : undefined, presetBaseUrl: this.options.providerBaseUrls?.[provider] };
			}
			env.PI_DESKTOP_CONNECTIONS = JSON.stringify(connections);
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

	private permissionPolicy(conversationId: string): RuntimePermissionPolicy {
		const conversation = this.conversation(conversationId);
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		const own = this.toolSettings.effective(conversation.project, conversationId);
		const inherited = this.store.taskPolicies?.[conversationId];
		const parent = task?.parentConversationId ? this.permissionPolicy(task.parentConversationId) : undefined;
		const translate = (policy: RuntimePermissionPolicy | undefined): PermissionRule[] => (policy?.rules ?? []).map((rule) => {
			if (!rule.path || !policy || !isAbsolute(rule.path) || !inside(policy.project, rule.path)) return rule;
			return { ...rule, path: join(conversation.project, relative(policy.project, rule.path)) };
		});
		// A child keeps its spawn ceiling and also receives later parent revocations.
		const unique = new Map<string, PermissionRule>();
		for (const rule of [...translate(inherited), ...translate(parent), ...own.rules]) {
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
		if (task?.parentConversationId) { disabledTools.add("Agent"); disabledTools.add("AgentSend"); }
		const modes = [
			task?.readOnly ? "read" : undefined,
			this.store.settings.permission,
			inherited?.mode,
			parent?.mode,
		].filter((mode): mode is RuntimePermissionPolicy["mode"] => Boolean(mode));
		const mode = modes.includes("read")
			? "read"
			: modes.includes("plan")
				? "plan"
				: modes.includes("ask")
					? "ask"
					: modes.includes("acceptEdits")
						? "acceptEdits"
						: "auto";
		return { version: 1, mode, rules, disabledTools: [...disabledTools], project: conversation.project };
	}

	private toolOverrides(conversationId: string): Record<string, boolean> {
		const conversation = this.conversation(conversationId);
		const task = this.store.tasks.find((item) => item.conversationId === conversationId);
		const own = this.toolSettings.effective(conversation.project, conversationId).overrides;
		if (!task?.parentConversationId) return own;
		const parent = this.conversation(task.parentConversationId);
		const inherited = this.toolSettings.effective(parent.project, parent.id).overrides;
		const combined: Record<string, boolean> = { ...inherited, ...own, Agent: false, AgentSend: false };
		for (const [name, enabled] of Object.entries(inherited)) if (!enabled) combined[name] = false;
		for (const name of this.store.taskPolicies?.[conversationId]?.disabledTools ?? []) combined[name] = false;
		return combined;
	}

	private writeRuntimeControls(runtime: SessionRuntime): Promise<void> {
		const write = (runtime.controlWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
			if (runtime.policyFile) await this.atomicJson(runtime.policyFile, this.permissionPolicy(runtime.conversationId));
			if (runtime.controls) await this.atomicJson(join(runtime.controls.directory, "tools.json"), { overrides: this.toolOverrides(runtime.conversationId) });
		});
		runtime.controlWrites = write;
		return write;
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

	private controlRequest(runtime: SessionRuntime, operation: "list" | "apply" | "notify", result?: unknown): Promise<DesktopToolInfo[]> {
		const bridge = runtime.controls;
		if (!bridge) return Promise.reject(new Error("工具管理扩展未加载，请重新构建桌面运行时。"));
		const action = bridge.operation.then(async () => {
			const requestId = randomUUID();
			const requestFile = join(bridge.directory, "request.json");
			const responseFile = join(bridge.directory, "response.json");
			try {
				await rm(responseFile, { force: true });
				await this.atomicJson(requestFile, { requestId, operation, ...(operation === "notify" ? { result } : {}) });
				const response = await this.requireAgent(runtime).request<{ disposition: string }>({ type: "prompt", message: `/${bridge.command} ${bridge.token} ${requestId}` });
				if (response.disposition !== "handled") throw new Error("工具管理命令未被处理。");
				const data = JSON.parse(await readFile(responseFile, "utf8"));
				if (data?.requestId !== requestId || typeof data.ok !== "boolean") throw new Error("工具管理返回格式错误。");
				if (!data.ok) throw new Error(String(data.error));
				if (!Array.isArray(data.tools)) throw new Error("工具清单格式错误。");
				return data.tools as DesktopToolInfo[];
			} finally { await Promise.all([rm(requestFile, { force: true }), rm(responseFile, { force: true })]); }
		});
		bridge.operation = action.then(() => {}, () => {});
		return action;
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
			if (input.allowedTools !== undefined) {
				if (!Array.isArray(input.allowedTools) || input.allowedTools.length > 50)
					throw new Error("Agent 工具列表无效。");
				for (const name of input.allowedTools)
					if (typeof name !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(name))
						throw new Error("Agent 工具名称无效。");
			}
			const existing = input.worktreeId
				? (await this.worktrees.list()).find((item) => item.id === input.worktreeId)
				: undefined;
			if (input.worktreeId && (!existing || existing.status !== "ready")) throw new Error("指定的 Worktree 不可用。");
			if (existing && input.baseRef !== undefined) throw new Error("已有 Worktree 不能重新指定 Git 基准。");
			const project = await realpath(input.project ?? existing?.repository ?? this.requireActive().project);
			if (!(await stat(project)).isDirectory()) throw new Error("项目目录不存在。");
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
			if (!this.store.projects.some((item) => item.path === project))
				this.store.projects.push({ path: project, name: basename(project) });
			const conversation = this.createConversation(directory);
			conversation.title = input.title?.trim().slice(0, 160) || input.message.trim().split("\n")[0].slice(0, 60);
			if (worktree) await this.worktrees.bindConversation(worktree.id, conversation.id);
			const task: DesktopTask = {
				id: conversation.id,
				conversationId: conversation.id,
				project,
				workingDirectory: conversation.project,
				worktreeId: worktree?.id,
				title: conversation.title,
				prompt: input.message,
				status: "queued",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revision: 0,
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				allowedTools: input.allowedTools,
				...delegation,
			};
			if (delegation) {
				const inherited = this.permissionPolicy(delegation.parentConversationId);
				this.store.taskPolicies ??= {};
				this.store.taskPolicies[task.id] = inherited;
			}
			this.store.tasks.unshift(task);
			this.updateTask(task, "queued");
			await this.persist();
			void this.scheduleTasks();
			return structuredClone(task);
		});
	}

	async taskSnapshot(id: string): Promise<Snapshot> {
		await this.operation;
		const task = this.task(id);
		const conversation = this.conversation(task.conversationId);
		if (await this.projectAvailable(conversation)) {
			const runtime = await this.ensureRuntime(conversation);
			await runtime.settling;
		}
		return this.buildSnapshot(task.conversationId);
	}

	async cancelTask(id: string): Promise<DesktopTask> {
		await this.operation;
		const task = this.task(id);
		await this.delegation.cancelChildren(task.conversationId);
		await this.external.cancelChildren(task.conversationId);
		if (!["queued", "running", "waiting_for_input"].includes(task.status)) return structuredClone(task);
		this.updateTask(task, "cancelled");
		this.launches.set(task.conversationId, (this.launches.get(task.conversationId) ?? 0) + 1);
		const runtime = this.runtimes.get(task.conversationId);
		if (runtime?.agent && (runtime.busy || runtime.pendingUI.size)) {
			await this.cancelDialogs(runtime);
			await runtime.agent.request({ type: "abort" });
		} else if (runtime) {
			await this.stopRuntime(runtime);
		}
		await this.persist();
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
		this.delegation.dispose();
		await this.toolHost.close();
		this.connectionCheck?.cancel(new Error("桌面服务已关闭，连接测试已取消。"));
		await this.operation;
		await this.external.close();
		await this.terminals.dispose();
		for (const task of this.store.tasks) {
			if (["queued", "running", "waiting_for_input"].includes(task.status))
				this.updateTask(task, "interrupted", "应用已关闭，任务未自动重新执行。");
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
	private updateTask(task: DesktopTask, status: DesktopTask["status"], error?: string): void {
		task.status = status;
		task.error = error;
		task.updatedAt = Date.now();
		task.revision = (task.revision ?? 0) + 1;
		for (const listener of this.taskListeners) listener({ type: "task_updated", task: structuredClone(task) });
		void this.persist().catch(() => {});
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
	private assertPathAvailable(project: string, exceptId?: string, externalExceptId?: string): void {
		// Explore/Plan have a host-enforced read-only ceiling and never write checkpoints.
		if (exceptId && this.store.tasks.some((task) => task.conversationId === exceptId && task.parentConversationId && task.readOnly)) return;
		if (this.external?.conflicts(project, externalExceptId)) throw new Error("此目录有运行中的外部 Agent，请使用独立 Worktree。");
		for (const runtime of this.runtimes.values()) {
			if (runtime.conversationId === exceptId) continue;
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
					task.conversationId !== exceptId &&
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
		try {
			if (runtime.checkpointId) {
				await this.git.finish(this.conversation(runtime.conversationId).project, runtime.checkpointId);
				runtime.checkpointId = undefined;
			}
			await this.syncState(runtime).catch(() => {});
			await this.saveSessionLeaf(runtime).catch(() => {});
			this.conversation(runtime.conversationId).updatedAt = Date.now();
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task?.parentConversationId && runtime.agent) {
				const { messages } = await runtime.agent.request<{ messages: Message[] }>({ type: "get_messages" });
				const final = [...messages].reverse().find((message) => message.role === "assistant");
				const text = final?.role === "assistant" ? final.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
				task.result = { text: text.slice(0, 48 * 1024), truncated: text.length > 48 * 1024 };
			}
			if (task && ["running", "waiting_for_input"].includes(task.status))
				this.updateTask(task, error ? "failed" : aborted ? "cancelled" : "completed", error);
			await this.persist();
			if (!runtime.stopping && !this.closed) {
				const conv = this.conversation(runtime.conversationId);
				void this.hooks.run("Stop", {
					project: conv.project,
					projectTrusted: this.isProjectTrusted(conv.project),
					conversationId: conv.id,
					env: this.options.env,
				}).catch(() => {});
			}
		} catch (failure) {
			const message = `无法完成 Git 恢复点：${failure instanceof Error ? failure.message : String(failure)}`;
			const task = this.store.tasks.find((item) => item.conversationId === runtime.conversationId);
			if (task && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "failed", message);
			this.emit({ conversationId: runtime.conversationId, event: { type: "desktop_error", message } });
		} finally {
			runtime.settling = undefined;
			void this.scheduleTasks();
			this.external?.pump();
		}
	}
	private async stopRuntime(runtime: SessionRuntime, cursor: "capture" | "preserve" = "capture"): Promise<void> {
		runtime.stopping = true;
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
		if (runtime.navigation) await rm(runtime.navigation.directory, { recursive: true, force: true });
		if (runtime.controls) {
			this.toolHost.revoke(runtime.controls.hostToken);
			await rm(runtime.controls.directory, { recursive: true, force: true });
		}
		if (runtime.policyFile) await rm(runtime.policyFile, { force: true });
		if (runtime.sandboxProfileFile) await rm(runtime.sandboxProfileFile, { force: true });
		if (this.runtimes.get(runtime.conversationId) === runtime) this.runtimes.delete(runtime.conversationId);
	}
	private async scheduleTasks(): Promise<void> {
		if (this.scheduling || this.closed) return;
		this.scheduling = true;
		try {
			await this.operation;
			let active = this.store.tasks.filter((task) => ["running", "waiting_for_input"].includes(task.status)).length + this.external.countRunning();
			for (const task of this.store.tasks.filter((item) => item.status === "queued").reverse()) {
				if (active >= (this.options.maxConcurrentTasks ?? 4) || this.closed) break;
				try {
					this.assertPathAvailable(task.workingDirectory, task.conversationId);
				} catch {
					continue;
				}
				this.updateTask(task, "running");
				const launch = (this.launches.get(task.conversationId) ?? 0) + 1;
				this.launches.set(task.conversationId, launch);
				active++;
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
			if (task.model) await agent.request({ type: "set_model", provider: task.model.provider, modelId: task.model.id });
			if (this.closed || this.launches.get(task.conversationId) !== launch) return;
			if (task.thinkingLevel) await agent.request({ type: "set_thinking_level", level: task.thinkingLevel });
			if (this.closed || this.launches.get(task.conversationId) !== launch) return;
			await this.command({ type: "prompt", message: task.prompt }, task.conversationId, launch);
		} catch (error) {
			if (!this.closed && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "failed", error instanceof Error ? error.message : String(error));
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
				stopping: false,
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
			};
			if (this.store.settings.agentDir) env.PI_CODING_AGENT_DIR = this.store.settings.agentDir;
			const connections: Record<
				string,
				{
					baseUrl?: string;
					modelId?: string;
					envKey?: string;
					api?: ConnectionProtocol;
					mode?: ConnectionMode;
					presetBaseUrl?: string;
				}
			> = {};
			for (const provider of providers) {
				const connection = this.store.settings.connections[provider];
				const encrypted = this.store.keys[provider];
				const envKey = `PI_DESKTOP_KEY_${provider.toUpperCase()}`;
				if (encrypted) {
					if (!this.options.decrypt) throw new Error("无法读取系统安全存储中的 API Key。");
					env[envKey] = this.options.decrypt(encrypted);
				}
				if (connection)
					connections[provider] = {
						...connection,
						envKey: encrypted ? envKey : undefined,
						presetBaseUrl: this.options.providerBaseUrls?.[provider],
					};
			}
			env.PI_DESKTOP_CONNECTIONS = JSON.stringify(connections);
			runtime.policyFile = join(this.options.dataDir, `policy-${conversation.id}-${randomBytes(8).toString("hex")}.json`);
			env.PI_DESKTOP_POLICY_FILE = runtime.policyFile;
			if (this.store.settings.sandbox && (await probeSeatbeltSupport()).supported) {
				runtime.sandboxProfileFile = join(this.options.dataDir, `sandbox-${conversation.id}-${randomBytes(8).toString("hex")}.sb`);
				await writeFile(runtime.sandboxProfileFile, buildSeatbeltProfile(conversation.project, [this.options.dataDir]), { mode: 0o600 });
				env.PI_DESKTOP_SANDBOX_PROFILE = runtime.sandboxProfileFile;
			}
			const delegated = this.store.tasks.find((task) => task.conversationId === conversation.id && task.parentConversationId);
			// Set these explicitly so an inherited shell environment cannot change a session's role.
			env.PI_DESKTOP_CHILD = delegated ? "1" : "0";
			env.PI_DESKTOP_READ_ONLY_CHILD = delegated?.readOnly ? "1" : "0";
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
			const trustProject = await this.trustProjectFor(conversation.project);
			const trustDecision = this.store.projectTrust?.[trustProject];
			const args = [
				"--session-dir",
				sessionDir,
				...(sessionFile ? ["--session", sessionFile] : ["--session-id", conversation.id]),
				"--extension",
				this.options.permissionExtension ?? join(runtimeDir, "permission-extension.mjs"),
				...(navigationInstalled ? ["--extension", navigationExtension] : []),
				...(toolsInstalled ? ["--extension", toolExtension] : []),
				...(trustResources.length ? [trustDecision === "trusted" ? "--approve" : "--no-approve"] : []),
				...(this.options.args ?? []),
			];
			if (!sessionFile && this.store.settings.defaultModel) {
				const model = this.store.settings.defaultModel;
				args.push("--provider", model.provider, "--model", model.id);
			}
			const task = this.store.tasks.find((item) => item.conversationId === conversation.id);
			const policyMode = this.permissionPolicy(conversation.id).mode;
			const definedTools = piToolAllowlist(task?.allowedTools);
			if (definedTools !== undefined) {
				// An explicit empty allowlist must deny all built-in tools instead of
				// falling back to Pi's unrestricted default.
				args.push("--tools", definedTools.join(","));
				if (policyMode === "read" || policyMode === "plan") args.push("--exclude-tools", "mcp__*");
			} else if (policyMode === "read") {
				args.push("--tools", "read,grep,find,ls", "--exclude-tools", "mcp__*");
			} else if (policyMode === "plan") {
				args.push("--tools", "read,grep,find,ls,write,edit", "--exclude-tools", "mcp__*");
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
				project: conversation.project,
				projectTrusted: this.isProjectTrusted(conversation.project),
				conversationId: conversation.id,
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
		} catch (error) {
			runtime.engineStatus = "error";
			runtime.engineError = error instanceof Error ? error.message : String(error);
			await runtime.agent?.stop();
			runtime.agent = undefined;
		}
	}

	private onEvent(runtime: SessionRuntime, event: DesktopEvent["event"]): void {
		const conversationId = runtime.conversationId;
		const sequence = ++this.eventSequence;
		runtime.eventSequence = sequence;
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
			if (task && task.status !== "cancelled" && task.status !== "interrupted")
				this.updateTask(task, "waiting_for_input");
		}
		if (event.type === "agent_start") {
			runtime.busy = true;
			if (runtime.state) runtime.state.isStreaming = true;
			if (task && (task.status === "cancelled" || task.status === "interrupted")) {
				void runtime.agent?.request({ type: "abort" }).catch(() => {});
			} else if (task) this.updateTask(task, "running");
		}
		if (event.type === "compaction_start" && runtime.state) runtime.state.isCompacting = true;
		if (event.type === "compaction_end" && runtime.state) runtime.state.isCompacting = false;
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")
			runtime.lastError = event.message.errorMessage ?? "模型请求失败。";
		if (event.type === "agent_settled") {
			runtime.busy = false;
			if (runtime.state) runtime.state.isStreaming = false;
			runtime.pendingUI.clear();
			runtime.settling = this.finishRuntime(runtime, event.aborted, runtime.lastError);
			// Settlement is emitted after host cleanup; allocate its delivery sequence at that point.
			void runtime.settling.finally(() => this.emit({ conversationId, event }));
			return;
		}
		if (event.type === "desktop_error") {
			runtime.busy = false;
			runtime.bashBusy = false;
			runtime.engineStatus = "error";
			runtime.engineError = event.message;
			runtime.pendingUI.clear();
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
		this.conversation(runtime.conversationId).sessionFile = sessionFile
			? await stat(sessionFile).then(
					() => sessionFile,
					(error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					},
				)
			: undefined;
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
		return {
			eventSequence,
			liveTranscript,
			projects: this.store.projects,
			conversations: this.store.conversations,
			active: conversationId ? this.conversation(conversationId) : undefined,
			state: runtime ? runtime.state : undefined,
			models: runtime ? runtime.models : [],
			providerPresets,
			settings: {
				...this.store.settings,
				agentDir: this.store.settings.agentDir ?? this.defaultAgentDir(),
				configuredProviders: providers.filter((provider) => Boolean(this.store.keys[provider])),
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
		};
	}

	private async trustProjectFor(project: string): Promise<string> {
		if (this.store.projects.some((item) => item.path === project)) return project;
		const task = this.store.tasks.find((item) => item.workingDirectory === project);
		return task?.project ?? project;
	}

	private async projectTrustState(project: string): Promise<ProjectTrustState> {
		const trustProject = await this.trustProjectFor(project);
		const resources = await detectProjectTrustResources(project);
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
		const serialized = JSON.stringify(this.store, null, 2);
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
function validateStore(input: unknown): StoredState {
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
		!["light", "dark", "system"].includes(value.settings.theme)
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
	return {
		projects: value.projects,
		conversations: value.conversations,
		activeId: value.activeId,
		settings: {
			permission: value.settings.permission,
			theme: value.settings.theme,
			sandbox: typeof value.settings.sandbox === "boolean" ? value.settings.sandbox : undefined,
			notifications: typeof value.settings.notifications === "boolean" ? value.settings.notifications : undefined,
			defaultModel: value.settings.defaultModel,
			connections: value.settings.connections ?? {},
			agentDir: value.settings.agentDir,
		},
		keys: value.keys,
		tasks: value.tasks ?? [],
		taskPolicies: value.taskPolicies ? Object.fromEntries(Object.entries(value.taskPolicies).map(([id, policy]) => [id, validateRuntimePolicy(policy)])) : {},
		projectTrust,
	};
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
