import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKaggleRemoteJobQuery } from "../src/kaggle-remote-jobs.ts";
import type { RemoteJobObservation, RemoteJobTrackInput } from "../src/remote-job-types.ts";
import { RemoteJobsService } from "../src/remote-jobs.ts";

const notebook = { kind: "kaggle-notebook", notebook: "research/smoke", version: 4 } as const;
const submission = { kind: "kaggle-submission", competition: "sample-contest", submissionId: "101" } as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test("tracks exact versions, persists them, and resumes a pending query after restart", { timeout: 5_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-remote-jobs-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const statePath = join(dir, "remote-jobs.json");
	const input = { ...notebook, projectDir: dir, conversationId: "contest" };
	const offline = new RemoteJobsService({ statePath, canQuery: () => false });
	t.after(() => offline.dispose());
	const tracked = await offline.track(input);
	assert.equal(tracked.status, "unknown");
	assert.equal((await offline.track(input)).id, tracked.id);
	const nextVersion = await offline.track({ ...input, version: 5 });
	assert.notEqual(nextVersion.id, tracked.id);
	assert.equal((await offline.refresh(tracked.id))?.checkedAt, undefined);
	await assert.rejects(offline.track({ ...input, notebook: "https://invalid.example" }), /owner\/slug/);
	offline.dispose();

	const changes = deferred<void>();
	const queries: number[] = [];
	const online = new RemoteJobsService({
		statePath,
		onChange: (id, previous) => {
			assert.equal(previous?.status, "unknown");
			if (id === nextVersion.id) changes.resolve();
		},
		query: async (job) => {
			assert.equal(job.kind, "kaggle-notebook");
			queries.push(job.version);
			return { status: "completed", evidence: { artifactCount: 0 } };
		},
	});
	t.after(() => online.dispose());
	await online.start();
	assert.equal(online.list("contest").length, 2);
	// Start a referenced timer so Node can keep the service's unref-ed timer alive in this test.
	const timer = setTimeout(() => {}, 4_000);
	try { await changes.promise; } finally { clearTimeout(timer); }
	assert.deepEqual([...queries].sort(), [4, 5]);
	assert.equal(online.list()[0].evidence?.artifactCount, 0);
	const saved = JSON.parse(await readFile(statePath, "utf8"));
	assert.ok(saved.jobs.every((job: { nextCheckAt?: number }) => job.nextCheckAt === undefined));
});

test("coalesces refreshes, keeps observed status across query errors, and drops a deleted in-flight job", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-remote-query-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let allowed = false;
	let result = deferred<RemoteJobObservation>();
	let started = deferred<AbortSignal>();
	const service = new RemoteJobsService({
		statePath: join(dir, "remote-jobs.json"),
		canQuery: () => allowed,
		query: async (_job, signal) => {
			started.resolve(signal);
			return result.promise;
		},
	});
	t.after(() => service.dispose());
	const job = await service.track({ ...submission, projectDir: dir, conversationId: "contest" });
	allowed = true;
	const one = service.refresh(job.id);
	const two = service.refresh(job.id);
	await started.promise;
	result.resolve({ status: "awaiting-score" });
	assert.equal((await one)?.status, "awaiting-score");
	assert.deepEqual(await one, await two);

	result = deferred();
	started = deferred();
	const error = service.refresh(job.id);
	await started.promise;
	result.resolve({ status: "unknown", queryError: "unavailable" });
	const errorRecord = await error;
	assert.equal(errorRecord?.status, "awaiting-score");
	assert.equal(errorRecord?.queryError?.code, "unavailable");
	assert.equal(errorRecord?.checkedAt, (await one)?.checkedAt);

	allowed = false;
	const reattached = await service.track({ ...submission, projectDir: dir, conversationId: "contest", useProjectCredentials: true });
	assert.equal(reattached.id, job.id);
	assert.equal(reattached.status, "awaiting-score");
	assert.equal(reattached.queryError, undefined);

	allowed = true;
	result = deferred();
	started = deferred();
	const cancelled = service.refresh(job.id);
	const signal = await started.promise;
	allowed = false;
	service.reschedule();
	assert.equal(signal.aborted, true);
	assert.equal(await service.untrack(job.id), true);
	result.resolve({ status: "completed", evidence: { publicScore: "1" } });
	assert.equal(await cancelled, undefined);
	assert.deepEqual(service.list(), []);
});

