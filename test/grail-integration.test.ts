import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { access, cp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { GitSnapshots } from "../src/git-snapshots.ts";
import type { AgentProcess } from "../src/rpc.ts";
import type { DesktopEvent, GrailEvent, GrailVerdict } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "../src/permission-extension.ts");

async function setup(nested = false) {
	const fixture = await createCoreFixture();
	await cp(join(here, "fixtures", "grail-provider.js"), join(fixture.agentDir, "extensions", "grail-provider.js"));
	const project = nested ? join(fixture.project, "packages", "app") : fixture.project;
	await mkdir(join(project, "src"), { recursive: true });
	await mkdir(join(project, "test"));
	await writeFile(join(project, "package.json"), JSON.stringify({
		name: "grail-demo", private: true, type: "module",
		scripts: { test: "node --test", check: "node --check src/add.mjs", lint: "node lint.mjs" },
	}));
	await writeFile(join(project, "lint.mjs"), 'import { readFileSync } from "node:fs";\nif (/ +$/m.test(readFileSync("src/add.mjs", "utf8"))) process.exitCode = 1;\n');
	await writeFile(join(project, "src", "add.mjs"), "export function add(a, b) {\n\treturn 0;\n}\n");
	let testFixture = 'import assert from "node:assert/strict";\nimport { writeFileSync } from "node:fs";\nimport { test } from "node:test";\nimport { add } from "../src/add.mjs";\n';
	if (nested) {
		const sibling = join(fixture.project, "packages", "shared");
		const installed = join(fixture.project, "node_modules");
		await mkdir(sibling);
		await mkdir(installed);
		await writeFile(join(fixture.project, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
		await writeFile(join(fixture.project, ".gitignore"), "node_modules/\n");
		await writeFile(join(sibling, "package.json"), JSON.stringify({ name: "grail-shared", type: "module", exports: "./index.mjs" }));
		await writeFile(join(sibling, "index.mjs"), "export const expected = 3;\n");
		await symlink(sibling, join(installed, "grail-shared"));
		testFixture += 'import { expected } from "../../shared/index.mjs";\nimport { expected as linked } from "grail-shared";\n';
		testFixture += 'test("add", () => { writeFileSync("grail-local-artifact", "test"); assert.equal(expected, 3); assert.equal(add(1, 2), expected); assert.equal(linked, expected); });\n';
	} else {
		testFixture += 'test("add", () => { writeFileSync("grail-local-artifact", "test"); console.log("test-output".repeat(7_000)); console.log("PRIVATE_GRAIL_LOG_MARKER"); assert.equal(add(1, 2), 3); });\n';
	}
	await writeFile(
		join(project, "test", "add.test.mjs"),
		testFixture,
	);
	await exec("git", ["init", "-q", fixture.project]);
	await exec("git", ["add", "."], { cwd: fixture.project });
	await exec("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "seed"], { cwd: fixture.project });
	const control = join(fixture.root, "grail-mode");
	const log = join(fixture.root, "grail-log.jsonl");
	await writeFile(control, "grail");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: { ...fixture.env, HOME: fixture.root, GRAIL_TEST_CONTROL: control, GRAIL_TEST_LOG: log },
		initialProject: project,
	});
	const grail: GrailEvent[] = [];
	const session: DesktopEvent[] = [];
	service.subscribeGrail((event) => grail.push(event));
	service.subscribe((event) => session.push(event));
	return { fixture, project, service, control, log, grail, session };
}

function waitFor<T>(check: () => T | undefined, label: string, timeout = 60000): Promise<T> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			const value = check();
			if (value !== undefined) return resolve(value);
			if (Date.now() - started > timeout) return reject(new Error(`Missing ${label}`));
			setTimeout(tick, 50);
		};
		tick();
	});
}

