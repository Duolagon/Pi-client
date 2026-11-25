import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { createKaggleRemoteJobQuery, kagglePublicScore } from "./kaggle-remote-jobs.ts";
import {
	remoteJobErrorCodes,
	remoteJobStatuses,
	type RemoteJobEvidence,
	type RemoteJobObservation,
	type RemoteJobQuery,
	type RemoteJobRecord,
	type RemoteJobTrackInput,
} from "./remote-job-types.ts";

const maxJobs = 300;
const activeInterval = 60_000;
const scoringInterval = 3 * activeInterval;
const maximumBackoff = 30 * activeInterval;
const slug = "[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}";
const notebookPattern = new RegExp(`^${slug}/${slug}$`);
const slugPattern = new RegExp(`^${slug}$`);
const terminal = new Set(["completed", "failed", "cancelled"]);

interface StoredJob {
	record: RemoteJobRecord;
	nextCheckAt?: number;
	failures: number;
}

type Change = (jobId: string, previous?: RemoteJobRecord) => void;

interface RemoteJobsOptions {
	statePath: string;
	onChange?: Change;
	query?: RemoteJobQuery;
	canQuery?: () => boolean;
}

function validDate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTrackInput(value: unknown): RemoteJobTrackInput {
	if (!value || typeof value !== "object") throw new Error("无效的远端任务。");
	const input = value as Partial<RemoteJobTrackInput>;
	if (typeof input.conversationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.conversationId) ||
		typeof input.projectDir !== "string" || input.projectDir.length > 4096 || input.projectDir.includes("\0") || !isAbsolute(input.projectDir) ||
		(input.useProjectCredentials !== undefined && typeof input.useProjectCredentials !== "boolean"))
		throw new Error("远端任务需要有效的会话和项目路径。");
	const location = {
		conversationId: input.conversationId,
		projectDir: normalize(input.projectDir),
		...(input.useProjectCredentials ? { useProjectCredentials: true } : {}),
	};

	if (input.kind === "kaggle-notebook" && typeof input.notebook === "string" && notebookPattern.test(input.notebook) &&
		typeof input.version === "number" && Number.isSafeInteger(input.version) && input.version >= 1)
		return { ...location, kind: input.kind, notebook: input.notebook.toLowerCase(), version: input.version };
	if (input.kind === "kaggle-submission" && typeof input.competition === "string" && slugPattern.test(input.competition) &&
		typeof input.submissionId === "string" && /^[1-9][0-9]{0,19}$/.test(input.submissionId))
		return { ...location, kind: input.kind, competition: input.competition.toLowerCase(), submissionId: input.submissionId };
	throw new Error("请提供 Kaggle Notebook 的 owner/slug 和版本号，或比赛 slug 和提交 ID。");
}

function jobTarget(input: RemoteJobTrackInput): string {
	return input.kind === "kaggle-notebook"
		? `${input.notebook}/${input.version}`
		: `${input.competition}/${input.submissionId}`;
}

function jobUrl(input: RemoteJobTrackInput): string {
	return input.kind === "kaggle-notebook"
		? `https://www.kaggle.com/code/${input.notebook}`
		: `https://www.kaggle.com/competitions/${input.competition}/submissions`;
}

function parseEvidence(input: RemoteJobEvidence | undefined): RemoteJobEvidence | undefined {
	if (!input || typeof input !== "object") return;
	const { artifactCount, artifactsMore } = input;
	const publicScore = kagglePublicScore(input.publicScore);
	if (typeof artifactCount === "number" && Number.isSafeInteger(artifactCount) && artifactCount >= 0)
		return { artifactCount, artifactsMore: artifactsMore === true };
	if (publicScore !== undefined) return { publicScore };
}

