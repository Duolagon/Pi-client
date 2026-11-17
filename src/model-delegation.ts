import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopTask } from "./task-types.ts";
import type { AgentDefinition } from "./agent-types.ts";
import type { WorktreeInfo } from "./worktree-types.ts";
import { finalAssistantText } from "./delegation-types.ts";
import type {
	AgentToolInput,
	DelegationCallbacks,
	DelegationContext,
	DelegatedTaskResult,
	SubagentType,
	TaskOutputInput,
} from "./delegation-types.ts";

const activeStatuses = new Set(["queued", "running", "waiting_for_input"]);
const maxOutput = 48 * 1024;
const maxOutstanding = 8;

/** Host authority for model-created tasks. The model never supplies its owner or source project. */
export class ModelDelegation {
	private callbacks: DelegationCallbacks;
	private spawning: Promise<void> = Promise.resolve();
	private disposed = new AbortController();
	private watches = new Map<string, Promise<void>>();
	private notified = new Set<string>();

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
			case "TaskOutput":
				return this.result(context.conversationId, parseOutput(input), context.signal);
			case "TaskStop": {
				only(input, ["task_id"]);
				const task = await this.ownedTask(context.conversationId, text(input.task_id, "task_id", 200));
				await this.callbacks.cancelTask(task.id);
				return this.result(context.conversationId, { task_id: task.id }, context.signal);
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
					})),
					truncated: tasks.length > 128,
				};
			}
			case "WorktreeCreate": {
				only(input, ["base_ref"]);
				await this.assertParent(context.conversationId);
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
				await this.assertParent(context.conversationId);
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
		const started = Date.now();
		let task = await this.ownedTask(owner, input.task_id);
		while (input.block && activeStatuses.has(task.status) && task.status !== "waiting_for_input" && Date.now() - started < timeout) {
			this.checkAbort(signal);
			await delay(Math.min(100, Math.max(1, timeout - (Date.now() - started))), undefined, { signal });
			task = await this.ownedTask(owner, input.task_id);
		}
		this.checkAbort(signal);
		const snapshot = await this.callbacks.taskSnapshot(task.id);
		const output = task.result?.text ?? finalAssistantText(snapshot.messages);
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
			output: output.slice(0, maxOutput),
			truncated: Boolean(task.result?.truncated) || output.length > maxOutput,
			error: task.error,
			pending_approvals: snapshot.pendingUI.length,
		};
	}

	/** Stopping a parent cancels only its model-created children, preserving independent manual tasks. */
	async cancelChildren(owner: string): Promise<void> {
		const children = (await this.callbacks.listTasks()).filter(
			(task) => task.parentConversationId === owner && activeStatuses.has(task.status),
		);
		await Promise.all(children.map((task) => this.callbacks.cancelTask(task.id)));
	}

	/** Called after a persisted task transition; schedules notification without blocking host serialization. */
	observeTask(task: DesktopTask): void {
		if (!task.parentConversationId || activeStatuses.has(task.status) || this.disposed.signal.aborted) return;
		if (task.runInBackground || this.watches.has(task.id)) void this.notify(task.parentConversationId, task.id);
	}

	dispose(): void {
		this.disposed.abort();
	}

	private async agent(context: DelegationContext, input: AgentToolInput): Promise<DelegatedTaskResult> {
		// A narrow lock makes the per-parent cap and tool-call idempotency atomic.
		const spawn = this.spawning.then(async () => {
			this.checkAbort(context.signal);
			await this.assertParent(context.conversationId);
			const tasks = await this.callbacks.listTasks();
			const previous = tasks.find(
				(task) => task.parentConversationId === context.conversationId && task.parentToolCallId === context.toolCallId,
			);
			if (previous) return previous;
			if (tasks.filter((task) => task.parentConversationId === context.conversationId && activeStatuses.has(task.status)).length >= maxOutstanding)
				throw new Error("This conversation already has 8 outstanding subagents; collect or stop one first");
			const owner = await this.callbacks.getConversation(context.conversationId);
			const definition = await this.resolveAgent(owner.project, input.subagent_type);
			const readOnly = definition?.readOnly ?? input.subagent_type !== "general-purpose";
			const selection = await this.callbacks.getSelection(owner.id);
			const isolation = input.isolation ?? (readOnly ? "shared" : (await this.callbacks.isGit(owner.project)) ? "worktree" : "shared");
			if (input.worktree_id) await this.ownedWorktree(owner.id, input.worktree_id);
			if (input.worktree_id && isolation === "shared") throw new Error("An existing worktree requires worktree isolation");
			if (isolation === "shared" && !(await this.callbacks.canRunShared?.(owner.id, readOnly)))
				throw new Error("Shared subagent work cannot run alongside this parent; choose worktree isolation or a read-only Explore/Plan agent");
			this.checkAbort(context.signal);
			const message = definition && definition.scope !== "builtin" && definition.prompt ? `${definition.prompt}\n\n---\n\nTask:\n${input.prompt}` : input.prompt;
			return this.callbacks.startTask(
				{
					project: owner.project,
					message,
					title: input.description,
					isolation,
					worktreeId: input.worktree_id,
					model: definition?.model ?? selection.model,
					thinkingLevel: definition?.thinkingLevel ?? selection.thinkingLevel,
					...(definition?.tools ? { allowedTools: definition.tools } : {}),
				},
				{
					parentConversationId: owner.id,
					parentToolCallId: context.toolCallId,
					subagentType: definition?.name ?? input.subagent_type,
					delegationDepth: 1,
					readOnly,
					runInBackground: input.run_in_background ?? false,
				},
			);
		});
		this.spawning = spawn.then(() => {}, () => {});
		const task = await spawn;
		if (context.signal?.aborted) {
			await this.callbacks.cancelTask(task.id);
			context.signal.throwIfAborted();
		}
		if (input.run_in_background) {
			this.watch(context.conversationId, task.id);
			return this.result(context.conversationId, { task_id: task.id });
		}
		try {
			// Keep the foreground call bounded. A slow child remains retrievable via TaskOutput.
			const started = Date.now();
			let result: DelegatedTaskResult;
			do {
				result = await this.result(context.conversationId, { task_id: task.id, block: true, timeout: 60000 }, context.signal);
			} while (activeStatuses.has(result.status) && result.pending_approvals === 0 && Date.now() - started < 300000);
			if (activeStatuses.has(result.status)) this.watch(context.conversationId, task.id);
			return result;
		} catch (error) {
			if (context.signal?.aborted) await this.callbacks.cancelTask(task.id);
			throw error;
		}
	}

	private async resolveAgent(project: string, name: string): Promise<AgentDefinition | undefined> {
		if (this.callbacks.resolveAgent) {
			const definition = await this.callbacks.resolveAgent(project, name);
			if (!definition) throw new Error("Unknown subagent_type");
			return definition;
		}
		if (name === "general-purpose" || name === "Explore" || name === "Plan")
			return {
				name,
				description: name,
				prompt: "",
				readOnly: name !== "general-purpose",
				scope: "builtin",
			};
		throw new Error("Unknown subagent_type");
	}

	private watch(owner: string, id: string): void {
		if (this.watches.has(id) || !this.callbacks.notify || this.disposed.signal.aborted) return;
		const watch = (async () => {
			while (!this.disposed.signal.aborted) {
				const task = await this.ownedTask(owner, id);
				if (!activeStatuses.has(task.status)) {
					await this.notify(owner, id);
					return;
				}
				await delay(100, undefined, { signal: this.disposed.signal, ref: false });
			}
		})().catch(() => {
			// Lifecycle shutdown and parent removal must not create unhandled rejections.
		}).finally(() => this.watches.delete(id));
		this.watches.set(id, watch);
	}
	private async notify(owner: string, id: string): Promise<void> {
		if (!this.callbacks.notify || this.notified.has(id) || this.disposed.signal.aborted) return;
		this.notified.add(id);
		try {
			await this.callbacks.notify(owner, await this.result(owner, { task_id: id }));
		} catch {
			// A closed or unavailable parent can retrieve the persisted result later.
			this.notified.delete(id);
		}
	}

	private async assertParent(owner: string): Promise<void> {
		if ((await this.callbacks.listTasks()).some((task) => task.conversationId === owner && task.parentConversationId))
			throw new Error("Subagents cannot spawn nested agents or manage additional worktrees");
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
	private checkAbort(signal?: AbortSignal): void {
		if (this.disposed.signal.aborted) throw new Error("Model delegation service is closed");
		signal?.throwIfAborted();
	}
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
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}`);
	return value;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid ${name}`);
	return value as boolean | undefined;
}
function parseAgent(value: Record<string, unknown>): AgentToolInput {
	only(value, ["description", "prompt", "subagent_type", "run_in_background", "isolation", "worktree_id"]);
	const subagent = text(value.subagent_type, "subagent_type", 100);
	if (value.isolation !== undefined && value.isolation !== "shared" && value.isolation !== "worktree") throw new Error("Invalid isolation");
	return {
		description: text(value.description, "description", 160),
		prompt: text(value.prompt, "prompt", 128 * 1024),
		subagent_type: subagent,
		run_in_background: optionalBoolean(value.run_in_background, "run_in_background"),
		isolation: value.isolation as AgentToolInput["isolation"],
		worktree_id: value.worktree_id === undefined ? undefined : text(value.worktree_id, "worktree_id", 200),
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
