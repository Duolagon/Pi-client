import { isAbsolute, relative, sep } from "node:path";
import type { DesktopTask, TaskRunStats, TaskStopReason } from "./task-types.ts";
import type { AgentDefinition } from "./agent-types.ts";
import type { WorktreeInfo } from "./worktree-types.ts";
import {
	AGENT_CALL_NAME_PATTERN, DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_MAX_SUBAGENT_DEPTH, MAX_AGENT_OUTPUT, MAX_AGENT_PROMPT, MAX_AGENT_SYSTEM_PROMPT,
	MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS, MAX_SEND_MESSAGE,
	MAX_SEND_SUMMARY, MAX_SEND_TARGET, exceedsLength,
} from "./delegation-limits.ts";
import { formatAgentToolText } from "./delegation-format.ts";
import {
	agentCallModels,
	type AgentCallModel,
	type AgentToolInput,
	type DelegationCallbacks,
	type DelegationContext,
	type DelegatedTaskResult,
	type ModelToolResult,
	type SendMessageInput,
	type TaskOutputInput,
	type ToolUsage,
} from "./delegation-types.ts";

const activeStatuses = new Set(["queued", "running", "waiting_for_input"]);
/** Built-in agent types with native one-shot semantics: SendMessage cannot continue them. */
const oneShotTypes = new Set(["Explore", "Plan"]);

/** Host authority for model-created tasks. The model never supplies its owner or source project. */
export class ModelDelegation {
	private callbacks: DelegationCallbacks;
	private spawning: Promise<void> = Promise.resolve();
	private disposed = new AbortController();

	constructor(callbacks: DelegationCallbacks) {
		this.callbacks = callbacks;
	}

	async handle(context: DelegationContext, tool: string, value: unknown): Promise<unknown> {
		this.checkAbort(context.signal);
		if (!context.conversationId || !context.toolCallId) throw new Error("Invalid delegation context");
		const input = object(value);
		switch (tool) {
			case "Agent":
				return this.agent(context, parseAgent(input));
			case "SendMessage":
				return this.sendMessage(context, parseSend(input));
			case "AgentSend": {
				// Legacy alias: `task_id` is the agentId; it keeps its foreground default.
				only(input, ["task_id", "message", "run_in_background"]);
				return this.sendMessage(context, parseSend({ to: input.task_id, message: input.message, run_in_background: input.run_in_background }), { legacy: true });
			}
			case "TaskOutput": {
				const parsed = parseOutput(input);
				const task = await this.resolveTarget(context.conversationId, parsed.task_id);
				return this.result(context.conversationId, { ...parsed, task_id: task.id }, context.signal);
			}
			case "TaskStop": {
				only(input, ["task_id"]);
				const task = await this.resolveTarget(context.conversationId, text(input.task_id, "task_id", 200));
				// The child records its result only after it settles, which is after cancelTask
				// returns. Read the live output first so the stop result is not empty.
				const live = activeStatuses.has(task.status) ? await this.callbacks.peekOutput?.(task.id).catch(() => undefined) : undefined;
				await this.callbacks.cancelTask(task.id, "model_stop");
				const result = await this.result(context.conversationId, { task_id: task.id }, context.signal);
				if (result.output || !live) return result;
				return { ...result, output: live.slice(0, MAX_AGENT_OUTPUT), truncated: result.truncated || live.length > MAX_AGENT_OUTPUT };
			}
			case "TaskList": {
				only(input, []);
				const tasks = (await this.callbacks.listTasks()).filter((task) => task.parentConversationId === context.conversationId);
				return {
					tasks: tasks.slice(0, 128).map((task) => ({
						task_id: task.id,
						description: task.title,
						status: task.status,
						subagent_type: task.subagentType,
						worktree_id: task.worktreeId,
						read_only: Boolean(task.readOnly),
						parent_tool_call_id: task.parentToolCallId,
						turn: task.turn ?? 1,
						...(task.name ? { name: task.name } : {}),
						...(!activeStatuses.has(task.status) && task.stats ? { usage: runUsage(task.stats) } : {}),
					})),
					truncated: tasks.length > 128,
				};
			}
			case "WorktreeCreate": {
				only(input, ["base_ref"]);
				await this.assertRootForWorktree(context.conversationId);
				const owner = await this.callbacks.getConversation(context.conversationId);
				return this.callbacks.createWorktree({
					project: owner.project,
					conversationId: owner.id,
					baseRef: input.base_ref === undefined ? undefined : text(input.base_ref, "base_ref", 1000),
				});
			}
			case "WorktreeList": {
				only(input, []);
				return { worktrees: await this.ownedWorktrees(context.conversationId) };
			}
			case "WorktreeMerge":
			case "WorktreeRemove": {
				only(input, ["worktree_id"]);
				await this.assertRootForWorktree(context.conversationId);
				const id = text(input.worktree_id, "worktree_id", 200);
				await this.ownedWorktree(context.conversationId, id);
				return tool === "WorktreeMerge" ? this.callbacks.mergeWorktree(id, context.conversationId, context.toolCallId) : this.callbacks.removeWorktree(id, context.conversationId, context.toolCallId);
			}
			default:
				throw new Error(`Unsupported desktop model tool: ${tool}`);
		}
	}

