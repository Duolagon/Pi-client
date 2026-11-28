import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { managedDirectory, managedFile, writeManagedFile } from "./managed-path.ts";
import { validateJsonSchema } from "./workflow-schema.ts";
import type {
	WorkflowApprovalDecision,
	WorkflowApprovalRequest,
	WorkflowEvent,
	WorkflowJournalEntry,
	WorkflowRecord,
	WorkflowRunInput,
	WorkflowStepRecord,
} from "./workflow-types.ts";
import type { DeliverCustomType, NotificationDelivery, NotificationDisposition } from "./tool-control-types.ts";

export const WORKFLOW_EVENT_TYPE: DeliverCustomType = "desktop_workflow_event";
const MAX_STRUCTURED_RETRIES = 5;
const MAX_LOGS = 200;
const MAX_AGENTS_PER_WORKFLOW = 100;
/** A runaway script cannot grow the record without bound; the agent cap is lower than this. */
const MAX_STEP_RECORDS = 400;

/**
 * Fallback for a worker that sends no phase path. Step keys embed their scope, e.g.
 * `root/phase:Review#0/par#0[1]`; the last phase wins. Names containing `/` or `#` do not parse.
 */
export function phaseOfStepKey(stepKey: string): string | undefined {
	const matches = [...stepKey.matchAll(/(?:^|\/)phase:([^/#]+)#/g)];
	return matches.at(-1)?.[1];
}

/** The innermost phase of a step: the worker's phase path when sent, else parsed from the key. */
function stepPhase(phases: unknown, stepKey: string): string | undefined {
	if (Array.isArray(phases)) {
		const last = phases.at(-1);
		return typeof last === "string" && last.trim() ? last.trim().slice(0, 200) : undefined;
	}
	return phaseOfStepKey(stepKey);
}

function stepDescription(opts: Record<string, unknown>, stepKey: string): string {
	return typeof opts.description === "string" && opts.description.trim()
		? opts.description.trim().slice(0, 160)
		: `Workflow step ${stepKey}`;
}

export interface WorkflowAgentStepRequest {
	workflowId: string;
	conversationId: string;
	rootConversationId: string;
	stepKey: string;
	workspaceKey: string;
	prompt: string;
	description: string;
	subagentType?: string;
	model?: string;
	isolation?: "worktree" | "shared";
	schema?: unknown;
	/** Called once the child task exists, so a running step row can link to it. */
	onTaskStarted?: (taskId: string) => void;
}

export interface WorkflowAgentStepResult {
	taskId: string;
	worktreeId?: string;
	workingDirectory?: string;
	output: string;
	structuredOutput?: unknown;
	usage?: { totalTokens: number; cost: number };
}

export type WorkflowDeliverFn = (
	conversationId: string,
	params: {
		customType: DeliverCustomType;
		key?: string;
		content: string;
		details: Record<string, unknown>;
		deliverAs?: NotificationDelivery;
		triggerTurn?: boolean;
		display?: boolean;
	},
) => Promise<NotificationDisposition | "unavailable">;

export interface WorkflowCallbacks {
	workerPath: () => string;
	permissionMode: (conversationId: string) => string;
	runAgentStep: (req: WorkflowAgentStepRequest, signal: AbortSignal) => Promise<WorkflowAgentStepResult>;
	resumeStructuredStep?: (
		taskId: string,
		feedback: string,
		signal: AbortSignal,
	) => Promise<WorkflowAgentStepResult>;
	cancelWorkflowTasks?: (workflowId: string) => Promise<void>;
	deliver?: WorkflowDeliverFn;
}

interface WorkerHandle {
	send(msg: unknown): void;
	onMessage(fn: (msg: unknown) => void): void;
	onExit(fn: (code: number | null) => void): void;
	kill(): void;
}

interface ActiveWorkflow {
	worker?: WorkerHandle;
	abort: AbortController;
	callerSignal?: AbortSignal;
}

async function spawnWorker(workerPath: string): Promise<WorkerHandle> {
	if (process.versions.electron) {
		try {
			const electronMod = await import("electron");
			if (electronMod?.utilityProcess && electronMod?.MessageChannelMain) {
				const { port1, port2 } = new electronMod.MessageChannelMain();
				const child = electronMod.utilityProcess.fork(workerPath, [], {
					serviceName: "pi-workflow-worker",
					env: { PATH: process.env.PATH ?? "" },
				});
				port1.start();
				child.postMessage({ type: "init" }, [port2]);
				return {
					send: (msg) => port1.postMessage(msg),
					onMessage: (fn) => port1.on("message", (ev) => fn(ev.data)),
					onExit: (fn) => child.once("exit", (code) => fn(code)),
					kill: () => {
						try {
							port1.close();
						} catch {}
						try {
							child.kill();
						} catch {}
					},
				};
			}
		} catch {
			// Fall back to Node IPC child process when utilityProcess is unavailable
		}
	}

	const execArgv = workerPath.endsWith(".ts") ? ["--experimental-strip-types"] : [];
	const child: ChildProcess = fork(workerPath, [], {
		execArgv,
		env: { PATH: process.env.PATH ?? "" },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	return {
		send: (msg) => {
			if (child.connected) child.send(msg as never);
		},
		onMessage: (fn) => child.on("message", (msg) => fn(msg)),
		onExit: (fn) => child.once("exit", (code) => fn(code)),
		kill: () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		},
	};
}

export class WorkflowService {
	private dataDir: () => string;
	private callbacks: WorkflowCallbacks;
	private workflows = new Map<string, WorkflowRecord>();
	private alwaysApprovedRoots = new Set<string>();
	private activeRuns = new Map<string, ActiveWorkflow>();
	private approvalWaiters = new Map<string, { resolve: (decision: WorkflowApprovalDecision) => void }>();
	private runWaiters = new Map<string, Set<() => void>>();
	private listeners = new Set<(event: WorkflowEvent) => void>();
	private locks = new Map<string, Promise<unknown>>();
	private closed = false;

	constructor(options: { dataDir: () => string; callbacks: WorkflowCallbacks }) {
		this.dataDir = options.dataDir;
		this.callbacks = options.callbacks;
	}

	subscribe(listener: (event: WorkflowEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(record: WorkflowRecord): void {
		const copy = structuredClone(record);
		for (const listener of this.listeners) listener({ type: "workflow_updated", workflow: copy });
	}

	private notifyWaiters(workflowId: string): void {
		const set = this.runWaiters.get(workflowId);
		if (!set) return;
		for (const done of set) done();
	}

	private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const prior = this.locks.get(id) ?? Promise.resolve();
		const next = prior.then(fn, fn);
		this.locks.set(
			id,
			next.then(
				() => {},
				() => {},
			),
		);
		return next;
	}

	async initialize(): Promise<void> {
		try {
			const approvalsFile = await managedFile(this.dataDir(), ["workflows"], "approvals.json", false);
			if (approvalsFile) {
				const parsed = JSON.parse(await readFile(approvalsFile, "utf8")) as { roots?: unknown };
				if (Array.isArray(parsed?.roots)) {
					for (const r of parsed.roots) if (typeof r === "string") this.alwaysApprovedRoots.add(r);
				}
			}
			const dir = await managedDirectory(this.dataDir(), ["workflows"], false);
			if (!dir) return;
			const files = await readdir(dir);
			for (const name of files) {
				if (!name.startsWith("wf_") || !name.endsWith(".json")) continue;
				const target = await managedFile(this.dataDir(), ["workflows"], name, false).catch(() => undefined);
				if (!target) continue;
				try {
					const parsed = JSON.parse(await readFile(target, "utf8")) as { version?: unknown; workflow?: WorkflowRecord };
					if (parsed?.version !== 1 || !parsed.workflow?.id) continue;
					const wf = parsed.workflow;
					// Records written before per-step rows existed carry none.
					if (!wf.steps || typeof wf.steps !== "object" || Array.isArray(wf.steps)) wf.steps = {};
					if (wf.status === "running" || wf.status === "waiting_for_approval") {
						wf.status = "failed";
						wf.error = "应用已重启；可使用工作流 Journal 恢复继续运行。";
						delete wf.pendingApproval;
						this.settleRunningSteps(wf, "应用已重启，这一步未完成。");
					}
					this.workflows.set(wf.id, wf);
				} catch {}
			}
		} catch {}
	}

	private async saveWorkflow(record: WorkflowRecord): Promise<void> {
		const file = (await managedFile(this.dataDir(), ["workflows"], `${record.id}.json`, true))!;
		await writeManagedFile(file, JSON.stringify({ version: 1, workflow: record }, null, 2));
	}

	private async saveApprovals(): Promise<void> {
		const file = (await managedFile(this.dataDir(), ["workflows"], "approvals.json", true))!;
		await writeManagedFile(file, JSON.stringify({ version: 1, roots: [...this.alwaysApprovedRoots] }, null, 2));
	}

	list(conversationId?: string): WorkflowRecord[] {
		return structuredClone(
			[...this.workflows.values()]
				.filter((wf) => !conversationId || wf.conversationId === conversationId || wf.rootConversationId === conversationId)
				.sort((a, b) => b.createdAt - a.createdAt),
		);
	}

	get(id: string): WorkflowRecord | undefined {
		const wf = this.workflows.get(id);
		return wf ? structuredClone(wf) : undefined;
	}

	async start(params: {
		conversationId: string;
		rootConversationId: string;
		project: string;
		input: WorkflowRunInput;
		callerSignal?: AbortSignal;
	}): Promise<WorkflowRecord> {
		if (this.closed) throw new Error("Workflow service is closed");
		params.callerSignal?.throwIfAborted();
		const script = typeof params.input.script === "string" ? params.input.script : "";
		if (!script.trim() || script.length > 256 * 1024 || script.includes("\0")) {
			throw new Error("Invalid workflow script");
		}
		const title = params.input.title?.trim().slice(0, 160) || "Workflow Run";
		const id = `wf_${randomBytes(6).toString("hex")}`;
		const now = Date.now();
		const record: WorkflowRecord = {
			id,
			conversationId: params.conversationId,
			rootConversationId: params.rootConversationId,
			project: params.project,
			title,
			script,
			status: "running",
			budget: {
				...(params.input.budget?.maxCost !== undefined ? { maxCost: params.input.budget.maxCost } : {}),
				...(params.input.budget?.maxTokens !== undefined ? { maxTokens: params.input.budget.maxTokens } : {}),
				maxAgents: Math.min(
					MAX_AGENTS_PER_WORKFLOW,
					params.input.budget?.maxAgents ?? MAX_AGENTS_PER_WORKFLOW,
				),
				spentCost: 0,
				spentTokens: 0,
				spawnedAgents: 0,
			},
			phases: [],
			logs: [],
			journal: {},
			steps: {},
			...(params.input.toolCallId ? { toolCallId: params.input.toolCallId.slice(0, 300) } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.workflows.set(id, record);
		await this.serialize(id, () => this.saveWorkflow(record));
		this.emit(record);
		void this.executeWorkflow(id, false, params.callerSignal);
		return structuredClone(record);
	}

	/** A shared child may use the parent's directory only while its tool invocation waits. */
	hasWaitingCaller(id: string, conversationId: string): boolean {
		const run = this.activeRuns.get(id);
		return Boolean(run?.callerSignal && !run.callerSignal.aborted && !run.abort.signal.aborted &&
			this.workflows.get(id)?.conversationId === conversationId);
	}

	async resume(id: string, ceiling?: { maxAgents: number; maxCost: number }): Promise<WorkflowRecord> {
		if (this.closed) throw new Error("Workflow service is closed");
		const record = this.workflows.get(id);
		if (!record) throw new Error(`Workflow not found: ${id}`);
		if (this.activeRuns.has(id)) throw new Error("Workflow is already running");
		if (record.status === "completed") return structuredClone(record);
		if (ceiling) {
			record.budget.maxAgents = Math.min(record.budget.maxAgents ?? ceiling.maxAgents, ceiling.maxAgents);
			record.budget.maxCost = Math.min(record.budget.maxCost ?? ceiling.maxCost, ceiling.maxCost);
		}

		record.status = "running";
		delete record.error;
		delete record.pendingApproval;
		record.updatedAt = Date.now();
		await this.serialize(id, () => this.saveWorkflow(record));
		this.emit(record);
		void this.executeWorkflow(id, true);
		return structuredClone(record);
	}

	async wait(id: string, signal?: AbortSignal): Promise<WorkflowRecord> {
		signal?.throwIfAborted();
		const existing = this.workflows.get(id);
		if (!existing) throw new Error(`Workflow not found: ${id}`);
		if (["completed", "failed", "cancelled"].includes(existing.status)) {
			return structuredClone(existing);
		}
		return new Promise<WorkflowRecord>((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error("Workflow wait aborted"));
			};
			const check = () => {
				if (settled) return;
				const current = this.workflows.get(id);
				if (!current) {
					settled = true;
					cleanup();
					reject(new Error(`Workflow not found: ${id}`));
					return;
				}
				if (["completed", "failed", "cancelled"].includes(current.status)) {
					settled = true;
					cleanup();
					resolve(structuredClone(current));
				}
			};
			const cleanup = () => {
				this.runWaiters.get(id)?.delete(check);
				signal?.removeEventListener("abort", onAbort);
			};
			let set = this.runWaiters.get(id);
			if (!set) {
				set = new Set();
				this.runWaiters.set(id, set);
			}
			set.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	async respondApproval(workflowId: string, requestId: string, decision: WorkflowApprovalDecision): Promise<WorkflowRecord> {
		const record = this.workflows.get(workflowId);
		if (!record) throw new Error(`Workflow not found: ${workflowId}`);
		if (!record.pendingApproval || record.pendingApproval.id !== requestId) {
			throw new Error("Workflow approval request not found or already resolved");
		}
		if (decision === "always") {
			this.alwaysApprovedRoots.add(record.rootConversationId);
			await this.saveApprovals();
		}
		delete record.pendingApproval;
		record.status = decision === "deny" ? "cancelled" : "running";
		if (decision === "deny") record.error = "用户拒绝了工作流审批请求。";
		record.updatedAt = Date.now();
		await this.serialize(workflowId, () => this.saveWorkflow(record));
		this.emit(record);

		const waiter = this.approvalWaiters.get(requestId);
		if (waiter) {
			this.approvalWaiters.delete(requestId);
			waiter.resolve(decision);
		}
		return structuredClone(record);
	}

	async stop(id: string): Promise<WorkflowRecord> {
		const record = this.workflows.get(id);
		if (!record) throw new Error(`Workflow not found: ${id}`);
		const active = this.activeRuns.get(id);
		active?.abort.abort();
		active?.worker?.kill();
		const stopping = !["completed", "failed", "cancelled"].includes(record.status);
		if (stopping) {
			record.status = "cancelled";
			record.error = "工作流已停止。";
			this.settleRunningSteps(record, "工作流已停止。");
			record.updatedAt = Date.now();
		}
		if (record.pendingApproval) {
			const reqId = record.pendingApproval.id;
			delete record.pendingApproval;
			const waiter = this.approvalWaiters.get(reqId);
			if (waiter) {
				this.approvalWaiters.delete(reqId);
				waiter.resolve("deny");
			}
		}
		await this.callbacks.cancelWorkflowTasks?.(id).catch(() => {});
		if (stopping) {
			await this.serialize(id, () => this.saveWorkflow(record));
			this.emit(record);
			this.notifyWaiters(id);
		}
		return structuredClone(record);
	}

	private async requireApproval(
		record: WorkflowRecord,
		kind: WorkflowApprovalRequest["kind"],
		title: string,
		detail: string,
		stepKey: string | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const mode = this.callbacks.permissionMode(record.conversationId);
		if (mode === "auto" || this.alwaysApprovedRoots.has(record.rootConversationId)) {
			return;
		}
		if (mode === "dontAsk") throw new Error("dontAsk 模式不弹出审批，已拒绝执行此工作流步骤");
		const requestId = randomUUID();
		record.status = "waiting_for_approval";
		record.pendingApproval = {
			id: requestId,
			workflowId: record.id,
			conversationId: record.conversationId,
			title,
			detail,
			kind,
			...(stepKey ? { stepKey } : {}),
			createdAt: Date.now(),
		};
		record.updatedAt = Date.now();
		await this.serialize(record.id, () => this.saveWorkflow(record));
		this.emit(record);

		const decision = await new Promise<WorkflowApprovalDecision>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Workflow aborted"));
				return;
			}
			const onAbort = () => {
				this.approvalWaiters.delete(requestId);
				reject(new Error("Workflow aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.approvalWaiters.set(requestId, {
				resolve: (dec) => {
					signal.removeEventListener("abort", onAbort);
					resolve(dec);
				},
			});
		});

		if (decision === "deny") {
			throw new Error("用户拒绝执行此工作流步骤");
		}
	}

	/** Step rows still marked running when the run can no longer finish them are settled as failed. */
	private settleRunningSteps(record: WorkflowRecord, message: string): void {
		const now = Date.now();
		for (const step of Object.values(record.steps ?? {})) {
			if (step.status !== "running") continue;
			step.status = "failed";
			step.completedAt = now;
			step.error = message;
		}
	}

	/** Upsert one step row and tell the renderer at once; the tree updates as steps start and settle. */
	private trackStep(record: WorkflowRecord, step: WorkflowStepRecord): void {
		if (Object.keys(record.steps).length >= MAX_STEP_RECORDS && !record.steps[step.stepKey]) return;
		record.steps[step.stepKey] = step;
		record.updatedAt = Date.now();
		this.emit(record);
		// Persist too: a row that only lived in memory would vanish on restart.
		void this.serialize(record.id, () => this.saveWorkflow(record)).catch(() => {});
	}

	private async executeAgentWithSchemaRetries(
		record: WorkflowRecord,
		opts: Record<string, unknown>,
		stepKey: string,
		workspaceKey: string,
		phase: string | undefined,
		signal: AbortSignal,
	): Promise<WorkflowJournalEntry> {
		const prompt = typeof opts.prompt === "string" && opts.prompt.trim() ? opts.prompt.trim() : "";
		if (!prompt) throw new Error("agent() step requires non-empty prompt");
		const description = stepDescription(opts, stepKey);
		const subagentType = typeof opts.subagent_type === "string" ? opts.subagent_type : "general-purpose";
		const isolation = opts.isolation === "shared" || opts.isolation === "worktree" ? opts.isolation : undefined;
		const model = typeof opts.model === "string" ? opts.model : undefined;
		const schema = opts.schema;

		if (
			record.budget.maxAgents !== undefined &&
			record.budget.spawnedAgents >= record.budget.maxAgents
		) {
			throw new Error(`Workflow agent budget exceeded (${record.budget.spawnedAgents}/${record.budget.maxAgents})`);
		}
		if (record.budget.maxCost !== undefined && record.budget.spentCost >= record.budget.maxCost) {
			throw new Error(`Workflow cost budget exceeded ($${record.budget.spentCost.toFixed(4)}/$${record.budget.maxCost})`);
		}
		if (record.budget.maxTokens !== undefined && record.budget.spentTokens >= record.budget.maxTokens) {
			throw new Error(`Workflow token budget exceeded (${record.budget.spentTokens}/${record.budget.maxTokens})`);
		}

		record.budget.spawnedAgents += 1;
		const startedAt = Date.now();
		this.trackStep(record, { stepKey, label: description, ...(phase ? { phase } : {}), status: "running", startedAt });
		let stepResult = await this.callbacks.runAgentStep(
			{
				workflowId: record.id,
				conversationId: record.conversationId,
				rootConversationId: record.rootConversationId,
				stepKey,
				workspaceKey,
				prompt,
				description,
				subagentType,
				model,
				isolation,
				schema,
				onTaskStarted: (taskId) => {
					const row = record.steps[stepKey];
					if (row?.status === "running" && row.startedAt === startedAt) this.trackStep(record, { ...row, taskId });
				},
			},
			signal,
		);

		let totalTokens = stepResult.usage?.totalTokens ?? 0;
		let totalCost = stepResult.usage?.cost ?? 0;
		let validatedStructured: unknown;

		if (schema !== undefined) {
			for (let attempt = 0; attempt <= MAX_STRUCTURED_RETRIES; attempt++) {
				let candidate = stepResult.structuredOutput;
				if (candidate === undefined) {
					try {
						candidate = JSON.parse(stepResult.output);
					} catch {
						candidate = undefined;
					}
				}
				const check = validateJsonSchema(schema, candidate);
				if (check.valid) {
					validatedStructured = candidate;
					break;
				}
				if (attempt >= MAX_STRUCTURED_RETRIES || !this.callbacks.resumeStructuredStep) {
					throw new Error(
						`StructuredOutput validation failed after ${attempt} retries: ${check.errors.join("; ")}`,
					);
				}
				const feedback = `Your previous output did not satisfy the required StructuredOutput JSON Schema (${check.errors.join("; ")}). Please call StructuredOutput with valid JSON matching the schema.`;
				stepResult = await this.callbacks.resumeStructuredStep(stepResult.taskId, feedback, signal);
				totalTokens += stepResult.usage?.totalTokens ?? 0;
				totalCost += stepResult.usage?.cost ?? 0;
			}
		}

		record.budget.spentTokens += totalTokens;
		record.budget.spentCost += totalCost;
		this.trackStep(record, {
			stepKey, label: description, ...(phase ? { phase } : {}), status: "completed",
			startedAt, completedAt: Date.now(),
			...(stepResult.taskId ? { taskId: stepResult.taskId } : {}),
			usage: { totalTokens, cost: totalCost },
		});
		// Cost is known only when a step settles, so agents already running can overshoot the cap.
		// Once it is crossed, cancel the rest instead of letting a wide parallel() finish.
		if (record.budget.maxCost !== undefined && record.budget.spentCost >= record.budget.maxCost)
			await this.callbacks.cancelWorkflowTasks?.(record.id).catch(() => {});

		return {
			stepKey,
			status: "completed",
			taskId: stepResult.taskId,
			...(stepResult.worktreeId ? { worktreeId: stepResult.worktreeId } : {}),
			...(stepResult.workingDirectory ? { workingDirectory: stepResult.workingDirectory } : {}),
			output: stepResult.output,
			...(validatedStructured !== undefined ? { structuredOutput: validatedStructured } : {}),
			usage: { totalTokens, cost: totalCost },
			completedAt: Date.now(),
		};
	}

	private async executeWorkflow(id: string, isResume: boolean, callerSignal?: AbortSignal): Promise<void> {
		const record = this.workflows.get(id);
		if (!record || record.status !== "running" || this.closed) return;
		const abort = new AbortController();
		const cancelled = () => abort.signal.aborted || record.status === "cancelled";
		const active: ActiveWorkflow = { abort, callerSignal };
		this.activeRuns.set(id, active);
		const stopWhenCallerAborts = () => { void this.stop(id).catch(() => {}); };
		callerSignal?.addEventListener("abort", stopWhenCallerAborts, { once: true });

		try {
			if (callerSignal?.aborted) {
				await this.stop(id);
				return;
			}
			await this.requireApproval(
				record,
				"start_workflow",
				isResume ? `恢复执行工作流：${record.title}` : `执行工作流：${record.title}`,
				record.script.slice(0, 600),
				undefined,
				abort.signal,
			);

			abort.signal.throwIfAborted();
			const worker = await spawnWorker(this.callbacks.workerPath());
			active.worker = worker;
			abort.signal.throwIfAborted();

			const done = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
				let finished = false;
				const finish = (outcome: { ok: boolean; result?: unknown; error?: string }) => {
					if (finished) return;
					finished = true;
					resolve(outcome);
				};

				worker.onExit((code) => {
					finish({ ok: false, error: `Workflow worker exited unexpectedly (code=${code})` });
				});

				worker.onMessage((raw) => {
					if (abort.signal.aborted || !raw || typeof raw !== "object") return;
					const msg = raw as Record<string, unknown>;
					if (msg.type === "ready") {
						worker.send({ type: "start", script: record.script });
						return;
					}
					if (msg.type === "done") {
						finish({
							ok: msg.ok === true,
							result: msg.result,
							error: typeof msg.error === "string" ? msg.error : undefined,
						});
						return;
					}
					if (msg.type === "rpc") {
						const rpcId = String(msg.id ?? "");
						const method = String(msg.method ?? "");
						const payload = (msg.payload ?? {}) as Record<string, unknown>;
						void this.handleWorkerRpc(record, method, payload, abort.signal)
							.then((result) => {
								if (!abort.signal.aborted) worker.send({ type: "rpc_result", id: rpcId, ok: true, result });
							})
							.catch((err) => {
								if (!abort.signal.aborted) worker.send({
									type: "rpc_result",
									id: rpcId,
									ok: false,
									error: err instanceof Error ? err.message : String(err),
								});
							});
					}
				});
			});

			if (cancelled()) {
				return;
			}
			if (done.ok) {
				record.status = "completed";
				record.result = done.result ?? null;
			} else {
				record.status = "failed";
				record.error = done.error ?? "Workflow execution failed";
			}
			this.settleRunningSteps(record, done.ok ? "工作流已结束，这一步未返回。" : "工作流失败，这一步未完成。");
			record.updatedAt = Date.now();
			await this.serialize(id, () => this.saveWorkflow(record));
			this.emit(record);
			this.notifyWaiters(id);

			if (this.callbacks.deliver) {
				const summary = done.ok
					? `[SYSTEM NOTIFICATION - NOT USER INPUT] 工作流 "${record.title}" (${id}) 已完成。`
					: `[SYSTEM NOTIFICATION - NOT USER INPUT] 工作流 "${record.title}" (${id}) 失败：${record.error}`;
				void this.callbacks
					.deliver(record.conversationId, {
						customType: WORKFLOW_EVENT_TYPE,
						key: `${id}_done:1`,
						content: summary,
						details: { workflow_id: id, title: record.title, status: record.status, result: record.result, error: record.error },
						deliverAs: "followUp",
						triggerTurn: false,
						display: true,
					})
					.catch(() => {});
			}
		} catch (err) {
			if (!cancelled()) {
				record.status = "failed";
				record.error = err instanceof Error ? err.message : String(err);
				this.settleRunningSteps(record, "工作流失败，这一步未完成。");
				record.updatedAt = Date.now();
				await this.serialize(id, () => this.saveWorkflow(record)).catch(() => {});
				this.emit(record);
			}
			this.notifyWaiters(id);
		} finally {
			active.worker?.kill();
			this.activeRuns.delete(id);
			callerSignal?.removeEventListener("abort", stopWhenCallerAborts);
		}
	}

	private async handleWorkerRpc(
		record: WorkflowRecord,
		method: string,
		payload: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (method === "budget") {
			return structuredClone(record.budget);
		}
		if (method === "log") {
			record.logs.push({
				ts: Date.now(),
				level: "info",
				message: String(payload.message ?? "").slice(0, 4000),
			});
			if (record.logs.length > MAX_LOGS) record.logs = record.logs.slice(-MAX_LOGS);
			record.updatedAt = Date.now();
			this.emit(record);
			return true;
		}
		if (method === "phase_start") {
			const name = String(payload.name ?? "phase");
			record.phases.push({ name, status: "running", startedAt: Date.now() });
			record.updatedAt = Date.now();
			await this.serialize(record.id, () => this.saveWorkflow(record));
			this.emit(record);
			return true;
		}
		if (method === "phase_end") {
			const name = String(payload.name ?? "phase");
			const existing = [...record.phases].reverse().find((p) => p.name === name && p.status === "running");
			if (existing) {
				existing.status = payload.status === "failed" ? "failed" : "completed";
				existing.completedAt = Date.now();
				if (typeof payload.error === "string") existing.error = payload.error;
			}
			record.updatedAt = Date.now();
			await this.serialize(record.id, () => this.saveWorkflow(record));
			this.emit(record);
			return true;
		}
		if (method === "agent") {
			const stepKey = String(payload.stepKey ?? "");
			const workspaceKey = String(payload.workspaceKey ?? "");
			const opts = (payload.options ?? {}) as Record<string, unknown>;
			if (!stepKey) throw new Error("Missing workflow agent stepKey");
			if (!/^[a-f0-9]{64}$/.test(workspaceKey)) throw new Error("Invalid workflow agent workspace key");
			const phase = stepPhase(payload.phases, stepKey);

			// Deterministic journal replay: already-completed steps return cached outcome without re-spawning
			const cached = record.journal[stepKey];
			if (cached && cached.status === "completed") {
				this.trackStep(record, {
					stepKey, label: record.steps[stepKey]?.label ?? stepDescription(opts, stepKey), ...(phase ? { phase } : {}), status: "replayed",
					startedAt: cached.completedAt, completedAt: cached.completedAt,
					...(cached.taskId ? { taskId: cached.taskId } : {}),
					...(cached.usage ? { usage: cached.usage } : {}),
				});
				return {
					taskId: cached.taskId ?? "",
					...(cached.worktreeId ? { worktreeId: cached.worktreeId } : {}),
					...(cached.workingDirectory ? { workingDirectory: cached.workingDirectory } : {}),
					output: cached.output ?? "",
					...(cached.structuredOutput !== undefined ? { structuredOutput: cached.structuredOutput } : {}),
					...(cached.usage ? { usage: cached.usage } : {}),
					replayed: true,
				};
			}

			const entry = await this.executeAgentWithSchemaRetries(record, opts, stepKey, workspaceKey, phase, signal).catch((error) => {
				// A stopped run already settled its rows; a late rejection must not overwrite the row a
				// resumed run has since written for the same step.
				if (signal.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const existing = record.steps[stepKey];
				this.trackStep(record, {
					stepKey, label: existing?.label ?? stepDescription(opts, stepKey), ...(phase ? { phase } : {}), status: "failed",
					startedAt: existing?.startedAt ?? Date.now(), completedAt: Date.now(), error: message.slice(0, 500),
					...(existing?.taskId ? { taskId: existing.taskId } : {}),
				});
				throw error;
			});
			await this.serialize(record.id, async () => {
				record.journal[stepKey] = entry;
				record.updatedAt = Date.now();
				await this.saveWorkflow(record);
			});
			this.emit(record);
			return {
				taskId: entry.taskId ?? "",
				...(entry.worktreeId ? { worktreeId: entry.worktreeId } : {}),
				...(entry.workingDirectory ? { workingDirectory: entry.workingDirectory } : {}),
				output: entry.output ?? "",
				...(entry.structuredOutput !== undefined ? { structuredOutput: entry.structuredOutput } : {}),
				...(entry.usage ? { usage: entry.usage } : {}),
				replayed: false,
			};
		}
		throw new Error(`Unsupported workflow RPC method: ${method}`);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const [, active] of this.activeRuns) {
			active.abort.abort();
			active.worker?.kill();
		}
		this.activeRuns.clear();
		for (const [reqId, waiter] of this.approvalWaiters) {
			this.approvalWaiters.delete(reqId);
			waiter.resolve("deny");
		}
		for (const wfId of [...this.runWaiters.keys()]) {
			this.notifyWaiters(wfId);
		}
		this.listeners.clear();
	}
}
