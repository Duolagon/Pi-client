import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkExecutorCompatibility, discoverExecutors, executablePath, validateExecutorInput } from "./external-executors.ts";
import type { ExternalExecutorSettings } from "./external-executors.ts";
import { MAX_AGENT_OUTPUT, exceedsLength } from "./delegation-limits.ts";
import { evaluatePermission, validateRuntimePolicy } from "./permission-policy.ts";
import type { PermissionRule, RuntimePermissionPolicy } from "./permission-types.ts";
import type { WorktreeCreateInput, WorktreeInfo } from "./worktree-types.ts";
import { localDay, type UsageRecord } from "./usage-stats.ts";
import { MAX_INLINE_PATCH_BYTES, MAX_SUMMARY_FILES } from "./external-changes.ts";
import { externalModelOptions } from "./external-model-options.ts";
import { externalExecutorDefinition, isExternalProvider } from "./external-registry.ts";
import { createRegistryExternalAdapter } from "./external-registry-adapter.ts";
import { describeExternalFailure, diagnosticsOf, redactDiagnostic } from "./external-errors.ts";
import { acpOutputInstruction, parseAgentOutputSchema, parseAgentOutputText, validateAgentOutput, type AgentOutputSchema } from "./agent-output-schema.ts";
import type {
	ExternalAdapter, ExternalAdapterEvent, ExternalApprovalRequest, ExternalApprovalResponse, ExternalEvent,
	ExternalExecutor, ExternalExecutorInput, ExternalProvider, ExternalReplay, ExternalSession,
	ExternalTask, ExternalTaskResult, ExternalTaskSendInput, ExternalTaskStartInput, ExternalChangeSummary, ExternalUsage,
} from "./external-types.ts";

const active = new Set(["queued", "running", "waiting_for_input"]);
const outputLimit = MAX_AGENT_OUTPUT;
const maxPendingMessages = 8;
const maxUndeliveredResults = 8;
const policyModesByRestriction: RuntimePermissionPolicy["mode"][] = ["read", "plan", "ask", "acceptEdits", "auto"];
/**
 * Why an external task stopped. A background parent is told about every stop except its own
 * TaskStop (`model_stop`, the tool result already said so) and its own abort (`parent_abort`).
 * `policy_change`: host permissions changed; `restart`: the app quit or restarted;
 * `executor_stop`: the external executor ended the turn as cancelled by itself.
 */
export type ExternalStopReason = "user_stop" | "model_stop" | "parent_abort" | "policy_change" | "restart" | "executor_stop";
const stopReasons: readonly ExternalStopReason[] = ["user_stop", "model_stop", "parent_abort", "policy_change", "restart", "executor_stop"];
const silentStops: ReadonlySet<ExternalStopReason> = new Set(["model_stop", "parent_abort"]);
/** `notify` marks a background task whose result is delivered through the host's outbox. */
interface VerifiedExecutor {
	executable: string;
	version?: string;
	compatibility: "compatible" | "incompatible";
	continuation: boolean;
	error?: string;
}
interface StoredNativeUsage {
	/** Latest cumulative native session cost, kept separate from cost observed by this app. */
	observedCostUsd?: number;
	observedTokens?: Omit<ExternalUsage, "costUsd">;
	costUsd: number;
	days: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number; turns: number }>;
}
interface StoredTask {
	task: ExternalTask;
	policy: RuntimePermissionPolicy;
	prompt: string;
	notify: boolean;
	notifiedTurn?: number;
	stopReason?: ExternalStopReason;
	usage?: StoredNativeUsage;
	usesMultiSettings?: true;
	outputSchema?: AgentOutputSchema;
	originalPrompt?: string;
	followUps?: string[];
	undelivered?: ExternalNotification[];
}
/** A finished background turn whose result the parent has not received yet. */
export interface ExternalNotification { task: ExternalTask; stopReason?: ExternalStopReason }
interface Runtime {
	session?: ExternalSession;
	abort?: AbortController;
	running?: Promise<void>;
	closing?: Promise<void>;
	events: ExternalEvent[];
	logBytes: number;
	logWrites: Promise<void>;
	approvals: Map<string, { request: ExternalApprovalRequest; resolve(response: ExternalApprovalResponse): void }>;
	sessionGrants?: Set<string>;
	/** The run has not recorded its final output yet; a stopped task is delivered after it has. */
	executing?: boolean;
	usage?: Extract<ExternalAdapterEvent, { type: "usage" }>;
	usageAttempts?: Array<NonNullable<Runtime["usage"]>>;
}
export interface ExternalAgentOptions {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	networkEnv?(): NodeJS.ProcessEnv;
	nodeExecutable: string;
	claudeHelperPath: string;
	adapters: Partial<Record<ExternalProvider, ExternalAdapter>>;
	maxConcurrent?: number;
	project(conversationId: string): string;
	isProjectTrusted(project: string): boolean;
	policy(conversationId: string): RuntimePermissionPolicy;
	delegated(conversationId: string): boolean;
	createWorktree(input: WorktreeCreateInput): Promise<WorktreeInfo>;
	listWorktrees(): Promise<WorktreeInfo[]>;
	canStart(task: ExternalTask): boolean;
	/** Start a checkpoint; the returned function finishes it and summarizes the turn's changes. */
	beginCheckpoint?(task: ExternalTask): Promise<() => Promise<ExternalChangeSummary | void>>;
	/** Native model and effort the user pinned for an executor. */
	executorModel?(executor: ExternalProvider): { model?: string; effort?: string } | undefined;
	usesMultiSettings?(conversationId: string): boolean;
	checkBudget?(executor: ExternalProvider): void;
	reserveBudget?(task: ExternalTask): Promise<{ maxBudgetUsd: number; release(): Promise<void> } | undefined>;
	capacity(): number;
	/** Deliver pending background results of a parent from the host's persisted outbox. */
	flushNotifications(conversationId: string): void;
	onActivityChange(): void;
}

/** Own external processes independently of Pi sessions, while preserving immutable parent identity. */
export class ExternalAgents {
	private options: ExternalAgentOptions;
	private settings: ExternalExecutorSettings = {};
	private tasks = new Map<string, StoredTask>();
	private runtimes = new Map<string, Runtime>();
	private listeners = new Set<(event: ExternalEvent) => void>();
	private operation: Promise<void> = Promise.resolve();
	private persistence: Promise<void> = Promise.resolve();
	private pumping = false;
	private initialized = false;
	private closed = false;
	private verified = new Map<ExternalProvider, VerifiedExecutor>();
	private executorsCache?: { at: number; values: ExternalExecutor[] };
	constructor(options: ExternalAgentOptions) { this.options = options; }

