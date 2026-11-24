import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import type {
	CronCreateInput,
	CronEvent,
	CronJobRecord,
	CronJobSource,
	ScheduleWakeupInput,
} from "./cron-types.ts";
import type { DeliverCustomType, NotificationDelivery, NotificationDisposition } from "./tool-control-types.ts";

export const CRON_WAKEUP_TYPE: DeliverCustomType = "desktop_cron_wakeup";
export const CRON_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 10_000;
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_JITTER_MS = 60_000;
const MAX_JOBS_PER_CONVERSATION = 50;
const MAX_PROMPT_LENGTH = 16000;
const MAX_TIMER_SLEEP_MS = 60_000;

interface ParsedCronField {
	wildcard: boolean;
	values: Set<number>;
}

interface ParsedCron {
	minute: ParsedCronField;
	hour: ParsedCronField;
	dom: ParsedCronField;
	month: ParsedCronField;
	dow: ParsedCronField;
}

function parseField(part: string, min: number, max: number, normalizeSeven = false): ParsedCronField {
	const trimmed = part.trim();
	if (!trimmed) throw new Error("Empty cron field");
	const wildcard = trimmed === "*";
	const values = new Set<number>();
	for (const segment of trimmed.split(",")) {
		const [rangePart, stepPart] = segment.split("/");
		if (segment.split("/").length > 2) throw new Error(`Invalid cron segment: ${segment}`);
		let step = 1;
		if (stepPart !== undefined) {
			if (!/^\d+$/.test(stepPart)) throw new Error(`Invalid cron step: ${stepPart}`);
			step = Number(stepPart);
			if (step < 1 || step > max) throw new Error(`Cron step out of range: ${step}`);
		}
		let start = min;
		let end = max;
		if (rangePart !== "*") {
			const dash = rangePart.indexOf("-");
			if (dash >= 0) {
				const left = rangePart.slice(0, dash);
				const right = rangePart.slice(dash + 1);
				if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) throw new Error(`Invalid cron range: ${rangePart}`);
				start = Number(left);
				end = Number(right);
			} else {
				if (!/^\d+$/.test(rangePart)) throw new Error(`Invalid cron value: ${rangePart}`);
				start = Number(rangePart);
				end = stepPart !== undefined ? max : start;
			}
		}
		if (start < min || end > max || start > end) {
			throw new Error(`Cron value out of range [${min}..${max}]: ${rangePart}`);
		}
		for (let val = start; val <= end; val += step) {
			values.add(normalizeSeven && val === 7 ? 0 : val);
		}
	}
	if (!values.size) throw new Error(`Empty cron field values: ${part}`);
	return { wildcard, values };
}

export function parseCronExpression(expr: string): ParsedCron {
	if (typeof expr !== "string" || expr.length > 200 || expr.includes("\0")) {
		throw new Error("Invalid cron expression");
	}
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error("Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week");
	}
	return {
		minute: parseField(fields[0]!, 0, 59),
		hour: parseField(fields[1]!, 0, 23),
		dom: parseField(fields[2]!, 1, 31),
		month: parseField(fields[3]!, 1, 12),
		dow: parseField(fields[4]!, 0, 7, true),
	};
}

export function computeNextCronRun(expr: string, afterMs: number, jitterMs = 0): number {
	const parsed = parseCronExpression(expr);
	// Start checking from the next whole minute boundary strictly after afterMs - jitterMs so
	// added jitter stays >= afterMs + 100ms
	const cursor = new Date(Math.ceil((afterMs + 1000) / 60_000) * 60_000);
	cursor.setSeconds(0, 0);
	const maxMinutes = 7 * 24 * 60;
	for (let i = 0; i <= maxMinutes; i++) {
		const month = cursor.getMonth() + 1;
		const dom = cursor.getDate();
		const dow = cursor.getDay();
		const hour = cursor.getHours();
		const minute = cursor.getMinutes();

		const domOk = parsed.dom.values.has(dom);
		const dowOk = parsed.dow.values.has(dow);
		const dayMatch =
			!parsed.dom.wildcard && !parsed.dow.wildcard ? domOk || dowOk : domOk && dowOk;

		if (
			parsed.month.values.has(month) &&
			dayMatch &&
			parsed.hour.values.has(hour) &&
			parsed.minute.values.has(minute)
		) {
			const candidate = cursor.getTime() + jitterMs;
			if (candidate > afterMs) return candidate;
		}
		cursor.setTime(cursor.getTime() + 60_000);
	}
	throw new Error("Cron expression has no valid trigger within the 7-day window");
}

