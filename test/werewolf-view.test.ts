import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildWerewolfConfrontPrompt,
	classifyWerewolfClaim,
	parseProbeSignature,
	summarizeWerewolfSession,
	werewolfMetrics,
	werewolfReviewForReply,
} from "../src/renderer/werewolf-view.ts";
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

test("werewolf helpers format probe formulas, session summaries, and confront repair prompts", () => {
	const behaviorJson = JSON.stringify({
		kind: "behavior",
		op: "equal",
		left: { call: { module: "src/math.mjs", exportName: "price", args: [{ literal: 2 }] } },
		right: { literal: 2 },
	});
	const parsed = parseProbeSignature(behaviorJson);
	assert.deepEqual(parsed, {
		kind: "behavior",
		badge: "等价断言",
		formula: "math.mjs::price(2) === 2",
	});
	assert.equal(parseProbeSignature("npm test"), undefined);

	const contradictedClaim: WerewolfClaim = {
		id: "c1",
		quote: "price(2) 返回 2。",
		requirements: "核验 price(2)",
		description: "检查返回值",
		status: "contradicted",
		evidence: { summary: "实测不等", expected: "2", actual: "3", reproduction: behaviorJson, source: "src/math.mjs" },
	};
	const gapClaim: WerewolfClaim = {
		id: "c2",
		requirements: "确认币种",
		description: "缺少币种说明",
		status: "unverified",
	};
	assert.equal(classifyWerewolfClaim(contradictedClaim), "contradicted");
	assert.equal(classifyWerewolfClaim(gapClaim), "gap");

	const review: WerewolfReview = {
		id: "rev-1",
		replyTimestamp: 200,
		createdAt: 205,
		status: "contradicted",
		claims: [contradictedClaim, gapClaim],
	};
	const prompt = buildWerewolfConfrontPrompt(review);
	assert.match(prompt, /【与证据矛盾】检查返回值/);
	assert.match(prompt, /实测结果：3/);
	assert.match(prompt, /【交付缺口 \/ 待兑现要求】缺少币种说明/);

	const session = summarizeWerewolfSession([
		review,
		{ id: "rev-2", replyTimestamp: 300, createdAt: 305, status: "verified", claims: [claim("ok", "verified")] },
		{ id: "rev-3", replyTimestamp: 400, createdAt: 405, status: "pending", claims: [] },
	]);
	assert.equal(session.wolfTurns, 1);
	assert.equal(session.villagerTurns, 1);
	assert.equal(session.pendingCount, 1);
	assert.equal(session.hallucinationRate, 0.5);
});
