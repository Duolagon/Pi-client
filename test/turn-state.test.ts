import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAssistantEntries, matchUserEntries, submittedPlan } from "../src/renderer/turn-state.ts";
import type { SessionEntriesResult } from "../src/session-types.ts";
import type { Message } from "../src/shared.ts";

const repeated: Message = { role: "user", content: [{ type: "text", text: "same prompt" }], timestamp: 1 };
function entry(id: string, parentId: string | null): SessionEntriesResult["entries"][number] {
	return { type: "message", id, parentId, timestamp: "2026-11-23T00:00:00Z", message: repeated };
}

test("repeated prompts are linked to their own entries on the active branch", () => {
	const entries = [entry("first", null), entry("left", "first"), entry("right", "first")];
	assert.deepEqual(matchUserEntries([repeated, repeated], { entries, leafId: "right" }), { 0: "first", 1: "right" });
	assert.deepEqual(matchUserEntries([repeated], { entries, leafId: "left" }), { 0: "left" });
	assert.deepEqual(matchUserEntries([{ ...repeated, timestamp: 2 }], { entries, leafId: "right" }), {});
});

test("assistant review anchors only link to the active native branch even for identical replies", () => {
	const reply: Message = {
		role: "assistant", content: [{ type: "text", text: "相同回复" }], timestamp: 2,
		api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const first = entry("question", null);
	const entries: SessionEntriesResult["entries"] = [first,
		{ ...first, id: "left", parentId: "question", message: reply },
		{ ...first, id: "right", parentId: "question", message: reply },
	];
	assert.deepEqual(matchAssistantEntries([repeated, reply], { entries, leafId: "right" }), { 1: "right" });
	assert.deepEqual(matchAssistantEntries([repeated, reply], { entries, leafId: "left" }), { 1: "left" });
	assert.deepEqual(matchAssistantEntries([repeated, reply], { entries, leafId: "question" }), {});
});

test("a failed or unsaved latest submission cannot approve an older plan", () => {
	const success: Message = {
		role: "toolResult", toolName: "ExitPlanMode", toolCallId: "planned", content: [],
		details: { saved: true, content: "# Plan" }, isError: false, timestamp: 2,
	};
	assert.deepEqual(submittedPlan([repeated, success]), { id: "planned", content: "# Plan" });
	assert.equal(submittedPlan([repeated, success, { ...success, isError: true }]), undefined);
	assert.equal(submittedPlan([repeated, success, { ...success, details: { saved: false } }]), undefined);
	assert.equal(submittedPlan([repeated, success, repeated]), undefined);
});