function deterministicJitterMs(id: string, periodMs: number): number {
	const max = Math.min(Math.floor(periodMs * 0.1), MAX_JITTER_MS);
	if (max <= 0) return 0;
	const hash = createHash("sha256").update(id).digest();
	const value = hash.readUInt32BE(0);
	return value % (max + 1);
}

/** Parse `/loop [interval_or_cron] <prompt>` into `{ prompt, interval_seconds?, cron? }`. */
export function parseLoopCommandArgs(rawArgs: string): {
	prompt: string;
	interval_seconds?: number;
	cron?: string;
} {
	const trimmed = rawArgs.trim();
	if (!trimmed) {
		throw new Error("用法：/loop [间隔如 5m / Cron 表达式] <提示词>");
	}
	// Check leading 5-field cron expression
	const tokens = trimmed.split(/\s+/);
	if (tokens.length >= 6) {
		const maybeCron = tokens.slice(0, 5).join(" ");
		try {
			parseCronExpression(maybeCron);
			const prompt = trimmed.slice(maybeCron.length).trim();
			if (prompt) return { cron: maybeCron, prompt };
		} catch {
			// Not a cron prefix, try interval prefix below
		}
	}
	const intervalMatch = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)\b\s+([\s\S]+)$/i.exec(trimmed);
	if (intervalMatch) {
		const amount = Number(intervalMatch[1]);
		const unit = intervalMatch[2]!.toLowerCase();
		const mult = unit.startsWith("s") ? 1 : unit.startsWith("m") ? 60 : unit.startsWith("h") ? 3600 : 86400;
		const seconds = amount * mult;
		if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 7 * 24 * 3600) {
			throw new Error("/loop 间隔需在 10 秒到 7 天之间。");
		}
		return { interval_seconds: seconds, prompt: intervalMatch[3]!.trim() };
	}
	// Trailing "every <interval>" support: `/loop check tests every 5m`
	const trailingMatch = /^([\s\S]+?)\s+every\s+(\d+)\s*(s|m|h|d)$/i.exec(trimmed);
	if (trailingMatch) {
		const amount = Number(trailingMatch[2]);
		const unit = trailingMatch[3]!.toLowerCase();
		const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
		const seconds = amount * mult;
		if (seconds >= 10 && seconds <= 7 * 24 * 3600) {
			return { interval_seconds: seconds, prompt: trailingMatch[1]!.trim() };
		}
	}
	return { interval_seconds: Math.floor(DEFAULT_LOOP_INTERVAL_MS / 1000), prompt: trimmed };
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
		throw new Error(`Invalid ${label}`);
	}
	return value.trim();
}

