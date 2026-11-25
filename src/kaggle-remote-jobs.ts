import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RemoteJobErrorCode, RemoteJobObservation, RemoteJobQuery, RemoteJobTrackInput } from "./remote-job-types.ts";

const origin = "https://api.kaggle.com";
const endpoints = {
	status: "/v1/kernels.KernelsApiService/GetKernelSessionStatus",
	files: "/v1/kernels.KernelsApiService/ListKernelFiles",
	submissions: "/v1/competitions.CompetitionApiService/ListSubmissions",
};
const maxCredentialBytes = 8192;
const maxBodyBytes = 2 * 1024 * 1024;
const pageSize = 100;
const notebookStatuses: Record<string, RemoteJobObservation["status"]> = {
	NEW_SCRIPT: "unknown",
	QUEUED: "queued",
	RUNNING: "running",
	COMPLETE: "completed",
	ERROR: "failed",
	CANCEL_REQUESTED: "running",
	CANCEL_ACKNOWLEDGED: "cancelled",
};
const submissionStatuses: Record<string, RemoteJobObservation["status"]> = {
	PENDING: "awaiting-score",
	COMPLETE: "completed",
	ERROR: "failed",
};

function validSecret(value: unknown): value is string {
	return typeof value === "string" && value.length <= maxCredentialBytes && /^[!-~]+$/.test(value);
}

async function readCredentialFile(path: string): Promise<string | undefined> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
	if (!file) return undefined;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxCredentialBytes) return undefined;
		const bytes = Buffer.alloc(maxCredentialBytes + 1);
		const { bytesRead } = await file.read(bytes);
		if (bytesRead > maxCredentialBytes) return undefined;
		return bytes.subarray(0, bytesRead).toString("utf8").trim();
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}

