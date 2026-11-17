import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type RpcId = string | number;
export interface JsonLineProcessOptions {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	onNotification(method: string, params: unknown): void;
	onRequest(method: string, params: unknown, id: RpcId): Promise<unknown>;
	onFailure?(error: Error): void;
}

/** JSONL transport shared by native agent adapters. It never starts a shell. */
export class JsonLineProcess {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
	private failure?: Error;
	private writes: Promise<void> = Promise.resolve();
	private closing?: Promise<void>;
	private exited = false;
	private stopping = false;
	private options: JsonLineProcessOptions;

	constructor(options: JsonLineProcessOptions) {
		this.options = options;
		this.child = spawn(options.executable, options.args, {
			cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true, detached: process.platform !== "win32",
		});
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.child.stdout.on("data", (chunk: Buffer) => {
			if (this.failure) return;
			buffer += decoder.write(chunk);
			let boundary: number;
			while ((boundary = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, boundary).replace(/\r$/, "");
				buffer = buffer.slice(boundary + 1);
				if (!line.trim()) continue;
				if (Buffer.byteLength(line) > 8 * 1024 * 1024) { this.fail(new Error("External agent protocol line is too large")); return; }
				try { this.receive(JSON.parse(line)); }
				catch { this.fail(new Error("External agent returned an invalid JSONL protocol message")); return; }
			}
			if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) this.fail(new Error("External agent protocol line is too large"));
		});
		this.child.stdout.once("end", () => {
			if (!this.stopping) this.fail(new Error(buffer.trim() ? "External agent closed with an incomplete protocol message" : "External agent closed its protocol stream"));
		});
		// Drain diagnostic output without leaking a native program's authentication/configuration text.
		this.child.stderr.on("data", () => {});
		this.child.once("error", (error) => this.fail(new Error(`External agent could not start: ${error.message}`)));
		this.child.stdin.on("error", () => this.fail(new Error("External agent input pipe closed")));
		this.child.once("close", (code, signal) => {
			this.exited = true;
			if (!this.stopping) this.fail(new Error(`External agent exited (${code ?? signal ?? "unknown"})`));
		});
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
		if (this.failure || this.stopping) return Promise.reject(this.failure ?? new Error("External agent is closed"));
		const id = randomUUID();
		const response = new Promise<T>((resolve, reject) => {
			const timer = timeoutMs > 0 ? setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`External agent request timed out: ${method}`));
			}, timeoutMs) : undefined;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
		});
		void this.write({ jsonrpc: "2.0", id, method, params }).catch((error: Error) => this.fail(error));
		return response;
	}

	notify(method: string, params?: unknown): Promise<void> {
		return this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.stopping = true;
		this.rejectPending(new Error("External agent is closed"));
		this.closing = (async () => {
			if (this.exited) return;
			await new Promise<void>((resolve) => {
				let settled = false;
				const done = () => { if (settled) return; settled = true; clearTimeout(kill); clearTimeout(limit); resolve(); };
				const kill = setTimeout(() => this.signal("SIGKILL"), 1000);
				const limit = setTimeout(done, 2000);
				this.child.once("close", done);
				this.child.stdin.end();
				this.signal("SIGTERM");
			});
		})();
		return this.closing;
	}

	private receive(value: unknown): void {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid protocol object");
		const record = value as Record<string, unknown>;
		if (record.jsonrpc !== undefined && record.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version");
		if (typeof record.method === "string") {
			if (record.id !== undefined) {
				if (typeof record.id !== "string" && typeof record.id !== "number") throw new Error("Invalid request id");
				const id = record.id;
				void Promise.resolve().then(() => this.options.onRequest(record.method as string, record.params, id)).then(
					(result) => this.write({ jsonrpc: "2.0", id, result }),
					(error) => this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: error instanceof Error ? error.message : "Unsupported external agent request" } }),
				).catch(() => {});
			} else this.options.onNotification(record.method, record.params);
			return;
		}
		if (typeof record.id !== "string" && typeof record.id !== "number") throw new Error("Invalid response id");
		const pending = this.pending.get(String(record.id));
		if (!pending) return;
		if (!("result" in record) && !(record.error && typeof record.error === "object")) throw new Error("Missing response result");
		clearTimeout(pending.timer);
		this.pending.delete(String(record.id));
		if (record.error && typeof record.error === "object") {
			const error = record.error as Record<string, unknown>;
			pending.reject(new Error(typeof error.message === "string" ? error.message : "External agent request failed"));
		} else if ("result" in record) pending.resolve(record.result);
		else throw new Error("Missing response result");
	}

	private write(value: unknown): Promise<void> {
		this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
			if (this.failure || this.stopping) return reject(this.failure ?? new Error("External agent is closed"));
			this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
		}));
		return this.writes;
	}

	private signal(signal: NodeJS.Signals): void {
		if (!this.child.pid) return;
		try {
			if (process.platform === "win32") this.child.kill(signal);
			else process.kill(-this.child.pid, signal);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.child.kill(signal); }
	}
	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
	}
	private fail(error: Error): void {
		if (this.failure || this.stopping) return;
		this.failure = error;
		this.rejectPending(error);
		try { this.options.onFailure?.(error); }
		finally { void this.close(); }
	}
}