function parseEntry(value: unknown): StoredJob | undefined {
	if (!value || typeof value !== "object") return;
	const candidate = value as Partial<StoredJob>;
	const record = candidate.record;
	if (!record || typeof record.id !== "string" || !/^[0-9a-f-]{36}$/.test(record.id) || !remoteJobStatuses.includes(record.status) ||
		!validDate(record.createdAt) || !validDate(record.updatedAt)) return;
	let input: RemoteJobTrackInput;
	try { input = parseTrackInput(record); } catch { return; }
	const error = record.queryError;
	return {
		record: {
			...input, id: record.id, url: jobUrl(input), status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
			checkedAt: validDate(record.checkedAt) ? record.checkedAt : undefined,
			queryError: error && remoteJobErrorCodes.includes(error.code) && validDate(error.at) ? { code: error.code, at: error.at } : undefined,
			evidence: parseEvidence(record.evidence),
		},
		nextCheckAt: validDate(candidate.nextCheckAt) ? candidate.nextCheckAt : undefined,
		failures: typeof candidate.failures === "number" && Number.isInteger(candidate.failures) ? Math.max(0, Math.min(20, candidate.failures)) : 0,
	};
}

/** Watches known Kaggle jobs. Registration and polling only read from the provider. */
export class RemoteJobsService {
	private readonly options: RemoteJobsOptions;
	private readonly query: RemoteJobQuery;
	private entries = new Map<string, StoredJob>();
	private loadPromise?: Promise<void>;
	private writes = Promise.resolve();
	private pending = new Map<string, { controller: AbortController; result: Promise<RemoteJobRecord | undefined> }>();
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(options: RemoteJobsOptions) {
		this.options = options;
		this.query = options.query ?? createKaggleRemoteJobQuery();
	}

	start(): Promise<void> {
		return this.loadPromise ??= this.load();
	}

	list(conversationId?: string): RemoteJobRecord[] {
		return [...this.entries.values()]
			.map(({ record }) => record)
			.filter((record) => !conversationId || conversationId === record.conversationId)
			.sort((left, right) => right.createdAt - left.createdAt)
			.map((record) => structuredClone(record));
	}

	async track(value: RemoteJobTrackInput): Promise<RemoteJobRecord> {
		await this.start();
		const input = parseTrackInput(value);
		if (input.useProjectCredentials) input.projectDir = await realpath(input.projectDir);
		return this.transaction(async () => {
			const existing = [...this.entries.values()].find(({ record }) =>
				record.conversationId === input.conversationId && record.kind === input.kind && jobTarget(record) === jobTarget(input));
			const sameCredentials = existing?.record.projectDir === input.projectDir &&
				existing?.record.useProjectCredentials === input.useProjectCredentials;
			if (existing && sameCredentials) return structuredClone(existing.record);
			if (!existing && this.entries.size >= maxJobs) throw new Error("远端任务已达到上限，请先移除不再追踪的任务。");
			const now = Date.now();
			const record: RemoteJobRecord = existing
				? { ...existing.record, ...input, useProjectCredentials: input.useProjectCredentials, updatedAt: now, queryError: undefined }
				: { ...input, id: randomUUID(), url: jobUrl(input), status: "unknown", createdAt: now, updatedAt: now };
			this.pending.get(record.id)?.controller.abort();
			await this.save(record.id, { record, failures: 0, nextCheckAt: now });
			return structuredClone(record);
		});
	}

	async refresh(id: string): Promise<RemoteJobRecord | undefined> {
		await this.start();
		if (this.disposed || this.options.canQuery?.() === false) return this.currentRecord(id);
		const active = this.pending.get(id);
		if (active) return active.result;
		const entry = this.entries.get(id);
		if (!entry) return;
		const controller = new AbortController();
		const result = this.poll(entry, controller.signal).finally(() => {
			this.pending.delete(id);
			this.reschedule();
		});
		this.pending.set(id, { controller, result });
		return result;
	}

	async untrack(id: string): Promise<boolean> {
		await this.start();
		return this.transaction(async () => {
			if (!this.entries.has(id)) return false;
			await this.save(id, undefined);
			this.pending.get(id)?.controller.abort();
			return true;
		});
	}

