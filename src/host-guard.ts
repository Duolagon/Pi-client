// Imported by the CommonJS main process (via monitor-service). Do not import @earendil-works/pi-coding-agent
// here: its config module needs import.meta.url and crashes main.cjs at startup. See host-guard-bash.ts.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NICE_BIN = "/usr/bin/nice";
export const DEFAULT_NICE_VALUE = 10;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_RSS_RATIO = 0.55;
const CRITICAL_PRESSURE_RSS_RATIO = 0.2;
const MACOS_CRITICAL_PRESSURE = 4;

let cachedHasNice: boolean | undefined;
function hasNiceBinary(): boolean {
	if (process.platform === "win32") return false;
	if (cachedHasNice === undefined) cachedHasNice = existsSync(NICE_BIN);
	return cachedHasNice;
}

/**
 * Wrap a command invocation with `/usr/bin/nice -n <niceValue>` on Unix so heavy agent
 * workloads never starve the OS UI, WindowServer, or network/DNS daemons.
 */
export function resolveNiceCommand(
	executable: string,
	args: string[],
	niceValue = DEFAULT_NICE_VALUE,
): { command: string; args: string[] } {
	if (niceValue > 0 && hasNiceBinary() && executable !== NICE_BIN) {
		return { command: NICE_BIN, args: ["-n", String(niceValue), executable, ...args] };
	}
	return { command: executable, args };
}

/** Compute the default per-host memory cap for tracked agent process groups (in bytes). */
export function resolveMaxRssBytes(totalMemBytes = totalmem(), env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_DESKTOP_MAX_BASH_RSS_MB;
	if (raw !== undefined && raw.trim() !== "") {
		const mb = Number(raw);
		if (Number.isFinite(mb) && mb === 0) return 0; // explicitly disabled
		if (Number.isFinite(mb) && mb >= 128) return Math.floor(mb * 1024 * 1024);
	}
	return Math.max(512 * 1024 * 1024, Math.floor(totalMemBytes * DEFAULT_MAX_RSS_RATIO));
}

/**
 * Return an env copy with safe default thread-pool limits (leaving cores for the host OS)
 * without overriding values the user or command explicitly configured.
 */
export function buildSafeComputeEnv(
	baseEnv: NodeJS.ProcessEnv = process.env,
	opts?: { cpuCount?: number; totalMemBytes?: number },
): NodeJS.ProcessEnv {
	const cpuCount = opts?.cpuCount ?? (cpus().length || 4);
	const totalMemBytes = opts?.totalMemBytes ?? totalmem();
	const safeWorkers = String(Math.max(1, cpuCount - 2));
	const maxMb = String(Math.max(512, Math.floor(resolveMaxRssBytes(totalMemBytes, baseEnv) / (1024 * 1024))));
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	for (const key of [
		"OMP_NUM_THREADS",
		"OPENBLAS_NUM_THREADS",
		"MKL_NUM_THREADS",
		"NUMEXPR_NUM_THREADS",
		"VECLIB_MAXIMUM_THREADS",
		"PI_MAX_WORKERS",
	]) {
		if (!env[key]) env[key] = safeWorkers;
	}
	if (!env.PI_MAX_MEMORY_MB) env.PI_MAX_MEMORY_MB = maxMb;
	return env;
}

/**
 * Kill an entire process group reliably across platforms.
 * On macOS, SIGSTOP precedes SIGKILL to avoid the race where a dying child wakes its waiting
 * shell before the shell receives SIGKILL.
 */
export function killProcessGroup(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			child.once("error", () => {});
		} catch {}
		return;
	}
	if (process.platform === "darwin") {
		try {
			process.kill(-pid, "SIGSTOP");
		} catch {}
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

/** Parse `ps -axo pid=,pgid=,rss=` (rss in KiB) into `pgid -> total RSS bytes`. */
export function parsePsGroupRss(stdout: string): Map<number, number> {
	const totals = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < 3) continue;
		const pgid = Number(parts[1]);
		const rssKb = Number(parts[2]);
		if (!Number.isFinite(pgid) || !Number.isFinite(rssKb) || pgid <= 0 || rssKb < 0) continue;
		totals.set(pgid, (totals.get(pgid) ?? 0) + rssKb * 1024);
	}
	return totals;
}

async function defaultSampleGroupRss(): Promise<Map<number, number>> {
	if (process.platform === "win32") return new Map();
	try {
		const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,rss="], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 });
		return parsePsGroupRss(stdout);
	} catch {
		return new Map();
	}
}

async function defaultSampleMemoryPressure(): Promise<number> {
	if (process.platform !== "darwin") return 1;
	try {
		const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 1000 });
		const level = Number(stdout.trim());
		return Number.isFinite(level) ? level : 1;
	} catch {
		return 1;
	}
}

