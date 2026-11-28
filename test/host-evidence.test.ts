import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { parseDiffLines } from "../src/grail-judge.ts";
import {
	checkKind,
	collectHostEvidence,
	runScope,
	shellMayWrite,
	judgePassClaim,
	passClaimKind,
	passClaimSentences,
	scanTestIntegrity,
	type EvidenceMessage,
} from "../src/host-evidence.ts";
import { evaluateWerewolfPlan, werewolfVerdict } from "../src/werewolf.ts";

const call = (id: string, name: string, args: Record<string, unknown>): EvidenceMessage =>
	({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, timestamp: number, details?: unknown, text = ""): EvidenceMessage =>
	({ role: "toolResult", toolCallId: id, timestamp, details, content: [{ type: "text", text }] });

test("host evidence records verification runs with counts and every write, in order", () => {
	const evidence = collectHostEvidence([
		call("w1", "edit", { path: "src/a.ts" }), result("w1", 10),
		call("t1", "bash", { command: "node --test" }), result("t1", 20, { exitCode: 0 }, "ℹ tests 3\nℹ pass 3\nℹ fail 0"),
		call("c1", "bash", { command: "npx tsc --noEmit" }), result("c1", 30, { exitCode: 2 }),
		call("s1", "bash", { command: "sed -i '' 's/a/b/' src/a.ts" }), result("s1", 40, { exitCode: 0 }),
		call("b1", "bash", { command: "npm test" }), result("b1", 50, { exitCode: 0, background: true }),
		call("w2", "write", { path: "test/a.test.ts" }), result("w2", 60),
	]);
	assert.deepEqual(evidence.runs.map(({ kind, exitCode, tests }) => ({ kind, exitCode, tests })), [
		{ kind: "test", exitCode: 0, tests: { total: 3, passed: 3, failed: 0, skipped: undefined } },
		{ kind: "check", exitCode: 2, tests: undefined },
	]);
	assert.deepEqual(evidence.writes.map(({ path, test }) => [path, test]), [["src/a.ts", false], ["(shell)", false], ["test/a.test.ts", true]]);
	assert.equal(checkKind("npx eslint ."), "lint");
	assert.equal(checkKind("npm run typecheck"), "check");
	assert.equal(checkKind("npm test -- --watch && echo ok"), undefined);
});

test("pass claims are found in plain sentences and skipped when hedged or negated", () => {
	assert.equal(passClaimKind("测试全部通过。"), "test");
	assert.equal(passClaimKind("修了未处理的异常，测试全部通过"), "test");
	assert.equal(passClaimKind("All tests pass now."), "test");
	assert.equal(passClaimKind("类型检查也通过了"), "check");
	assert.equal(passClaimKind("lint 通过"), "lint");
	for (const hedged of ["测试还没有通过", "应该能让测试通过", "如果测试通过就合并", "tests should pass after this", "make the tests pass"])
		assert.equal(passClaimKind(hedged), undefined, hedged);
	assert.deepEqual(passClaimSentences("改好了。测试全部通过。lint 通过。").map(({ kind }) => kind), ["test", "lint"]);
});

test("a pass claim is judged by the latest run of that check and any later write", () => {
	const run = (id: string, exitCode: number, finishedAt: number, tests?: { total: number; passed?: number; failed?: number }) =>
		({ id, command: "node --test", kind: "test" as const, exitCode, scope: "full" as const, finishedAt, batch: finishedAt, ...(tests ? { tests } : {}) });
	assert.equal(judgePassClaim("test", { runs: [], writes: [] }).status, "unverified");
	assert.equal(judgePassClaim("test", { runs: [run("a", 0, 10), run("b", 1, 20)], writes: [] }).status, "contradicted");
	assert.equal(judgePassClaim("test", { runs: [run("a", 1, 10), run("b", 0, 20, { total: 2, passed: 2, failed: 0 })], writes: [] }).status, "verified");
	assert.equal(judgePassClaim("test", { runs: [run("a", 0, 10, { total: 4, passed: 3, failed: 1 })], writes: [] }).status, "contradicted");
	assert.equal(judgePassClaim("test", { runs: [run("a", 0, 10, { total: 0, passed: 0 })], writes: [] }).status, "unverified");
	const stale = judgePassClaim("test", { runs: [run("a", 0, 10)], writes: [{ id: "w", path: "src/a.ts", finishedAt: 20, batch: 20, test: false }] });
	assert.equal(stale.status, "unverified");
	assert.match(stale.summary, /src\/a\.ts/);
	// "新增的测试通过了" talks about a subset; a failing full run does not refute it.
	assert.equal(judgePassClaim("test", { runs: [run("a", 1, 10)], writes: [] }, "新增的测试通过了").status, "unverified");
	const touchedTests = judgePassClaim("test", { runs: [run("a", 0, 20)], writes: [{ id: "w", path: "test/x.test.ts", finishedAt: 10, batch: 10, test: true }] });
	assert.equal(touchedTests.status, "verified");
	assert.match(touchedTests.summary, /改过测试文件/);
});

test("werewolf decides pass claims from host records even when the planner skipped them", async () => {
	const reply = "修好了解析错误。测试全部通过。";
	const evidence = {
		runs: [{ id: "t1", command: "node --test", kind: "test" as const, exitCode: 1, scope: "full" as const, finishedAt: 10, batch: 1, tests: { total: 3, passed: 2, failed: 1 } }],
		writes: [],
	};
	const input = { requirements: ["修复解析错误"], reply, receipts: [{ id: "t1", command: "node --test", exitCode: 1 }], evidence };
	const claims = await evaluateWerewolfPlan(input, JSON.stringify({ claims: [] }), tmpdir(), AbortSignal.timeout(3000));
	assert.equal(claims.length, 1);
	assert.equal(claims[0].quote, "测试全部通过。");
	assert.equal(claims[0].status, "contradicted");
	assert.equal(claims[0].evidence?.source, "t1");
	assert.equal(werewolfVerdict(claims), "contradicted");
	// A planner claim on the same sentence left undecided is filled in, not duplicated.
	const planned = { claims: [{ quote: "测试全部通过。", description: "测试结果" }] };
	const merged = await evaluateWerewolfPlan(input, JSON.stringify(planned), tmpdir(), AbortSignal.timeout(3000));
	assert.deepEqual(merged.map((claim) => [claim.description, claim.status]), [["测试结果", "contradicted"]]);
});

const diff = (path: string, body: string) => ({ path, diff: body });

test("test integrity flags scripts that swallow failures as a veto and other check changes for review", () => {
	const lines = parseDiffLines([
		diff("package.json", '@@ -3,1 +3,1 @@\n-    "test": "node --test",\n+    "test": "node --test || true",\n'),
		diff("packages/a/package.json", '@@ -3,1 +3,1 @@\n-    "lint": "eslint .",\n+    "lint": "eslint src",\n'),
		diff("vitest.config.ts", "@@ -1,1 +1,2 @@\n export default {\n+  exclude: ['test/slow/**'],\n+  bail: 0,\n"),
		diff("test/__snapshots__/a.test.ts.snap", "@@ -1,1 +1,1 @@\n-old\n+new\n"),
		diff("test/b.test.ts", "@@ -1,1 +0,0 @@\n-test('b', () => {});\n"),
	]);
	const hits = scanTestIntegrity(lines, [
		{ path: "package.json", status: "modified" }, { path: "test/b.test.ts", status: "deleted" },
	]);
	assert.deepEqual(hits.map(({ file, rule, review }) => [file, rule, review ?? false]), [
		["package.json", "修改了检查脚本", true],
		["package.json", "检查脚本会吞掉失败", false],
		["packages/a/package.json", "修改了检查脚本", true],
		["packages/a/package.json", "修改了检查脚本", true],
		["vitest.config.ts", "修改了测试或检查配置", true],
		["test/__snapshots__/a.test.ts.snap", "更新了测试快照", true],
		["test/b.test.ts", "删除了测试文件", true],
	]);
	// Unrelated package.json changes are not flagged.
	assert.deepEqual(scanTestIntegrity(parseDiffLines([diff("package.json", '@@ -2,1 +2,1 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n')]), []), []);
});

test("check kind follows the runner or script name, and builds count as none", () => {
	assert.equal(checkKind("npx tsc -p test/tsconfig.json"), "check");
	assert.equal(checkKind("tsc --noEmit -p tests"), "check");
	assert.equal(checkKind("npm run check"), "check");
	assert.equal(checkKind("npm test"), "test");
	assert.equal(checkKind("node --test test/a.test.ts"), "test");
	assert.equal(checkKind("npx vitest run"), "test");
	assert.equal(checkKind("python -m pytest -q"), "test");
	assert.equal(checkKind("npm run build"), undefined);
	assert.equal(runScope("node --test test/a.test.ts"), "subset");
	assert.equal(runScope("npx vitest run -t parser"), "subset");
	assert.equal(runScope("pytest tests/test_a.py::test_b"), "subset");
	assert.equal(runScope("node --test test/*.test.ts"), "full");
	assert.equal(runScope("npm test"), "full");
});

test("shell writes are recognized without flagging common read-only spellings", () => {
	for (const command of ["echo x > src/a.ts", "sed -i '' s/a/b/ f", "npx eslint --fix .", "npm run format", "git pull", "git stash", "git checkout src/a.ts", "node -e \"require('fs').writeFileSync('a','b')\"", "cat a | tee out.txt"])
		assert.equal(shellMayWrite(command), true, command);
	for (const command of ["npm test 2>&1", "grep x src > /dev/null", "ls > /tmp/list", "echo 'a > b'", "git stash list", "git checkout -b feature", "cat a | tee", "node --test 2> err.log"])
		assert.equal(shellMayWrite(command), false, command);
});

test("parallel calls, background work and delegated agents make an earlier pass stale", () => {
	const parallel = collectHostEvidence([
		{ role: "assistant", content: [
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
			{ type: "toolCall", id: "w1", name: "edit", arguments: { path: "src/a.ts" } },
		] },
		result("w1", 10), result("t1", 20, { exitCode: 0 }, "ℹ tests 1\nℹ pass 1\nℹ fail 0"),
	]);
	assert.equal(judgePassClaim("test", parallel).status, "unverified");
	const background = collectHostEvidence([
		call("b1", "bash", { command: "npx prettier --write . &", run_in_background: true }), result("b1", 5, { background: true }),
		call("t1", "bash", { command: "npm test" }), result("t1", 20, { exitCode: 0 }, "ℹ tests 1\nℹ pass 1\nℹ fail 0"),
	]);
	assert.equal(judgePassClaim("test", background).status, "unverified");
	const agent = collectHostEvidence([
		call("t1", "bash", { command: "npm test" }), result("t1", 20, { exitCode: 0 }, "ℹ tests 1\nℹ pass 1\nℹ fail 0"),
		call("a1", "Agent", { subagent_type: "general-purpose", prompt: "fix" }), result("a1", 30),
	]);
	assert.equal(judgePassClaim("test", agent).status, "unverified");
	const explore = collectHostEvidence([
		call("t1", "bash", { command: "npm test" }), result("t1", 20, { exitCode: 0 }, "ℹ tests 1\nℹ pass 1\nℹ fail 0"),
		call("a1", "Agent", { subagent_type: "Explore", prompt: "look" }), result("a1", 30),
	]);
	assert.equal(judgePassClaim("test", explore).status, "verified");
});

test("a filtered run cannot verify a whole-suite claim", () => {
	const base = { kind: "test" as const, exitCode: 0, tests: { total: 1, passed: 1, failed: 0 } };
	const subsetOnly = { runs: [{ ...base, id: "s", command: "node --test test/a.test.ts", scope: "subset" as const, finishedAt: 10, batch: 1 }], writes: [] };
	assert.equal(judgePassClaim("test", subsetOnly, "测试全部通过").status, "unverified");
	assert.equal(judgePassClaim("test", subsetOnly, "新增的测试通过了").status, "verified");
	const failedFull = { runs: [
		{ ...base, id: "f", command: "npm test", scope: "full" as const, exitCode: 1, finishedAt: 5, batch: 1 },
		...subsetOnly.runs.map((run) => ({ ...run, batch: 2 })),
	], writes: [] };
	assert.equal(judgePassClaim("test", failedFull, "测试全部通过").status, "contradicted");
	const unparsed = judgePassClaim("test", { runs: [{ id: "x", command: "npm test", kind: "test", exitCode: 0, scope: "full", finishedAt: 1, batch: 1 }], writes: [] });
	assert.equal(unparsed.status, "verified");
	assert.match(unparsed.summary, /没能从输出里读出测试数量/);
});

test("sentences that mention a pass without claiming the current suite passed are not claims", () => {
	for (const sentence of ["3 个测试通过，其余还在跑", "3 tests passed in the parser module", "测试通过了吗？", "测试通过率提高到 90%", "测试通过后再合并", "上一轮测试全部通过", "用户说测试全部通过", "日志里写着“测试全部通过”"])
		assert.equal(passClaimKind(sentence), undefined, sentence);
	assert.deepEqual(passClaimSentences("其余测试通过，只有 1 个失败。").map(({ partial }) => partial), [true]);
	const evidence = { runs: [{ id: "t", command: "npm test", kind: "test" as const, exitCode: 1, scope: "full" as const, finishedAt: 1, batch: 1 }], writes: [] };
	assert.equal(judgePassClaim("test", evidence, "其余测试通过，只有 1 个失败。", true).status, "unverified");
});

test("only a new swallow in a script the judge runs is a veto", () => {
	const hits = (body: string) => scanTestIntegrity(parseDiffLines([diff("package.json", body)]), []).map(({ rule, review }) => [rule, review ?? false]);
	assert.deepEqual(hits('@@ -3,1 +3,1 @@\n-    "test:e2e": "playwright test",\n+    "test:e2e": "playwright test || true",\n'), [["修改了检查脚本", true], ["修改了检查脚本", true]]);
	assert.deepEqual(hits('@@ -3,1 +3,1 @@\n-    "test": "a || true",\n+    "test": "b || true",\n'), [["修改了检查脚本", true], ["修改了检查脚本", true]]);
	assert.deepEqual(hits('@@ -3,1 +3,1 @@\n-    "test": "node --test",\n+    "test": "node --test --silent || echo",\n'), [["修改了检查脚本", true], ["修改了检查脚本", true]]);
	assert.deepEqual(hits('@@ -3,1 +3,1 @@\n-    "lint-staged": "x",\n+    "lint-staged": "x || true",\n'), []);
	assert.deepEqual(hits('@@ -3,1 +3,1 @@\n-    "lint": "eslint .",\n+    "lint": "eslint . || :",\n'), [["修改了检查脚本", true], ["检查脚本会吞掉失败", false]]);
});
