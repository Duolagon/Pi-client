import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { evaluatePermission, validateRuntimePolicy } from "./permission-policy.ts";
import type { RuntimePermissionPolicy } from "./permission-types.ts";
import type { ExternalAdapterEvent, ExternalApprovalRequest, ExternalApprovalResponse, ExternalTurnResult } from "./external-types.ts";

export interface ClaudeHelperConfig {
	executable: string;
	cwd: string;
	resumeSessionId?: string;
	policy: RuntimePermissionPolicy;
}
export type ClaudeHelperRequest =
	| { type: "init"; id: string; config: ClaudeHelperConfig }
	| { type: "run"; id: string; prompt: string }
	| { type: "interrupt" | "close"; id: string }
	| { type: "permission_response"; id: string; response: ExternalApprovalResponse };
export type ClaudeHelperPacket =
	| { type: "response"; id: string; ok: true; value?: unknown }
	| { type: "response"; id: string; ok: false; error: string }
	| { type: "event"; event: ExternalAdapterEvent }
	| { type: "permission_cancelled"; id: string; reason: string }
	| { type: "permission"; request: ExternalApprovalRequest };

type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
const nativeNames: Record<string, string> = {
	Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", Bash: "bash", Grep: "grep", Glob: "find", LS: "ls",
};

/** Preserve native arguments while exposing the common file selector used by the host. */
export function claudePermissionCall(name: string, input: Record<string, unknown>, cwd: string) {
	const mapped = nativeNames[name] ?? name;
	const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
	return { toolName: mapped, input: { ...input, ...(path ? { path: resolve(cwd, path) } : {}) } };
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
	private values: SDKUserMessage[] = [];
	private waiter?: (value: IteratorResult<SDKUserMessage>) => void;
	private ended = false;
	push(value: SDKUserMessage): void {
		if (this.ended) throw new Error("Claude input is closed");
		if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
		else this.values.push(value);
	}
	end(): void { this.ended = true; this.values = []; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return { next: () => {
			const value = this.values.shift();
			if (value) return Promise.resolve({ value, done: false });
			if (this.ended) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve) => { this.waiter = resolve; });
		} };
	}
}

