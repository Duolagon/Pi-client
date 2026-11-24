/**
 * Token usage and cost aggregation over Pi session JSONL files (/stats).
 * Files are streamed line by line and cached by size and mtime, so repeated
 * calls only re-read files that changed.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { UsageBucket, UsageStatsReport } from "./shared.ts";

/** One assistant message's usage, keyed for de-duplication across forked copies. */
export interface UsageRecord {
	key: string;
	day: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	samples?: number;
}

interface CachedFile {
	size: number;
	mtimeMs: number;
	records: UsageRecord[];
}

export const DEFAULT_USAGE_DAYS = 30;
export const MAX_USAGE_DAYS = 365;

/** Local calendar day "YYYY-MM-DD" for a millisecond timestamp. */
export function localDay(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown, max = 200): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Extracts the usage record of one session entry line, or undefined when it has none. */
export function usageRecordFromLine(line: string): UsageRecord | undefined {
	if (!line.includes('"assistant"') || !line.includes('"usage"')) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; id?: unknown; timestamp?: unknown; message?: unknown };
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	const message = record.message as {
		role?: unknown;
		provider?: unknown;
		model?: unknown;
		timestamp?: unknown;
		responseId?: unknown;
		usage?: unknown;
	};
	if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") return undefined;
	const usage = message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: unknown };
	const cost = usage.cost && typeof usage.cost === "object" ? count((usage.cost as { total?: unknown }).total) : 0;
	const at =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
			? message.timestamp
			: typeof record.timestamp === "string"
				? Date.parse(record.timestamp)
				: Number.NaN;
	if (!Number.isFinite(at)) return undefined;
	const input = count(usage.input);
	const output = count(usage.output);
	const cacheRead = count(usage.cacheRead);
	const cacheWrite = count(usage.cacheWrite);
	if (!input && !output && !cacheRead && !cacheWrite && !cost) return undefined;
	const provider = text(message.provider) ?? "unknown";
	const model = text(message.model) ?? "unknown";
	// Forked child sessions copy the parent's entries verbatim (same id and timestamp).
	const key = `${text(record.id, 100) ?? ""}|${at}|${text(message.responseId, 200) ?? ""}`;
	return { key, day: localDay(at), model: `${provider}/${model}`, input, output, cacheRead, cacheWrite, cost };
}

async function readRecords(path: string): Promise<UsageRecord[]> {
	const records: UsageRecord[] = [];
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const record = usageRecordFromLine(line);
			if (record) records.push(record);
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return records;
}

function emptyBucket(): Omit<UsageBucket, "key"> {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, messages: 0 };
}

function add(target: Omit<UsageBucket, "key">, record: UsageRecord): void {
	target.input += record.input;
	target.output += record.output;
	target.cacheRead += record.cacheRead;
	target.cacheWrite += record.cacheWrite;
	target.tokens += record.input + record.output + record.cacheRead + record.cacheWrite;
	target.cost += record.cost;
	target.messages += record.samples ?? 1;
}

export class UsageStatsCollector {
	private readonly cache = new Map<string, CachedFile>();
	/** Number of files read from disk (not served from cache) by the last collect call. */
	lastReads = 0;

	/**
	 * Aggregates usage of the given session files over the last `days` local days,
	 * today included. Unreadable or vanished files are skipped.
	 */
	async collect(files: string[], options: { days?: number; now?: number } = {}, extraRecords: UsageRecord[] = []): Promise<UsageStatsReport> {
		const days = Math.min(MAX_USAGE_DAYS, Math.max(1, Math.floor(options.days ?? DEFAULT_USAGE_DAYS)));
		const now = options.now ?? Date.now();
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		start.setDate(start.getDate() - (days - 1));
		const since = localDay(start.getTime());
		const unique = [...new Set(files)];
		this.lastReads = 0;
		let skipped = 0;
		const perFile: UsageRecord[][] = [];
		for (const path of unique) {
			try {
				const info = await stat(path);
				if (!info.isFile()) throw new Error("not a file");
				const cached = this.cache.get(path);
				if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
					perFile.push(cached.records);
					continue;
				}
				const records = await readRecords(path);
				this.lastReads += 1;
				this.cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, records });
				perFile.push(records);
			} catch {
				this.cache.delete(path);
				skipped += 1;
			}
		}
		for (const path of [...this.cache.keys()]) if (!unique.includes(path)) this.cache.delete(path);
		const seen = new Set<string>();
		const byDay = new Map<string, Omit<UsageBucket, "key">>();
		const byModel = new Map<string, Omit<UsageBucket, "key">>();
		const totals = emptyBucket();
		for (const records of [...perFile, extraRecords]) {
			for (const record of records) {
				if (record.day < since || seen.has(record.key)) continue;
				seen.add(record.key);
				const day = byDay.get(record.day) ?? emptyBucket();
				byDay.set(record.day, day);
				add(day, record);
				const model = byModel.get(record.model) ?? emptyBucket();
				byModel.set(record.model, model);
				add(model, record);
				add(totals, record);
			}
		}
		return {
			generatedAt: now,
			rangeDays: days,
			since,
			files: unique.length - skipped,
			skipped,
			totals,
			days: [...byDay].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.key.localeCompare(a.key)),
			models: [...byModel].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
		};
	}
}
