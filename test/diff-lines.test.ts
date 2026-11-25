import assert from "node:assert/strict";
import test from "node:test";
import { computeLineDiff, diffHunkCount, parseUnifiedDiff, summarizeLineChanges } from "../src/renderer/diff-lines.ts";

test("diff lines beginning with Git metadata prefixes keep review anchors inside hunks", () => {
	const diff = [
		"# 已暂存",
		"--- a/query.sql",
		"+++ b/query.sql",
		"@@ -20,2 +30,2 @@",
		"--- removed SQL line comment",
		"+++ added text beginning with ++",
		" SELECT 1;",
		"# 未暂存",
		"--- a/query.sql",
		"+++ b/query.sql",
		"@@ -0,0 +5 @@",
		"+created later",
	].join("\n");
	const lines = parseUnifiedDiff(diff);
	assert.equal(diffHunkCount(diff), 2);
	assert.deepEqual(lines.filter((line) => line.type === "del" || line.type === "add" || line.type === "ctx"), [
		{ type: "del", text: "-- removed SQL line comment", oldNum: 20, hunk: 0, section: "已暂存" },
		{ type: "add", text: "++ added text beginning with ++", newNum: 30, hunk: 0, section: "已暂存" },
		{ type: "ctx", text: "SELECT 1;", oldNum: 21, newNum: 31, hunk: 0, section: "已暂存" },
		{ type: "add", text: "created later", newNum: 5, hunk: 1, section: "未暂存" },
	]);
	assert.equal(lines.filter((line) => line.type === "meta").length, 6);
});

test("a small change in a long snippet still has exact counts and line anchors", () => {
	const oldLines = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`);
	const newLines = [...oldLines.slice(0, 107), "replacement", "inserted", ...oldLines.slice(108)];
	const diff = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
	assert.deepEqual(diff.counts, { additions: 2, removals: 1 });
	assert.deepEqual(diff.lines.slice(106, 111), [
		{ type: "ctx", text: "line 107", oldNum: 107, newNum: 107 },
		{ type: "del", text: "line 108", oldNum: 108 },
		{ type: "add", text: "replacement", newNum: 108 },
		{ type: "add", text: "inserted", newNum: 109 },
		{ type: "ctx", text: "line 109", oldNum: 109, newNum: 110 },
	]);
});

test("large unmatched ranges produce a before and after preview without invented counts", () => {
	const shared = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`).join("\n");
	const edit = { oldText: `old start\n${shared}\nold end`, newText: `new start\n${shared}\nnew end` };
	const diff = computeLineDiff(edit.oldText, edit.newText);
	assert.equal(diff.counts, undefined);
	assert.ok(diff.lines.some((line) => line.type === "meta" && line.text.startsWith("改动前")));
	assert.ok(diff.lines.some((line) => line.type === "meta" && line.text.startsWith("改动后")));
	assert.ok(diff.lines.every((line) => line.type !== "add" && line.type !== "del"));
	assert.equal(summarizeLineChanges([{ oldText: "one", newText: "two" }, edit]), undefined);
});

test("empty edits and terminal newlines do not inflate line counts", () => {
	assert.deepEqual(computeLineDiff("", "new\n").counts, { additions: 1, removals: 0 });
	assert.deepEqual(computeLineDiff("old\r\n", "").counts, { additions: 0, removals: 1 });
	assert.deepEqual(computeLineDiff("\n", "").counts, { additions: 0, removals: 1 });
});