/** A testable SDK host. The wire process only forwards these packets and owns its stdin lifetime. */
export class ClaudeSdkHelper {
	private config?: ClaudeHelperConfig;
	private native?: Query;
	private queue = new InputQueue();
	private loop?: Promise<void>;
	private current?: { id: string; text: string; streamed: boolean; cancelled: boolean };
	private permissions = new Map<string, { resolve: (response: ExternalApprovalResponse) => void; signal: AbortSignal; abort: () => void; timer: NodeJS.Timeout }>();
	private started = new Set<string>();
	private finished = new Set<string>();
	private sessionId?: string;
	private closed = false;
	private cleanup?: Promise<void>;
	private send: (packet: ClaudeHelperPacket) => void;
	private factory: QueryFactory;
	private approvalTimeoutMs: number;
	constructor(send: (packet: ClaudeHelperPacket) => void, factory: QueryFactory = query, approvalTimeoutMs = 15 * 60 * 1000) {
		if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 1 || approvalTimeoutMs > 15 * 60 * 1000) throw new Error("Invalid Claude approval timeout");
		this.send = send; this.factory = factory; this.approvalTimeoutMs = approvalTimeoutMs;
	}

	async receive(value: unknown): Promise<void> {
		const request = record(value);
		if (typeof request.id !== "string" || !request.id || request.id.length > 300) throw new Error("Invalid Claude helper request ID");
		try {
			if (request.type === "permission_response") {
				const response = permissionResponse(request.response);
				const pending = this.permissions.get(request.id);
				if (pending) { this.permissions.delete(request.id); clearTimeout(pending.timer); pending.signal.removeEventListener("abort", pending.abort); pending.resolve(response); }
				return;
			}
			if (request.type === "init") {
				if (this.config || this.closed) throw new Error("Claude helper already initialized or closed");
				const config = record(request.config);
				if (typeof config.executable !== "string" || !isAbsolute(config.executable) || typeof config.cwd !== "string" || !isAbsolute(config.cwd)) throw new Error("Claude executable and project must be absolute paths");
				if (config.resumeSessionId !== undefined && (typeof config.resumeSessionId !== "string" || !/^[a-zA-Z0-9_-]{1,300}$/.test(config.resumeSessionId))) throw new Error("Invalid Claude resume session");
				this.config = { executable: config.executable, cwd: config.cwd, policy: validateRuntimePolicy(config.policy), resumeSessionId: config.resumeSessionId as string | undefined };
				this.sessionId = this.config.resumeSessionId;
				this.start();
				await this.native!.initializationResult();
				this.respond(request.id, undefined);
				return;
			}
			if (!this.config || this.closed) throw new Error("Claude helper is unavailable");
			if (request.type === "run") {
				if (typeof request.prompt !== "string" || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 2 * 1024 * 1024) throw new Error("Invalid Claude prompt");
				if (this.current) throw new Error("Claude already has a running turn");
				this.current = { id: request.id, text: "", streamed: false, cancelled: false };
				this.started.clear(); this.finished.clear();
				if (!this.native) this.start();
				this.queue.push({ type: "user", message: { role: "user", content: request.prompt }, parent_tool_use_id: null });
				return;
			}
			if (request.type === "interrupt") {
				if (this.current) this.current.cancelled = true;
				this.cancelPermissions();
				await this.native?.interrupt();
				this.respond(request.id, undefined);
				return;
			}
			if (request.type === "close") { await this.close(); this.respond(request.id, undefined); return; }
			throw new Error("Unsupported Claude helper request");
		} catch (error) {
			if (request.type === "run" && this.current?.id === request.id) this.current = undefined;
			this.send({ type: "response", id: request.id, ok: false, error: message(error) });
		}
	}

	close(): Promise<void> {
		if (this.cleanup) return this.cleanup;
		this.cleanup = this.dispose();
		return this.cleanup;
	}
	private async dispose(): Promise<void> {
		this.closed = true;
		this.cancelPermissions();
		this.queue.end();
		const native = this.native;
		void native?.interrupt().catch(() => {});
		native?.close();
		if (this.current) this.finish({ status: "cancelled", text: this.current.text, sessionId: this.sessionId });
		if (native) {
			let timer: NodeJS.Timeout | undefined;
			try { await Promise.race([native.return(undefined).catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2500); })]); }
			finally { clearTimeout(timer); }
		}
	}

	private start(): void {
		const config = this.config!;
		const readonly = config.policy.mode === "read";
		const options: Options = {
			cwd: config.cwd,
			pathToClaudeCodeExecutable: config.executable,
			resume: config.resumeSessionId,
			includePartialMessages: true,
			permissionMode: readonly ? "plan" : "default",
			settingSources: ["user", "project", "local"],
			...(readonly ? { tools: ["Read", "Grep", "Glob", "LS"] } : {}),
			// SDK hooks remain in force even when native permission settings would auto-allow.
			hooks: {
				// The helper's approval deadline is shorter than this native hook timeout.
				// Old local CLIs do not implement onFailure:block; every callback path returns deny on failure.
				PreToolUse: [{ timeout: 3600, hooks: [async (input, toolUseID, context) => {
					try {
					if (input.hook_event_name !== "PreToolUse") return {};
					const args = record(input.tool_input);
					const id = input.tool_use_id || toolUseID || randomUUID();
					this.toolStart(id, input.tool_name, args);
					const response = await this.authorize(id, input.tool_name, args, context.signal);
					if (response.decision !== "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: response.decision === "cancel" ? "Host cancelled this operation" : "Host denied this operation" } };
					return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...(input.tool_name === "AskUserQuestion" ? { updatedInput: { ...args, answers: answerStrings(response.answers) } } : {}) } };
					} catch (error) { return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Host authorization failed: ${message(error)}` } }; }
				}] }],
				PostToolUse: [{ hooks: [async (input) => {
					if (input.hook_event_name === "PostToolUse") this.toolEnd(input.tool_use_id, false, printable(input.tool_response));
					return {};
				}] }],
				PostToolUseFailure: [{ hooks: [async (input) => {
					if (input.hook_event_name === "PostToolUseFailure") this.toolEnd(input.tool_use_id, true, input.error);
					return {};
				}] }],
			},
			canUseTool: async (name, args, context) => {
				try {
				const response = await this.authorize(context.toolUseID, name, args, context.signal, context.decisionReason);
				return response.decision === "allow"
					? { behavior: "allow", updatedInput: name === "AskUserQuestion" ? { ...args, answers: answerStrings(response.answers) } : args }
					: { behavior: "deny", message: "Host denied or cancelled this operation", interrupt: response.decision === "cancel" };
				} catch (error) { return { behavior: "deny", message: `Host authorization failed: ${message(error)}` }; }
			},
			stderr: (data) => this.event({ type: "diagnostic", message: redact(data).slice(0, 8000) }),
		};
		this.native = this.factory({ prompt: this.queue, options });
		this.loop = this.consume(this.native);
		void this.loop.catch(() => {});
	}

	private async authorize(nativeId: string, name: string, input: Record<string, unknown>, signal: AbortSignal, description?: string): Promise<ExternalApprovalResponse> {
		if (this.closed || signal.aborted || this.current?.cancelled) return { decision: "cancel" };
		const call = claudePermissionCall(name, input, this.config!.cwd);
		const local = await evaluatePermission(this.config!.policy, call);
		if (local.action === "deny") return { decision: "deny" };
		const id = `${nativeId || "claude"}:${randomUUID()}`;
		const request: ExternalApprovalRequest = { id, kind: name === "AskUserQuestion" ? "question" : name === "Bash" ? "command" : ["Edit", "Write", "MultiEdit"].includes(name) ? "file" : "tool", toolName: name, input: call.input, description: description ?? local.reason };
		const response = await new Promise<ExternalApprovalResponse>((resolve) => {
			const abort = () => { this.permissions.delete(id); clearTimeout(timer); this.send({ type: "permission_cancelled", id, reason: "Claude cancelled this approval" }); resolve({ decision: "cancel" }); };
			const timer = setTimeout(() => {
				this.permissions.delete(id); signal.removeEventListener("abort", abort);
				this.send({ type: "permission_cancelled", id, reason: "Claude approval timed out; operation denied" });
				resolve({ decision: "deny" });
			}, this.approvalTimeoutMs);
			this.permissions.set(id, { resolve, signal, abort, timer });
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			else this.send({ type: "permission", request });
		});
		if (name === "AskUserQuestion" && response.decision === "allow" && !response.answers) return { decision: "deny" };
		return response;
	}
	private async consume(native: Query): Promise<void> {
		try {
			for await (const message of native) this.consumeMessage(message);
			if (this.current) throw new Error("Claude ended without a turn result");
		} catch (error) {
			if (this.current?.cancelled || this.closed) { if (this.current) this.finish({ status: "cancelled", text: this.current.text, sessionId: this.sessionId }); }
			else if (this.current) { const id = this.current.id; this.current = undefined; this.send({ type: "response", id, ok: false, error: message(error) }); }
			this.native?.close();
			this.native = undefined;
			this.queue.end();
			this.queue = new InputQueue();
			if (this.config) this.config.resumeSessionId = this.sessionId;
		} finally {
			if (this.native === native) {
				native.close(); this.native = undefined;
				this.queue.end(); this.queue = new InputQueue();
				if (this.config) this.config.resumeSessionId = this.sessionId;
			}
		}
	}
	private consumeMessage(raw: SDKMessage): void {
		const item = raw as unknown as Record<string, unknown>;
		if (typeof item.session_id === "string" && this.sessionId !== item.session_id) {
			this.sessionId = item.session_id;
			this.event({ type: "session", sessionId: item.session_id });
		}
		if (item.type === "stream_event") {
			const event = record(item.event);
			const delta = event.delta && typeof event.delta === "object" ? record(event.delta) : undefined;
			if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
				if (this.current) { this.current.text += delta.text; this.current.streamed = true; }
				this.event({ type: "text_delta", text: delta.text });
			}
		}
		if ((item.type === "assistant" || item.type === "user") && item.message && typeof item.message === "object") {
			const content = record(item.message).content;
			if (Array.isArray(content)) for (const block of content) {
				const value = record(block);
				if (value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") this.toolStart(value.id, value.name, value.input);
				if (value.type === "tool_result" && typeof value.tool_use_id === "string") this.toolEnd(value.tool_use_id, Boolean(value.is_error), printable(value.content));
			}
		}
		if (item.type === "tool_progress" && typeof item.tool_use_id === "string") this.event({ type: "tool_update", id: item.tool_use_id, text: typeof item.elapsed_time_seconds === "number" ? `${item.elapsed_time_seconds}s` : "Running" });
		if (item.type === "result" && this.current) {
			const usage = item.usage && typeof item.usage === "object" ? record(item.usage) : {};
			this.event({ type: "usage", inputTokens: numeric(usage.input_tokens), outputTokens: numeric(usage.output_tokens) });
			if (item.is_error && !this.current.cancelled) {
				const id = this.current.id;
				this.current = undefined;
				this.send({ type: "response", id, ok: false, error: Array.isArray(item.errors) ? item.errors.map(String).join("\n").slice(0, 8000) : `Claude returned ${String(item.subtype)}` });
				return;
			}
			const text = typeof item.result === "string" ? item.result : this.current.text;
			if (!this.current.streamed && text) this.event({ type: "text_delta", text });
			this.finish({ status: this.current.cancelled ? "cancelled" : "completed", text, sessionId: this.sessionId });
		}
	}
	private toolStart(id: string, name: string, input: unknown): void { if (!this.started.has(id)) { this.started.add(id); this.event({ type: "tool_start", id, name, input }); } }
	private toolEnd(id: string, isError: boolean, output?: string): void { if (!this.finished.has(id)) { this.finished.add(id); this.event({ type: "tool_end", id, isError, output: output?.slice(0, 128 * 1024) }); } }
	private event(event: ExternalAdapterEvent): void { this.send({ type: "event", event }); }
	private respond(id: string, value: unknown): void { this.send({ type: "response", id, ok: true, value }); }
	private finish(value: ExternalTurnResult): void { if (this.current) { const id = this.current.id; this.current = undefined; this.cancelPermissions(); this.respond(id, value); } }
	private cancelPermissions(): void { for (const [id, pending] of this.permissions) { clearTimeout(pending.timer); pending.signal.removeEventListener("abort", pending.abort); this.send({ type: "permission_cancelled", id, reason: "Claude turn ended or was cancelled" }); pending.resolve({ decision: "cancel" }); this.permissions.delete(id); } }
}

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Claude protocol object"); return value as Record<string, unknown>; }
function message(error: unknown): string { return redact(error instanceof Error ? error.message : String(error)).slice(0, 8000); }
function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function printable(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? ""; }
function answerStrings(answers: ExternalApprovalResponse["answers"]): Record<string, string> { return Object.fromEntries(Object.entries(answers ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])); }
function permissionResponse(value: unknown): ExternalApprovalResponse {
	const input = record(value);
	if (typeof input.decision !== "string" || !["allow", "deny", "cancel"].includes(input.decision)) throw new Error("Invalid Claude permission decision");
	if (input.answers !== undefined) {
		const answers = record(input.answers);
		if (Object.values(answers).some((answer) => typeof answer !== "string" && !(Array.isArray(answer) && answer.every((value) => typeof value === "string")))) throw new Error("Invalid Claude question answers");
	}
	return { decision: input.decision as ExternalApprovalResponse["decision"], answers: input.answers as ExternalApprovalResponse["answers"] };
}
function redact(text: string): string {
	for (const [name, value] of Object.entries(process.env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value && value.length >= 8) text = text.split(value).join("[REDACTED]");
	return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	let writes = Promise.resolve();
	const helper = new ClaudeSdkHelper((packet) => {
		writes = writes.then(() => new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(packet)}\n`, (error) => error ? reject(error) : resolve())));
		void writes.catch(() => { void helper.close(); });
	});
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	process.stdout.on("error", () => { input.close(); void helper.close().finally(() => process.exit(1)); });
	input.on("line", (line) => {
		if (Buffer.byteLength(line) > 3 * 1024 * 1024) { void helper.close(); input.close(); return; }
		try { void helper.receive(JSON.parse(line)).catch(() => { void helper.close(); input.close(); }); }
		catch { void helper.close(); input.close(); }
	});
	input.once("close", () => { void helper.close().then(() => writes).finally(() => process.exit(0)); });
	process.once("SIGTERM", () => { void helper.close().then(() => writes).finally(() => process.exit(0)); });
}
