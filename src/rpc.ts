import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Command, DesktopEvent } from "./shared.ts";
import type { RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";

/** Own the child lifecycle and forward extension dialogs, which RpcClient does not expose. */
export class AgentProcess {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private stopped = false;
	private childClosed = false;
	private notifiedFailure = false;
	private failure?: Error;
	private stderr = "";
	private writes: Promise<void> = Promise.resolve();

	constructor(options: {
		executable: string;
		entry: string;
		cwd: string;
		args: string[];
		env: NodeJS.ProcessEnv;
		onEvent: (event: DesktopEvent["event"]) => void;
	}) {
		this.child = spawn(options.executable, [options.entry, ...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.child.stdout.on("data", (data: Buffer) => {
			buffer += decoder.write(data);
			let boundary: number;
			while ((boundary = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, boundary).replace(/\r$/, "");
				buffer = buffer.slice(boundary + 1);
				if (!line) continue;
				try {
					// The subprocess JSONL stream is the protocol trust boundary.
					const record = JSON.parse(line) as RpcResponse | DesktopEvent["event"];
					if (!record || typeof record.type !== "string") throw new Error("Invalid RPC record");
					if (record.type === "response") {
						if (!record.id) continue;
						const pending = this.pending.get(record.id);
						if (!pending) continue;
						if (record.success) pending.resolve("data" in record ? record.data : undefined);
						else pending.reject(new Error(record.error));
					} else options.onEvent(record);
				} catch (error) {
					this.fail(new Error(`Pi 协议错误：${error instanceof Error ? error.message : String(error)}`));
					if (!this.stopped && !this.notifiedFailure) {
						this.notifiedFailure = true;
						options.onEvent({ type: "desktop_error", message: "Pi 返回了无效的协议数据，请重新打开项目。" });
					}
				}
			}
		});
		this.child.stderr.on("data", (data: Buffer) => {
			this.stderr = (this.stderr + data.toString()).slice(-8000);
		});
		const processFailure = (error: Error) => {
			this.fail(error);
			if (!this.stopped && !this.notifiedFailure) {
				this.notifiedFailure = true;
				options.onEvent({ type: "desktop_error", message: error.message });
			}
		};
		this.child.once("error", processFailure);
		this.child.stdin.on("error", processFailure);
		this.child.once("close", () => {
			this.childClosed = true;
		});
		this.child.once("exit", (code, signal) => {
			const error = new Error(`Pi 进程已退出 (${code ?? signal})。${this.stderr}`);
			this.fail(error);
			if (!this.stopped && !this.notifiedFailure) {
				this.notifiedFailure = true;
				options.onEvent({ type: "desktop_error", message: error.message });
			}
		});
	}

	request<T>(command: Command, signal?: AbortSignal): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			signal?.throwIfAborted();
			const cleanup = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			const onAbort = () => fail(signal?.reason);
			const timer =
				command.type === "bash"
					? undefined
					: setTimeout(
							() => fail(new Error(`Pi 请求超时：${command.type}`)),
							command.type === "compact" ? 180000 : 45000,
						);
			this.pending.set(id, {
				resolve: (data) => { cleanup(); resolve(data as T); },
				reject: fail,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			void this.write({ ...command, id }, signal).catch((error: Error) => this.fail(error));
		});
	}

	respond(response: RpcExtensionUIResponse): Promise<void> {
		return this.write(response);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.fail(new Error("会话已关闭"));
		if (this.childClosed || !this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
			}, 5000);
			this.child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			this.child.stdin.end();
			this.child.kill("SIGTERM");
		});
	}

	private write(record: unknown, signal?: AbortSignal): Promise<void> {
		// Serialize writes and wait for callbacks to honor pipe backpressure.
		this.writes = this.writes.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (this.failure) return reject(this.failure);
					if (signal?.aborted) return resolve();
					this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => (error ? reject(error) : resolve()));
				}),
		);
		return this.writes;
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const request of this.pending.values()) request.reject(error);
	}
}
