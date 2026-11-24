import { isAbsolute } from "node:path";
import { JsonLineProcess, type RpcId } from "./external-rpc.ts";
import { validateRuntimePolicy } from "./permission-policy.ts";
import type {
	ExternalAdapter, ExternalApprovalOption, ExternalApprovalResponse,
	ExternalSession, ExternalSessionOptions, ExternalTurnResult,
} from "./external-types.ts";

const desktopTools = new Set([
	"Agent", "SendMessage", "AgentSend", "AgentExecutors", "TaskOutput", "TaskStop", "TaskList",
	"WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove",
]);
const outputLimit = 1024 * 1024;

/** How one ACP (Agent Client Protocol) CLI is launched and what it guarantees. */
export interface AcpProfile {
	/** Name used in errors, e.g. "Kimi". */
	label: string;
	args: string[];
	env: Record<string, string>;
	/** Kimi exposes session modes; the host must force its manual "default" mode. */
	requireDefaultMode: boolean;
	/** True when the CLI can run actions its own rules allow without asking the host (no forced manual mode). */
	selfApproves?: boolean;
	fallbackToolName: string;
	/** Shown when the CLI reports that it is not signed in. */
	loginHint?: string;
}

export const kimiProfile: AcpProfile = {
	label: "Kimi", args: ["acp"], env: { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" },
	requireDefaultMode: true, fallbackToolName: "kimi_tool",
};

/** ACP can forward native approvals, but does not authorize every native read/tool. */
export function assertAcpPolicy(options: ExternalSessionOptions, label: string, selfApproves = false): void {
	const policy = validateRuntimePolicy(options.policy);
	if (selfApproves && policy.dontAsk)
		throw new Error(`${label} ACP runs actions its own rules allow without asking the host, so dontAsk (deny anything not pre-approved) cannot be enforced; no external task was started`);
	if (policy.mode === "read" || policy.mode === "plan")
		throw new Error(`${label} ACP does not provide an enforceable read-only tool ceiling; use a different executor for Explore/Plan`);
	if (policy.rules.some((rule) => rule.action !== "allow" && !desktopTools.has(rule.tool)) || policy.disabledTools.some((name) => !desktopTools.has(name)))
		throw new Error(`${label} ACP cannot enforce the inherited fine-grained tool/path/command policy; no external task was started`);
}

export function assertKimiPolicy(options: ExternalSessionOptions): void {
	assertAcpPolicy(options, kimiProfile.label);
}

export class AcpAdapter implements ExternalAdapter {
	private profile: AcpProfile;
	constructor(profile: AcpProfile) { this.profile = profile; }
	async open(options: ExternalSessionOptions): Promise<ExternalSession> {
		const label = this.profile.label;
		assertAcpPolicy(options, label, this.profile.selfApproves === true);
		for (const [name, value] of [["executable", options.executable], ["cwd", options.cwd]])
			if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${label} ${name} must be an absolute local path`);
		if (options.resumeSessionId !== undefined) validText(options.resumeSessionId, "session ID", 300, label);
		const session = new AcpSession(options, this.profile);
		try { await session.initialize(); return session; }
		catch (error) { await session.close(); throw error; }
	}
}

export class KimiAdapter extends AcpAdapter {
	constructor() { super(kimiProfile); }
}

class AcpSession implements ExternalSession {
	private options: ExternalSessionOptions;
	private profile: AcpProfile;
	/** True once the host forced the CLI's manual mode; later switches to unattended modes are refused. */
	private modeGuard = false;
	private rpc: JsonLineProcess;
	private nativeId?: string;
	private closed = false;
	private accepting = false;
	private active?: Promise<ExternalTurnResult>;
	private cancelling?: Promise<void>;
	private cancelRequested = false;
	private capabilities: Record<string, unknown> = {};
	private text = "";
	private toolCalls = new Map<string, { name: string; input: Record<string, unknown>; ended: boolean }>();
	private approvalCancels = new Set<() => void>();
	private turn = 0;

	constructor(options: ExternalSessionOptions, profile: AcpProfile) {
		this.options = options;
		this.profile = profile;
		this.rpc = new JsonLineProcess({
			executable: options.executable, args: profile.args, cwd: options.cwd,
			env: { ...options.env, ...profile.env },
			onNotification: (method, params) => this.notification(method, params),
			onRequest: (method, params, id) => this.request(method, params, id),
		});
	}
	get sessionId(): string | undefined { return this.nativeId; }

	async initialize(): Promise<void> {
		try { await this.handshake(); }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.profile.loginHint && /authentication required/i.test(message))
				throw new Error(`${this.profile.label} 未登录：请先在终端运行 ${this.profile.loginHint} 登录一次。`);
			throw error;
		}
	}

	private async handshake(): Promise<void> {
		const label = this.profile.label;
		const initialized = this.record(await this.rpc.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-desktop", version: "0.1.0" },
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: true } },
		}), "initialize response");
		if (initialized.protocolVersion !== 1) throw new Error(`Unsupported ${label} ACP protocol version; expected ACP v1`);
		this.capabilities = optionalRecord(initialized.agentCapabilities);
		const resume = this.options.resumeSessionId;
		let restored: Record<string, unknown>;
		if (resume) {
			const sessionCapabilities = optionalRecord(this.capabilities.sessionCapabilities);
			const method = sessionCapabilities.resume !== undefined ? "session/resume"
				: this.capabilities.loadSession === true ? "session/load" : undefined;
			if (!method) throw new Error(`Installed ${label} ACP does not support restoring the requested session`);
			restored = this.record(await this.rpc.request(method, { sessionId: resume, cwd: this.options.cwd, mcpServers: [] }), "restored session");
			this.nativeId = restored.sessionId === undefined ? resume : this.text_(restored.sessionId, "session ID", 300);
			if (this.nativeId !== resume) throw new Error(`${label} restored a different session than requested`);
		} else {
			restored = this.record(await this.rpc.request("session/new", { cwd: this.options.cwd, mcpServers: [] }), "new session");
			this.nativeId = this.text_(restored.sessionId, "session ID", 300);
		}
		const modes = optionalRecord(restored.modes);
		const advertised = Array.isArray(modes.availableModes) && modes.availableModes.length > 0;
		const hasDefault = advertised && (modes.availableModes as unknown[]).some((mode) => optionalRecord(mode).id === "default");
		if (!hasDefault && (this.profile.requireDefaultMode || advertised))
			throw new Error(`Installed ${label} ACP does not expose its manual/default approval mode`);
		// A resumed session may have saved unattended mode. Never inherit it implicitly.
		if (hasDefault) {
			await this.rpc.request("session/set_mode", { sessionId: this.nativeId, modeId: "default" });
			this.modeGuard = true;
		}
		this.options.onEvent({ type: "session", sessionId: this.nativeId });
	}

	run(prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult> {
		if (this.closed) return Promise.reject(new Error(`${this.profile.label} session is closed`));
		if (this.active) return Promise.reject(new Error(`${this.profile.label} session already has an active turn`));
		if (!this.nativeId) return Promise.reject(new Error(`${this.profile.label} session has not initialized`));
		if (signal?.aborted) return Promise.resolve({ status: "cancelled", text: "", sessionId: this.nativeId });
		this.text_(prompt, "prompt", 2 * 1024 * 1024);
		this.text = "";
		this.toolCalls.clear();
		this.cancelRequested = false;
		this.accepting = true;
		this.turn++;
		const abort = () => { void this.interrupt().catch(() => {}); };
		const run = (async (): Promise<ExternalTurnResult> => {
			try {
				const result = this.record(await this.rpc.request("session/prompt", {
					sessionId: this.nativeId, prompt: [{ type: "text", text: prompt }],
				}, 0), "prompt response");
				const reason = result.stopReason;
				if (this.cancelRequested || reason === "cancelled") return { status: "cancelled", text: this.text, sessionId: this.nativeId };
				if (reason !== "end_turn") throw new Error(`${this.profile.label} turn did not complete: ${String(reason)}`);
				return { status: "completed", text: this.text, sessionId: this.nativeId };
			} catch (error) {
				if (this.cancelRequested) return { status: "cancelled", text: this.text, sessionId: this.nativeId };
				throw error;
			} finally {
				this.accepting = false;
				this.cancelApprovals();
				signal?.removeEventListener("abort", abort);
				this.active = undefined;
				this.cancelling = undefined;
			}
		})();
		this.active = run;
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return run;
	}

	interrupt(): Promise<void> {
		if (this.cancelling) return this.cancelling;
		if (!this.active || !this.nativeId || this.closed) return Promise.resolve();
		this.cancelRequested = true;
		this.cancelApprovals();
		const active = this.active;
		this.cancelling = (async () => {
			await this.rpc.notify("session/cancel", { sessionId: this.nativeId }).catch(() => {});
			if (!(await settledWithin(active, 5000))) {
				this.closed = true;
				await this.rpc.close();
			}
		})();
		return this.cancelling;
	}

	async close(): Promise<void> {
		if (this.closed) { await this.rpc.close(); return; }
		if (this.active) await this.interrupt();
		this.closed = true;
		this.cancelApprovals();
		if (this.nativeId && optionalRecord(this.capabilities.sessionCapabilities).close !== undefined)
			await this.rpc.request("session/close", { sessionId: this.nativeId }, 1500).catch(() => {});
		await this.rpc.close();
	}

	private notification(method: string, params: unknown): void {
		if (method !== "session/update") return;
		const packet = this.record(params, "session notification");
		// session/load replays old messages before returning. They are not a new turn.
		if (!this.accepting || packet.sessionId !== this.nativeId) return;
		const update = this.record(packet.update, "session update");
		if (update.sessionUpdate === "agent_message_chunk") {
			const content = optionalRecord(update.content);
			if (content.type !== "text" || typeof content.text !== "string") return;
			this.text = (this.text + content.text).slice(0, outputLimit);
			this.options.onEvent({ type: "text_delta", text: content.text });
		} else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const id = this.text_(update.toolCallId, "tool call ID", 500);
			const previous = this.toolCalls.get(id);
			const name = nativeToolName(update, previous?.name, this.profile.fallbackToolName);
			const input = update.rawInput === undefined ? previous?.input ?? {} : optionalRecord(update.rawInput);
			if (!previous) this.options.onEvent({ type: "tool_start", id, name, input });
			const output = contentText(update.content);
			if (output) this.options.onEvent({ type: "tool_update", id, text: output });
			const ended = update.status === "completed" || update.status === "failed";
			if (ended && !previous?.ended) this.options.onEvent({ type: "tool_end", id, isError: update.status === "failed", output });
			this.toolCalls.set(id, { name, input, ended: ended || Boolean(previous?.ended) });
		} else if (update.sessionUpdate === "current_mode_update") {
			if (this.modeGuard && update.currentModeId !== "default" && update.currentModeId !== "plan")
				throw new Error(`${this.profile.label} changed to an unattended mode outside the host approval flow`);
		}
	}

	private async request(method: string, params: unknown, id: RpcId): Promise<unknown> {
		if (!["session/request_permission", "elicitation/create"].includes(method))
			throw new Error(`Unsupported ${this.profile.label} client request: ${method}`);
		const packet = this.record(params, "client request");
		if (packet.sessionId !== this.nativeId || !this.accepting || this.cancelRequested)
			return method === "elicitation/create" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } };
		if (method === "elicitation/create") return this.elicitation(packet, id);
		const call = this.record(packet.toolCall, "permission tool call");
		const callId = this.text_(call.toolCallId, "permission tool call ID", 500);
		const known = this.toolCalls.get(callId);
		const choices = parseOptions(packet.options, this.profile.label);
		const isQuestion = call.title === "AskUserQuestion" || choices.some((choice) => /^q\d+_/.test(choice.id));
		const toolName = nativeToolName(call, known?.name, this.profile.fallbackToolName);
		const input = { ...(known?.input ?? {}), ...optionalRecord(call.rawInput) };
		const response = await this.approval(() => this.options.onPermission({
			id: String(id), kind: isQuestion ? "question" : toolName === "bash" ? "command" : ["write", "edit"].includes(toolName) ? "file" : "tool",
			toolName: isQuestion ? "AskUserQuestion" : toolName, input,
			description: contentText(call.content) || (typeof call.title === "string" ? call.title : undefined), options: choices,
		}));
		if (response.decision === "cancel") return { outcome: { outcome: "cancelled" } };
		const selected = response.optionId ? choices.find((choice) => choice.id === response.optionId)
			: choices.find((choice) => choice.kind === (response.decision === "allow" ? "allow_once" : "reject_once"));
		if (!selected || (response.decision === "allow" ? !selected.kind?.startsWith("allow_") : !selected.kind?.startsWith("reject_")))
			return { outcome: { outcome: "cancelled" } };
		return { outcome: { outcome: "selected", optionId: selected.id } };
	}

	private async elicitation(packet: Record<string, unknown>, id: RpcId): Promise<unknown> {
		if (packet.mode !== "form") return { action: "decline" };
		const schema = this.record(packet.requestedSchema, "question schema");
		const response = await this.approval(() => this.options.onPermission({
			id: String(id), kind: "question", toolName: "AskUserQuestion",
			input: { requestedSchema: schema }, description: typeof packet.message === "string" ? packet.message : undefined,
		}));
		if (response.decision !== "allow") return { action: response.decision === "cancel" ? "cancel" : "decline" };
		if (!validAnswers(schema, response.answers)) return { action: "decline" };
		return { action: "accept", content: response.answers };
	}

	private async approval(get: () => Promise<ExternalApprovalResponse>): Promise<ExternalApprovalResponse> {
		const turn = this.turn;
		let cancel!: () => void;
		const cancelled = new Promise<ExternalApprovalResponse>((resolve) => { cancel = () => resolve({ decision: "cancel" }); });
		this.approvalCancels.add(cancel);
		try {
			const response = await Promise.race([Promise.resolve().then(get).catch(() => ({ decision: "deny" as const })), cancelled]);
			return this.cancelRequested || !this.accepting || turn !== this.turn ? { decision: "cancel" } : response;
		} finally { this.approvalCancels.delete(cancel); }
	}
	private record(value: unknown, label: string): Record<string, unknown> { return record(value, label, this.profile.label); }
	private text_(value: unknown, label: string, max: number): string { return validText(value, label, max, this.profile.label); }
	private cancelApprovals(): void {
		for (const cancel of this.approvalCancels) cancel();
		this.approvalCancels.clear();
	}
}

function record(value: unknown, label: string, agent = "Kimi"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${agent} ${label}`);
	return value as Record<string, unknown>;
}
function optionalRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validText(value: unknown, label: string, max: number, agent = "Kimi"): string {
	if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new Error(`Invalid ${agent} ${label}`);
	return value;
}
function nativeToolName(call: Record<string, unknown>, previous: string | undefined, fallback: string): string {
	const title = typeof call.title === "string" ? call.title : "";
	const names: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", Bash: "bash", Terminal: "bash", Glob: "find", Grep: "grep" };
	if (names[title]) return names[title];
	if (previous) return previous;
	if (call.kind === "execute") return "bash";
	if (call.kind === "read") return "read";
	if (call.kind === "edit") return "edit";
	return title || fallback;
}
function contentText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.map((entry) => {
		const block = optionalRecord(entry);
		if (block.type === "content") {
			const content = optionalRecord(block.content);
			return content.type === "text" && typeof content.text === "string" ? content.text : "";
		}
		if (block.type === "diff") return `${typeof block.path === "string" ? block.path : ""}\n${typeof block.newText === "string" ? block.newText : ""}`;
		return "";
	}).filter(Boolean).join("\n").slice(0, outputLimit);
}
function parseOptions(value: unknown, agent: string): ExternalApprovalOption[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error(`Invalid ${agent} approval options`);
	return value.map((entry) => {
		const option = record(entry, "approval option", agent);
		if (!["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(option.kind))) throw new Error(`Invalid ${agent} approval option kind`);
		return { id: validText(option.optionId, "option ID", 500, agent), label: validText(option.name, "option label", 10000, agent), kind: option.kind as string };
	});
}
function validAnswers(schema: Record<string, unknown>, answers: ExternalApprovalResponse["answers"]): boolean {
	if (schema.type !== "object" || !answers) return false;
	const properties = optionalRecord(schema.properties);
	if (Object.keys(answers).some((key) => !Object.hasOwn(properties, key))) return false;
	if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(answers, key))) return false;
	for (const [key, value] of Object.entries(answers)) {
		const property = optionalRecord(properties[key]);
		const allowed = (entry: unknown, target: unknown): boolean => {
			const node = optionalRecord(entry);
			if (Array.isArray(node.enum)) return node.enum.includes(target);
			const options = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
			return options ? options.some((option) => optionalRecord(option).const === target) : typeof target === "string";
		};
		if (property.type === "string") { if (typeof value !== "string" || !allowed(property, value)) return false; }
		else if (property.type === "array") {
			if (!Array.isArray(value) || value.length < Number(property.minItems ?? 0) || value.length > 100 || value.some((item) => typeof item !== "string" || !allowed(property.items, item))) return false;
		} else return false;
	}
	return true;
}
async function settledWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try { return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
	finally { clearTimeout(timer); }
}