	async initialize(): Promise<void> {
		await mkdir(join(this.options.dataDir, "external-events"), { recursive: true, mode: 0o700 });
		try {
			const raw = JSON.parse(await readFile(join(this.options.dataDir, "external-agents.json"), "utf8"));
			if (!raw || raw.version !== 1 || !Array.isArray(raw.tasks) || raw.tasks.length > 500 || !raw.settings || typeof raw.settings !== "object") throw new Error("外部 Agent 存档无效。");
			for (const [id, entry] of Object.entries(raw.settings)) {
				const input = validateExecutorInput({ ...(entry as object), id });
				this.settings[input.id] = { enabled: input.enabled ?? true, executable: input.executable ?? undefined };
			}
			for (const [id, value] of Object.entries(raw.verified ?? {})) {
				const check = value as Partial<VerifiedExecutor> | null;
				if (!isExternalProvider(id) || !check || typeof check.executable !== "string" || !isAbsolute(check.executable) ||
					(check.compatibility !== "compatible" && check.compatibility !== "incompatible") ||
					typeof check.continuation !== "boolean" || (check.version !== undefined && typeof check.version !== "string") ||
					(check.error !== undefined && typeof check.error !== "string")) continue;
				this.verified.set(id, { executable: check.executable, version: check.version, compatibility: check.compatibility,
					continuation: check.continuation, error: check.error });
			}
			for (const record of raw.tasks) {
				const task = record?.task;
				if (!task || typeof task.id !== "string" || !/^external-[a-f0-9-]{36}$/.test(task.id) || !isExternalProvider(task.executor) ||
					typeof task.parentConversationId !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(task.parentConversationId) ||
					!["queued", "running", "waiting_for_input", "completed", "failed", "cancelled", "interrupted"].includes(task.status) ||
					typeof task.workingDirectory !== "string" || !isAbsolute(task.workingDirectory) || typeof task.project !== "string" || !isAbsolute(task.project) ||
					typeof task.output !== "string" || task.output.length > outputLimit || !Number.isSafeInteger(task.turn) || task.turn < 1 ||
					!Number.isSafeInteger(task.eventSequence) || task.eventSequence < 0 || typeof record.prompt !== "string" || record.prompt.length > 2 * 1024 * 1024)
					throw new Error("外部任务存档无效。");
				if (task.nativeSessionId !== undefined && (typeof task.nativeSessionId !== "string" || task.nativeSessionId.length > 500 || task.nativeSessionId.includes("\0"))) throw new Error("外部会话标识无效。");
				task.pendingApprovals = [];
				Object.assign(task, externalModelOptions(task.model, task.effort));
				task.runInBackground = Boolean(record.notify);
				task.changes = validatedChanges(task.changes);
				task.usage = validatedTurnUsage(task.usage);
				const followUps = storedFollowUps(record.followUps);
				task.pendingMessages = followUps?.length;
				delete task.sendDisposition;
				const outputSchema = record.outputSchema === undefined ? undefined : parseAgentOutputSchema(record.outputSchema);
				task.structuredOutput = task.status === "completed" && outputSchema && task.structuredOutput !== undefined
					? validateAgentOutput(outputSchema, task.structuredOutput) : undefined;
				if (record.notifiedTurn !== undefined && (!Number.isSafeInteger(record.notifiedTurn) || record.notifiedTurn < 1 || record.notifiedTurn > task.turn)) throw new Error("外部任务通知状态无效。");
				if (record.stopReason !== undefined && !stopReasons.includes(record.stopReason)) throw new Error("外部任务停止原因无效。");
				// A turn the app lost while it ran is reported to a background parent as stopped.
				// Records interrupted before stop reasons existed carry none and are never replayed.
				if (active.has(task.status)) { task.status = "interrupted"; task.error = "应用已重启；未重放任务，可显式发送新指令恢复原生会话。"; record.stopReason = "restart"; }
				this.tasks.set(task.id, { task, policy: validateRuntimePolicy(record.policy), prompt: record.prompt, notify: Boolean(record.notify), notifiedTurn: record.notifiedTurn, stopReason: record.stopReason,
					usage: validatedUsage(record.usage), outputSchema,
					originalPrompt: typeof record.originalPrompt === "string" ? record.originalPrompt.slice(0, 2 * 1024 * 1024) : undefined,
					followUps, undelivered: storedNotifications(record.undelivered, task, outputSchema), ...(record.usesMultiSettings === true ? { usesMultiSettings: true } : {}) });
				// The event log can be newer than the last atomic task snapshot after a crash.
				const recovered = await this.replay(task.id);
				task.eventSequence = Math.max(task.eventSequence, recovered.latestSequence);
				const session = [...recovered.events].reverse().find((event) => event.event.type === "session")?.event;
				if (session?.type === "session" && typeof session.sessionId === "string" && session.sessionId.length <= 500) task.nativeSessionId = session.sessionId;
				const runtime = this.runtime(task.id);
				runtime.logBytes = await stat(join(this.options.dataDir, "external-events", `${task.id}.jsonl`)).then((info) => info.size, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0; throw error; });
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		this.initialized = true;
		await this.persist();
	}

	subscribe(listener: (event: ExternalEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	has(id: string): boolean { return this.tasks.has(id); }
	countRunning(): number { return [...this.tasks.values()].filter(({ task }) => ["running", "waiting_for_input"].includes(task.status)).length; }
	pendingApprovalCount(): number {
		let count = 0;
		for (const runtime of this.runtimes.values()) count += runtime.approvals.size;
		return count;
	}
	measuredCostUsd(owner: string): number {
		let total = 0;
		for (const { task, usage } of this.tasks.values()) if (task.parentConversationId === owner) total += usage?.costUsd ?? 0;
		return total;
	}
	usageRecords(): UsageRecord[] {
		const entries: UsageRecord[] = [];
		for (const { task, usage } of this.tasks.values()) {
			for (const [day, entry] of Object.entries(usage?.days ?? {})) {
				entries.push({ key: `${task.id}:${day}`, day, model: `external/${task.executor}`, input: entry.input, output: entry.output,
					cacheRead: entry.cacheRead ?? 0, cacheWrite: entry.cacheWrite ?? 0, cost: entry.cost, samples: entry.turns });
			}
		}
		return entries;
	}
	activeClaudeInProject(project: string): boolean {
		return [...this.tasks.values()].some(({ task }) => task.executor === "claude" && task.project === project &&
			(active.has(task.status) || this.runtimes.get(task.id)?.executing === true));
	}
	activeInPath(path: string): boolean {
		return [...this.tasks.values()].some(({ task }) =>
			(active.has(task.status) || this.runtimes.get(task.id)?.executing) && overlaps(path, task.workingDirectory));
	}
	conflicts(path: string, exceptId?: string): boolean {
		return [...this.tasks.values()].some(({ task }) => task.id !== exceptId &&
			(["running", "waiting_for_input"].includes(task.status) || this.runtimes.get(task.id)?.executing) &&
			overlaps(path, task.workingDirectory));
	}
	list(owner?: string): ExternalTask[] { return structuredClone([...this.tasks.values()].map(({ task }) => task).filter((task) => !owner || task.parentConversationId === owner).reverse()); }
	/** True while any task of this owner is queued/running or still shutting down after a cancel. */
	hasActive(owner: string): boolean {
		return [...this.tasks.values()].some(({ task }) => task.parentConversationId === owner &&
			(active.has(task.status) || this.runtimes.get(task.id)?.executing === true));
	}
	snapshot(id: string): ExternalTask { return structuredClone(this.record(id).task); }
	notifyChangesUpdated(id: string): void {
		const task = this.record(id).task;
		this.update(task, task.status, task.error);
	}
	async executors(options?: { verifyCompatibility?: boolean }): Promise<ExternalExecutor[]> {
		if (options?.verifyCompatibility || !this.executorsCache || Date.now() - this.executorsCache.at > 10000) this.executorsCache = { at: Date.now(), values: await discoverExecutors(this.settings, this.options.env) };
		const discovered = this.executorsCache.values;
		if (options?.verifyCompatibility) {
			const checked = await Promise.all(discovered.map((item) => checkExecutorCompatibility(item, this.options.env)));
			for (const item of checked) {
				if (item.executable && item.compatibility && item.compatibility !== "unverified")
					this.verified.set(item.id, { executable: item.executable, version: item.version, compatibility: item.compatibility,
						continuation: item.capabilities.continuation, error: item.error });
				else this.verified.delete(item.id);
			}
			await this.persist();
			return checked;
		}
		return structuredClone(discovered.map((item) => {
			const check = this.verified.get(item.id);
			return item.available && check && check.executable === item.executable && check.version === item.version
				? { ...item, compatibility: check.compatibility, available: check.compatibility === "compatible",
					error: check.error, capabilities: { ...item.capabilities, continuation: check.continuation } } : item;
		}));
	}
	configure(value: ExternalExecutorInput): Promise<ExternalExecutor[]> {
		return this.serialize(async () => {
			const input = validateExecutorInput(value);
			if ([...this.tasks.values()].some(({ task }) => task.executor === input.id && active.has(task.status))) throw new Error("请先停止该执行器的活动任务。");
			const executable = input.executable === undefined ? this.settings[input.id]?.executable : input.executable === null ? undefined : await executablePath(input.executable);
			this.settings[input.id] = { enabled: input.enabled ?? this.settings[input.id]?.enabled ?? externalExecutorDefinition(input.id)!.enabledByDefault, executable };
			for (const [id, runtime] of this.runtimes) if (this.record(id).task.executor === input.id) { await runtime.session?.close(); runtime.session = undefined; }
			this.executorsCache = undefined;
			await this.persist();
			return this.executors();
		});
	}

	originalRequest(id: string, owner?: string): string {
		const record = this.record(id, owner);
		if (record.originalPrompt) return record.originalPrompt;
		if (record.task.turn === 1) return record.prompt;
		throw new Error("此历史任务未保存初始需求。");
	}

	start(input: ExternalTaskStartInput, owner: string, toolCallId?: string, provenance?: { reviewOf?: string; comparisonId?: string }): Promise<ExternalTask> {
		const usesMultiSettings = this.options.usesMultiSettings?.(owner) === true;
		return this.serialize(async () => {
			if (this.options.delegated(owner)) throw new Error("子任务不能再委派外部 Agent。");
			validatePrompt(input.prompt); validateDescription(input.description);
			const model = externalModelOptions(input.model, input.effort);
			const outputSchema = input.output_schema === undefined ? undefined : parseAgentOutputSchema(input.output_schema);
			if (!isExternalProvider(input.executor)) throw new Error("未知外部执行器。");
			const previous = toolCallId && [...this.tasks.values()].find(({ task }) => task.parentConversationId === owner && task.parentToolCallId === toolCallId);
			if (previous) return structuredClone(previous.task);
			this.options.checkBudget?.(input.executor);
			if (this.tasks.size >= 500 || this.list(owner).filter((task) => active.has(task.status)).length >= 8) throw new Error("外部任务数量已达上限，请先完成或停止已有子任务。");
			const executor = (await this.executors()).find((item) => item.id === input.executor)!;
			if (!executor.enabled || !executor.available) throw new Error(executor.error ?? "执行器已停用。");
			const subagentType = input.subagent_type ?? "general-purpose";
			if (!["Explore", "Plan", "general-purpose"].includes(subagentType)) throw new Error("未知子任务类型。");
			const project = await realpath(this.options.project(owner));
			const policy = structuredClone(this.options.policy(owner));
			const readOnly = policy.mode === "read" || policy.mode === "plan" || subagentType !== "general-purpose";
			if (readOnly && !executor.capabilities.readOnly) throw new Error(`${executor.id} 当前协议无法强制只读权限，不能启动 Explore/Plan。`);
			const isolation = input.isolation ?? (readOnly ? "shared" : "worktree");
			if (!["shared", "worktree"].includes(isolation) || (!readOnly && isolation === "shared")) throw new Error("外部可写任务必须使用独立 Worktree。");
			let tree: WorktreeInfo | undefined;
			if (input.worktree_id) {
				tree = (await this.options.listWorktrees()).find((item) => item.id === input.worktree_id && item.conversationId === owner && item.status === "ready");
				if (!tree || isolation !== "worktree" || !contains(tree.repository, project) || this.activeInPath(tree.path)) throw new Error("Worktree 不属于此父会话或仍在使用。");
			} else if (isolation === "worktree") tree = await this.options.createWorktree({ project, conversationId: owner });
			const workingDirectory = tree ? await realpath(join(tree.path, relative(tree.repository, project))) : project;
			const now = Date.now();
			const task: ExternalTask = { id: `external-${randomUUID()}`, executor: input.executor, parentConversationId: owner, parentToolCallId: toolCallId,
				title: input.description, project, workingDirectory, worktreeId: tree?.id, subagentType, readOnly, ...model, status: "queued", createdAt: now, updatedAt: now,
				revision: 0, turn: 1, eventSequence: 0, output: "", truncated: false, pendingApprovals: [], runInBackground: input.run_in_background ?? false };
			if (provenance?.reviewOf) task.reviewOf = provenance.reviewOf;
			if (provenance?.comparisonId) task.comparisonId = provenance.comparisonId;
			this.tasks.set(task.id, { task, policy, prompt: input.prompt, originalPrompt: input.prompt, notify: input.run_in_background ?? false,
				outputSchema,
				...(usesMultiSettings ? { usesMultiSettings: true } : {}) });
			this.update(task, "queued"); await this.persist(); this.pump(); return structuredClone(task);
		});
	}

	send(input: ExternalTaskSendInput, owner?: string): Promise<ExternalTask> {
		return this.serialize(async () => {
			validatePrompt(input.message);
			const record = this.record(input.taskId, owner);
			const task = record.task;
			this.options.checkBudget?.(task.executor);
			const runtime = this.runtimes.get(task.id);
			if (task.supportsResume === false && task.nativeSessionId && !runtime?.session)
				throw new Error("此 ACP 执行器无法恢复已关闭的会话，请新建任务。");
			if (active.has(task.status) && !record.followUps?.length && runtime?.session?.steer &&
				!runtime.abort?.signal.aborted && await runtime.session.steer(input.message)) {
				return { ...structuredClone(task), sendDisposition: "steered" };
			}
			const messages = [...(record.followUps ?? []), input.message];
			const prompt = messages.join("\n\n");
			validatePrompt(prompt);
			if (active.has(task.status)) {
				if (messages.length > maxPendingMessages) throw new Error("排队的追加消息已达上限。");
				record.followUps = messages;
				task.pendingMessages = messages.length;
				this.update(task, task.status, task.error);
				await this.persist();
				return { ...structuredClone(task), sendDisposition: "queued" };
			}
			await runtime?.running;
			await realpath(task.workingDirectory);
			await this.queueTurn(record, prompt, input.runInBackground ?? false);
			return structuredClone(task);
		});
	}

	private async queueTurn(record: StoredTask, prompt: string, background: boolean): Promise<void> {
		const { task } = record;
		if (shouldNotify(record)) {
			const pending = record.undelivered ??= [];
			if (pending.length >= maxUndeliveredResults) throw new Error("请先交付此前的后台结果，再运行下一轮。");
			pending.push({ task: structuredClone(task), stopReason: record.stopReason });
		}
		record.prompt = prompt;
		record.notify = background;
		record.stopReason = undefined;
		record.followUps = undefined;
		task.pendingMessages = undefined;
		task.runInBackground = background;
		task.turn++;
		task.output = "";
		task.error = undefined;
		task.truncated = false;
		task.changes = undefined;
		task.structuredOutput = undefined;
		task.usage = undefined;
		this.update(task, "queued");
		await this.persist();
		this.pump();
	}

	async result(id: string, options: { block?: boolean; timeout?: number } = {}, owner?: string, signal?: AbortSignal): Promise<ExternalTaskResult> {
		const timeout = options.block ? options.timeout ?? 60000 : 0;
		if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("等待上限必须为 0–60000 毫秒。");
		const started = Date.now();
		let task = this.record(id, owner).task;
		while (options.block && active.has(task.status) && task.status !== "waiting_for_input" && Date.now() - started < timeout) {
			signal?.throwIfAborted(); await delay(Math.min(100, timeout - (Date.now() - started)), undefined, { signal }); task = this.record(id, owner).task;
		}
		signal?.throwIfAborted();
		return { task_id: task.id, executor: task.executor, parent_conversation_id: task.parentConversationId, parent_tool_call_id: task.parentToolCallId,
			status: task.status, turn: task.turn, native_session_id: task.nativeSessionId, worktree_id: task.worktreeId, working_directory: task.workingDirectory,
			output: task.output, truncated: task.truncated, error: task.error, pending_approvals: task.pendingApprovals.length,
			...(task.pendingMessages ? { pending_messages: task.pendingMessages } : {}),
			...(task.usage ? { usage: { ...task.usage } } : {}),
			...(task.changes && !active.has(task.status) ? { changes: structuredClone(task.changes) } : {}),
			...(task.status === "completed" && task.structuredOutput !== undefined ? { structured_output: structuredClone(task.structuredOutput) } : {}) };
	}
	async awaitModelResult(id: string, owner: string, background: boolean, signal?: AbortSignal): Promise<ExternalTaskResult> {
		if (background) return this.result(id, {}, owner, signal);
		try {
			let result: ExternalTaskResult;
			const started = Date.now();
			do { result = await this.result(id, { block: true, timeout: 60000 }, owner, signal); }
			while (active.has(result.status) && !result.pending_approvals && Date.now() - started < 300000);
			if (active.has(result.status)) {
				// The parent stops waiting; the result now reaches it through the outbox.
				this.record(id, owner).notify = true;
				this.record(id, owner).task.runInBackground = true;
				await this.persist();
				this.options.flushNotifications(owner);
			}
			return result;
		} catch (error) { if (signal?.aborted) await this.cancel(id, owner, "parent_abort"); throw error; }
	}

	/** `reason` records who stopped the task; see `ExternalStopReason` for which stops notify. */
	async cancel(id: string, owner?: string, reason: ExternalStopReason = "user_stop", error?: string): Promise<ExternalTask> {
		const record = this.record(id, owner);
		const task = record.task;
		if (!active.has(task.status)) return structuredClone(task);
		record.stopReason = reason;
		if (reason === "user_stop" || reason === "model_stop" || reason === "parent_abort") {
			record.followUps = undefined;
			task.pendingMessages = undefined;
		}
		this.update(task, "cancelled", error);
		const runtime = this.runtimes.get(id);
		this.clearApprovals(task, runtime);
		runtime?.abort?.abort(new Error("用户取消了外部任务。"));
		await runtime?.session?.interrupt().catch(() => {});
		if (runtime?.session && !runtime.executing) {
			await runtime.session.close().catch(() => {});
			runtime.session = undefined;
		}
		await this.persist(); this.pump();
		// A running turn is delivered once it has recorded its output (see run()).
		if (record.notify && !silentStops.has(reason)) this.options.flushNotifications(task.parentConversationId);
		return structuredClone(task);
	}
	/**
	 * Cancel a parent's active external children. `foregroundOnly` is the parent's Esc
	 * (background children keep running); `backgroundOnly` is "stop all background agents".
	 */
	async cancelChildren(owner: string, options: { foregroundOnly?: boolean; backgroundOnly?: boolean; reason?: ExternalStopReason } = {}): Promise<ExternalTask[]> {
		const targets = [...this.tasks.values()].filter(({ task, notify }) => task.parentConversationId === owner && active.has(task.status) &&
			!(options.foregroundOnly && notify) && !(options.backgroundOnly && !notify));
		return Promise.all(targets.map(({ task }) => this.cancel(task.id, owner, options.reason ?? "parent_abort")));
	}
	/** Background children that can wake this parent's current goal when they settle. */
	hasActiveBackgroundChildren(owner: string, since: number): boolean {
		return [...this.tasks.values()].some(({ task, notify }) => notify && task.parentConversationId === owner &&
			task.createdAt >= since && (active.has(task.status) || this.runtimes.get(task.id)?.executing === true));
	}

	/** Finished background turns of `owner` that have not been delivered yet. */
	pendingNotifications(owner: string): ExternalNotification[] {
		return [...this.tasks.values()]
			.filter(({ task }) => task.parentConversationId === owner)
			.flatMap((record) => [
				...(record.undelivered ?? []),
				...(shouldNotify(record) && !this.runtimes.get(record.task.id)?.executing ? [{ task: record.task, stopReason: record.stopReason }] : []),
			]).map((notice) => structuredClone(notice));
	}
	/** Record a delivered turn, including one archived while a follow-up runs. */
	async markNotified(id: string, turn: number): Promise<void> {
		const record = this.tasks.get(id);
		if (!record) return;
		if (record.task.turn === turn) record.notifiedTurn = turn;
		else record.undelivered = record.undelivered?.filter((notice) => notice.task.turn !== turn);
		await this.persist();
	}

	/** Protocols without a per-tool authorization hook cannot safely keep running after revocation. */
	async invalidatePolicies(): Promise<void> {
		for (const runtime of this.runtimes.values()) runtime.sessionGrants?.clear();
		for (const { task } of this.tasks.values()) {
			if (task.executor === "claude") continue;
			if (active.has(task.status))
				await this.cancel(task.id, undefined, "policy_change", "宿主权限已更改，外部任务已停止；请在新权限下显式继续。");
			else {
				const runtime = this.runtimes.get(task.id);
				if (runtime?.session?.supportsResume === false) {
					const session = runtime.session;
					runtime.session = undefined;
					await session.close();
				}
			}
		}
		await this.persist();
	}
	async respond(id: string, requestId: string, response: ExternalApprovalResponse): Promise<void> {
		const task = this.record(id).task;
		const runtime = this.runtimes.get(id); const pending = runtime?.approvals.get(requestId);
		if (!pending || !active.has(task.status)) throw new Error("此外部审批已失效。");
		if (!["allow", "deny", "cancel"].includes(response.decision)) throw new Error("审批决定无效。");
		if (response.optionId) {
			const option = pending.request.options?.find((item) => item.id === response.optionId);
			if (!option || (pending.request.kind !== "question" && ["allow_always", "reject_always"].includes(option.kind ?? "")))
				throw new Error("审批选项无效，外部执行器仅接收单次决定。");
		}
		const { rememberForSession, ...nativeResponse } = response;
		if (rememberForSession && (response.decision !== "allow" || !canRemember(pending.request)))
			throw new Error("此请求仅支持单次授权。");
		if (response.decision === "allow" && pending.request.kind !== "question") {
			const decision = await evaluatePermission(this.policyFor(this.record(id)), normalizeCall(pending.request));
			if (decision.action === "deny") { this.resolveApproval(task, runtime!, requestId, { decision: "deny" }); throw new Error(decision.reason); }
		}
		if (!runtime!.approvals.has(requestId) || !active.has(task.status)) throw new Error("此外部审批已失效。");
		if (rememberForSession) {
			const grants = runtime!.sessionGrants ??= new Set();
			if (grants.size >= 100) grants.delete(grants.values().next().value!);
			grants.add(permissionFingerprint(pending.request));
			nativeResponse.optionId = pending.request.options?.find((option) => option.kind === "allow_once")?.id;
		}
		this.resolveApproval(task, runtime!, requestId, nativeResponse);
		await this.persist();
	}

	async replay(id: string, afterSequence = 0): Promise<ExternalReplay> {
		const task = this.record(id).task;
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("输出序号无效。");
		const runtime = this.runtimes.get(id);
		await runtime?.logWrites;
		let events = runtime?.events;
		if (!events?.length || afterSequence < events[0].sequence - 1) {
			try {
				const path = join(this.options.dataDir, "external-events", `${id}.jsonl`);
				if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error("外部事件日志过大。");
				events = (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
					try { const event = JSON.parse(line) as ExternalEvent; return event.taskId === id && Number.isSafeInteger(event.sequence) ? [event] : []; } catch { return []; }
				}).slice(-2000);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; events = []; }
		}
		const latestSequence = Math.max(task.eventSequence, events.at(-1)?.sequence ?? 0);
		return structuredClone({ events: events.filter((event) => event.sequence > afterSequence), latestSequence,
			truncated: Boolean(events.length && afterSequence < events[0].sequence - 1) });
	}

	pump(): void {
		if (this.pumping || this.closed || !this.initialized) return;
		this.pumping = true;
		void this.operation.then(() => {
			for (const record of this.tasks.values()) {
				if (this.closed || this.countRunning() >= Math.min(this.options.maxConcurrent ?? 4, this.options.capacity())) break;
				if (record.task.status !== "queued" || !this.options.canStart(record.task)) continue;
				const runtime = this.runtime(record.task.id);
				if (runtime.running) continue;
				this.update(record.task, "running");
				runtime.executing = true;
				runtime.abort = new AbortController();
				runtime.running = this.run(record, runtime).finally(() => {
					runtime.running = undefined;
					this.options.onActivityChange();
					this.pump();
					if (!this.closed && record.task.status === "completed" && record.followUps?.length) {
						const turn = record.task.turn;
						void this.serialize(async () => {
							if (record.task.turn === turn && record.task.status === "completed" && record.followUps?.length)
								await this.queueTurn(record, record.followUps.join("\n\n"), true);
						}).catch(() => {});
					}
				});
			}
		}).finally(() => { this.pumping = false; }).catch(() => {});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const { task } of this.tasks.values()) {
			const runtime = this.runtimes.get(task.id);
			if (active.has(task.status)) {
				this.tasks.get(task.id)!.stopReason = "restart";
				this.update(task, "interrupted", "应用已关闭；任务未自动重放。"); runtime?.abort?.abort();
			}
			this.clearApprovals(task, runtime);
		}
		await Promise.allSettled([...this.runtimes.values()].map(async (runtime) => { await runtime.session?.close(); await runtime.running; await runtime.logWrites; }));
		await this.operation;
		await this.persist(); await this.persistence;
		this.listeners.clear();
	}

	private async run(record: StoredTask, runtime: Runtime): Promise<void> {
		const task = record.task;
		let finishCheckpoint: (() => Promise<ExternalChangeSummary | void>) | undefined;
		let budget: Awaited<ReturnType<NonNullable<ExternalAgentOptions["reserveBudget"]>>>;
		let status: ExternalTask["status"] = "completed";
		let failure: string | undefined;
		let structuredOutput: unknown;
		let env = this.options.env;
		const resumed = task.nativeSessionId !== undefined;
		runtime.usage = undefined;
		runtime.usageAttempts = undefined;
		try {
			await realpath(task.workingDirectory);
			const executor = (await this.executors()).find((item) => item.id === task.executor)!;
			if (!executor.enabled || !executor.available || !executor.executable) throw new Error(executor.error ?? "执行器不可用。");
			const policy = this.policyFor(record);
			runtime.abort!.signal.throwIfAborted();
			this.options.checkBudget?.(task.executor);
			budget = await this.options.reserveBudget?.(task);
			runtime.abort!.signal.throwIfAborted();
			if (policy.mode !== "read" && policy.mode !== "plan") finishCheckpoint = await this.options.beginCheckpoint?.(task);
			runtime.abort!.signal.throwIfAborted();
			env = { ...this.options.env, ...this.options.networkEnv?.() };
			for (const key of Object.keys(env)) if (key.startsWith("PI_DESKTOP_") || key.startsWith("PI_CODING_")) delete env[key];
			const pinned = record.usesMultiSettings ? this.options.executorModel?.(task.executor) : undefined;
			const model = task.model ?? pinned?.model;
			const effort = task.effort ?? pinned?.effort;
			const adapter = this.options.adapters[task.executor] ?? createRegistryExternalAdapter(task.executor);
			if (!adapter) throw new Error("执行器协议不可用。");
			if (!runtime.session) runtime.session = await adapter.open({
				model, effort,
				executable: executor.executable, cwd: task.workingDirectory, env, resumeSessionId: task.nativeSessionId,
				policy: this.policyFor(record), helperPath: this.options.claudeHelperPath, nodeExecutable: this.options.nodeExecutable,
				projectTrusted: this.options.isProjectTrusted(task.project),
				maxBudgetUsd: budget?.maxBudgetUsd,
				...(record.outputSchema && executor.capabilities.transport !== "acp" ? { outputSchema: record.outputSchema } : {}),
				onEvent: (event) => {
					if (event.type === "diagnostic") event = { ...event, message: redactDiagnostic(event.message, env).slice(0, 4000) };
					this.adapterEvent(task, event);
				},
				onPermission: (request, signal) => this.permission(record, runtime, request, signal),
			});
			if (runtime.session.supportsResume !== undefined) task.supportsResume = runtime.session.supportsResume;
			if (runtime.session.sessionId) task.nativeSessionId = runtime.session.sessionId;
			await this.persist(); // Save the native ID before submitting a prompt whenever the protocol provides it.
			runtime.abort!.signal.throwIfAborted();
			const result = await this.runOutputTurn(record, runtime, executor.capabilities.transport);
			if (runtime.session.supportsResume !== false) {
				await runtime.session.close();
				runtime.session = undefined;
			}
			const changes = await finishCheckpoint?.();
			finishCheckpoint = undefined;
			if (changes) task.changes = changes;
			status = result.status;
			structuredOutput = result.structuredOutput;
		} catch (error) {
			status = runtime.abort?.signal.aborted ? "cancelled" : "failed";
			if (status === "cancelled") failure = redactDiagnostic(error instanceof Error ? error.message : String(error), env).slice(0, 4000);
			else {
				const described = describeExternalFailure(task.executor, error, diagnosticsOf(error) ?? runtime.session?.diagnostics?.(), env);
				failure = described.message;
				this.event(task, { type: "diagnostic", message: `失败类型：${described.kind}` });
			}
		} finally {
			this.clearApprovals(task, runtime);
			const changes = await finishCheckpoint?.().catch((error: unknown) => {
				this.event(task, { type: "diagnostic", message: `无法完成恢复点：${error instanceof Error ? error.message : String(error)}` });
			});
			if (changes) task.changes = changes;
			const reported = [...(runtime.usageAttempts ?? []), ...(runtime.usage ? [runtime.usage] : [])];
			if (reported.length) this.recordUsage(record, reported, resumed, status === "failed");
			await budget?.release().catch(() => {});
			// An ACP without load/resume can still accept queued input in its open session.
			const keepForQueue = !this.closed && !runtime.abort?.signal.aborted && status === "completed" &&
				runtime.session?.supportsResume === false && Boolean(record.followUps?.length);
			if (!keepForQueue) {
				const session = runtime.session;
				runtime.session = undefined;
				await session?.close().catch(() => {});
			}
			if (active.has(task.status)) {
				if (status === "cancelled") record.stopReason = "executor_stop";
				if (status === "completed" && record.outputSchema && structuredOutput !== undefined) {
					task.structuredOutput = structuredOutput;
					if (!task.output) task.output = JSON.stringify(structuredOutput);
				}
				this.update(task, status, failure);
			}
			runtime.executing = false;
			await this.persist();
			if (!this.closed && record.notify) this.options.flushNotifications(task.parentConversationId);
		}
	}

	private async runOutputTurn(record: StoredTask, runtime: Runtime, transport: ExternalExecutor["capabilities"]["transport"]) {
		const { task, outputSchema } = record;
		const session = runtime.session!;
		const signal = runtime.abort!.signal;
		const instruction = outputSchema && transport === "acp" ? acpOutputInstruction(outputSchema) : undefined;
		const run = async (prompt: string) => {
			const result = await session.run(prompt, signal);
			if (result.sessionId) task.nativeSessionId = result.sessionId;
			if (result.text || outputSchema) {
				task.output = result.text.slice(0, outputLimit);
				task.truncated = result.text.length > outputLimit;
			}
			return result;
		};
		const first = await run(instruction ? `${record.prompt}\n\n${instruction}` : record.prompt);
		if (!outputSchema || first.status !== "completed") return first;
		try {
			return { ...first, structuredOutput: validateAgentOutput(outputSchema,
				transport === "sdk" ? first.structuredOutput : parseAgentOutputText(first.text)) };
		} catch {
			if (!instruction) throw new Error("The external executor did not return a valid result for output_schema.");
		}
		signal.throwIfAborted();
		this.event(task, { type: "diagnostic", message: "结构化结果未通过校验，执行器将重新整理一次输出。" });
		task.output = "";
		task.truncated = false;
		if (runtime.usage) (runtime.usageAttempts ??= []).push(runtime.usage);
		runtime.usage = undefined;
		const retry = await run(`The previous result was not valid for the requested JSON Schema. Reformat your existing answer only. Do not repeat tools or edits.\n\n${instruction}`);
		if (retry.status !== "completed") return retry;
		try { return { ...retry, structuredOutput: validateAgentOutput(outputSchema, parseAgentOutputText(retry.text)) }; }
		catch { throw new Error("The external executor returned invalid structured output after one retry."); }
	}

	private recordUsage(record: StoredTask, reports: NonNullable<Runtime["usage"]>[], resumed: boolean, failed: boolean): void {
		const totals = record.usage ??= { costUsd: 0, days: {} };
		const usage: ExternalUsage = {};
		for (const report of reports) {
			for (const key of tokenFields) {
				const total = usageNumber(report.sessionTokens?.[key]);
				const previous = totals.observedTokens?.[key];
				if (failed && total === 0 && !report[key]) continue;
				const count = total === undefined || (previous === undefined && resumed)
					? usageNumber(report[key]) : total - (previous !== undefined && total >= previous ? previous : 0);
				if (total !== undefined) (totals.observedTokens ??= {})[key] = total;
				if (count !== undefined) usage[key] = (usage[key] ?? 0) + count;
			}
			const cost = usageNumber(report.sessionCostUsd);
			const previous = totals.observedCostUsd;
			if (failed && cost === 0 && report.costUsd === undefined) continue;
			// For a resumed session whose baseline predates the app, do not charge historical usage.
			const delta = usageNumber(report.costUsd) ?? (cost === undefined || (previous === undefined && resumed)
				? undefined : cost - (previous !== undefined && cost >= previous ? previous : 0));
			if (cost !== undefined) totals.observedCostUsd = cost;
			if (delta !== undefined) usage.costUsd = (usage.costUsd ?? 0) + delta;
		}
		if (!Object.keys(usage).length) return;
		record.task.usage = usage;
		this.event(record.task, { type: "usage", ...usage });
		totals.costUsd += usage.costUsd ?? 0;
		const day = localDay(Date.now());
		const entry = totals.days[day] ??= { input: 0, output: 0, cost: 0, turns: 0 };
		entry.input += usage.inputTokens ?? 0;
		entry.output += usage.outputTokens ?? 0;
		entry.cacheRead = (entry.cacheRead ?? 0) + (usage.cachedInputTokens ?? 0);
		entry.cacheWrite = (entry.cacheWrite ?? 0) + (usage.cacheWriteTokens ?? 0);
		entry.cost += usage.costUsd ?? 0;
		entry.turns++;
		for (const key of Object.keys(totals.days).sort().slice(0, -365)) delete totals.days[key];
	}

	private async permission(record: StoredTask, runtime: Runtime, request: ExternalApprovalRequest, signal?: AbortSignal): Promise<ExternalApprovalResponse> {
		const task = record.task;
		if (runtime.abort?.signal.aborted || signal?.aborted || this.closed || !active.has(task.status)) return { decision: "cancel" };
		if (request.kind !== "question") {
			const policy = this.policyFor(record);
			const decision = await evaluatePermission(policy, normalizeCall(request));
			if (runtime.abort?.signal.aborted || signal?.aborted || this.closed || !active.has(task.status)) return { decision: "cancel" };
			// dontAsk never surfaces an approval prompt; anything not pre-approved is denied.
			if (decision.action === "deny" || (decision.action === "ask" && policy.dontAsk)) return { decision: "deny" };
			if (decision.action === "allow") return { decision: "allow" };
			if (runtime.sessionGrants?.size && canRemember(request) && runtime.sessionGrants.has(permissionFingerprint(request)))
				return { decision: "allow", optionId: request.options?.find((option) => option.kind === "allow_once")?.id };
		}
		const id = randomUUID();
		const pending = { ...structuredClone(request), id };
		const cancelled = () => { this.resolveApproval(task, runtime, id, { decision: "cancel" }); };
		return new Promise<ExternalApprovalResponse>((resolve) => {
			runtime.approvals.set(id, { request: pending, resolve }); task.pendingApprovals.push(pending);
			this.update(task, "waiting_for_input"); this.event(task, { type: "approval", request: pending });
			void this.persist().catch((error) => runtime.abort?.abort(error));
			signal?.addEventListener("abort", cancelled, { once: true });
			if (signal?.aborted) cancelled();
		}).finally(() => signal?.removeEventListener("abort", cancelled));
	}
	private resolveApproval(task: ExternalTask, runtime: Runtime, id: string, response: ExternalApprovalResponse): void {
		const pending = runtime.approvals.get(id); if (!pending) return;
		runtime.approvals.delete(id); task.pendingApprovals = task.pendingApprovals.filter((item) => item.id !== id);
		this.event(task, { type: "approval_resolved", id });
		const status = !task.pendingApprovals.length && task.status === "waiting_for_input" ? "running" : task.status;
		this.update(task, status, task.error);
		pending.resolve(response);
	}
	private clearApprovals(task: ExternalTask, runtime?: Runtime): void {
		for (const id of [...runtime?.approvals.keys() ?? []]) this.resolveApproval(task, runtime!, id, { decision: "cancel" });
		task.pendingApprovals = [];
	}
	private policyFor(record: StoredTask): RuntimePermissionPolicy {
		const task = record.task; const current = this.options.policy(task.parentConversationId);
		const unique = new Map<string, PermissionRule>();
		for (const source of [record.policy, current]) for (const rule of source.rules) {
			const mapped = rule.path && isAbsolute(rule.path) && contains(source.project, rule.path)
				? { ...rule, path: join(task.workingDirectory, relative(source.project, rule.path)) } : rule;
			unique.set(JSON.stringify(mapped), mapped);
		}
		const rules = [...unique.values()].map((rule, index) => ({ ...rule, id: `external-${index}-${rule.id.slice(0, 150)}` }));
		const modes = [record.policy.mode, current.mode];
		if (task.readOnly && (task.subagentType !== "general-purpose" || record.policy.mode !== "plan")) modes.push("read");
		const mode = policyModesByRestriction.find((candidate) => modes.includes(candidate)) ?? "read";
		return { version: 1, project: task.workingDirectory, mode,
			...(record.policy.dontAsk || current.dontAsk ? { dontAsk: true } : {}),
			...(record.policy.sandbox || current.sandbox ? { sandbox: true } : {}),
			rules, disabledTools: [...new Set([...record.policy.disabledTools, ...current.disabledTools, "Agent", "SendMessage", "AgentSend"])] };
	}
	private adapterEvent(task: ExternalTask, event: ExternalAdapterEvent): void {
		if (event.type === "usage") this.runtime(task.id).usage = event;
		if (event.type === "session") {
			task.nativeSessionId = event.sessionId;
			void this.persist().catch(() => this.runtimes.get(task.id)?.abort?.abort(new Error("无法保存原生会话标识。")));
		}
		if (event.type === "text_delta") {
			const text = task.output + event.text; task.output = text.slice(0, outputLimit); task.truncated ||= text.length > outputLimit;
		}
		this.event(task, event);
	}
	private update(task: ExternalTask, status: ExternalTask["status"], error?: string): void {
		task.status = status; task.error = error; task.updatedAt = Date.now(); task.revision++;
		this.event(task, { type: "task_updated", task: structuredClone(task) }); this.options.onActivityChange();
	}
	private event(task: ExternalTask, event: ExternalEvent["event"]): void {
		const runtime = this.runtime(task.id);
		const packet: ExternalEvent = { taskId: task.id, executor: task.executor, parentConversationId: task.parentConversationId,
			sequence: ++task.eventSequence, turn: task.turn, timestamp: Date.now(), event };
		let line = JSON.stringify(packet);
		if (Buffer.byteLength(line) > 256 * 1024) { packet.event = { type: "diagnostic", message: "此事件超过 256 KiB，已省略；结果可从原生会话查询。" }; line = JSON.stringify(packet); }
		runtime.events.push(packet); while (runtime.events.length > 2000 || Buffer.byteLength(JSON.stringify(runtime.events)) > 4 * 1024 * 1024) runtime.events.shift();
		const payload = `${line}\n`; runtime.logBytes += Buffer.byteLength(payload);
		const rotate = runtime.logBytes > 8 * 1024 * 1024;
		if (rotate) runtime.logBytes = Buffer.byteLength(payload);
		runtime.logWrites = runtime.logWrites.catch(() => {}).then(() => rotate
			? writeFile(join(this.options.dataDir, "external-events", `${task.id}.jsonl`), payload, { mode: 0o600 })
			: appendFile(join(this.options.dataDir, "external-events", `${task.id}.jsonl`), payload, { mode: 0o600 })).catch((error) => {
			runtime.abort?.abort(error);
		});
		for (const listener of this.listeners) listener(structuredClone(packet));
	}
	private runtime(id: string): Runtime {
		let runtime = this.runtimes.get(id);
		if (!runtime) { runtime = { events: [], logBytes: 0, logWrites: Promise.resolve(), approvals: new Map() }; this.runtimes.set(id, runtime); }
		return runtime;
	}
	private record(id: string, owner?: string): StoredTask {
		const record = this.tasks.get(id);
		if (!record || owner && record.task.parentConversationId !== owner) throw new Error("此会话没有该外部子任务。");
		return record;
	}
	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const promise = this.operation.then(() => { if (this.closed) throw new Error("外部执行器已关闭。"); return action(); });
		this.operation = promise.then(() => {}, () => {}); return promise;
	}
	private persist(): Promise<void> {
		const body = JSON.stringify({ version: 1, settings: this.settings, verified: Object.fromEntries(this.verified), tasks: [...this.tasks.values()] });
		this.persistence = this.persistence.catch(() => {}).then(async () => {
			const target = join(this.options.dataDir, "external-agents.json");
			await writeFile(`${target}.tmp`, body, { mode: 0o600 }); await rename(`${target}.tmp`, target);
		}); return this.persistence;
	}
}

function usageNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const tokenFields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens"] as const;

function validatedTurnUsage(value: unknown): ExternalUsage | undefined {
	if (!value || typeof value !== "object") return;
	const input = value as ExternalUsage;
	const usage: ExternalUsage = {};
	for (const key of [...tokenFields, "costUsd"] as const) {
		const count = usageNumber(input[key]);
		if (count !== undefined) usage[key] = count;
	}
	if (Object.keys(usage).length) return usage;
}

function validatedUsage(value: unknown): StoredNativeUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<StoredNativeUsage>;
	const costUsd = usageNumber(candidate.costUsd);
	if (costUsd === undefined || !candidate.days || typeof candidate.days !== "object" || Array.isArray(candidate.days)) return undefined;
	const days: StoredNativeUsage["days"] = {};
	for (const [day, entry] of Object.entries(candidate.days).slice(-365)) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entry || typeof entry !== "object") continue;
		const input = usageNumber(entry.input), output = usageNumber(entry.output), cost = usageNumber(entry.cost), turns = usageNumber(entry.turns);
		if (input !== undefined && output !== undefined && cost !== undefined && turns)
			days[day] = { input, output, cost, turns, cacheRead: usageNumber(entry.cacheRead), cacheWrite: usageNumber(entry.cacheWrite) };
	}
	return { costUsd, observedCostUsd: usageNumber(candidate.observedCostUsd), observedTokens: validatedTurnUsage(candidate.observedTokens), days };
}

