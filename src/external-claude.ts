import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ClaudeHelperConfig, ClaudeHelperPacket, ClaudeHelperRequest } from "./external-claude-helper.ts";
import type { ExternalAdapter, ExternalSession, ExternalSessionOptions, ExternalTurnResult } from "./external-types.ts";
import { ExternalFailure, redactDiagnostic, withDiagnostics } from "./external-errors.ts";

export class ClaudeAdapter implements ExternalAdapter {
	async open(options: ExternalSessionOptions): Promise<ExternalSession> {
		if (!options.helperPath || !isAbsolute(options.helperPath)) throw new Error("Claude SDK helper is missing; rebuild the desktop runtime");
		if (!isAbsolute(options.executable) || !isAbsolute(options.cwd)) throw new Error("Claude executable and working directory must be absolute paths");
		const session = new ClaudeSession(options);
		try { await session.initialize(); return session; }
		catch (error) { await session.close(); throw withDiagnostics(error, session.diagnostics()); }
	}
}

class ClaudeSession implements ExternalSession {
	private options: ExternalSessionOptions;
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
	private writeQueue = Promise.resolve();
	private failure?: Error;
	private ended = false;
	private closing = false;
	private active?: { controller: AbortController; completion: Promise<ExternalTurnResult> };
	private nativeSessionId?: string;
	private approvalGeneration = 0;
	private approvals = new Map<string, AbortController>();
	private exit: Promise<void>;
	private stderr = "";
	constructor(options: ExternalSessionOptions) {
		this.options = options;
		this.nativeSessionId = options.resumeSessionId;
		const environment: NodeJS.ProcessEnv = { ...options.env, ELECTRON_RUN_AS_NODE: "1" };
		// Do not inherit desktop IPC tokens or Pi provider keys into another agent.
		for (const key of Object.keys(environment)) if (key.startsWith("PI_DESKTOP_") || key.startsWith("PI_CODING_AGENT_")) delete environment[key];
		delete environment.CLAUDECODE;
		this.child = spawn(options.nodeExecutable ?? process.execPath, [options.helperPath!], {
			cwd: options.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.exit = new Promise((resolve) => this.child.once("close", () => { this.ended = true; resolve(); }));
		this.child.once("error", (error) => this.fail(error));
		this.child.stdin.on("error", (error) => this.fail(error));
		this.child.once("close", (code, signal) => this.fail(new Error(`Claude helper exited (${code ?? signal}). ${this.diagnostics()}`)));
		const errors = new StringDecoder("utf8");
		this.child.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + errors.write(data)).slice(-16000); });
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.child.stdout.on("data", (data: Buffer) => {
			buffer += decoder.write(data);
			if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { this.fail(new Error("Claude helper frame exceeds the limit")); this.kill("SIGTERM"); return; }
			for (;;) {
				const boundary = buffer.indexOf("\n");
				if (boundary < 0) break;
				const line = buffer.slice(0, boundary).replace(/\r$/, "");
				buffer = buffer.slice(boundary + 1);
				if (!line) continue;
				let value: unknown;
				try { value = JSON.parse(line); }
				catch { this.fail(new Error("Claude helper returned an invalid JSONL protocol message")); this.kill("SIGTERM"); return; }
				try { this.receive(value); }
				catch (error) { this.fail(new Error(`Claude helper protocol error: ${error instanceof Error ? error.message : String(error)}`)); this.kill("SIGTERM"); return; }
			}
		});
	}
	get sessionId(): string | undefined { return this.nativeSessionId; }
	diagnostics(): string { return redactDiagnostic(this.stderr, this.options.env).slice(-8000); }
	async initialize(): Promise<void> {
		await this.request({ type: "init", id: randomUUID(), config: {
			executable: this.options.executable, cwd: this.options.cwd, policy: this.options.policy, resumeSessionId: this.options.resumeSessionId,
			projectTrusted: this.options.projectTrusted === true,
			maxBudgetUsd: this.options.maxBudgetUsd,
			...(this.options.model ? { model: this.options.model } : {}),
			...(this.options.effort ? { effort: this.options.effort as ClaudeHelperConfig["effort"] } : {}),
			...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
		} }, 15000);
	}
	async run(prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult> {
		if (this.closing || this.failure) throw this.failure ?? new Error("Claude session is closed");
		if (this.active) throw new Error("Claude session already has an active turn");
		if (!prompt.trim() || Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new Error("Invalid Claude prompt");
		signal?.throwIfAborted();
		const controller = new AbortController();
		const completion = this.request({ type: "run", id: randomUUID(), prompt }) as Promise<ExternalTurnResult>;
		const active = { controller, completion };
		this.active = active;
		const abort = () => { void this.interrupt().catch(() => {}); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const result = await completion;
			if (!result || !["completed", "cancelled"].includes(result.status) || typeof result.text !== "string") throw new Error("Claude helper returned an invalid turn result");
			if (result.sessionId) this.nativeSessionId = result.sessionId;
			return result;
		} finally {
			signal?.removeEventListener("abort", abort);
			controller.abort();
			this.approvalGeneration++;
			this.cancelApprovals();
			if (this.active === active) this.active = undefined;
		}
	}
	async steer(message: string): Promise<boolean> {
		if (!this.active || this.ended || this.closing) return false;
		return await this.request({ type: "steer", id: randomUUID(), prompt: message }, 4000) === true;
	}

	async interrupt(): Promise<void> {
		if (!this.active || this.ended) return;
		this.active.controller.abort();
		this.approvalGeneration++;
		this.cancelApprovals();
		try {
			await this.request({ type: "interrupt", id: randomUUID() }, 5000);
			await bounded(this.active?.completion.then(() => {}, () => {}), 5000, "Claude cancellation was not acknowledged");
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			await this.close();
			throw error;
		}
	}
	async close(): Promise<void> {
		if (this.closing) { await this.exit; return; }
		this.closing = true;
		this.active?.controller.abort();
		this.approvalGeneration++;
		this.cancelApprovals();
		if (!this.ended) {
			if (!this.failure) await this.request({ type: "close", id: randomUUID() }, 4000).catch(() => {});
			this.child.stdin.end();
			await Promise.race([this.exit, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
			if (!this.ended) this.kill("SIGTERM");
			await Promise.race([this.exit, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
			if (!this.ended) this.kill("SIGKILL");
			await this.exit;
		}
		// A helper can exit before a native worker has drained. The detached group is ours.
		if (process.platform !== "win32" && this.child.pid) {
			try {
				process.kill(-this.child.pid, "SIGTERM");
				await new Promise((resolve) => setTimeout(resolve, 100));
				try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* Group already exited. */ }
			} catch { /* No processes remain in the managed group. */ }
		}
		this.fail(new Error("Claude session is closed"));
	}
	private receive(input: unknown): void {
		if (!input || typeof input !== "object" || !("type" in input)) throw new Error("Invalid packet");
		const packet = input as ClaudeHelperPacket;
		if (packet.type === "response") {
			const pending = this.pending.get(packet.id);
			if (!pending) return;
			this.pending.delete(packet.id); clearTimeout(pending.timer);
			if (packet.ok) pending.resolve(packet.value);
			else {
				const detail = typeof packet.error === "string" ? redactDiagnostic(packet.error, this.options.env).slice(0, 8000) : "Claude helper request failed";
				pending.reject(packet.kind && ["auth", "quota", "refusal", "rate_limit", "context"].includes(packet.kind)
					? new ExternalFailure(packet.kind, detail) : new Error(detail));
			}
		} else if (packet.type === "event") {
			if (!packet.event || typeof packet.event.type !== "string") throw new Error("Invalid event");
			if (packet.event.type === "session") this.nativeSessionId = packet.event.sessionId;
			this.options.onEvent(packet.event);
		} else if (packet.type === "permission_cancelled") {
			this.approvals.get(packet.id)?.abort(new Error(packet.reason));
			this.approvals.delete(packet.id);
		} else if (packet.type === "permission") {
			if (!packet.request || typeof packet.request.id !== "string" || typeof packet.request.toolName !== "string" || !packet.request.input || typeof packet.request.input !== "object") throw new Error("Invalid approval request");
			const generation = this.approvalGeneration;
			if (!this.active || this.active.controller.signal.aborted) { void this.write({ type: "permission_response", id: packet.request.id, response: { decision: "cancel" } }); return; }
			const controller = new AbortController();
			this.approvals.set(packet.request.id, controller);
			void this.options.onPermission(packet.request, controller.signal).then((response) => {
				if (generation === this.approvalGeneration && !this.closing && !controller.signal.aborted) return this.write({ type: "permission_response", id: packet.request.id, response });
			}, () => { if (generation === this.approvalGeneration && !this.closing && !controller.signal.aborted) return this.write({ type: "permission_response", id: packet.request.id, response: { decision: "deny" } }); }).catch((error) => this.fail(error)).finally(() => { if (this.approvals.get(packet.request.id) === controller) this.approvals.delete(packet.request.id); });
		} else throw new Error("Unknown packet");
	}
	private request(command: ClaudeHelperRequest, timeout?: number): Promise<unknown> {
		if (this.failure || this.ended) return Promise.reject(this.failure ?? new Error("Claude helper is closed"));
		return new Promise((resolve, reject) => {
			const timer = timeout === undefined ? undefined : setTimeout(() => { this.pending.delete(command.id); reject(new Error(`Claude helper timed out: ${command.type}`)); }, timeout);
			this.pending.set(command.id, { resolve, reject, timer });
			void this.write(command).catch((error) => this.fail(error));
		});
	}
	private write(command: ClaudeHelperRequest): Promise<void> {
		this.writeQueue = this.writeQueue.then(() => new Promise<void>((resolve, reject) => {
			if (this.failure || this.ended) return reject(this.failure ?? new Error("Claude helper is closed"));
			this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => error ? reject(error) : resolve());
		}));
		return this.writeQueue;
	}
	private fail(error: Error): void {
		this.failure ??= error;
		this.cancelApprovals();
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
	}
	private cancelApprovals(): void { for (const controller of this.approvals.values()) controller.abort(); this.approvals.clear(); }
	private kill(signal: NodeJS.Signals): void {
		if (!this.child.pid || this.ended) return;
		try { if (process.platform !== "win32") process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { this.child.kill(signal); }
	}
}

async function bounded(promise: Promise<void> | undefined, timeout: number, error: string): Promise<void> {
	if (!promise) return;
	let timer: NodeJS.Timeout | undefined;
	try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(error)), timeout); })]); }
	finally { clearTimeout(timer); }
}