async function authorization(job: RemoteJobTrackInput, env: NodeJS.ProcessEnv, home: string): Promise<string | undefined> {
	if (job.useProjectCredentials) {
		const project = await realpath(job.projectDir).catch(() => undefined);
		if (!project || project !== job.projectDir) return;
		const directory = join(project, ".secrets");
		if (await realpath(directory).catch(() => undefined) !== directory) return;
		const token = await readCredentialFile(join(directory, "kaggle_token"));
		if (validSecret(token)) return `Bearer ${token}`;
		return;
	}
	const tokenEnv = env.KAGGLE_API_TOKEN?.trim();
	const token = tokenEnv
		? isAbsolute(tokenEnv) ? await readCredentialFile(tokenEnv) : tokenEnv
		: await readCredentialFile(join(home, ".kaggle", "access_token")) ?? await readCredentialFile(join(home, ".kaggle", "access_token.txt"));
	if (validSecret(token)) return `Bearer ${token}`;
	let user = env.KAGGLE_USERNAME;
	let key = env.KAGGLE_KEY;
	if (!user || !key) {
		const content = await readCredentialFile(join(env.KAGGLE_CONFIG_DIR || join(home, ".kaggle"), "kaggle.json"));
		try {
			const config = JSON.parse(content ?? "{}");
			user ||= config?.username;
			key ||= config?.key;
		} catch { return undefined; }
	}
	if (validSecret(user) && validSecret(key) && !user.includes(":"))
		return `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;
}

class QueryFailure extends Error {
	readonly code: RemoteJobErrorCode;

	constructor(code: RemoteJobErrorCode) {
		super(code);
		this.code = code;
	}
}

function failureCode(error: unknown): RemoteJobErrorCode {
	return error instanceof QueryFailure ? error.code : "unavailable";
}

export function kagglePublicScore(value: unknown): string | undefined {
	const score = typeof value === "number" ? String(value) : value;
	return typeof score === "string" && score.length <= 40 && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(score) && Number.isFinite(Number(score))
		? score
		: undefined;
}

function statusFrom(value: unknown, statuses: Record<string, RemoteJobObservation["status"]>): RemoteJobObservation["status"] {
	const key = typeof value === "string" ? value.split(".").at(-1)?.toUpperCase() : undefined;
	if (!key || !Object.hasOwn(statuses, key)) throw new QueryFailure("invalid-response");
	return statuses[key];
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) throw new QueryFailure("invalid-response");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > maxBodyBytes) {
				await reader.cancel();
				throw new QueryFailure("invalid-response");
			}
			chunks.push(value);
		}
		const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!json || typeof json !== "object" || Array.isArray(json))
			throw new QueryFailure("invalid-response");
		return json;
	} catch (error) {
		if (error instanceof SyntaxError) throw new QueryFailure("invalid-response");
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function rejectedStatus(status: number): RemoteJobErrorCode {
	if (status === 401 || status === 403) return "access";
	if (status === 404) return "not-found";
	return "unavailable";
}

export function createKaggleRemoteJobQuery(options: {
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	home?: string;
	dispatcher?: () => Promise<{ close(): Promise<void> } | undefined>;
} = {}): RemoteJobQuery {
	const fetchRequest = options.fetch ?? fetch;
	return async (job, signal) => {
		try {
			const env = options.env ? { ...process.env, ...options.env } : process.env;
			const credential = await authorization(job, env, options.home ?? homedir());
			if (!credential) throw new QueryFailure("credentials");
			const call = async (endpoint: keyof typeof endpoints, body: Record<string, string | number>) => {
				const dispatcher = await options.dispatcher?.();
				try {
					const init: RequestInit & { dispatcher?: unknown } = {
						method: "POST",
						headers: { authorization: credential, "content-type": "application/json" },
						body: JSON.stringify(body),
						redirect: "error",
						signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
						...(dispatcher ? { dispatcher } : {}),
					};
					const response = await fetchRequest(origin + endpoints[endpoint], init);
					if (!response.ok) {
						await response.body?.cancel().catch(() => {});
						throw new QueryFailure(rejectedStatus(response.status));
					}
					const json = await responseObject(response);
					if (typeof json.code === "number" && json.code >= 400) throw new QueryFailure(rejectedStatus(json.code));
					return json;
				} finally {
					await dispatcher?.close().catch(() => {});
				}
			};

			if (job.kind === "kaggle-notebook") {
				const [userName, kernelSlug] = job.notebook.split("/");
				const version = { userName, kernelSlug, versionLabel: `v${job.version}` };
				// Kaggle's SDK defines QUEUED as the omitted default for this response.
				const result = await call("status", version);
				const status = statusFrom(Object.hasOwn(result, "status") ? result.status : "QUEUED", notebookStatuses);
				if (status !== "completed") return { status };
				try {
					const result = await call("files", { ...version, pageSize });
					const files = result.files ?? [];
					if (!Array.isArray(files) || files.some((file) => !file || typeof file.name !== "string" || !file.name))
						throw new QueryFailure("invalid-response");
					return { status, evidence: { artifactCount: files.length, artifactsMore: Boolean(result.nextPageToken) } };
				} catch (error) {
					return { status, queryError: failureCode(error) };
				}
			}

			// A submission can move between pages as new submissions arrive.
			let pageToken = "";
			for (let page = 0; page < 5; page++) {
				const result = await call("submissions", { competitionName: job.competition, pageSize, ...(pageToken ? { pageToken } : {}) });
				const submissions = result.submissions ?? [];
				if (!Array.isArray(submissions)) throw new QueryFailure("invalid-response");
				const match = submissions.find((entry) => entry && (typeof entry.ref === "string" || Number.isSafeInteger(entry.ref)) && String(entry.ref) === job.submissionId);
				if (match) {
					const status = statusFrom(Object.hasOwn(match, "status") ? match.status : "PENDING", submissionStatuses);
					const publicScore = kagglePublicScore(match.publicScore);
					return { status, ...(publicScore !== undefined ? { evidence: { publicScore } } : {}) };
				}
				if (typeof result.nextPageToken !== "string" || !result.nextPageToken || result.nextPageToken === pageToken) break;
				pageToken = result.nextPageToken;
			}
			throw new QueryFailure("not-found");
		} catch (error) {
			return { status: "unknown", queryError: failureCode(error) };
		}
	};
}
