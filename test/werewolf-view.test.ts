import assert from "node:assert/strict";
import { test } from "node:test";
import { werewolfMetrics, werewolfReviewForReply } from "../src/renderer/werewolf-view.ts";
import type { WerewolfClaim, WerewolfReview } from "../src/werewolf-types.ts";

function claim(id: string, status: WerewolfClaim["status"], requirements?: string): WerewolfClaim {
	return { id, status, quote: id, description: id, requirements };
}

test("werewolf metrics report unresolved claims separately and deduplicate acceptance requirements", () => {
	const metrics = werewolfMetrics([
		claim("1", "verified", "范围"), claim("2", "contradicted", "范围"),
		claim("3", "verified", "文件"), claim("4", "unverified", "交互"), claim("5", "verified"),
		{ ...claim("6", "unverified", "遗漏要求"), quote: undefined },
	]);
	assert.equal(metrics.hallucinationRate, 0.25);
	assert.equal(metrics.coverage, 0.8);
	assert.equal(metrics.pending, 1);
	assert.equal(metrics.acceptanceTotal, 4);
	assert.equal(metrics.acceptanceVerified, 1);
	assert.equal(werewolfMetrics([]).coverage, undefined);
	assert.equal(werewolfMetrics([claim("1", "unverified")]).hallucinationRate, undefined);
});

test("a native entry anchor or an unambiguous timestamp is needed to show a verdict", () => {
	const legacy: WerewolfReview = { id: "legacy", replyTimestamp: 100, createdAt: 101, status: "pending", claims: [] };
	const left: WerewolfReview = { ...legacy, id: "left", replyEntryId: "left-entry" };
	const right: WerewolfReview = { ...legacy, id: "right", replyEntryId: "right-entry" };
	assert.equal(werewolfReviewForReply([legacy], 100), legacy);
	assert.equal(werewolfReviewForReply([left, right], 100, "right-entry"), right);
	assert.equal(werewolfReviewForReply([left], 100, "right-entry"), undefined);
	assert.equal(werewolfReviewForReply([legacy, left], 100), undefined);
});