function validatePrompt(value: string): void { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 2 * 1024 * 1024 || value.includes("\0")) throw new Error("外部任务指令无效。"); }
function validateDescription(value: string): void { if (typeof value !== "string" || !value.trim() || exceedsLength(value, 160) || value.includes("\0")) throw new Error("外部任务名称无效。"); }
function contains(root: string, path: string): boolean { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); }
function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }
function shouldNotify({ task, notify, notifiedTurn, stopReason }: StoredTask): boolean {
	return notify && notifiedTurn !== task.turn && (["completed", "failed"].includes(task.status) ||
		(["cancelled", "interrupted"].includes(task.status) && stopReason !== undefined && !silentStops.has(stopReason)));
}

function storedFollowUps(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.length || value.length > maxPendingMessages || value.some((item) => typeof item !== "string")) return;
	try { validatePrompt(value.join("\n\n")); return value as string[]; }
	catch { return undefined; }
}

function storedNotifications(value: unknown, task: ExternalTask, schema?: AgentOutputSchema): ExternalNotification[] | undefined {
	if (!Array.isArray(value) || value.length > maxUndeliveredResults) return;
	return value.flatMap((entry: ExternalNotification) => {
		const old = entry?.task;
		if (!old || old.id !== task.id || !Number.isSafeInteger(old.turn) || old.turn < 1 || old.turn >= task.turn ||
			!["completed", "failed", "cancelled", "interrupted"].includes(old.status) ||
			typeof old.output !== "string" || old.output.length > outputLimit || !Number.isFinite(old.updatedAt)) return [];
		let structuredOutput: ExternalTask["structuredOutput"];
		if (schema && old.structuredOutput !== undefined) {
			try { structuredOutput = validateAgentOutput(schema, old.structuredOutput); } catch { structuredOutput = undefined; }
		}
		return [{
			task: {
				...task, turn: old.turn, status: old.status, updatedAt: old.updatedAt, output: old.output,
				truncated: old.truncated === true, error: typeof old.error === "string" ? old.error.slice(0, 8000) : undefined,
				pendingApprovals: [], pendingMessages: undefined, changes: validatedChanges(old.changes), usage: validatedTurnUsage(old.usage), structuredOutput,
			},
			stopReason: entry.stopReason && stopReasons.includes(entry.stopReason) ? entry.stopReason : undefined,
		}];
	});
}

