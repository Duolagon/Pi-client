import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewNotes, reviewRevision, type ReviewNote } from "../src/renderer/workspace-review-state.ts";

test("review feedback keeps the path, diff section, original side, line and quoted context", () => {
	const note: ReviewNote = {
		id: "one", path: "src/My Module.ts", source: "workspace", version: "hash",
		side: "old", section: "已暂存", line: 7, text: "  return false;", note: "保留旧行为",
	};
	const feedback = formatReviewNotes([note, { ...note, side: "new", section: "未暂存", line: 11, note: "补一条测试" }]);
	assert.match(feedback, /src\/My Module.ts · 已暂存 · 原文件第 7 行[\s\S]+return false;[\s\S]+保留旧行为/);
	assert.match(feedback, /src\/My Module.ts · 未暂存 · 新文件第 11 行[\s\S]+补一条测试/);
});

test("review revision is repeatable and changes when the file diff is updated", async () => {
	const initial = await reviewRevision("@@ -1 +1 @@\n-old\n+new");
	assert.equal(await reviewRevision("@@ -1 +1 @@\n-old\n+new"), initial);
	assert.notEqual(await reviewRevision("@@ -1 +1 @@\n-old\n+newer"), initial);
});