	/** Apply an offline setting change immediately to the scheduler and any in-flight request. */
	reschedule(): void {
		clearTimeout(this.timer);
		if (this.disposed || this.options.canQuery?.() === false) {
			for (const { controller } of this.pending.values()) controller.abort();
			return;
		}
		const next = [...this.entries.values()].reduce<StoredJob | undefined>((earliest, job) => {
			if (job.nextCheckAt === undefined || this.pending.has(job.record.id)) return earliest;
			return !earliest || job.nextCheckAt < earliest.nextCheckAt! ? job : earliest;
		}, undefined);
		if (next?.nextCheckAt !== undefined) {
			const delay = Math.min(2_147_000_000, Math.max(0, next.nextCheckAt - Date.now()));
			this.timer = setTimeout(() => {
				void this.refresh(next.record.id).catch(() => {
					// A temporary local persistence error must not create a zero-delay retry loop.
					clearTimeout(this.timer);
					if (!this.disposed) this.timer = setTimeout(() => this.reschedule(), activeInterval).unref();
				});
			}, delay).unref();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.reschedule();
	}

	private currentRecord(id: string): RemoteJobRecord | undefined {
		const record = this.entries.get(id)?.record;
		return record && structuredClone(record);
	}

	private async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.options.statePath, "utf8")) as { version?: unknown; jobs?: unknown };
			if (saved?.version !== 1 || !Array.isArray(saved.jobs)) throw new Error("无法读取远端任务记录。");
			for (const item of saved.jobs.slice(0, maxJobs)) {
				const entry = parseEntry(item);
				if (entry) this.entries.set(entry.record.id, entry);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.reschedule();
	}

	private transaction<T>(change: () => Promise<T>): Promise<T> {
		const next = this.writes.then(async () => {
			if (this.disposed) throw new Error("远端任务服务已关闭。");
			return change();
		});
		this.writes = next.then(() => {}, () => {});
		return next;
	}

	private async save(id: string, value: StoredJob | undefined): Promise<void> {
		const previous = this.currentRecord(id);
		const next = new Map(this.entries);
		if (value) next.set(id, value);
		else next.delete(id);
		const path = this.options.statePath;
		const temporary = `${path}.${randomUUID()}.tmp`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try {
			await writeFile(temporary, JSON.stringify({ version: 1, jobs: [...next.values()] }), { mode: 0o600, flag: "wx" });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
		this.entries = next;
		this.reschedule();
		this.options.onChange?.(id, previous);
	}

	private async poll(entry: StoredJob, signal: AbortSignal): Promise<RemoteJobRecord | undefined> {
		let observed: RemoteJobObservation;
		try {
			observed = await this.query(structuredClone(entry.record), signal);
		} catch {
			observed = { status: "unknown", queryError: "unavailable" };
		}
		const id = entry.record.id;
		if (signal.aborted || this.disposed) return this.currentRecord(id);
		return this.transaction(async () => {
			if (signal.aborted || this.entries.get(id) !== entry) return this.currentRecord(id);
			const now = Date.now();
			const warn = observed.queryError;
			const previous = entry.record;
			const status = observed.status === "unknown" && warn ? previous.status : observed.status;
			const failures = warn ? Math.min(20, entry.failures + 1) : 0;
			const retryInterval = warn ? Math.min(maximumBackoff, activeInterval * 2 ** failures) :
				status === "awaiting-score" ? scoringInterval : activeInterval;
			const record: RemoteJobRecord = {
				...previous,
				status,
				updatedAt: now,
				checkedAt: observed.status === "unknown" && warn ? previous.checkedAt : now,
				queryError: warn ? { code: warn, at: now } : undefined,
				evidence: parseEvidence(observed.evidence) ?? (status === previous.status ? previous.evidence : undefined),
			};
			await this.save(id, { record, failures, nextCheckAt: warn || !terminal.has(status) ? now + retryInterval : undefined });
			return structuredClone(record);
		});
	}
}