function validateStoredJob(raw: unknown): CronJobRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const allowedKeys = new Set([
		"id",
		"conversationId",
		"project",
		"prompt",
		"cron",
		"intervalMs",
		"recurring",
		"durable",
		"jitterMs",
		"createdAt",
		"expiresAt",
		"nextRunAt",
		"lastRunAt",
		"runCount",
		"enabled",
		"source",
	]);
	if (Object.keys(obj).some((k) => !allowedKeys.has(k))) return undefined;
	try {
		const id = assertText(obj.id, "id", 80);
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return undefined;
		const conversationId = assertText(obj.conversationId, "conversationId", 200);
		const prompt = assertText(obj.prompt, "prompt", MAX_PROMPT_LENGTH);
		const project = obj.project === undefined ? undefined : assertText(obj.project, "project", 4096);
		if (project !== undefined && !isAbsolute(project)) return undefined;
		const cron = obj.cron === undefined ? undefined : assertText(obj.cron, "cron", 200);
		if (cron) parseCronExpression(cron);
		const intervalMs = obj.intervalMs === undefined ? undefined : Number(obj.intervalMs);
		if (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > CRON_LIFETIME_MS)) {
			return undefined;
		}
		if (!cron && intervalMs === undefined) return undefined;
		if (typeof obj.recurring !== "boolean" || typeof obj.durable !== "boolean" || typeof obj.enabled !== "boolean") {
			return undefined;
		}
		const createdAt = Number(obj.createdAt);
		const expiresAt = Number(obj.expiresAt);
		const nextRunAt = Number(obj.nextRunAt);
		const jitterMs = Number(obj.jitterMs ?? 0);
		const runCount = Number(obj.runCount ?? 0);
		if (
			!Number.isFinite(createdAt) ||
			!Number.isFinite(expiresAt) ||
			!Number.isFinite(nextRunAt) ||
			!Number.isSafeInteger(jitterMs) ||
			jitterMs < 0 ||
			jitterMs > MAX_JITTER_MS ||
			!Number.isSafeInteger(runCount) ||
			runCount < 0
		) {
			return undefined;
		}
		// Enforce 7-day ceiling even on tampered disk files
		if (expiresAt > createdAt + CRON_LIFETIME_MS || expiresAt <= createdAt) return undefined;
		const source = obj.source === "tool" || obj.source === "loop" || obj.source === "wakeup" ? obj.source : undefined;
		if (!source) return undefined;
		const lastRunAt = obj.lastRunAt === undefined ? undefined : Number(obj.lastRunAt);
		if (lastRunAt !== undefined && !Number.isFinite(lastRunAt)) return undefined;

		return {
			id,
			conversationId,
			...(project ? { project } : {}),
			prompt,
			...(cron ? { cron } : {}),
			...(intervalMs !== undefined ? { intervalMs } : {}),
			recurring: obj.recurring,
			durable: obj.durable,
			jitterMs,
			createdAt,
			expiresAt,
			nextRunAt,
			...(lastRunAt !== undefined ? { lastRunAt } : {}),
			runCount,
			enabled: obj.enabled,
			source,
		};
	} catch {
		return undefined;
	}
}

export type CronDeliverFn = (
	conversationId: string,
	params: {
		customType: DeliverCustomType;
		key?: string;
		content: string;
		details: Record<string, unknown>;
		deliverAs?: NotificationDelivery;
		triggerTurn?: boolean;
		display?: boolean;
		idleOnly?: boolean;
	},
	project?: string,
) => Promise<NotificationDisposition | "unavailable">;

