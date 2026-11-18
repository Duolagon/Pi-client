import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type {
	TerminalCreateInput,
	TerminalEvent,
	TerminalInfo,
	TerminalOutputChunk,
	TerminalReplay,
} from "./terminal-types.ts";

const exec = promisify(execFile);
const maximumInputBytes = 1024 * 1024;
const maximumQueuedInputBytes = 4 * 1024 * 1024;
interface TerminalRecord {
	info: TerminalInfo;
	child: ChildProcessWithoutNullStreams;
	decoder: StringDecoder;
	chunks: TerminalOutputChunk[];
	bytes: number;
	sequence: number;
	trimmedSequence?: number;
	writes: Promise<void>;
	queuedInputBytes: number;
	ended: Promise<void>;
	finish: () => void;
	closing?: Promise<void>;
	exit?: { code: number | null; signal?: string };
	finished: boolean;
}
interface ProcessIdentity {
	pid: number;
	parent: number;
	group: number;
	identity: string;
}
export interface TerminalServiceOptions {
	helperPath: string;
	env?: NodeJS.ProcessEnv;
	maxBufferBytes?: number;
	maxTerminals?: number;
	shell?: string;
}

/** Own persistent PTYs independently of Pi RPC processes and active renderer tabs. */
export class TerminalService {
	private options: TerminalServiceOptions;
	private records = new Map<string, TerminalRecord>();
	private listeners = new Set<(event: TerminalEvent) => void>();
	private disposed = false;
	private maxBufferBytes: number;
	constructor(options: TerminalServiceOptions) {
		this.options = options;
		this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
		if (!Number.isInteger(this.maxBufferBytes) || this.maxBufferBytes < 1024)
			throw new Error("Terminal output buffer must be at least 1024 bytes.");
	}