	/** Retrieve a child result without exposing any unrelated conversation or task. */
	async result(owner: string, input: TaskOutputInput, signal?: AbortSignal): Promise<DelegatedTaskResult> {
		const timeout = input.block ? input.timeout ?? 60000 : 0;
		if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("timeout must be 0–60000 ms");
		let task = await this.ownedTask(owner, input.task_id);
		if (input.block && settledForReader(task) === false && timeout > 0) {
			// Woken by the host's task-update path; no timer polls the child.
			await this.callbacks.waitForTask(task.id, (item) => settledForReader(item), this.signal(signal), timeout);
			task = await this.ownedTask(owner, input.task_id);
		}
		this.checkAbort(signal);
		// Reading a result is side-effect free: it never starts, wakes or waits on a child runtime.
		// An active task reports its live output; the stored result belongs to a finished run.
		const terminal = !activeStatuses.has(task.status);
		const live = terminal ? undefined : await this.callbacks.peekOutput?.(task.id);
		const stored = live === undefined ? task.result : undefined;
		const output = live ?? stored?.text ?? "";
		const pending = terminal ? 0 : ((await this.callbacks.pendingApprovalCount?.(task.id)) ?? 0);
		return {
			task_id: task.id,
			conversation_id: task.conversationId,
			parent_conversation_id: owner,
			parent_tool_call_id: task.parentToolCallId!,
			status: task.status,
			description: task.title,
			subagent_type: task.subagentType!,
			read_only: Boolean(task.readOnly),
			worktree_id: task.worktreeId,
			working_directory: task.workingDirectory,
			output: output.slice(0, MAX_AGENT_OUTPUT),
			truncated: Boolean(stored?.truncated) || output.length > MAX_AGENT_OUTPUT,
			...(terminal && task.result?.partial ? { partial: true as const } : {}),
			error: task.error,
			pending_approvals: pending,
			...(task.name ? { name: task.name } : {}),
			...(terminal && task.stats ? { usage: runUsage(task.stats) } : {}),
		};
	}

	/**
	 * Cancel a parent's model-created children, preserving independent manual tasks.
	 * `foregroundOnly` is the parent's Esc: background children keep running and still
	 * report back; `backgroundOnly` is the user's explicit "stop all background agents".
	 */
	async cancelChildren(owner: string, options: { foregroundOnly?: boolean; backgroundOnly?: boolean; reason?: TaskStopReason } = {}): Promise<DesktopTask[]> {
		const tasks = await this.callbacks.listTasks();
		const targets: DesktopTask[] = [];
		const visited = new Set<string>([owner]);
		const collect = (parentId: string) => {
			for (const task of tasks) {
				if (task.parentConversationId !== parentId || visited.has(task.conversationId)) continue;
				visited.add(task.conversationId);
				const active = activeStatuses.has(task.status);
				if (options.foregroundOnly) {
					if (active && !task.runInBackground) targets.push(task);
					else if (!active) collect(task.conversationId);
					continue;
				}
				if (options.backgroundOnly) {
					if (active && task.runInBackground) targets.push(task);
					else collect(task.conversationId);
					continue;
				}
				if (active) targets.push(task);
				else collect(task.conversationId);
			}
		};
		collect(owner);
		return Promise.all(targets.map((task) => this.callbacks.cancelTask(task.id, options.reason ?? "parent_abort")));
	}

