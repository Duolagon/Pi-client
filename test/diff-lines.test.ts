import assert from "node:assert/strict";
import test from "node:test";
import { diffHunkCount, parseUnifiedDiff } from "../src/renderer/diff-lines.ts";

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
