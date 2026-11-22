import assert from "node:assert/strict";
import { test } from "node:test";
import { betterApproach, citationText, comparisonText, gradeTone, grailWording, latestVerdict, revealDecision } from "../src/renderer/grail-view.ts";
import type { GrailVerdict } from "../src/shared.ts";

function verdict(partial: Partial<GrailVerdict> = {}): GrailVerdict {
	return {
		id: "v1",
		conversationId: "c1",
		wish: 0,
		startedAt: 1,
		finishedAt: 2,
		grade: "granted",
		reasons: [],
		steps: {},
		requirement: ["修复"],
		files: [],
		costUsd: 0.1,
		...partial,
	};
}

test("grail theme uses 圣杯 wording; light/dark stay neutral", () => {
	const grail = grailWording(true);
	assert.equal(grail.start, "请圣杯鉴定");
	assert.equal(grail.grades.grail, "圣杯显灵");
	assert.equal(grail.grades.unfulfilled, "愿未达成");
	const neutral = grailWording(false);
	assert.equal(neutral.start, "质量鉴定");
	const all = JSON.stringify(neutral);
	for (const word of ["圣杯", "显灵", "愿望"]) assert.equal(all.includes(word), false, word);
	assert.deepEqual(Object.keys(neutral.grades).sort(), Object.keys(grail.grades).sort());
});

test("reveal plays only for 圣杯显灵 of the active, visible conversation", () => {
	const base = { grade: "grail" as const, verdictConversation: "c1", activeConversation: "c1", visible: true, reducedMotion: false };
	assert.equal(revealDecision(base), "play");
	assert.equal(revealDecision({ ...base, visible: false }), "defer");
	assert.equal(revealDecision({ ...base, reducedMotion: true }), "skip");
	assert.equal(revealDecision({ ...base, activeConversation: "c2" }), "skip");
	assert.equal(revealDecision({ ...base, grade: "granted" }), "skip");
});

test("comparison with the previous verdict and the named better approach", () => {
	const wording = grailWording(true);
	assert.equal(comparisonText(verdict(), wording), undefined);
	assert.equal(comparisonText(verdict({ grade: "grail", previousGrade: "granted" }), wording), "上次：愿望达成；这次：圣杯显灵");
	const v = verdict({
		steps: {
			comparison: {
				status: "ok",
				dropped: 0,
				findings: [
					{ criterion: "requirement", pass: true, note: "ok", citations: [{ file: "a.ts", side: "+", line: 3 }] },
					{ criterion: "lessCode", pass: false, note: " 直接在 parse 里处理即可 ", citations: [{ file: "a.ts", side: "-", line: 7 }] },
				],
			},
		},
	});
	assert.equal(betterApproach(v), "直接在 parse 里处理即可");
	assert.equal(betterApproach(verdict()), undefined);
	assert.equal(citationText({ file: "a.ts", side: "-", line: 7 }), "a.ts:-7");
});

test("tones and latest verdict", () => {
	assert.equal(gradeTone("grail"), "gold");
	assert.equal(gradeTone("unjudgeable"), "muted");
	assert.equal(latestVerdict(null), undefined);
	const last = verdict({ id: "v2" });
	assert.equal(latestVerdict({ conversationId: "c1", wish: 0, verdicts: [verdict(), last], hasDiff: true })?.id, "v2");
});