export class CronService {
	private dataDir: () => string;
	private deliver: CronDeliverFn;
	private isEnabled: () => boolean;
	private isProjectTrusted: (project: string) => boolean;
	private applyJitter: boolean;
	private jobs = new Map<string, CronJobRecord>();
	private loadedProjects = new Set<string>();
	private globalLoaded = false;
	private pendingOneShotRetries = new Set<string>();
	private unavailableUntil = new Map<string, number>();
	private listeners = new Set<(event: CronEvent) => void>();
	private tickTimer?: NodeJS.Timeout;
	private lock: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: {
		dataDir: () => string;
		deliver: CronDeliverFn;
		isEnabled: () => boolean;
		isProjectTrusted: (project: string) => boolean;
		applyJitter?: boolean;
	}) {
		this.dataDir = options.dataDir;
		this.deliver = options.deliver;
		this.isEnabled = options.isEnabled;
		this.isProjectTrusted = options.isProjectTrusted;
		this.applyJitter = options.applyJitter ?? true;
	}

	subscribe(listener: (event: CronEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		const snapshot = structuredClone([...this.jobs.values()].sort((a, b) => a.nextRunAt - b.nextRunAt));
		for (const listener of this.listeners) {
			listener({ type: "cron_updated", jobs: snapshot });
		}
	}

	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const next = this.lock.then(action, action);
		this.lock = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	async loadGlobal(): Promise<void> {
		if (this.closed) return;
		await this.serialize(async () => {
			if (this.globalLoaded) return;
			this.globalLoaded = true;
			const file = await managedFile(this.dataDir(), [], "scheduled_tasks.json", false).catch(() => undefined);
			if (!file) return;
			await this.readFileIntoMemory(file);
			this.scheduleNextTick();
		});
	}

	async loadProject(project: string): Promise<void> {
		if (this.closed || !project || !isAbsolute(project) || !this.isProjectTrusted(project)) return;
		await this.serialize(async () => {
			if (this.loadedProjects.has(project)) return;
			this.loadedProjects.add(project);
			const file = await managedFile(project, [".pi"], "scheduled_tasks.json", false).catch(() => undefined);
			if (!file) return;
			await this.readFileIntoMemory(file, project);
			this.scheduleNextTick();
		});
	}

	private async readFileIntoMemory(file: string, project?: string): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
			const obj = assertObject(parsed, "scheduled_tasks.json");
			if (obj.version !== 1 || !Array.isArray(obj.jobs)) return;
			const now = Date.now();
			for (const raw of obj.jobs) {
				const job = validateStoredJob(raw);
				if (!job || !job.durable || job.project !== project || this.jobs.has(job.id) || now >= job.expiresAt) continue;
				this.jobs.set(job.id, job);
			}
		} catch {
			// Invalid or unreadable schedule file fails closed without loading stale/unsafe entries
		}
	}

	private async persistScope(project?: string): Promise<void> {
		if (project) {
			if (!this.isProjectTrusted(project)) return;
			const scoped = [...this.jobs.values()].filter((job) => job.durable && job.project === project);
			const file = (await managedFile(project, [".pi"], "scheduled_tasks.json", true))!;
			await writeManagedFile(file, JSON.stringify({ version: 1, jobs: scoped }, null, 2));
			return;
		}
		const globalJobs = [...this.jobs.values()].filter((job) => job.durable && !job.project);
		const file = (await managedFile(this.dataDir(), [], "scheduled_tasks.json", true))!;
		await writeManagedFile(file, JSON.stringify({ version: 1, jobs: globalJobs }, null, 2));
	}

	async create(params: {
		conversationId: string;
		project?: string;
		source?: CronJobSource;
		input: CronCreateInput;
	}): Promise<CronJobRecord> {
		if (this.closed) throw new Error("Cron service is closed");
		if (!this.isEnabled()) {
			throw new Error("定时唤醒功能已在设置中关闭（cronEnabled = false）。");
		}
		const raw = assertObject(params.input, "CronCreate input");
		const allowed = ["prompt", "cron", "interval_seconds", "recurring", "durable"];
		if (Object.keys(raw).some((k) => !allowed.includes(k))) throw new Error("Unknown CronCreate field");
		const prompt = assertText(raw.prompt, "prompt", MAX_PROMPT_LENGTH);
		const cron = raw.cron === undefined ? undefined : assertText(raw.cron, "cron", 200);
		const intervalSeconds = raw.interval_seconds === undefined ? undefined : Number(raw.interval_seconds);
		if ((cron === undefined) === (intervalSeconds === undefined)) {
			throw new Error("CronCreate requires exactly one of 'cron' or 'interval_seconds'");
		}
		let intervalMs: number | undefined;
		if (intervalSeconds !== undefined) {
			if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > CRON_LIFETIME_MS / 1000) {
				throw new Error("interval_seconds must be an integer between 10 and 604800 (7 days)");
			}
			intervalMs = intervalSeconds * 1000;
		}
		if (cron) parseCronExpression(cron);
		if (raw.recurring !== undefined && typeof raw.recurring !== "boolean") throw new Error("Invalid recurring flag");
		if (raw.durable !== undefined && typeof raw.durable !== "boolean") throw new Error("Invalid durable flag");
		const recurring = raw.recurring ?? true;
		const requestedDurable = raw.durable ?? true;

		if (params.project && requestedDurable && !this.isProjectTrusted(params.project)) {
			throw new Error("当前项目尚未被信任，无法向项目 .pi/scheduled_tasks.json 写入持久化定时任务。请先信任项目或设置 durable=false。");
		}

		return this.serialize(async () => {
			if (params.project && this.isProjectTrusted(params.project) && !this.loadedProjects.has(params.project)) {
				this.loadedProjects.add(params.project);
				const file = await managedFile(params.project, [".pi"], "scheduled_tasks.json", false).catch(() => undefined);
				if (file) await this.readFileIntoMemory(file, params.project);
			}
			if (!this.globalLoaded) {
				this.globalLoaded = true;
				const gFile = await managedFile(this.dataDir(), [], "scheduled_tasks.json", false).catch(() => undefined);
				if (gFile) await this.readFileIntoMemory(gFile);
			}

			const existingCount = [...this.jobs.values()].filter((j) => j.conversationId === params.conversationId).length;
			if (existingCount >= MAX_JOBS_PER_CONVERSATION) {
				throw new Error(`Maximum scheduled tasks (${MAX_JOBS_PER_CONVERSATION}) reached for conversation`);
			}

			const now = Date.now();
			const id = `cron_${randomBytes(6).toString("hex")}`;
			const periodMs = intervalMs ?? 60_000;
			const jitterMs = this.applyJitter ? deterministicJitterMs(id, periodMs) : 0;
			const nextRunAt = cron ? computeNextCronRun(cron, now, jitterMs) : now + periodMs + jitterMs;
			const expiresAt = now + CRON_LIFETIME_MS;
			if (nextRunAt > expiresAt) {
				throw new Error("Next trigger time exceeds 7-day maximum cron lifetime");
			}

			const job: CronJobRecord = {
				id,
				conversationId: params.conversationId,
				...(params.project ? { project: params.project } : {}),
				prompt,
				...(cron ? { cron } : {}),
				...(intervalMs !== undefined ? { intervalMs } : {}),
				recurring,
				durable: requestedDurable,
				jitterMs,
				createdAt: now,
				expiresAt,
				nextRunAt,
				runCount: 0,
				enabled: true,
				source: params.source ?? "tool",
			};
			this.jobs.set(id, job);
			if (job.durable) {
				await this.persistScope(job.project);
			}
			this.scheduleNextTick();
			this.emit();
			return structuredClone(job);
		});
	}

	async scheduleWakeup(params: {
		conversationId: string;
		project?: string;
		input: ScheduleWakeupInput;
	}): Promise<CronJobRecord> {
		if (this.closed) throw new Error("Cron service is closed");
		if (!this.isEnabled()) {
			throw new Error("定时唤醒功能已在设置中关闭（cronEnabled = false）。");
		}
		const raw = assertObject(params.input, "ScheduleWakeup input");
		const allowed = ["delay_seconds", "reason", "prompt"];
		if (Object.keys(raw).some((k) => !allowed.includes(k))) throw new Error("Unknown ScheduleWakeup field");
		const delaySeconds = Number(raw.delay_seconds);
		if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > CRON_LIFETIME_MS / 1000) {
			throw new Error("delay_seconds must be an integer between 1 and 604800 (7 days)");
		}
		const reason = assertText(raw.reason, "reason", 2000);
		const promptText = raw.prompt !== undefined ? assertText(raw.prompt, "prompt", MAX_PROMPT_LENGTH) : reason;
		const trustedProject = params.project && this.isProjectTrusted(params.project) ? params.project : undefined;

		return this.serialize(async () => {
			const now = Date.now();
			const id = `wake_${randomBytes(6).toString("hex")}`;
			const intervalMs = delaySeconds * 1000;
			const jitterMs = this.applyJitter ? deterministicJitterMs(id, intervalMs) : 0;
			const expiresAt = now + CRON_LIFETIME_MS;
			const nextRunAt = Math.min(expiresAt - 1, now + intervalMs + jitterMs);
			const job: CronJobRecord = {
				id,
				conversationId: params.conversationId,
				...(trustedProject ? { project: trustedProject } : {}),
				prompt: promptText,
				intervalMs,
				recurring: false,
				durable: Boolean(trustedProject),
				jitterMs,
				createdAt: now,
				expiresAt,
				nextRunAt,
				runCount: 0,
				enabled: true,
				source: "wakeup",
			};
			this.jobs.set(id, job);
			if (job.durable) {
				await this.persistScope(job.project);
			}
			this.scheduleNextTick();
			this.emit();
			return structuredClone(job);
		});
	}

	async list(conversationId?: string, project?: string): Promise<CronJobRecord[]> {
		if (project && isAbsolute(project) && this.isProjectTrusted(project)) {
			await this.loadProject(project);
		}
		await this.loadGlobal();
		const now = Date.now();
		const out: CronJobRecord[] = [];
		for (const job of this.jobs.values()) {
			if (now >= job.expiresAt) continue;
			if (conversationId && job.conversationId !== conversationId) continue;
			out.push(structuredClone(job));
		}
		return out.sort((a, b) => a.nextRunAt - b.nextRunAt);
	}

	async delete(id: string, conversationId?: string): Promise<boolean> {
		if (typeof id !== "string" || !id.trim()) throw new Error("Invalid cron job id");
		return this.serialize(async () => {
			const job = this.jobs.get(id);
			if (!job) return false;
			if (conversationId && job.conversationId !== conversationId) {
				throw new Error(`Cron job ${id} belongs to another conversation`);
			}
			this.jobs.delete(id);
			this.pendingOneShotRetries.delete(id);
			this.unavailableUntil.delete(id);
			if (job.durable) {
				await this.persistScope(job.project);
			}
			this.scheduleNextTick();
			this.emit();
			return true;
		});
	}

	onEnabledChanged(): void {
		if (this.closed) return;
		this.scheduleNextTick();
		void this.processDue();
	}

	onConversationSettled(conversationId: string): void {
		if (this.closed || !this.isEnabled()) return;
		const hasPending = [...this.pendingOneShotRetries].some((id) => this.jobs.get(id)?.conversationId === conversationId);
		if (hasPending) void this.processDue(conversationId);
	}

	private scheduleNextTick(): void {
		if (this.tickTimer) {
			clearTimeout(this.tickTimer);
			this.tickTimer = undefined;
		}
		if (this.closed || !this.jobs.size || !this.isEnabled()) return;
		let earliest = Infinity;
		for (const job of this.jobs.values()) {
			if (!job.enabled || (job.durable && job.project && !this.isProjectTrusted(job.project))) continue;
			if (this.pendingOneShotRetries.has(job.id)) continue;
			const dueAt = Math.max(job.nextRunAt, this.unavailableUntil.get(job.id) ?? 0);
			if (dueAt < earliest) earliest = dueAt;
		}
		if (!Number.isFinite(earliest)) return;
		const waitMs = Math.min(MAX_TIMER_SLEEP_MS, Math.max(10, earliest - Date.now()));
		this.tickTimer = setTimeout(() => {
			this.tickTimer = undefined;
			void this.processDue();
		}, waitMs);
		this.tickTimer.unref?.();
	}

	async processDue(settledConversationId?: string): Promise<void> {
		if (this.closed) return;
		await this.serialize(async () => {
			const now = Date.now();
			const touchedProjects = new Set<string | undefined>();
			let changed = false;

			for (const job of [...this.jobs.values()]) {
				if (now >= job.expiresAt) {
					this.jobs.delete(job.id);
					this.pendingOneShotRetries.delete(job.id);
					if (job.durable) touchedProjects.add(job.project);
					changed = true;
					continue;
				}
				if (!this.isEnabled() || !job.enabled || (job.durable && job.project && !this.isProjectTrusted(job.project))) continue;
				const retryBackoff = this.unavailableUntil.get(job.id) ?? 0;
				if (retryBackoff > now && !settledConversationId) continue;
				const isRetryMatch = settledConversationId && this.pendingOneShotRetries.has(job.id) && job.conversationId === settledConversationId;
				if (!isRetryMatch && now < job.nextRunAt) continue;

				const seq = job.runCount + 1;
				const header = `[SYSTEM NOTIFICATION - NOT USER INPUT] 定时唤醒任务（${job.source}，id=${job.id}，第 ${seq} 次执行，自动运行会消耗额度）：`;
				const content = `${header}\n\n${job.prompt}`;
				const disposition = await this.deliver(job.conversationId, {
					customType: CRON_WAKEUP_TYPE,
					key: `${job.id}:${seq}`,
					content,
					details: {
						job_id: job.id,
						source: job.source,
						sequence: seq,
						recurring: job.recurring,
						prompt: job.prompt,
					},
					deliverAs: "followUp",
					triggerTurn: true,
					display: true,
					idleOnly: true,
				}, job.project).catch(() => "unavailable" as const);

				if (disposition === "deferred") {
					if (!job.recurring) {
						this.pendingOneShotRetries.add(job.id);
					} else {
						// Idle-only for recurring cron: skip busy slot and schedule next future run without stacking
						this.advanceRecurring(job, now);
						if (job.durable) touchedProjects.add(job.project);
						changed = true;
					}
					continue;
				}

				if (disposition === "unavailable") {
					// Back off retries for inactive/unloaded conversations; recurring slots advance cleanly.
					if (job.recurring) {
						this.advanceRecurring(job, now);
						if (job.durable) touchedProjects.add(job.project);
						changed = true;
					} else {
						this.unavailableUntil.set(job.id, now + 15_000);
					}
					continue;
				}
				this.unavailableUntil.delete(job.id);

				this.pendingOneShotRetries.delete(job.id);
				job.runCount += 1;
				job.lastRunAt = now;
				changed = true;
				if (job.durable) touchedProjects.add(job.project);

				if (!job.recurring) {
					this.jobs.delete(job.id);
				} else {
					this.advanceRecurring(job, now);
					if (job.nextRunAt >= job.expiresAt) {
						this.jobs.delete(job.id);
					}
				}
			}

			for (const proj of touchedProjects) {
				await this.persistScope(proj).catch(() => {});
			}
			if (changed) this.emit();
			this.scheduleNextTick();
		});
	}

	private advanceRecurring(job: CronJobRecord, fromMs: number): void {
		if (job.cron) {
			try {
				job.nextRunAt = computeNextCronRun(job.cron, fromMs, job.jitterMs);
			} catch {
				job.nextRunAt = job.expiresAt + 1;
			}
		} else {
			const period = Math.max(MIN_INTERVAL_MS, job.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS);
			job.nextRunAt = fromMs + period + job.jitterMs;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.tickTimer) {
			clearTimeout(this.tickTimer);
			this.tickTimer = undefined;
		}
		this.jobs.clear();
		this.pendingOneShotRetries.clear();
		this.unavailableUntil.clear();
		this.listeners.clear();
	}
}