test("only queries fixed Kaggle RPCs, binds notebook artifacts to the exact version, and keeps partial evidence distinct", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-kaggle-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const calls: Array<{ url: string; body: unknown }> = [];
	let closed = 0;
	let queued = false;
	let partial = true;
	const dispatcher = { close: async () => { closed++; } };
	const query = createKaggleRemoteJobQuery({
		env: { KAGGLE_API_TOKEN: "fixture-token" },
		home,
		dispatcher: async () => dispatcher,
		fetch: async (url, options) => {
			const address = String(url);
			assert.equal(new URL(address).origin, "https://api.kaggle.com");
			assert.equal(options?.redirect, "error");
			assert.equal(options?.method, "POST");
			assert.equal((options as RequestInit & { dispatcher: unknown }).dispatcher, dispatcher);
			assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-token");
			calls.push({ url: address, body: JSON.parse(String(options.body)) });
			if (address.endsWith("/GetKernelSessionStatus")) return Response.json(queued ? {} : { status: "COMPLETE" });
			assert.ok(address.endsWith("/ListKernelFiles"));
			return partial ? new Response(undefined, { status: 503 }) : Response.json({ files: [{ name: "agent_eval.csv" }], nextPageToken: "cursor" });
		},
	});
	const input = { ...notebook, projectDir: home, conversationId: "contest" };
	assert.deepEqual(await query(input, new AbortController().signal), { status: "completed", queryError: "unavailable" });
	partial = false;
	assert.deepEqual(await query(input, new AbortController().signal), { status: "completed", evidence: { artifactCount: 1, artifactsMore: true } });
	queued = true;
	assert.deepEqual(await query(input, new AbortController().signal), { status: "queued" });
	assert.equal(closed, 5);
	for (const call of calls) assert.ok(call.body && (call.body as { versionLabel?: string }).versionLabel === "v4");
});

test("selects the exact submission across pages and only reads real project credentials on opt-in", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-kaggle-project-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const project = await realpath(dir);
	const secrets = join(project, ".secrets");
	await mkdir(secrets);
	const token = join(secrets, "kaggle_token");
	const outside = join(project, "other-secret");
	await writeFile(outside, "unapproved-fixture");
	await symlink(outside, token);
	const pages: string[] = [];
	const query = createKaggleRemoteJobQuery({
		env: { KAGGLE_API_TOKEN: undefined, KAGGLE_CONFIG_DIR: undefined, KAGGLE_USERNAME: undefined, KAGGLE_KEY: undefined },
		home: project,
		fetch: async (url, options) => {
			assert.match(String(url), /\/ListSubmissions$/);
			assert.equal(new Headers(options?.headers).get("authorization"), "Bearer opted-in-fixture");
			const body = JSON.parse(String(options?.body));
			assert.equal(body.competitionName, "sample-contest");
			pages.push(body.pageToken ?? "");
			return body.pageToken
				? Response.json({ submissions: [{ ref: 101, status: "COMPLETE", publicScore: "0.123" }] })
				: Response.json({ submissions: [{ ref: 100, status: "COMPLETE", publicScore: "0.9" }], nextPageToken: "page-2" });
		},
	});
	const signal = new AbortController().signal;
	const input: RemoteJobTrackInput = { ...submission, projectDir: project, conversationId: "contest" };
	assert.deepEqual(await query(input, signal), { status: "unknown", queryError: "credentials" });
	assert.deepEqual(await query({ ...input, useProjectCredentials: true }, signal), { status: "unknown", queryError: "credentials" });
	assert.deepEqual(pages, []);
	await rm(token);
	await writeFile(token, "opted-in-fixture\n", { mode: 0o600 });
	assert.deepEqual(await query({ ...input, useProjectCredentials: true }, signal), { status: "completed", evidence: { publicScore: "0.123" } });
	assert.deepEqual(pages, ["", "page-2"]);
});