function canRemember(request: ExternalApprovalRequest): boolean {
	return request.kind !== "question" && request.kind !== "permissions" &&
		Object.keys(request.input).length > 0 &&
		(!request.options?.length || request.options.some((option) => option.kind === "allow_once"));
}

function permissionFingerprint(request: ExternalApprovalRequest): string {
	return createHash("sha256").update(JSON.stringify([request.kind, request.toolName, request.input])).digest("hex");
}

function normalizeCall(request: ExternalApprovalRequest) {
	const names: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", Bash: "bash", Shell: "bash", Grep: "grep", Glob: "find", List: "ls", LS: "ls" };
	return { toolName: names[request.toolName] ?? request.toolName, input: { ...request.input, ...(typeof request.input.file_path === "string" ? { path: request.input.file_path } : {}) } };
}

const changeStatuses = new Set(["added", "modified", "deleted", "type-changed"]);
/** A stored change summary, or undefined when it is malformed. */
function validatedChanges(value: unknown): ExternalChangeSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const count = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
	if (!Array.isArray(input.files) || input.files.length > MAX_SUMMARY_FILES || typeof input.truncated !== "boolean" || !count(input.additions) || !count(input.deletions)) return undefined;
	const files = input.files.filter((file): file is ExternalChangeSummary["files"][number] => Boolean(file) && typeof file === "object" &&
		typeof file.path === "string" && file.path.length <= 4096 && changeStatuses.has(file.status) &&
		(file.binary === undefined || typeof file.binary === "boolean") &&
		(file.additions === undefined || count(file.additions)) && (file.deletions === undefined || count(file.deletions)));
	if (files.length !== input.files.length) return undefined;
	return {
		files: files.map(({ path, status, binary, additions, deletions }) => ({ path, status, binary, additions, deletions })),
		truncated: input.truncated, additions: input.additions as number, deletions: input.deletions as number,
		...(typeof input.patch === "string" && Buffer.byteLength(input.patch) <= MAX_INLINE_PATCH_BYTES ? { patch: input.patch } : {}),
		...(typeof input.fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.fingerprint) ? { fingerprint: input.fingerprint } : {}),
		...(typeof input.checkpointId === "string" && input.checkpointId.length <= 200 ? { checkpointId: input.checkpointId } : {}) };
}
