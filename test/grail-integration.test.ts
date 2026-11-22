import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent, GrailEvent, GrailVerdict } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "../src/permission-extension.ts");

async function setup() {
	const fixture = await createCoreFixture();
	await cp(join(here, "fixtures", "grail-provider.js"), join(fixture.agentDir, "extensions", "grail-provider.js"));
	const project = fixture.project;
	await mkdir(join(project, "src"));
	await mkdir(join(project, "test"));
	await writeFile(join(project, "package.json"), JSON.stringify({ name: "grail-demo", private: true, type: "module", scripts: { test: "node --test" } }));
	await writeFile(join(project, "src", "add.mjs"), "export function add(a, b) {\n\treturn 0;\n}\n");
	await writeFile(
		join(project, "test", "add.test.mjs"),
		'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/add.mjs";\ntest("add", () => assert.equal(add(1, 2), 3));\n',
	);
	await exec("git", ["init", "-q", project]);
	await exec("git", ["add", "."], { cwd: project });
	await exec("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "seed"], { cwd: project });
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
	return { fixture, service, control, log, grail, session };
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
		assert.equal(first.grade, "grail", JSON.stringify(first.reasons) + (first.steps.objective?.runs[0]?.output ?? ""));
		assert.equal(first.steps.objective?.status, "pass");
		assert.ok((first.steps.objective?.runs[0].testCount ?? 0) >= 1);
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

		await writeFile(control, "granted");
		const second = await judge();
		assert.equal(second.grade, "granted");
		assert.equal(second.previousGrade, "grail");
		assert.ok(second.reasons.some((reason) => reason.includes("少写两行")));

		await writeFile(join(fixture.project, "src", "add.mjs"), "export function add(a, b) {\n\treturn a - b;\n}\n");
		const third = await judge();
		assert.equal(third.grade, "unfulfilled");
		assert.equal(third.steps.objective?.status, "fail");
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
