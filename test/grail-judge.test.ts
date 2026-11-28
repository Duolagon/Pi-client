import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	annotateDiff,
	detectScripts,
	extractJson,
	gradeVerdict,
	packageManager,
	parseBlindSolution,
	parseComparison,
	parseDiffLines,
	parseTestCount,
	parseTestSummary,
	parseTscErrors,
	runObjectiveChecks,
	runProcess,
	scanDistortions,
	scriptEnvironment,
	GRAIL_CRITERIA,
} from "../src/grail-judge.ts";
import type { GrailComparisonResult, GrailCriterion, GrailStepResults } from "../src/shared.ts";

const diff = (path: string, body: string) => ({ path, diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}` });

test("parseDiffLines numbers added lines on the new side and removed lines on the old side", () => {
	const lines = parseDiffLines([diff("src/a.ts", "@@ -3,3 +3,3 @@\n keep\n-old\n+new\n+more\n tail\n\\ No newline at end of file")]);
	assert.deepEqual(
		lines.map(({ side, line, text }) => [side, line, text]),
		[["-", 4, "old"], ["+", 4, "new"], ["+", 5, "more"]],
	);
	const annotated = annotateDiff([diff("src/a.ts", "@@ -3,3 +3,3 @@\n keep\n-old\n+new\n")]).text;
	assert.match(annotated, /^- 4 \| old$/m);
	assert.match(annotated, /^\+ 4 \| new$/m);
});

test("distortion scan reports every pattern with file and line", () => {
	const added = [
		"it.skip('x', () => {});",
		"describe.only('y', () => {});",
		"test('z', { skip: true }, () => {});",
		"// @ts-ignore",
		"// @ts-expect-error",
		"const v = value as any;",
		"/* eslint-disable no-console */",
		"console.log(value);",
		"debugger;",
		"// TODO: later",
	];
	const body = `@@ -1,0 +1,${added.length} @@\n${added.map((line) => `+${line}`).join("\n")}\n`;
	const hits = scanDistortions(parseDiffLines([diff("src/x.ts", body)]));
	assert.deepEqual(
		hits.map((hit) => [hit.rule, hit.line]),
		[
			["新增 .skip / .only", 1],
			["新增 .skip / .only", 2],
			["新增 .skip / .only", 3],
			["新增 @ts-ignore / @ts-expect-error", 4],
			["新增 @ts-ignore / @ts-expect-error", 5],
			["新增 as any", 6],
			["新增 eslint-disable", 7],
			["留下 console.log", 8],
			["留下 debugger", 9],
			["新增 TODO", 10],
		],
	);
	assert.ok(hits.every((hit) => hit.file === "src/x.ts" && hit.side === "+"));

	const tests = scanDistortions(
		parseDiffLines([
			diff("test/a.test.ts", "@@ -10,2 +10,1 @@\n-assert.equal(add(1, 2), 3);\n keep\n@@ -20,1 +19,1 @@\n-expect(sum).toBe(3);\n+expect(sum).toBe(4);\n"),
		]),
	);
	assert.deepEqual(
		tests.map((hit) => [hit.rule, hit.file, hit.line, hit.side]),
		[
			["删除断言", "test/a.test.ts", 10, "-"],
			["测试期望值被修改", "test/a.test.ts", 20, "-"],
		],
	);
	// Removed lines in non-test files, docs and clean code are not distortions.
	assert.deepEqual(
		scanDistortions(parseDiffLines([diff("src/a.ts", "@@ -1,1 +1,1 @@\n-assert.ok(x);\n+return x;\n"), diff("README.md", "@@ -0,0 +1,1 @@\n+TODO in docs\n")])),
		[],
	);
	assert.deepEqual(scanDistortions(parseDiffLines([
		diff("src/example.ts", "@@ -0,0 +1,2 @@\n+const help = 'Try console.log(value);';\n+const example = `console.log(value)`;\n"),
	])), []);
});

test("test count parsing covers node --test, vitest, jest and mocha output", () => {
	assert.equal(parseTestCount("ℹ tests 7\nℹ suites 0\nℹ pass 7\nℹ fail 0"), 7);
	assert.equal(parseTestCount("# tests 3\n# pass 3"), 3);
	assert.equal(parseTestCount("# tests 0\n# pass 0"), 0);
	assert.equal(parseTestCount(" Test Files  2 passed (2)\n      Tests  5 passed | 1 skipped (6)\n"), 6);
	assert.equal(parseTestCount("Tests:       1 failed, 4 passed, 5 total"), 5);
	assert.equal(parseTestCount("  3 passing (12ms)\n  1 failing\n  2 pending"), 6);
	assert.equal(parseTestCount("\x1b[32mℹ tests 2\x1b[39m"), 2);
	assert.equal(parseTestCount("all good"), undefined);
	assert.equal(parseTscErrors("src/a.ts(1,1): error TS2322: x\nFound 2 errors in 1 file."), 2);
	assert.equal(parseTscErrors("src/a.ts(1,1): error TS2322: x"), 1);
	assert.equal(parseTscErrors(""), 0);
});

test("script detection reads test, check/typecheck and lint, skipping the npm placeholder", () => {
	assert.deepEqual(detectScripts({ scripts: { test: "node --test", typecheck: "tsc --noEmit", lint: "eslint .", build: "x" } }), [
		{ name: "test", script: "test" },
		{ name: "check", script: "typecheck" },
		{ name: "lint", script: "lint" },
	]);
	assert.deepEqual(detectScripts({ scripts: { test: 'echo "Error: no test specified" && exit 1', check: "tsc" } }), [{ name: "check", script: "check" }]);
	assert.deepEqual(detectScripts({ scripts: { test: "  " } }), []);
	assert.deepEqual(detectScripts({ scripts: { test: "echo no test specified", "test:backend": "node --test" } }),
		[{ name: "test", script: "test:backend" }]);
	assert.deepEqual(detectScripts(null), []);
	assert.deepEqual(detectScripts({ scripts: ["test"] }), []);
	assert.equal(packageManager(["pnpm-lock.yaml"]), "pnpm");
	assert.equal(packageManager(["yarn.lock"]), "yarn");
	assert.equal(packageManager(["package-lock.json"]), "npm");
});

test("objective checks require a passed test and distinguish missing evidence from failure", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-grail-objective-test-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const testFile = join(project, "example.test.mjs");
	const manifest = { type: "module", scripts: { test: "node --test" } };
	const env = scriptEnvironment({ PATH: process.env.PATH, HOME: project }, join(project, "npm-cache"));
	const run = (overrides: Partial<Parameters<typeof runObjectiveChecks>[0]> = {}) =>
		runObjectiveChecks({
			project, manifest, files: ["package.json"], env, deadline: Date.now() + 10000, signal: new AbortController().signal, ...overrides,
		});
	await writeFile(join(project, "package.json"), JSON.stringify(manifest));
	await writeFile(testFile, "import { test } from 'node:test';\ntest.skip('optional integration', () => {});\n");
	const onlySkipped = await run();
	assert.equal(onlySkipped.runs[0].testCount, 1);
	assert.match(onlySkipped.reason!, /全部跳过/);
	assert.equal(onlySkipped.status, "unavailable");
	assert.equal(onlySkipped.checks?.[0].status, "skipped");
	assert.equal(onlySkipped.runs[0].skippedCount, 1);

	await writeFile(testFile, "import { test } from 'node:test';\ntest('passing example', () => {});\n");
	const missingChecks = await run();
	assert.equal(missingChecks.status, "pass");
	assert.match(missingChecks.reason!, /类型检查.*lint/);
	assert.equal(missingChecks.runs[0].exitCode, 0);
	assert.deepEqual(missingChecks.checks?.map(({ status }) => status), ["pass", "skipped", "skipped"]);

	const unavailableRunner = await run({ env: { ...env, PATH: project } });
	assert.equal(unavailableRunner.status, "unavailable");
	assert.match(unavailableRunner.reason!, /无法启动/);
	assert.equal(unavailableRunner.checks?.[0].status, "unavailable");
	const timedOut = await run({ deadline: Date.now() + 2 });
	assert.equal(timedOut.status, "unavailable");
	assert.match(timedOut.reason!, /超时/);

	await writeFile(testFile, "import { test } from 'node:test';\ntest('failing example', () => { throw new Error('expected failure'); });\n");
	const failedTest = await run();
	assert.equal(failedTest.status, "fail");
	assert.match(failedTest.reason!, /退出码 1/);
	assert.equal(gradeVerdict({ objective: failedTest }).grade, "unfulfilled");

	await writeFile(testFile, "import 'uninstalled-grail-test-dependency';\n");
	const dependencyFields = { devDependencies: { "uninstalled-grail-test-dependency": "1.0.0" } };
	const missingDependency = await run({ manifest: { ...manifest, ...dependencyFields } });
	assert.equal(missingDependency.status, "unavailable");
	assert.match(missingDependency.reason!, /无法加载所需的测试依赖/);
	assert.equal(gradeVerdict({ objective: missingDependency }).grade, "unjudgeable");
	assert.equal((await run({ inheritedManifests: [dependencyFields] })).status, "unavailable");
	assert.equal((await run()).status, "fail");

	await writeFile(testFile, "import './missing-project-source.mjs';\n");
	assert.equal((await run()).status, "fail");

	const wrappedManifest = { ...manifest, scripts: { test: "node --test || true" } };
	await writeFile(join(project, "package.json"), JSON.stringify(wrappedManifest));
	await writeFile(testFile, "import { test } from 'node:test';\ntest('failing example', () => { throw new Error('expected failure'); });\n");
	const failedTestWithSuccessfulExit = await run({ manifest: wrappedManifest });
	assert.equal(failedTestWithSuccessfulExit.runs[0].exitCode, 0);
	assert.equal(failedTestWithSuccessfulExit.status, "fail");
	assert.equal(failedTestWithSuccessfulExit.checks?.[0].status, "fail");
	assert.match(failedTestWithSuccessfulExit.reason!, /1 个失败/);
});

test("script environment strips credentials and host context", () => {
	const env = scriptEnvironment(
		{ PATH: "/bin", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", PI_DESKTOP_KEY_OPENAI: "x", AWS_PROFILE: "p", NODE_TEST_CONTEXT: "child", HOME: "/h", DB_PASSWORD: "p" },
		"/tmp/cache",
	);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/h");
	for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "PI_DESKTOP_KEY_OPENAI", "AWS_PROFILE", "NODE_TEST_CONTEXT", "DB_PASSWORD"]) assert.equal(env[key], undefined, key);
	assert.equal(env.CI, "1");
	assert.equal(env.npm_config_cache, "/tmp/cache");
});

test("command evidence records a bounded UTF-8 output tail and actual exit details", async () => {
	const result = await runProcess(process.execPath, ["-e", `
		process.stdout.write("early marker\\n" + "日志".repeat(14000));
		process.stdout.write("\\nlast marker\\n");
		process.exitCode = 7;
	`], { cwd: tmpdir(), env: process.env, timeoutMs: 5_000, signal: new AbortController().signal });
	assert.equal(result.exitCode, 7);
	assert.equal(result.timedOut, false);
	assert.equal(result.outputTruncated, true);
	assert.ok(result.outputBytes > 64 * 1024);
	assert.ok(Buffer.byteLength(result.output) <= 64 * 1024);
	assert.ok(!result.output.includes("\uFFFD"));
	assert.ok(!result.output.includes("early marker"));
	assert.ok(result.output.endsWith("last marker\n"));
});

test("blind solution parsing requires every point and accepts fenced JSON", () => {
	const solution = { rootCause: "r", cutPoint: "c", files: ["a.ts"], sizeEstimate: "10 行", hardSpots: ["边界"], tests: ["t"] };
	assert.deepEqual(parseBlindSolution("说明\n```json\n" + JSON.stringify(solution) + "\n```"), { status: "ok", solution });
	assert.equal(parseBlindSolution(JSON.stringify({ ...solution, cutPoint: "" })).status, "unavailable");
	assert.equal(parseBlindSolution("没有 JSON").status, "unavailable");
	assert.match(parseBlindSolution('{"unable":"需求不清"}').reason!, /需求不清/);
	assert.equal(extractJson("[1,2]"), undefined);
});

test("comparison parsing drops conclusions without a citation of a changed line", () => {
	const lines = parseDiffLines([diff("src/a.ts", "@@ -1,1 +1,2 @@\n-old\n+new\n+next\n")]);
	const result = parseComparison(
		JSON.stringify({
			findings: [
				{ criterion: "requirement", pass: true, note: "ok", citations: [{ file: "src/a.ts", side: "+", line: 1 }] },
				{ criterion: "cut", pass: true, note: "no cite", citations: [] },
				{ criterion: "edge", pass: true, note: "unchanged line", citations: [{ file: "src/a.ts", side: "+", line: 9 }] },
				{ criterion: "removable", pass: true, note: "wrong file", citations: [{ file: "src/b.ts", side: "+", line: 1 }] },
				{ criterion: "unknown", pass: true, citations: [{ file: "src/a.ts", side: "+", line: 1 }] },
				{ criterion: "beyond", pass: "yes", citations: [{ file: "src/a.ts", side: "+", line: 1 }] },
				{ criterion: "lessCode", pass: false, note: "old line", citations: [{ file: "src/a.ts", side: "-", line: 1 }, { file: "x", side: "+", line: 1 }] },
			],
		}),
		lines,
	);
	assert.equal(result.status, "ok");
	assert.equal(result.dropped, 5);
	assert.deepEqual(result.findings.map((item) => item.criterion), ["requirement", "lessCode"]);
	assert.deepEqual(result.findings[1].citations, [{ file: "src/a.ts", side: "-", line: 1 }]);
	assert.equal(parseComparison("nonsense", lines).status, "unavailable");
});

function comparison(overrides: Partial<Record<GrailCriterion, boolean>> = {}, omit: GrailCriterion[] = []): GrailComparisonResult {
	const findings = (Object.keys(GRAIL_CRITERIA) as GrailCriterion[])
		.filter((criterion) => !omit.includes(criterion))
		.map((criterion) => ({ criterion, pass: overrides[criterion] ?? true, note: `${criterion} note`, citations: [{ file: "a.ts", side: "+" as const, line: 1 }] }));
	return { status: "ok", findings, dropped: 0 };
}
const passing: GrailStepResults = {
	objective: { status: "pass", runs: [] },
	distortion: { hits: [] },
	blind: { status: "ok", solution: { rootCause: "r", cutPoint: "c", files: ["a"], sizeEstimate: "s", hardSpots: [], tests: [] } },
	comparison: comparison(),
};

test("grade function covers every grade and stops at the first veto", () => {
	assert.equal(gradeVerdict(passing).grade, "grail");
	const assertionChanges = scanDistortions(parseDiffLines([
		diff("test/x.test.ts", "@@ -1,2 +1,2 @@\n-  assert.equal(x, 1);\n+    assert.equal(x, 1);\n-  expect(y).toBe(2);\n+  expect(y).toBe(3);\n"),
	]));
	assert.equal(assertionChanges.length, 1);
	assert.equal(assertionChanges[0].review, undefined);
	assert.equal(gradeVerdict({ ...passing, distortion: { hits: assertionChanges } }).grade, "twisted");
	// Equivalent rewrites keep the expectation and are not vetoed.
	assert.deepEqual(scanDistortions(parseDiffLines([
		diff("test/y.test.ts", "@@ -1,3 +1,3 @@\n-assert.equal(x,1);\n-assert.deepEqual(y, [1]);\n-assert.equal(z, 2)\n+assert.strictEqual(x, 1);\n+assert.deepStrictEqual(y, [1]);\n+assert.equal(z, 2, 'z is two');\n"),
	])), []);
	// Missing type check or lint scripts still allow a judgement, but never the grail.
	const noLint = gradeVerdict({ ...passing, objective: { status: "pass", runs: [], checks: [
		{ name: "test", status: "pass" }, { name: "check", status: "pass" }, { name: "lint", status: "skipped", reason: "x" },
	] } });
	assert.equal(noLint.grade, "granted");
	assert.match(noLint.reasons.join(), /lint/);
	const granted = gradeVerdict({ ...passing, comparison: comparison({ lessCode: false }) });
	assert.equal(granted.grade, "granted");
	assert.match(granted.reasons.join(), /lessCode note/);
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ edge: false }) }).grade, "granted");
	// A criterion without a cited conclusion is not proven, so no grail.
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({}, ["beyond"]) }).grade, "granted");
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ broken: false }) }).grade, "twisted");
	// "无可缺" is a gap in the wish itself; "无可删" and "无可挑" are taste, so they only cap the grade.
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ missing: false }) }).grade, "unfulfilled");
	for (const criterion of ["removable", "flawless"] as const) {
		const judged = gradeVerdict({ ...passing, comparison: comparison({ [criterion]: false }) });
		assert.equal(judged.grade, "granted", criterion);
		assert.match(judged.reasons.join(), new RegExp(`${criterion} note`));
	}
	// Each of them still has to be judged with a citation.
	for (const criterion of ["removable", "missing", "flawless"] as const)
		assert.equal(gradeVerdict({ ...passing, comparison: comparison({}, [criterion]) }).grade, "unjudgeable");
	const onePositiveFinding = { ...comparison(), findings: comparison().findings.filter((item) => item.criterion === "requirement") };
	assert.equal(gradeVerdict({ ...passing, comparison: onePositiveFinding }).grade, "unjudgeable");
	const twisted = gradeVerdict({ ...passing, distortion: { hits: [{ file: "a.ts", line: 3, side: "+", rule: "新增 as any", text: "x as any" }] } });
	assert.equal(twisted.grade, "twisted");
	assert.deepEqual(twisted.reasons, ["新增 as any：a.ts:3（新增）"]);
	assert.equal(gradeVerdict({ ...passing, objective: { status: "fail", reason: "npm run test 退出码 1。", runs: [] } }).grade, "unfulfilled");
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ requirement: false }) }).grade, "unfulfilled");
	assert.equal(gradeVerdict({ ...passing, objective: { status: "unavailable", reason: "没有测试", runs: [] } }).grade, "unjudgeable");
	assert.equal(gradeVerdict({ ...passing, blind: { status: "unavailable", reason: "给不出" } }).grade, "unjudgeable");
	assert.equal(gradeVerdict({ ...passing, comparison: { status: "unavailable", findings: [], dropped: 0 } }).grade, "unjudgeable");
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({}, ["requirement"]) }).grade, "unjudgeable");
	assert.equal(gradeVerdict({}).grade, "unjudgeable");
	assert.equal(gradeVerdict({ objective: passing.objective }).grade, "unjudgeable");
	// Veto order: a failing check wins over a distortion hit.
	assert.equal(gradeVerdict({ ...passing, objective: { status: "fail", runs: [] }, distortion: twisted as never }).grade, "unfulfilled");
});

test("a deleted test file is left to the reviewer instead of vetoed as deleted assertions", () => {
	const lines = parseDiffLines([{ path: "test/b.test.ts", diff: "@@ -1,2 +0,0 @@\n-test('b', () => {\n-  assert.equal(1, 1);\n" }]);
	assert.ok(scanDistortions(lines).length > 0);
	assert.deepEqual(scanDistortions(lines, new Set(["test/b.test.ts"])), []);
});

test("pytest summaries need the timing suffix", () => {
	assert.deepEqual(parseTestSummary("===== 3 passed, 1 failed in 0.12s ====="), { total: 4, passed: 3, failed: 1, skipped: 0 });
	assert.equal(parseTestSummary("====== skipped section ======"), undefined);
});
