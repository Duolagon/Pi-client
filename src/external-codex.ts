import { isAbsolute } from "node:path";
import type { ExternalAdapter, ExternalApprovalRequest, ExternalApprovalResponse, ExternalSession, ExternalSessionOptions, ExternalTurnResult } from "./external-types.ts";
import { JsonLineProcess, type RpcId } from "./external-rpc.ts";
import { codexErrorKind, ExternalFailure, ExternalRpcError, redactDiagnostic, withDiagnostics } from "./external-errors.ts";
import { externalPlan } from "./external-plan.ts";

const desktopTools = new Set(["Agent", "SendMessage", "AgentSend", "AgentExecutors", "AgentMessage", "TaskOutput", "TaskStop", "TaskList", "WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove"]);
const limit = 1024 * 1024;
type RecordValue = Record<string, unknown>;
interface Turn {
	id?: string;
	ready: Promise<void>;
	started(): void;
	completion: Promise<ExternalTurnResult>;
	resolve(result: ExternalTurnResult): void;
	reject(error: Error): void;
	text: Map<string, string>;
	final: Map<string, string>;
	cancelled: boolean;
	/** Cumulative thread usage before this turn, to report this turn's own tokens. */
	baseline?: { input: number; output: number; cached: number };
}

/** Codex keeps its native authentication local and exposes a bidirectional App Server session. */
export class CodexAdapter implements ExternalAdapter {
	async open(options: ExternalSessionOptions): Promise<ExternalSession> {
		assertCodexPolicy(options);
		if (!isAbsolute(options.executable) || !isAbsolute(options.cwd)) throw new Error("Codex executable and project must use absolute paths");
		const session = new CodexSession(options);
		try { await session.initialize(); return session; }
		catch (error) { await session.close(); throw withDiagnostics(error, session.diagnostics()); }
	}
}

/** Stable App Server has no pre-execution hook for every native file/MCP tool. Refuse false guarantees. */
export function assertCodexPolicy(options: Pick<ExternalSessionOptions, "policy">): void {
	for (const name of options.policy.disabledTools)
		if (!desktopTools.has(name)) throw new Error(`unsupported_policy: Codex cannot enforce disabled native tool ${name}`);
	for (const rule of options.policy.rules) {
		if (rule.action === "allow") continue;
		if (!desktopTools.has(rule.tool)) throw new Error(`unsupported_policy: Codex cannot enforce native rule ${rule.id} before every tool call`);
	}
}

class CodexSession implements ExternalSession {
	private options: ExternalSessionOptions;
	private readOnly: boolean;
	private rpc: JsonLineProcess;
	private nativeId?: string;
	private active?: Turn;
	private items = new Map<string, RecordValue>();
	private permissionCancels = new Set<() => void>();
	private requestCancels = new Map<string, AbortController>();
	private closed = false;
	private interruption?: Promise<void>;
	get sessionId(): string | undefined { return this.nativeId; }
	diagnostics(): string { return this.rpc.stderrTail; }

	constructor(options: ExternalSessionOptions) {
		this.options = options;
		this.readOnly = options.policy.mode === "read" || options.policy.mode === "plan";
		this.rpc = new JsonLineProcess({
			executable: options.executable,
			args: ["app-server", "--listen", "stdio://", "--disable", "multi_agent", "--strict-config"],
			cwd: options.cwd, env: options.env,
			onNotification: (method, params) => this.notification(method, object(params ?? {})),
			onRequest: (method, params, id) => this.request(method, object(params ?? {}), id),
			onFailure: (error) => this.fail(error),
		});
	}

