import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExternalEvent } from "../src/external-types.ts";
import { externalPlan } from "../src/external-plan.ts";
import { externalTimelineTurns, mergeExternalTimeline, timelineEvent } from "../src/renderer/external-timeline.ts";

const event = (sequence: number, payload: ExternalEvent["event"], turn = 1) => timelineEvent({
	taskId: "external-fixture", executor: "kimi", parentConversationId: "parent", sequence, turn, timestamp: sequence * 1000, event: payload,
})!;

test("external timeline merges live and replay events by sequence and folds tool updates", () => {
	const start = event(1, { type: "tool_start", id: "read-1", name: "Read", input: { fixture: "privately retained native input" } });
	const progress = event(2, { type: "tool_update", id: "read-1", text: "some progress" });
	const end = event(3, { type: "tool_end", id: "read-1", isError: false, output: "the final output" });
	const rerun = event(4, { type: "tool_start", id: "read-1", name: "Read again", input: {} }, 2);
	const merged = mergeExternalTimeline([end, rerun], [start, progress, end]);
	assert.deepEqual(merged.map(({ sequence }) => sequence), [1, 2, 3, 4]);
	assert.doesNotMatch(JSON.stringify(merged), /privately retained native input/);
	const turns = externalTimelineTurns(merged);
	assert.equal(turns.length, 2);
	assert.equal(turns[1].items.length, 1);
	assert.deepEqual(turns[1].items[0], { kind: "tool", sequence: 1, timestamp: 1000, name: "Read", output: "the final output", isError: false, partialOutput: false });
});

test("external timeline retains the most recent native plan and defined usage for each turn", () => {
	const plan = externalPlan([{ step: "read", status: "inProgress" }], "step", "Start");
	assert.deepEqual(plan, { type: "plan", steps: [{ text: "read", status: "in_progress" }], explanation: "Start" });
	const [turn] = externalTimelineTurns([
		event(1, plan!),
		event(2, { type: "usage", inputTokens: 40, outputTokens: 10 }),
		event(3, externalPlan([{ content: "read", status: "completed" }, { content: "bad", status: "unknown" }], "content")!),
		event(4, { type: "usage", sessionCostUsd: 0.024 }),
	]);
	assert.deepEqual(turn.usage, { type: "usage", inputTokens: 40, outputTokens: 10, sessionCostUsd: 0.024 });
	assert.equal(turn.items.length, 1);
	const [latest] = turn.items;
	assert.equal(latest.kind, "plan");
	assert.equal(latest.sequence, 1);
	assert.deepEqual(latest.plan.steps, [{ text: "read", status: "completed" }]);
});