test("Grail judgement: grail, 愿望达成, failing test, cancel and seal, never visible to the agent", { timeout: 180000 }, async () => {
	const { fixture, service, control, log, grail, session } = await setup();
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		await service.saveSettings({ permission: "auto", theme: "light", grailModel: { provider: "grail-test", id: "grail-judge-1" }, grailMaxCost: 1, grailTimeoutSec: 120 });
		const conversationId = snapshot.active!.id;
		assert.equal((await service.grailState(conversationId)).hasDiff, false);
		assert.equal((await service.grailState(conversationId)).readiness, "no-checkpoint");
		const empty = await service.startGrail(conversationId);
		const none = await waitFor(() => grail.find((event): event is Extract<GrailEvent, { type: "grail_verdict" }> => event.type === "grail_verdict" && event.verdict.id === empty.id), "empty verdict");
		assert.equal(none.verdict.grade, "unjudgeable");

		// One agent turn creates the wish's first checkpoint; the fix itself is then made in the worktree.
		const settled = session.length;
		await service.command({ type: "prompt", message: "read-write-bash 实现 add" }, conversationId);
		await waitFor(() => session.slice(settled).find((event) => event.event.type === "agent_settled"), "agent_settled");
		await waitFor(() => (service as unknown as { runtimes: Map<string, { checkpointId?: string }> }).runtimes.get(conversationId)?.checkpointId === undefined || undefined, "checkpoint finished");
		await writeFile(join(fixture.project, "src", "add.mjs"), "export function add(a, b) {\n\treturn a + b;\n}\n");
		assert.equal((await service.grailState(conversationId)).hasDiff, true);

		const judge = async (): Promise<GrailVerdict> => {
			const { id } = await service.startGrail(conversationId);
			const done = await waitFor(() => grail.find((event) => (event.type === "grail_verdict" && event.verdict.id === id) || (event.type === "grail_failed" && event.id === id)), "verdict");
			assert.equal(done.type, "grail_verdict", JSON.stringify(done));
			return (done as Extract<GrailEvent, { type: "grail_verdict" }>).verdict;
		};

		const first = await judge();
		await assert.rejects(access(join(fixture.project, "grail-local-artifact")), { code: "ENOENT" });
		assert.equal(first.grade, "grail", JSON.stringify(first.reasons) + (first.steps.objective?.runs[0]?.output ?? ""));
		assert.equal(first.steps.objective?.status, "pass");
		assert.deepEqual(first.steps.objective.checks?.map(({ status }) => status), ["pass", "pass", "pass"]);
		const testRun = first.steps.objective.runs[0];
		assert.equal(testRun.command, "npm run test");
		assert.equal(testRun.scriptBody, "node --test");
		assert.equal(testRun.exitCode, 0);
		assert.ok((testRun.passedCount ?? 0) >= 1);
		assert.ok((testRun.outputBytes ?? 0) > 64 * 1024);
		assert.equal(testRun.outputTruncated, true);
		assert.ok(Buffer.byteLength(testRun.output) <= 64 * 1024);
		assert.match(testRun.output, /PRIVATE_GRAIL_LOG_MARKER/);
		const source = first.evidence!.source;
		assert.match(source.revision ?? "", /^[a-f0-9]{40}$/);
		assert.match(source.baselineTree, /^[a-f0-9]{64}$/);
		assert.notEqual(source.baselineTree, source.selectedTree);
		assert.equal(source.selectedTree, source.testedTree);
		assert.equal(source.project, ".");
		assert.equal(first.steps.comparison?.dropped, 1);
		assert.deepEqual(first.requirement, ["read-write-bash 实现 add"]);
		assert.ok(first.files.some((file) => file.path === "src/add.mjs"));
		const progress = grail.filter((event) => event.type === "grail_progress" && event.id === first.id).map((event) => (event as { step: string }).step);
		assert.deepEqual(progress, ["diff", "objective", "distortion", "blind", "comparison"]);

		// The blind reviewer saw only the requirement and the pre-wish repository.
		const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { step: string; cwd: string; prompt: string });
		const blind = calls.find((call) => call.step === "blind")!;
		assert.doesNotMatch(blind.prompt, /a \+ b/);
		assert.notEqual(resolve(blind.cwd), resolve(fixture.project));
		assert.match(calls.find((call) => call.step === "comparison")!.prompt, /a \+ b/);
		assert.match(calls.find((call) => call.step === "comparison")!.prompt, /"command":"npm run test","exitCode":0/);
		assert.ok(calls.every((call) => !call.prompt.includes("PRIVATE_GRAIL_LOG_MARKER")));
		assert.notEqual(resolve(calls.find((call) => call.step === "comparison")!.cwd), resolve(fixture.project));

		await writeFile(control, "granted");
		const second = await judge();
		assert.equal(second.grade, "granted");
		assert.equal(second.previousGrade, "grail");
		assert.deepEqual(second.evidence?.source, source);
		assert.ok(second.reasons.some((reason) => reason.includes("少写两行")));

		await writeFile(join(fixture.project, "src", "add.mjs"), "export function add(a, b) {\n\treturn a - b;\n}\n");
		const third = await judge();
		assert.equal(third.grade, "unfulfilled");
		assert.equal(third.steps.objective?.status, "fail");
		assert.equal(third.evidence?.source.revision, source.revision);
		assert.notEqual(third.evidence?.source.testedTree, source.testedTree);
		assert.equal(third.steps.blind, undefined);
		assert.ok(third.steps.objective!.runs[0].output.length > 0);

		await writeFile(join(fixture.project, "src", "add.mjs"), "export function add(a, b) {\n\treturn a + b;\n}\n");
		// Cancel during the objective step: the slow test is killed and no verdict is recorded.
		await writeFile(join(fixture.project, "test", "slow.test.mjs"), 'import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 4000)); writeFileSync("slow-finished.txt", "x"); });\n');
		const before = (await service.grailState(conversationId)).verdicts.length;
		const { id } = await service.startGrail(conversationId);
		await waitFor(() => grail.find((event) => event.type === "grail_progress" && event.id === id && event.step === "objective"), "objective step");
		await new Promise((done) => setTimeout(done, 500));
		assert.equal(await service.cancelGrail(conversationId), true);
		const cancelled = grail.find((event) => event.type === "grail_failed" && event.id === id);
		assert.ok(cancelled && cancelled.type === "grail_failed" && cancelled.cancelled);
		await new Promise((done) => setTimeout(done, 5000));
		await assert.rejects(stat(join(fixture.project, "slow-finished.txt")));
		assert.ok(!grail.some((event) => event.type === "grail_verdict" && event.verdict.id === id));
		const state = await service.grailState(conversationId);
		assert.equal(state.verdicts.length, before);
		assert.equal(state.running, undefined);

		// Verdicts are stored privately and the agent's session never sees them.
		const file = join(fixture.dataDir, "grail", `${conversationId}.json`);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		const messages = JSON.stringify((await service.snapshot()).messages);
		assert.doesNotMatch(messages, /圣杯|grail|愿望/i);
		for (const name of await readdir(join(fixture.dataDir, "sessions"), { recursive: true }))
			if (name.endsWith(".jsonl")) assert.doesNotMatch(await readFile(join(fixture.dataDir, "sessions", name), "utf8"), /圣杯|愿望/);

		const sealed = await service.sealGrailWish(conversationId);
		assert.equal(sealed.wish, 1);
		assert.equal(sealed.hasDiff, false);
		assert.equal(sealed.verdicts.length, before);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("nested Git project tests selected changes against frozen siblings and rejects truncated diffs", { timeout: 60_000 }, async () => {
	const { fixture, project, service, grail, session, log } = await setup(true);
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		await service.saveSettings({ permission: "auto", grailModel: { provider: "grail-test", id: "grail-judge-1" } });
		const conversationId = snapshot.active!.id;
		const started = Date.now();
		await service.command({ type: "prompt", message: "Define add using both operands." }, conversationId);
		await waitFor(() => session.find((event) => event.event.type === "agent_settled"), "agent_settled");
		const runtime = (service as unknown as { runtimes: Map<string, { agent: AgentProcess; checkpointId?: string }> }).runtimes.get(conversationId)!;
		await waitFor(() => runtime.checkpointId === undefined || undefined, "checkpoint finished");
		assert.equal((await service.grailState(conversationId)).readiness, "clean");
		const command = runtime.agent.request.bind(runtime.agent);
		// This is the native get_entries response after compaction plus a discarded sibling branch.
		const message = (id: string, parentId: string | null, content: string) => ({
			id, parentId, type: "message", timestamp: new Date(started).toISOString(),
			message: { role: "user", content, timestamp: started },
		});
		runtime.agent.request = <T>(input: Record<string, unknown>) => input.type === "get_entries"
			? Promise.resolve({ leafId: "compact", entries: [
				message("root", null, "Define add using both operands."),
				message("other", "root", "Discarded: subtract both operands."),
				message("selected", "root", "Preserve the sum for negative operands."),
				{ id: "compact", parentId: "selected", type: "compaction", firstKeptEntryId: "selected" },
			] } as T)
			: command<T>(input);
		await writeFile(join(project, "src", "add.mjs"), "export function add(a, b) {\n\treturn a + b;\n}\n");
		assert.equal((await service.grailState(conversationId)).readiness, "ready");
		const git = (service as unknown as { git: GitSnapshots }).git;
		const diff = git.diffToWorktree.bind(git);
		git.diffToWorktree = async (...args) => {
			const result = await diff(...args);
			await writeFile(join(fixture.project, "packages", "shared", "index.mjs"), "export const expected = 99;\n");
			return result;
		};
		const judge = async () => {
			const { id } = await service.startGrail(conversationId);
			const done = await waitFor(() => grail.find((event) => (event.type === "grail_verdict" && event.verdict.id === id) || (event.type === "grail_failed" && event.id === id)), "verdict");
			if (done.type !== "grail_verdict") throw new Error(JSON.stringify(done));
			return done.verdict;
		};
		const result = await judge();
		assert.equal(result.grade, "grail", JSON.stringify(result.reasons) + (result.steps.objective?.runs[0]?.output ?? ""));
		assert.deepEqual(result.requirement, ["Define add using both operands.", "Preserve the sum for negative operands."]);
		assert.deepEqual(result.steps.objective?.runs.map(({ name }) => name), ["test", "check", "lint"]);
		assert.equal(result.evidence?.source.project, "packages/app");
		assert.match(result.evidence?.source.testedTree ?? "", /^[a-f0-9]{64}$/);
		assert.notEqual(result.evidence?.source.selectedTree, result.evidence?.source.testedTree);
		assert.deepEqual(result.files.map(({ path }) => path), ["src/add.mjs"]);
		const blob = (content: string) => join(fixture.dataDir, "checkpoints", "git-snapshots", "blobs", createHash("sha256").update(content).digest("hex"));
		await access(blob("export function add(a, b) {\n\treturn a + b;\n}\n"));
		await assert.rejects(access(blob("export const expected = 3;\n")), { code: "ENOENT" });
		const calls = await readFile(log, "utf8");
		await writeFile(join(project, "z-data.txt"), "y".repeat(210_000));
		const incomplete = await judge();
		assert.equal(incomplete.grade, "unjudgeable");
		assert.match(incomplete.reasons.join(" "), /容量/);
		assert.equal(await readFile(log, "utf8"), calls, "incomplete diffs must not dispatch paid review stages");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("Grail refuses unpriced models before dispatch and rejects priced usage without cost", { timeout: 20000 }, async () => {
	const { fixture, project, service, control, log } = await setup();
	try {
		const run = (service as unknown as {
			grailModelRun(cwd: string, model: { provider: string; id: string }, prompt: string, budget: { max: number; spent: number }, deadline: number, signal: AbortSignal, id: string): Promise<string>;
		}).grailModelRun.bind(service);
		const signal = new AbortController().signal;
		const budget = { max: 0.01, spent: 0 };
		await assert.rejects(run(project, { provider: "grail-test", id: "grail-unpriced" }, "【圣杯盲解】", budget, Date.now() + 10000, signal, "test"), /缺少可核算的价格/);
		await assert.rejects(access(log), { code: "ENOENT" });
		await writeFile(control, "zero-cost");
		await assert.rejects(run(project, { provider: "grail-test", id: "grail-judge-1" }, "【圣杯盲解】", budget, Date.now() + 10000, signal, "test"), /消耗了计费 Token，却未报告费用/);
		assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
		assert.equal(budget.spent, 0);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