	async initialize(): Promise<void> {
		await this.rpc.request("initialize", { clientInfo: { name: "pi_desktop", title: "Pi Desktop", version: "0.1.0" }, capabilities: { experimentalApi: false } });
		await this.rpc.notify("initialized", {});
		const parameters = {
			cwd: this.options.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user",
			sandbox: this.readOnly ? "read-only" : "workspace-write",
			config: { "features.multi_agent": false },
			...(this.options.model ? { model: this.options.model } : {}),
		};
		const response = await this.rpc.request<RecordValue>(this.options.resumeSessionId ? "thread/resume" : "thread/start", {
			...parameters, ...(this.options.resumeSessionId ? { threadId: this.options.resumeSessionId, excludeTurns: true } : {}),
		});
		const thread = object(response.thread);
		const id = text(thread.id);
		if (this.options.resumeSessionId && id !== this.options.resumeSessionId) throw new Error("Codex resumed a different native thread");
		const sandbox = object(response.sandbox);
		if (this.readOnly ? sandbox.type !== "readOnly" : !["workspaceWrite", "readOnly"].includes(String(sandbox.type)))
			throw new Error("unsupported_policy: Codex did not confirm the requested sandbox");
		if (response.approvalPolicy !== "untrusted" || (response.approvalsReviewer !== undefined && response.approvalsReviewer !== "user"))
			throw new Error("unsupported_policy: Codex did not confirm user-routed untrusted approvals");
		await this.checkModel(typeof response.model === "string" ? response.model : undefined,
			typeof response.modelProvider === "string" ? response.modelProvider : undefined);
		this.nativeId = id;
		this.options.onEvent({ type: "session", sessionId: id });
		if (this.readOnly) {
			const servers = await this.rpc.request<RecordValue>("mcpServerStatus/list", { threadId: id, limit: 100 });
			if (!Array.isArray(servers.data) || servers.data.length || servers.nextCursor)
				throw new Error("unsupported_policy: read-only Codex tasks require a native configuration without MCP servers");
		}
	}

	/**
	 * Reject a pinned model or effort the installed Codex does not offer, before any turn starts.
	 * An App Server without `model/list` keeps the request; Codex then reports modelNotFound itself.
	 */
	private async checkModel(threadModel: string | undefined, modelProvider: string | undefined): Promise<void> {
		const { model, effort } = this.options;
		const effective = model ?? threadModel;
		if (!effective || (!model && !effort)) return;
		const models: RecordValue[] = [];
		let cursor: unknown = null;
		try {
			for (let page = 0; page < 10; page++) {
				const response = await this.rpc.request<RecordValue>("model/list", {
					includeHidden: true, limit: 100, ...(modelProvider ? { modelProvider } : {}), ...(cursor ? { cursor } : {}),
				}, 10000);
				if (Array.isArray(response.data)) models.push(...response.data.filter((item): item is RecordValue => Boolean(item) && typeof item === "object"));
				cursor = response.nextCursor;
				if (!cursor) break;
			}
		} catch { return; }
		if (!models.length) return;
		const selected = models.find((item) => item.model === effective || item.id === effective);
		if (model && !selected && !cursor)
			throw new ExternalFailure("model", `Codex 没有模型 ${model}。可用模型：${models.filter((item) => item.hidden !== true).map((item) => String(item.model ?? item.id)).slice(0, 20).join("、")}`);
		if (model && selected && threadModel && threadModel !== model && threadModel !== selected.model)
			throw new ExternalFailure("model", `Codex 未确认使用模型 ${model}，它返回了 ${threadModel}。`);
		const supported = selected?.supportedReasoningEfforts;
		const efforts = Array.isArray(supported)
			? supported.map((item) => item && typeof item === "object" ? (item as RecordValue).reasoningEffort : item).filter((item): item is string => typeof item === "string")
			: [];
		if (effort && efforts.length && !efforts.includes(effort))
			throw new ExternalFailure("model", `Codex 模型 ${effective} 不支持思考强度 ${effort}；可选：${efforts.join("、")}`);
	}