	/** Called after a persisted task transition; hands delivery to the host's outbox without blocking it. */
	observeTask(task: DesktopTask): void {
		if (!task.parentConversationId || activeStatuses.has(task.status) || this.disposed.signal.aborted) return;
		if (task.runInBackground) void Promise.resolve(this.callbacks.flushNotifications?.(task.parentConversationId)).catch(() => {});
	}

	dispose(): void {
		this.disposed.abort();
	}

	private async agent(context: DelegationContext, input: AgentToolInput): Promise<ModelToolResult<DelegatedTaskResult>> {
		const teamsEnabled = (await this.callbacks.teamsEnabled?.()) === true;
		const effectiveIgnored = (input.ignored ?? []).filter((name) => !(name === "team_name" && teamsEnabled));
		const warnings = effectiveIgnored.map((name) => `Parameter '${name}' is not supported by this client and was ignored.`);
		const teamName = teamsEnabled ? input.team_name : undefined;
		// "fork" (or the legacy fork flag) forks this conversation into a general-purpose child.
		const fork = input.fork === true || input.subagent_type === "fork";
		const isNativeFork = input.subagent_type === "fork";
		const typeName = input.subagent_type === "fork" ? "general-purpose" : input.subagent_type;
		if (fork && (await this.callbacks.forkSubagentEnabled?.()) === false)
			throw new Error("Fork subagents are disabled in settings (forkSubagent).");
		// A fork child itself cannot fork or spawn again: prevent infinite recursion.
		const owner = await this.callbacks.getConversation(context.conversationId);
		if (owner.origin === "fork") throw new Error("Forked agents cannot fork or spawn agents");
		if (fork && input.model) warnings.push("A fork keeps this conversation's model; 'model' was ignored.");
		// A narrow lock makes the per-parent cap and tool-call idempotency atomic.
		const spawn = this.spawning.then(async () => {
			this.checkAbort(context.signal);
			const { depth: currentDepth, nextDepth, readOnlyParent } = await this.assertCanDelegate(context.conversationId);
			const tasks = await this.callbacks.listTasks();
			const previous = tasks.find(
				(task) => task.parentConversationId === context.conversationId && task.parentToolCallId === context.toolCallId,
			);
			if (previous) return { task: previous, sharedWriter: !previous.readOnly && !previous.worktreeId };
			const rawCap = (await this.callbacks.maxConcurrentSubagents?.()) ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
			const maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS_LIMIT, Number.isFinite(rawCap) ? Math.floor(rawCap) : DEFAULT_MAX_CONCURRENT_SUBAGENTS));
			if (tasks.filter((task) => task.parentConversationId === context.conversationId && activeStatuses.has(task.status)).length >= maxConcurrent) {
				throw new Error(
					`Concurrent subagent limit reached. You can run ${maxConcurrent} subagents at once. Do not retry; wait for a running agent to finish.`,
				);
			}
			if (input.name && tasks.some((task) => task.parentConversationId === context.conversationId && task.name === input.name && activeStatuses.has(task.status)))
				throw new Error(`An active subagent named '${input.name}' already exists in this conversation; choose another name`);
			const owner = await this.callbacks.getConversation(context.conversationId);
			const definition = await this.resolveAgent(owner.project, typeName);
			const readOnly = definition?.readOnly ?? typeName !== "general-purpose";
			if (readOnlyParent && !readOnly)
				throw new Error("Read-only subagents cannot spawn writable subagents; use Explore, Plan, or a read-only agent");
			if ((await this.callbacks.isPlanMode?.(owner.id)) && !readOnly)
				throw new Error("Plan 模式下仅允许委派 Explore / Plan 等只读子 Agent。");
			const selection = await this.callbacks.getSelection(owner.id);
			// Model precedence: the call's alias, then the definition, then the parent's selection.
			const model = fork ? selection.model : await this.resolveModel(owner.id, input.model, definition, selection.model);
			const git = await this.callbacks.isGit(owner.project);
			const isolation = input.isolation ?? definition?.isolation ?? (readOnly ? "shared" : git ? "worktree" : "shared");
			if (input.worktree_id) await this.ownedWorktree(owner.id, input.worktree_id);
			if (input.worktree_id && isolation === "shared") throw new Error("An existing worktree requires worktree isolation");
			const explicitBackground = input.run_in_background ?? definition?.background;
			const sharedWriter = !readOnly && isolation === "shared";
			// Native `subagent_type: "fork"` forces background when isolated/git-backed (not sharedWriter).
			// Nested delegators (depth >= 1) default to foreground so the subagent collects its child's result directly.
			// Writable shared work defaults to foreground: the parent waits on this call so the two do not race.
			const defaultBg = currentDepth >= 1 ? false : ((await this.callbacks.defaultBackground?.()) ?? true);
			const runInBackground = isNativeFork && !sharedWriter
				? true
				: (explicitBackground ?? (sharedWriter ? false : defaultBg));
			if (!readOnly && isolation === "worktree" && (await this.callbacks.confineSubagentBash?.()) !== false) {
				const seatbelt = await this.callbacks.seatbeltSupport?.();
				if (seatbelt && !seatbelt.supported) {
					warnings.push(`Subagent Bash sandbox confinement (confineSubagentBash) is unavailable on this platform: ${seatbelt.reason ?? "Seatbelt unsupported"}`);
				}
			}
			if (sharedWriter && runInBackground)
				throw new Error(
					"A background writable subagent cannot run alongside this parent in a shared directory; set run_in_background:false, or use worktree isolation in a Git repository",
				);
			if (isolation === "shared" && !(await this.callbacks.canRunShared?.(owner.id, readOnly, !runInBackground)))
				throw new Error(
					git
						? "Shared subagent work cannot run alongside this parent; choose worktree isolation or a read-only Explore/Plan agent"
						: "Shared subagent work cannot run alongside this parent; set run_in_background:false or use a read-only Explore/Plan agent",
				);
			// The parent waits on this call, but tool calls of the same message run in parallel
			// with it: a sibling write, edit or bash would change the shared directory meanwhile.
			if (sharedWriter && (context.batch?.writers ?? 0) > 0)
				throw new Error(
					"A writable subagent in this shared directory must be the only file-changing tool call in its message; call Agent again on its own, or use a read-only Explore/Plan agent",
				);
			// The definition body, preloaded skills and memory become the child's system prompt;
			// the first user message carries only the task. A plain fork keeps the parent's prompt.
			const extraContext = definition && definition.scope !== "builtin" && this.callbacks.prepareAgentContext
				? await this.callbacks.prepareAgentContext(owner.project, definition)
				: undefined;
			this.checkAbort(context.signal);
			const systemPrompt = fork && definition?.scope === "builtin"
				? ""
				: [definition?.prompt?.trim(), extraContext?.trim()].filter(Boolean).join("\n\n---\n\n");
			if (exceedsLength(systemPrompt, MAX_AGENT_SYSTEM_PROMPT)) throw new Error("The agent definition, skills and memory are too large");
			const task = await this.callbacks.startTask(
				{
					project: owner.project,
					message: input.prompt,
					title: input.description,
					isolation,
					worktreeId: input.worktree_id,
					model,
					thinkingLevel: fork ? selection.thinkingLevel : (definition?.thinkingLevel ?? selection.thinkingLevel),
					...(definition?.tools ? { allowedTools: definition.tools } : {}),
					...(definition?.disallowedTools?.length ? { disallowedTools: definition.disallowedTools } : {}),
					...(definition?.permissionMode ? { permissionMode: definition.permissionMode } : {}),
					...(definition?.maxTurns ? { maxTurns: definition.maxTurns } : {}),
					...(definition?.omitClaudeMd ? { omitClaudeMd: true } : {}),
					...(definition?.mcpServers ? { mcpServers: definition.mcpServers } : {}),
					...(fork ? { forkParentConversationId: owner.id, isFork: true } : {}),
					...(systemPrompt ? { systemPrompt } : {}),
				},
				{
					parentConversationId: owner.id,
					parentToolCallId: context.toolCallId,
					subagentType: definition?.name ?? typeName,
					delegationDepth: nextDepth,
					readOnly,
					runInBackground,
					...(input.name ? { name: input.name } : {}),
					...(teamName ? { teamName } : {}),
				},
			);
			return { task, sharedWriter };
		});
		this.spawning = spawn.then(() => {}, () => {});
		const { task, sharedWriter } = await spawn;
		if (context.signal?.aborted) {
			await this.callbacks.cancelTask(task.id, "parent_abort");
			context.signal.throwIfAborted();
		}
		// Background results reach the parent through the host's persisted outbox.
		if (task.runInBackground) {
			const launched = await this.result(context.conversationId, { task_id: task.id });
			return this.toolResult({ ...launched, ...(warnings.length ? { warnings } : {}) }, { launched: true });
		}
		const waited = await this.waitForeground(context, task.id, sharedWriter);
		return this.toolResult({ ...waited.result, ...(warnings.length ? { warnings } : {}) }, { backgroundedByUser: waited.backgroundedByUser });
	}

	/** Move a foreground child to background delivery; its foreground waiter returns immediately. */
	async detach(taskId: string): Promise<void> {
		await this.callbacks.detachTask?.(taskId);
	}

	/**
	 * Wait for a foreground child. A shared writer keeps the parent waiting until it ends,
	 * through approvals too, so the two never write the same directory at once. Other
	 * children are handed to background delivery once the configured wait has passed, the
	 * user moves them to the background (Ctrl+B), or they wait for an approval. The parent's
	 * abort stops the child it waits for.
	 */
	private async waitForeground(
		context: DelegationContext,
		taskId: string,
		sharedWriter: boolean,
	): Promise<{ result: DelegatedTaskResult; backgroundedByUser: boolean }> {
		const unsubProgress = context.onProgress ? this.callbacks.subscribeTaskProgress?.(taskId, context.onProgress) : undefined;
		try {
			const limit = sharedWriter ? 0 : await this.foregroundLimit();
			const started = Date.now();
			let result: DelegatedTaskResult;
			let backgroundedByUser = false;
			for (;;) {
				await this.callbacks.waitForTask(
					taskId,
					sharedWriter ? (item) => !activeStatuses.has(item.status) : (item) => !activeStatuses.has(item.status) || Boolean(item.runInBackground),
					this.signal(context.signal),
					60000,
				);
				this.checkAbort(context.signal);
				const current = (await this.callbacks.listTasks()).find((item) => item.id === taskId);
				result = await this.result(context.conversationId, { task_id: taskId }, context.signal);
				if (!activeStatuses.has(result.status)) break;
				if (!sharedWriter && current?.runInBackground) {
					backgroundedByUser = this.callbacks.isUserBackgrounded?.(taskId) ?? true;
					break;
				}
				if (limit > 0 && Date.now() - started >= limit) break;
			}
			// The parent stops waiting; the child now reports back like a background agent.
			if (activeStatuses.has(result.status) && !backgroundedByUser) await this.callbacks.detachTask?.(taskId);
			return { result, backgroundedByUser };
		} catch (error) {
			if (context.signal?.aborted) await this.callbacks.cancelTask(taskId, "parent_abort");
			throw error;
		} finally {
			unsubProgress?.();
		}
	}

	/**
	 * SendMessage: continue one of this parent's own children by agentId or name. A running
	 * child is steered; a finished, stopped or interrupted one starts its next run with its
	 * whole history. The child keeps its permission ceiling, tools and maxTurns.
	 */
	private async sendMessage(context: DelegationContext, input: SendMessageInput, options: { legacy?: boolean } = {}): Promise<ModelToolResult<DelegatedTaskResult>> {
		if (!this.callbacks.resumeTask) throw new Error("SendMessage is not available in this client");
		// The same lock as Agent: the replay check and the resume are one atomic step.
		const send = this.spawning.then(async () => {
			this.checkAbort(context.signal);
			const { depth: currentDepth, readOnlyParent } = await this.assertCanDelegate(context.conversationId);
			const task = await this.resolveTarget(context.conversationId, input.to);
			if (readOnlyParent && !task.readOnly)
				throw new Error("Read-only subagents cannot continue writable subagents");
			const sharedWriter = !task.readOnly && !task.worktreeId;
			if (task.turnCalls?.includes(context.toolCallId)) return { task, sharedWriter, delivered: false };
			if (task.quarantined) throw new Error("This agent's record is damaged and it cannot be continued; launch a new Agent instead");
			if (task.subagentType && oneShotTypes.has(task.subagentType))
				throw new Error(`${task.subagentType} agents are one-shot and cannot be continued; launch a new Agent instead`);
			const running = activeStatuses.has(task.status);
			if (!running && !task.readOnly && (await this.callbacks.isPlanMode?.(context.conversationId)))
				throw new Error("Plan 模式下不能继续可写的子 Agent。");
			// A writable child sharing the parent's directory runs only while the parent waits on it.
			const defaultBg = currentDepth >= 1 ? false : ((await this.callbacks.defaultBackground?.()) ?? true);
			const background = input.run_in_background ?? (options.legacy || sharedWriter ? false : defaultBg);
			if (!running && sharedWriter) {
				if (background)
					throw new Error(
						"A background writable subagent cannot run alongside this parent in a shared directory; set run_in_background:false, or launch a new agent with worktree isolation",
					);
				if (!(await this.callbacks.canRunShared?.(context.conversationId, false, true)))
					throw new Error("Shared subagent work cannot run alongside this parent; launch a new agent with worktree isolation");
				if ((context.batch?.writers ?? 0) > 0)
					throw new Error("A writable subagent in this shared directory must be the only file-changing tool call in its message; call SendMessage again on its own");
			}
			this.checkAbort(context.signal);
			const sent = await this.callbacks.resumeTask!(task.id, input.message, { source: "model", background, toolCallId: context.toolCallId });
			return { task: sent.task, sharedWriter, delivered: sent.status === "delivered_to_running_agent" };
		});
		this.spawning = send.then(() => {}, () => {});
		const { task, sharedWriter, delivered } = await send;
		if (delivered) return this.toolResult(await this.result(context.conversationId, { task_id: task.id }), { delivered: true });
		// A replayed call of a turn that has already finished returns that turn's result.
		if (!activeStatuses.has(task.status)) return this.toolResult(await this.result(context.conversationId, { task_id: task.id }));
		if (task.runInBackground) return this.toolResult(await this.result(context.conversationId, { task_id: task.id }), { resumed: true });
		const waited = await this.waitForeground(context, task.id, sharedWriter);
		return this.toolResult(waited.result, { backgroundedByUser: waited.backgroundedByUser });
	}

	/** Shape a child result as the native Agent tool result; usage is counted into the parent. */
	private async toolResult(result: DelegatedTaskResult, options: { launched?: boolean; resumed?: boolean; delivered?: boolean; backgroundedByUser?: boolean } = {}): Promise<ModelToolResult<DelegatedTaskResult>> {
		const tree = result.worktree_id ? (await this.callbacks.listWorktrees().catch(() => [])).find((item) => item.id === result.worktree_id) : undefined;
		const text = formatAgentToolText(result, {
			launched: options.launched,
			resumed: options.resumed,
			delivered: options.delivered,
			backgroundedByUser: options.backgroundedByUser,
			...(result.worktree_id ? { worktree: { path: result.working_directory, branch: tree?.branch, baseRef: tree?.baseRef } } : {}),
		});
		const task = options.launched || options.resumed || options.delivered || activeStatuses.has(result.status) ? undefined : (await this.callbacks.listTasks()).find((item) => item.id === result.task_id);
		const usage = task?.stats ? runToolUsage(task.stats) : undefined;
		return { kind: "desktop_tool_result", text, details: result, ...(usage ? { usage } : {}) };
	}

	private async foregroundLimit(): Promise<number> {
		const value = (await this.callbacks.foregroundTimeoutMs?.()) ?? DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS;
		return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS ? value : DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS;
	}

	private async resolveModel(
		owner: string,
		alias: AgentCallModel | undefined,
		definition: AgentDefinition | undefined,
		inherited: { provider: string; id: string } | undefined,
	): Promise<{ provider: string; id: string } | undefined> {
		if (alias) {
			if (alias === "inherit") return inherited;
			// An explicit model request fails visibly instead of silently using another model.
			const resolved = this.callbacks.resolveModelAlias ? await this.callbacks.resolveModelAlias(owner, alias, true) : undefined;
			if (!resolved) throw new Error(`Model '${alias}' is not available for this conversation; omit model to inherit the parent's model`);
			return resolved;
		}
		if (definition?.model) return definition.model;
		if (definition?.modelAlias && this.callbacks.resolveModelAlias) return (await this.callbacks.resolveModelAlias(owner, definition.modelAlias)) ?? inherited;
		return inherited;
	}

	private async resolveAgent(project: string, name: string): Promise<AgentDefinition | undefined> {
		const definition = this.callbacks.resolveAgent
			? await this.callbacks.resolveAgent(project, name)
			: name === "general-purpose" || name === "Explore" || name === "Plan"
				? { name, description: name, prompt: "", readOnly: name !== "general-purpose", scope: "builtin" as const }
				: undefined;
		if (definition) {
			if (definition.definitionError) throw new Error(definition.definitionError);
			return definition;
		}
		const available = (await this.callbacks.listAgentNames?.(project).catch(() => undefined)) ?? ["general-purpose", "Explore", "Plan"];
		throw new Error(`Agent type '${name.slice(0, 100)}' not found. Available agents: ${available.slice(0, 64).join(", ")}`);
	}

	private async assertRootForWorktree(owner: string): Promise<void> {
		if ((await this.callbacks.listTasks()).some((task) => task.conversationId === owner && (task.parentConversationId || task.quarantined)))
			throw new Error("Subagents cannot spawn nested agents or manage additional worktrees");
	}

	private async assertCanDelegate(owner: string): Promise<{ depth: number; nextDepth: number; readOnlyParent: boolean }> {
		const conv = await this.callbacks.getConversation(owner);
		if (conv.origin === "fork") throw new Error("Forked agents cannot fork or spawn agents");
		const task = (await this.callbacks.listTasks()).find((item) => item.conversationId === owner);
		if (task?.quarantined) throw new Error("This agent's record is damaged and cannot spawn nested agents");
		const depth = task?.parentConversationId ? (task.delegationDepth ?? 1) : 0;
		const maxDepth = (await this.callbacks.maxSubagentDepth?.()) ?? DEFAULT_MAX_SUBAGENT_DEPTH;
		if (depth >= maxDepth) {
			throw new Error(`Subagent nesting limit reached (depth ${depth}). Complete this task directly; subagents cannot delegate, and cannot spawn nested agents.`);
		}
		return { depth, nextDepth: depth + 1, readOnlyParent: Boolean(task?.readOnly) };
	}
	/**
	 * A child of `owner` by exact agentId, else by call-level name (the newest child with that
	 * name: once a newer agent took the name, an older one is reachable by agentId only).
	 */
	private async resolveTarget(owner: string, to: string): Promise<DesktopTask> {
		const tasks = (await this.callbacks.listTasks()).filter((task) => task.parentConversationId === owner);
		const exact = tasks.find((task) => task.id === to);
		if (exact) return exact;
		const named = tasks.filter((task) => task.name === to).sort((left, right) => right.createdAt - left.createdAt)[0];
		if (named) return named;
		const running = tasks.filter((task) => activeStatuses.has(task.status)).slice(0, 20)
			.map((task) => (task.name ? `${task.name} (${task.id})` : task.id));
		throw new Error(
			`Subagent task not found in this conversation: no agent with id or name '${to.slice(0, 200)}'. ${running.length ? `Running agents: ${running.join(", ")}` : "No agents are running."}`,
		);
	}
	private async ownedTask(owner: string, id: string): Promise<DesktopTask> {
		const task = (await this.callbacks.listTasks()).find((item) => item.id === id && item.parentConversationId === owner);
		if (!task) throw new Error("Subagent task not found in this conversation");
		return task;
	}
	private async ownedWorktrees(owner: string): Promise<WorktreeInfo[]> {
		const conversation = await this.callbacks.getConversation(owner);
		const children = (await this.callbacks.listTasks()).filter((task) => task.parentConversationId === owner);
		const childIds = new Set(children.map((task) => task.conversationId));
		const childWorktrees = new Set(children.map((task) => task.worktreeId));
		return (await this.callbacks.listWorktrees()).filter(
			(tree) => contains(tree.repository, conversation.project) &&
				(tree.conversationId === owner || childIds.has(tree.conversationId ?? "") || childWorktrees.has(tree.id)),
		);
	}
	private async ownedWorktree(owner: string, id: string): Promise<WorktreeInfo> {
		const tree = (await this.ownedWorktrees(owner)).find((item) => item.id === id && item.status === "ready");
		if (!tree) throw new Error("Worktree not found in this conversation");
		return tree;
	}
	/** Combine a caller's abort signal with service shutdown. */
	private signal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.disposed.signal]) : this.disposed.signal;
	}
	private checkAbort(signal?: AbortSignal): void {
		if (this.disposed.signal.aborted) throw new Error("Model delegation service is closed");
		signal?.throwIfAborted();
	}
}

