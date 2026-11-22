import assert from "node:assert/strict";
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
	parseTscErrors,
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
	assert.deepEqual(detectScripts(null), []);
	assert.deepEqual(detectScripts({ scripts: ["test"] }), []);
	assert.equal(packageManager(["pnpm-lock.yaml"]), "pnpm");
	assert.equal(packageManager(["yarn.lock"]), "yarn");
	assert.equal(packageManager(["package-lock.json"]), "npm");
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
	const granted = gradeVerdict({ ...passing, comparison: comparison({ lessCode: false }) });
	assert.equal(granted.grade, "granted");
	assert.match(granted.reasons.join(), /lessCode note/);
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ edge: false }) }).grade, "granted");
	// A criterion without a cited conclusion is not proven, so no grail.
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({}, ["beyond"]) }).grade, "granted");
	assert.equal(gradeVerdict({ ...passing, comparison: comparison({ broken: false }) }).grade, "twisted");
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