	async run(prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult> {
		if (this.closed) throw new Error("Codex session is closed");
		if (this.active) throw new Error("Codex session already has an active turn");
		if (!prompt || Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new Error("Invalid Codex prompt");
		signal?.throwIfAborted();
		assertCodexPolicy(this.options);
		let started!: () => void;
		let resolve!: Turn["resolve"];
		let reject!: Turn["reject"];
		const turn: Turn = { ready: new Promise<void>((done) => { started = done; }), started: () => started(),
			completion: new Promise<ExternalTurnResult>((done, fail) => { resolve = done; reject = fail; }),
			resolve: (result) => resolve(result), reject: (error) => reject(error), text: new Map(), final: new Map(), cancelled: false };
		void turn.completion.catch(() => {});
		this.active = turn;
		this.items.clear();
		const abort = () => { void this.interrupt().catch((error) => this.fail(error instanceof Error ? error : new Error("Codex cancellation failed"))); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const response = await this.rpc.request<RecordValue>("turn/start", {
				threadId: this.nativeId, cwd: this.options.cwd,
				input: [{ type: "text", text: prompt }], approvalPolicy: "untrusted", approvalsReviewer: "user",
				...(this.options.model ? { model: this.options.model } : {}),
				...(this.options.effort ? { effort: this.options.effort } : {}),
				...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
				sandboxPolicy: this.readOnly ? { type: "readOnly", networkAccess: false }
					: { type: "workspaceWrite", writableRoots: [this.options.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
			});
			const result = object(response.turn);
			const id = text(result.id);
			if (turn.id && turn.id !== id) throw new Error("Codex turn identity changed");
			turn.id = id;
			turn.started();
			if (signal?.aborted) abort();
			return await turn.completion;
		} catch (error) {
			if (turn.cancelled) return { status: "cancelled", text: this.output(turn), sessionId: this.nativeId };
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
			if (this.active === turn) this.active = undefined;
			this.cancelPermissions();
		}
	}

	async steer(message: string): Promise<boolean> {
		const turn = this.active;
		if (!turn?.id || turn.cancelled || this.closed) return false;
		try {
			const result = await this.rpc.request<RecordValue>("turn/steer", {
				threadId: this.nativeId, expectedTurnId: turn.id, input: [{ type: "text", text: message }],
			}, 4000);
			if (result.turnId !== turn.id) throw new Error("Codex did not confirm the target turn for additional input");
			return true;
		} catch (error) {
			if (error instanceof ExternalRpcError) return false;
			throw error;
		}
	}

	interrupt(): Promise<void> {
		if (this.interruption) return this.interruption;
		const turn = this.active;
		if (!turn) return Promise.resolve();
		turn.cancelled = true;
		this.cancelPermissions();
		this.interruption = (async () => {
			await bounded(turn.ready, 1500);
			if (!turn.id || this.closed) { await this.close(); return; }
			try {
				await this.rpc.request("turn/interrupt", { threadId: this.nativeId, turnId: turn.id }, 2000);
				if (!(await bounded(turn.completion, 3000))) await this.close();
			} catch { await this.close(); }
		})().finally(() => { this.interruption = undefined; });
		return this.interruption;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.cancelPermissions();
		if (this.active) {
			const turn = this.active;
			turn.cancelled = true;
			turn.resolve({ status: "cancelled", text: this.output(turn), sessionId: this.nativeId });
			turn.started();
			this.active = undefined;
		}
		await this.rpc.close();
	}

	private notification(method: string, params: RecordValue): void {
		if (this.closed || (params.threadId !== undefined && params.threadId !== this.nativeId)) return;
		if (method === "serverRequest/resolved") {
			this.requestCancels.get(String(params.requestId))?.abort(new Error("Native approval resolved or withdrawn"));
			return;
		}
		const turn = this.active;
		if (!turn) return;
		if (method === "turn/started") {
			const started = object(params.turn);
			turn.id = text(started.id);
			turn.started();
			return;
		}
		if (params.turnId !== undefined && turn.id && params.turnId !== turn.id) return;
		if (method === "item/agentMessage/delta") {
			const id = text(params.itemId);
			const delta = text(params.delta, true);
			turn.text.set(id, ((turn.text.get(id) ?? "") + delta).slice(0, limit));
			this.options.onEvent({ type: "text_delta", text: delta });
		} else if (method === "item/started" || method === "item/completed") {
			const item = object(params.item);
			const id = text(item.id);
			this.items.set(id, item);
			if (item.type === "agentMessage") {
				if (method === "item/completed" && typeof item.text === "string") {
					const previous = turn.text.get(id) ?? "";
					const value = item.text.slice(0, limit);
					turn.text.set(id, value);
					if (item.phase === "final_answer") turn.final.set(id, value);
					if (value.startsWith(previous) && value.length > previous.length) this.options.onEvent({ type: "text_delta", text: value.slice(previous.length) });
				}
			} else if (!["userMessage", "reasoning", "plan"].includes(String(item.type))) {
				if (method === "item/started") this.options.onEvent({ type: "tool_start", id, name: String(item.type), input: item });
				else this.options.onEvent({ type: "tool_end", id, isError: ["failed", "declined", "cancelled"].includes(String(item.status)), output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(0, limit) : undefined });
			}
		} else if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(method)) {
			this.options.onEvent({ type: "tool_update", id: text(params.itemId), text: text(params.delta, true) });
		} else if (method === "turn/plan/updated") {
			const plan = externalPlan(params.plan, "step", params.explanation);
			if (plan) this.options.onEvent(plan);
		} else if (method === "thread/tokenUsage/updated") {
			// `total` is cumulative for the thread (a resumed one included); report this turn's share.
			const usage = object(params.tokenUsage);
			const total = object(usage.total ?? {});
			const last = object(usage.last ?? {});
			const input = numeric(total.inputTokens), output = numeric(total.outputTokens);
			const cached = numeric(total.cachedInputTokens) ?? 0;
			const lastInput = numeric(last.inputTokens);
			const lastCached = numeric(last.cachedInputTokens) ?? 0;
			if (input === undefined || output === undefined) {
				this.options.onEvent({ type: "usage",
					inputTokens: lastInput === undefined ? undefined : Math.max(0, lastInput - lastCached),
					cachedInputTokens: lastCached || undefined, outputTokens: numeric(last.outputTokens) });
				return;
			}
			turn.baseline ??= { input: Math.max(0, input - (lastInput ?? 0)), output: Math.max(0, output - (numeric(last.outputTokens) ?? 0)),
				cached: Math.max(0, cached - lastCached) };
			const cacheRead = Math.max(0, cached - turn.baseline.cached);
			this.options.onEvent({ type: "usage", inputTokens: Math.max(0, input - turn.baseline.input - cacheRead),
				outputTokens: Math.max(0, output - turn.baseline.output), ...(cacheRead ? { cachedInputTokens: cacheRead } : {}) });
		} else if (method === "error") {
			// A retried error is progress information; a final one arrives with turn/completed.
			const error = object(params.error ?? {});
			const message = typeof error.message === "string" ? redactDiagnostic(error.message, this.options.env).slice(0, 2000) : "Codex reported an error";
			this.options.onEvent({ type: "diagnostic", message: params.willRetry === true ? `Codex 正在重试：${message}` : `Codex 错误：${message}` });
		} else if (method === "turn/completed") {
			const completed = object(params.turn);
			if (turn.id && completed.id !== turn.id) return;
			this.active = undefined;
			this.cancelPermissions();
			if (completed.status === "failed") {
				const error = completed.error && typeof completed.error === "object" ? object(completed.error) : {};
				const message = typeof error.message === "string" ? redactDiagnostic(error.message, this.options.env).slice(0, 4000) : "Codex turn failed";
				const details = typeof error.additionalDetails === "string" ? `\n${redactDiagnostic(error.additionalDetails, this.options.env).slice(0, 2000)}` : "";
				const kind = codexErrorKind(error.codexErrorInfo);
				turn.reject(kind ? new ExternalFailure(kind, message + details) : new Error(message + details));
			} else turn.resolve({ status: turn.cancelled || completed.status === "interrupted" ? "cancelled" : "completed", text: this.output(turn), sessionId: this.nativeId });
		}
	}

	private async request(method: string, params: RecordValue, id: RpcId): Promise<unknown> {
		const controller = new AbortController();
		this.requestCancels.set(String(id), controller);
		try { return await this.handleRequest(method, params, id, controller.signal); }
		finally { this.requestCancels.delete(String(id)); }
	}

	private async handleRequest(method: string, params: RecordValue, id: RpcId, signal: AbortSignal): Promise<unknown> {
		if (this.closed || !this.active || params.threadId !== this.nativeId || (this.active.id && params.turnId !== undefined && params.turnId !== this.active.id))
			throw new Error("Codex request does not belong to the active task");
		const requestId = String(id);
		if (method === "item/commandExecution/requestApproval") {
			if (this.readOnly) return { decision: "decline" };
			if (params.kind !== undefined && !["command", "writeStdin"].includes(String(params.kind))) return { decision: "decline" };
			const item = this.items.get(String(params.itemId));
			// A cached shell's original launch command cannot authorize later terminal input.
			const command = typeof params.command === "string" ? params.command : params.kind === "writeStdin" ? undefined : item?.command;
			if (typeof command !== "string") return { decision: "decline" };
			const response = await this.permission({ id: requestId, kind: "command", toolName: "bash", input: { command, cwd: params.cwd ?? this.options.cwd, kind: params.kind ?? "command", ...(params.networkApprovalContext ? { network: params.networkApprovalContext } : {}) }, description: typeof params.reason === "string" ? params.reason : undefined }, signal);
			return { decision: decision(response) };
		}
		if (method === "item/fileChange/requestApproval") {
			if (this.readOnly) return { decision: "decline" };
			const item = this.items.get(String(params.itemId));
			const changes = item?.changes;
			if (!Array.isArray(changes) || !changes.length) return { decision: "decline" };
			for (let index = 0; index < changes.length; index++) {
				const change = object(changes[index]);
				if (typeof change.path !== "string") return { decision: "decline" };
				const kind = typeof change.kind === "object" && change.kind ? object(change.kind).type : change.kind;
				const response = await this.permission({ id: `${requestId}.${index}`, kind: "file", toolName: kind === "add" ? "write" : "edit", input: { path: change.path, changes: [change] }, description: typeof params.reason === "string" ? params.reason : undefined }, signal);
				if (response.decision !== "allow") return { decision: decision(response) };
			}
			return { decision: "accept" };
		}
		if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
			const response = await this.permission({ id: requestId, kind: "question", toolName: "AskUserQuestion", input: { questions: params.questions } }, signal);
			if (response.decision !== "allow") { void this.interrupt(); return { answers: {} }; }
			return { answers: Object.fromEntries(Object.entries(response.answers ?? {}).map(([key, value]) => [key, { answers: Array.isArray(value) ? value : [value] }])) };
		}
		if (method === "item/permissions/requestApproval") {
			// Do not grant additional filesystem/network authority through this adapter.
			await this.permission({ id: requestId, kind: "permissions", toolName: "request_permissions", input: { requestedPermissions: params.permissions }, description: "Codex requested authority beyond the task sandbox; this adapter cannot grant it." }, signal);
			return { permissions: {}, scope: "turn" };
		}
		if (method === "mcpServer/elicitation/request") {
			const response = await this.permission({ id: requestId, kind: "question", toolName: "mcp__elicitation", input: params }, signal);
			return response.decision === "allow" ? { action: "accept", content: response.answers ?? {} } : { action: response.decision === "cancel" ? "cancel" : "decline" };
		}
		throw new Error(`Unsupported Codex request: ${method}`);
	}

	private async permission(request: ExternalApprovalRequest, signal: AbortSignal): Promise<ExternalApprovalResponse> {
		if (signal.aborted) return { decision: "cancel" };
		let cancel!: () => void;
		const cancelled = new Promise<ExternalApprovalResponse>((resolve) => { cancel = () => resolve({ decision: "cancel" }); });
		this.permissionCancels.add(cancel);
		signal.addEventListener("abort", cancel, { once: true });
		try { return await Promise.race([this.options.onPermission(request, signal), cancelled]); }
		finally { signal.removeEventListener("abort", cancel); this.permissionCancels.delete(cancel); }
	}
	private cancelPermissions(): void {
		for (const controller of this.requestCancels.values()) controller.abort(new Error("Codex approval cancelled"));
		this.requestCancels.clear();
		for (const cancel of this.permissionCancels) cancel();
		this.permissionCancels.clear();
	}
	private output(turn: Turn): string {
		const messages = [...(turn.final.size ? turn.final : turn.text).values()];
		return (this.options.outputSchema ? messages.at(-1) ?? "" : messages.join("\n")).slice(0, limit);
	}
	private fail(error: Error): void { this.cancelPermissions(); this.active?.started(); this.active?.reject(error); this.active = undefined; }
}

function object(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex protocol object");
	return value as RecordValue;
}
function text(value: unknown, empty = false): string {
	if (typeof value !== "string" || (!empty && !value) || value.length > 8 * 1024 * 1024) throw new Error("Invalid Codex protocol text");
	return value;
}
function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function decision(value: ExternalApprovalResponse): "accept" | "decline" | "cancel" { return value.decision === "allow" ? "accept" : value.decision === "cancel" ? "cancel" : "decline"; }
async function bounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try { return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
	finally { clearTimeout(timer); }
}