/** A run's usage in Pi's shape, as the parent session counts it (tool result or usage entry). */
export function runToolUsage(stats: TaskRunStats): ToolUsage {
	return {
		input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
}
/** The model-facing usage summary of a finished run (TaskOutput, TaskList). */
function runUsage(stats: TaskRunStats): { total_tokens: number; tool_uses: number; duration_ms: number } {
	return { total_tokens: stats.tokens.total, tool_uses: stats.toolUses, duration_ms: Math.round(stats.durationMs) };
}
/** True when a blocking reader can return: the task finished or waits for a human. */
function settledForReader(task: DesktopTask): boolean {
	return !activeStatuses.has(task.status) || task.status === "waiting_for_input";
}
function contains(root: string, path: string): boolean {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model tool input");
	return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unsupported model tool parameter");
}
function text(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || exceedsLength(value, max) || value.includes("\0")) throw new Error(`Invalid ${name}`);
	return value;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid ${name}`);
	return value as boolean | undefined;
}
function parseAgent(value: Record<string, unknown>): AgentToolInput {
	// `mode` and `team_name` (Claude Code teams) are the only leniently accepted fields.
	only(value, ["description", "prompt", "subagent_type", "model", "run_in_background", "name", "isolation", "worktree_id", "fork", "mode", "team_name"]);
	const subagent = value.subagent_type === undefined ? "general-purpose" : text(value.subagent_type, "subagent_type", 100);
	if (value.isolation === "remote") throw new Error("isolation 'remote' is not supported by this client; use worktree or shared");
	if (value.isolation !== undefined && value.isolation !== "shared" && value.isolation !== "worktree") throw new Error("Invalid isolation");
	if (value.model !== undefined && !agentCallModels.includes(value.model as AgentCallModel)) throw new Error("Invalid model");
	if (value.name !== undefined && (typeof value.name !== "string" || !AGENT_CALL_NAME_PATTERN.test(value.name))) throw new Error("Invalid name");
	if (value.mode !== undefined) text(value.mode, "mode", 100);
	if (value.team_name !== undefined) text(value.team_name, "team_name", 200);
	const ignored = ["mode", "team_name"].filter((key) => value[key] !== undefined);
	return {
		description: text(value.description, "description", 160),
		prompt: text(value.prompt, "prompt", MAX_AGENT_PROMPT),
		subagent_type: subagent,
		run_in_background: optionalBoolean(value.run_in_background, "run_in_background"),
		isolation: value.isolation as AgentToolInput["isolation"],
		worktree_id: value.worktree_id === undefined ? undefined : text(value.worktree_id, "worktree_id", 200),
		fork: optionalBoolean(value.fork, "fork"),
		...(value.model !== undefined ? { model: value.model as AgentCallModel } : {}),
		...(value.name !== undefined ? { name: value.name as string } : {}),
		...(value.team_name !== undefined ? { team_name: value.team_name as string } : {}),
		...(ignored.length ? { ignored } : {}),
	};
}
function parseSend(value: Record<string, unknown>): SendMessageInput {
	only(value, ["to", "message", "summary", "run_in_background"]);
	return {
		to: text(value.to, "to", MAX_SEND_TARGET),
		message: text(value.message, "message", MAX_SEND_MESSAGE),
		...(value.summary !== undefined ? { summary: text(value.summary, "summary", MAX_SEND_SUMMARY) } : {}),
		...(value.run_in_background !== undefined ? { run_in_background: optionalBoolean(value.run_in_background, "run_in_background") } : {}),
	};
}
function parseOutput(value: Record<string, unknown>): TaskOutputInput {
	only(value, ["task_id", "block", "timeout"]);
	if (value.timeout !== undefined && (!Number.isSafeInteger(value.timeout) || (value.timeout as number) < 0 || (value.timeout as number) > 60000))
		throw new Error("timeout must be 0–60000 ms");
	return {
		task_id: text(value.task_id, "task_id", 200),
		block: optionalBoolean(value.block, "block"),
		timeout: value.timeout as number | undefined,
	};
}