	async create(input: TerminalCreateInput, launch?: { program: string; args: string[]; label: string; env?: NodeJS.ProcessEnv }): Promise<TerminalInfo> {
		if (process.platform === "win32") throw new Error("Windows 当前支持单次命令，交互终端需要 POSIX PTY。");
		if (this.disposed) throw new Error("终端服务已关闭。");
		const project = await realpath(input.project);
		if (!(await stat(project)).isDirectory()) throw new Error("终端项目路径必须是文件夹。");
		const cols = input.cols ?? 100,
			rows = input.rows ?? 30;
		validateSize(cols, rows);
		const environment = { ...process.env, ...this.options.env };
		const shell =
			launch?.program ??
			input.shell ??
			this.options.shell ??
			environment.SHELL ??
			(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
		if (!isAbsolute(shell) || !isAbsolute(this.options.helperPath)) throw new Error("终端程序必须使用绝对路径。");
		await Promise.all([access(shell, fsConstants.X_OK), access(this.options.helperPath, fsConstants.X_OK)]);
		for (const name of Object.keys(environment))
			if (name.startsWith("PI_DESKTOP_KEY_") || name === "PI_DESKTOP_CONNECTIONS" || name === "ELECTRON_RUN_AS_NODE")
				delete environment[name];
		Object.assign(environment, {
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			COLUMNS: String(cols),
			LINES: String(rows),
			PWD: project,
		});
		if (this.disposed) throw new Error("终端服务已关闭。");
		if (
			[...this.records.values()].filter((item) => item.info.status !== "exited").length >=
			(this.options.maxTerminals ?? 16)
		)
			throw new Error("已达到同时运行的终端数量上限。");
		Object.assign(environment, launch?.env);
		const child = spawn(this.options.helperPath, [shell, String(cols), String(rows), ...(launch?.args ?? [])], {
			cwd: project,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		let finish: () => void = () => {};
		const ended = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const record: TerminalRecord = {
			info: {
				id: randomUUID(),
				conversationId: input.conversationId,
				project,
				shell,
				label: launch?.label,
				cols,
				rows,
				status: "starting",
				createdAt: Date.now(),
			},
			child,
			decoder: new StringDecoder("utf8"),
			chunks: [],
			bytes: 0,
			sequence: 0,
			writes: Promise.resolve(),
			queuedInputBytes: 0,
			ended,
			finish,
			finished: false,
		};
		this.records.set(record.info.id, record);
		let resolveReady: () => void = () => {},
			rejectReady: (error: Error) => void = () => {};
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const timer = setTimeout(() => rejectReady(new Error("终端启动超时。")), 5000);
		let control = "",
			exitCode: number | null = null,
			exitSignal: string | undefined;
		let receivedExit = false;
		child.stdout.on("data", (bytes: Buffer) => this.output(record, record.decoder.write(bytes)));
		child.stderr.on("data", (bytes: Buffer) => {
			control += bytes.toString("utf8");
			if (control.length > 16384) {
				rejectReady(new Error("终端返回了无效的控制数据。"));
				child.kill("SIGTERM");
				return;
			}
			let boundary: number;
			while ((boundary = control.indexOf("\n")) >= 0) {
				const line = control.slice(0, boundary);
				control = control.slice(boundary + 1);
				try {
					// The native helper's stderr is a small, private control-protocol boundary.
					const value: unknown = JSON.parse(line);
					if (!value || typeof value !== "object") throw new Error("Invalid PTY control record");
					const message = value as Record<string, unknown>;
					if (message.type === "ready" && Number.isInteger(message.pid) && Number(message.pid) > 0) {
						record.info.pid = Number(message.pid);
						if (record.info.status === "starting") record.info.status = "running";
						resolveReady();
					} else if (message.type === "exit" && (message.exitCode === null || Number.isInteger(message.exitCode))) {
						receivedExit = true;
						exitCode = message.exitCode as number | null;
						exitSignal = Number.isInteger(message.signal)
							? Object.entries(osConstants.signals).find(([, number]) => number === message.signal)?.[0]
							: undefined;
					} else if (message.type === "error" && typeof message.message === "string")
						rejectReady(new Error(message.message));
					else throw new Error("Invalid PTY control record");
				} catch {
					rejectReady(new Error("终端返回了无效的控制数据。"));
					child.kill("SIGTERM");
				}
			}
		});
		child.on("error", (error) => {
			rejectReady(error);
			this.finished(record, null);
		});
		child.stdin.on("error", (error) => {
			if (!record.closing) rejectReady(error);
		});
		child.once("close", (code, signal) => {
			this.output(record, record.decoder.end());
			rejectReady(new Error("终端在启动完成前退出。"));
			record.exit = { code: receivedExit ? exitCode : code, signal: exitSignal ?? signal ?? undefined };
			record.finish();
			if (!record.closing) this.finished(record, record.exit.code, record.exit.signal);
		});
		try {
			await ready;
			if (this.disposed || record.info.status !== "running") throw new Error("终端已关闭或正在关闭。");
			return { ...record.info };
		} catch (error) {
			await this.close(record.info.id);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	subscribe(listener: (event: TerminalEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(conversationId?: string): TerminalInfo[] {
		return [...this.records.values()]
			.filter((item) => conversationId === undefined || item.info.conversationId === conversationId)
			.map((item) => ({ ...item.info }));
	}

	replay(id: string, afterSequence = 0): TerminalReplay {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("终端输出序号无效。");
		const record = this.require(id);
		const earliestSequence = record.chunks[0]?.sequence ?? record.sequence + 1;
		return {
			terminal: { ...record.info },
			chunks: record.chunks.filter((item) => item.sequence > afterSequence).map((item) => ({ ...item })),
			earliestSequence,
			nextSequence: record.sequence + 1,
			truncated:
				afterSequence < earliestSequence - 1 ||
				(record.trimmedSequence !== undefined && afterSequence < record.trimmedSequence),
		};
	}

	write(id: string, data: string): Promise<void> {
		const record = this.requireRunning(id);
		const bytes = Buffer.from(data, "utf8");
		if (bytes.length > maximumInputBytes) throw new Error("单次终端输入超过 1 MB。");
		return this.frame(record, 1, bytes);
	}

	async resize(id: string, cols: number, rows: number): Promise<TerminalInfo> {
		validateSize(cols, rows);
		const record = this.requireRunning(id);
		const bytes = Buffer.alloc(8);
		bytes.writeUInt32BE(cols, 0);
		bytes.writeUInt32BE(rows, 4);
		await this.frame(record, 2, bytes);
		record.info.cols = cols;
		record.info.rows = rows;
		return { ...record.info };
	}

	close(id: string): Promise<void> {
		const record = this.require(id);
		if (record.finished) return Promise.resolve();
		if (record.closing) return record.closing;
		record.info.status = "closing";
		record.closing = this.stop(record);
		return record.closing;
	}

	async closeConversation(conversationId: string): Promise<void> {
		await Promise.all(this.list(conversationId).map((terminal) => this.close(terminal.id)));
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all([...this.records.keys()].map((id) => this.close(id)));
		this.listeners.clear();
	}

	private require(id: string): TerminalRecord {
		const record = this.records.get(id);
		if (!record) throw new Error("终端不存在。");
		return record;
	}
	private requireRunning(id: string): TerminalRecord {
		const record = this.require(id);
		if (record.info.status !== "running") throw new Error("终端已关闭或正在关闭。");
		return record;
	}
	private frame(record: TerminalRecord, kind: number, bytes: Buffer): Promise<void> {
		const size = 5 + bytes.length;
		if (record.queuedInputBytes + size > maximumQueuedInputBytes)
			throw new Error("终端输入缓冲已满，请等待当前输入处理完成后重试。");
		record.queuedInputBytes += size;
		const header = Buffer.alloc(5);
		header[0] = kind;
		header.writeUInt32BE(bytes.length, 1);
		const frame = Buffer.concat([header, bytes]);
		const queued = record.writes
			.then(
				() =>
					new Promise<void>((resolve, reject) => {
						if (record.finished || record.info.status !== "running") {
							reject(new Error("终端已关闭。"));
							return;
						}
						record.child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
					}),
			)
			.finally(() => {
				record.queuedInputBytes -= size;
			});
		record.writes = queued.catch(() => {});
		return queued;
	}

	private output(record: TerminalRecord, data: string): void {
		if (!data) return;
		const sequence = ++record.sequence;
		record.chunks.push({ sequence, data });
		record.bytes += Buffer.byteLength(data);
		while ((record.bytes > this.maxBufferBytes || record.chunks.length > 2048) && record.chunks.length > 1) {
			const dropped = record.chunks.shift()!;
			record.bytes -= Buffer.byteLength(dropped.data);
		}
		if (record.bytes > this.maxBufferBytes) {
			const last = record.chunks[0],
				bytes = Buffer.from(last.data);
			let start = bytes.length - this.maxBufferBytes;
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			last.data = bytes.subarray(start).toString("utf8");
			record.bytes = Buffer.byteLength(last.data);
			record.trimmedSequence = sequence;
		}
		this.emit({
			type: "terminal_data",
			terminalId: record.info.id,
			conversationId: record.info.conversationId,
			sequence,
			data,
		});
	}
	private async stop(record: TerminalRecord): Promise<void> {
		const helperPid = record.child.pid;
		let descendants: ProcessIdentity[] = [];
		if (helperPid) {
			try {
				const processes = await processIdentities();
				const owned = new Set([helperPid]);
				let previous = 0;
				while (previous !== owned.size) {
					previous = owned.size;
					for (const process of processes) if (owned.has(process.parent)) owned.add(process.pid);
				}
				descendants = processes.filter((process) => owned.has(process.pid));
			} catch {
				/* The native helper still hangs up the controlling terminal if ps is unavailable. */
			}
		}
		const terminate = (signal: NodeJS.Signals) => {
			const owned = new Set(descendants.map((item) => item.pid));
			const groups = new Set(descendants.filter((item) => owned.has(item.group)).map((item) => item.group));
			for (const group of groups) {
				try {
					process.kill(-group, signal);
				} catch {}
			}
			for (const item of descendants) {
				try {
					process.kill(item.pid, signal);
				} catch {}
			}
			try {
				record.child.kill(signal);
			} catch {}
		};
		let escalation: Promise<void> | undefined;
		const escalate = () =>
			(escalation ??= (async () => {
				try {
					const current = await processIdentities();
					for (const original of descendants) {
						// Recheck process birth and session/group identity before killing a recorded survivor.
						if (
							!current.some(
								(process) =>
									process.pid === original.pid &&
									process.group === original.group &&
									process.identity === original.identity,
							)
						)
							continue;
						try {
							process.kill(original.pid, "SIGKILL");
						} catch {}
					}
				} finally {
					try {
						record.child.kill("SIGKILL");
					} catch {}
				}
			})());
		const timer = setTimeout(() => {
			void escalate().catch(() => {});
		}, 1500);
		try {
			// Close does not wait behind buffered terminal input or a blocked foreground program.
			const frame = Buffer.from([3, 0, 0, 0, 0]);
			record.child.stdin.end(frame);
			terminate("SIGTERM");
			await record.ended;
			await escalate();
		} finally {
			clearTimeout(timer);
			this.finished(record, record.exit?.code ?? null, record.exit?.signal);
		}
	}
	private finished(record: TerminalRecord, exitCode: number | null, signal?: string): void {
		if (record.finished) return;
		record.finished = true;
		Object.assign(record.info, { status: "exited", exitCode, signal });
		record.finish();
		this.emit({
			type: "terminal_exit",
			terminalId: record.info.id,
			conversationId: record.info.conversationId,
			exitCode,
			signal,
		});
		const archived = [...this.records.values()].filter((item) => item.finished);
		for (const item of archived.slice(0, Math.max(0, archived.length - 64))) this.records.delete(item.info.id);
	}
	private emit(event: TerminalEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* A detached subscriber must not prevent PTY cleanup. */
			}
		}
	}
}

async function processIdentities(): Promise<ProcessIdentity[]> {
	const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,sess=,lstart="], {
		timeout: 1000,
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout.split("\n").flatMap((line) => {
		// ps output is an operating-system protocol boundary; birth/session fields distinguish reused PIDs.
		const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
		return fields
			? [
					{
						pid: Number(fields[1]),
						parent: Number(fields[2]),
						group: Number(fields[3]),
						identity: `${fields[4]}:${fields[5]}`,
					},
				]
			: [];
	});
}

function validateSize(cols: number, rows: number): void {
	if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000)
		throw new Error("终端尺寸必须是 1 到 1000 之间的整数。");
}