export interface GuardEntry {
	pgid: number;
	label: string;
	onKill: (reason: string) => void;
}

export interface HostResourceGuardOptions {
	pollMs?: number;
	totalMemBytes?: number;
	maxRssBytes?: number;
	sampleGroupRss?: () => Promise<Map<number, number>>;
	sampleMemoryPressure?: () => Promise<number>;
	killGroup?: (pgid: number) => void;
}

function formatGb(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Watchdog that monitors total RSS across tracked agent process groups and macOS kernel memory
 * pressure. Runs with zero overhead when no commands are registered, and immediately kills the
 * heaviest offending process group before a swap storm can freeze the host or drop networking.
 */
export class HostResourceGuard {
	private readonly entries = new Map<number, GuardEntry>();
	private readonly pollMs: number;
	private readonly totalMemBytes: number;
	private readonly maxRssBytes: number;
	private readonly sampleGroupRss: () => Promise<Map<number, number>>;
	private readonly sampleMemoryPressure: () => Promise<number>;
	private readonly killGroup: (pgid: number) => void;
	private timer?: NodeJS.Timeout;
	private polling = false;

	constructor(options: HostResourceGuardOptions = {}) {
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.totalMemBytes = options.totalMemBytes ?? totalmem();
		this.maxRssBytes = options.maxRssBytes ?? resolveMaxRssBytes(this.totalMemBytes);
		this.sampleGroupRss = options.sampleGroupRss ?? defaultSampleGroupRss;
		this.sampleMemoryPressure = options.sampleMemoryPressure ?? defaultSampleMemoryPressure;
		this.killGroup = options.killGroup ?? killProcessGroup;
	}

	register(pgid: number, entry: Omit<GuardEntry, "pgid">): void {
		if (!Number.isInteger(pgid) || pgid <= 0 || this.maxRssBytes <= 0) return;
		this.entries.set(pgid, { pgid, ...entry });
		if (!this.timer) {
			this.timer = setInterval(() => {
				void this.checkNow();
			}, this.pollMs);
			this.timer.unref?.();
		}
	}

	unregister(pgid: number): void {
		this.entries.delete(pgid);
		if (this.entries.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	stop(): void {
		this.entries.clear();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Run one inspection pass (also exposed for deterministic unit tests). */
	async checkNow(): Promise<boolean> {
		if (this.polling || this.entries.size === 0 || this.maxRssBytes <= 0) return false;
		this.polling = true;
		try {
			const [rssByGroup, pressure] = await Promise.all([this.sampleGroupRss(), this.sampleMemoryPressure()]);
			let totalAgentRss = 0;
			let heaviest: { entry: GuardEntry; rss: number } | undefined;
			for (const entry of this.entries.values()) {
				const rss = rssByGroup.get(entry.pgid) ?? 0;
				totalAgentRss += rss;
				if (!heaviest || rss > heaviest.rss) heaviest = { entry, rss };
			}
			if (!heaviest || heaviest.rss <= 0) return false;

			const criticalThreshold = Math.floor(this.totalMemBytes * CRITICAL_PRESSURE_RSS_RATIO);
			const overCap = heaviest.rss >= this.maxRssBytes || totalAgentRss >= this.maxRssBytes;
			const criticalPressure = pressure >= MACOS_CRITICAL_PRESSURE && totalAgentRss >= criticalThreshold;
			if (!overCap && !criticalPressure) return false;

			const reason = criticalPressure
				? `[Host Safety Guard] 已强制终止命令（${heaviest.entry.label}）：系统内存压力达到危急级别（pressure=${pressure}），当前任务进程组占用 ${formatGb(heaviest.rss)}（Agent 总占用 ${formatGb(totalAgentRss)}）。为防止本机卡死或断网已中止进程树，请降低并发数（--jobs）或限制单进程内存后重试。`
				: `[Host Safety Guard] 已强制终止命令（${heaviest.entry.label}）：进程组内存占用 ${formatGb(heaviest.rss)}（Agent 总占用 ${formatGb(totalAgentRss)}）超过本机安全上限 ${formatGb(this.maxRssBytes)}。为防止 Swap 风暴导致卡死或断网已中止进程树，请降低并发数（--jobs）或限制单进程内存后重试。`;

			this.unregister(heaviest.entry.pgid);
			this.killGroup(heaviest.entry.pgid);
			try {
				heaviest.entry.onKill(reason);
			} catch {}
			return true;
		} finally {
			this.polling = false;
		}
	}
}

export const sharedHostGuard = new HostResourceGuard();
