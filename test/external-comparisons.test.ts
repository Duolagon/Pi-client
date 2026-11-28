import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExternalTask } from "../src/external-types.ts";
import { groupExternalComparisons, type CandidateDelta } from "../src/renderer/external-comparisons.ts";

function task(id: string, createdAt: number, overrides: Partial<ExternalTask> = {}): ExternalTask {
	return {
		id, executor: "kimi", parentConversationId: "parent", title: id, project: "/example", workingDirectory: `/example/worktrees/${id}`,
		subagentType: "general-purpose", readOnly: false, status: "completed", createdAt, updatedAt: createdAt,
		revision: 1, turn: 2, eventSequence: 1, output: "Verified", truncated: false, pendingApprovals: [],
		changes: { files: [], additions: 0, deletions: 0, truncated: false }, ...overrides,
	};
}

test("comparison uses cumulative patches even after an identical no-edit verification turn", () => {
	const tasks = [task("red", 1), task("blue", 2), task("same-red", 3, { output: "different explanation" }),
		task("failed", 4, { status: "failed" })];
	const deltas = new Map(tasks.map(({ id }) => [id, { paths: 1, partial: false, fingerprint: id === "blue" ? "blue" : "red" }]));
	assert.deepEqual(groupExternalComparisons(tasks, deltas).map(group => group.map(t => t.id)),
		[["red", "same-red"], ["blue"], ["failed"]]);
});

test("only verified empty cumulative changes allow matching complete outputs to coalesce", () => {
	const ids = ["one", "two", "missing", "partial", "truncated", "different"];
	const tasks = ids.map((id, i) => task(id, i, { truncated: id === "truncated", output: id === "different" ? "other" : "Verified" }));
	const deltas = new Map<string, CandidateDelta>(ids.filter(id => id !== "missing")
		.map(id => [id, { paths: 0, partial: id === "partial" }]));
	assert.deepEqual(groupExternalComparisons(tasks, deltas).map(group => group.map(t => t.id)),
		[["one", "two"], ["missing"], ["partial"], ["truncated"], ["different"]]);
});
