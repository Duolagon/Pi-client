import type { WerewolfClaim, WerewolfReview } from "../werewolf-types.ts";

export function werewolfReviewForReply(reviews: readonly WerewolfReview[], timestamp: number, entryId?: string) {
	if (entryId) {
		const anchored = reviews.findLast((review) => review.replyEntryId === entryId);
		if (anchored) return anchored;
	}
	const candidates = reviews.filter((review) => review.replyTimestamp === timestamp);
	return candidates.length === 1 && candidates[0].replyEntryId === undefined ? candidates[0] : undefined;
}

export function werewolfMetrics(claims: readonly WerewolfClaim[]) {
	const assertions = claims.filter((claim) => claim.quote?.trim());
	const total = assertions.length;
	const contradicted = assertions.filter((claim) => claim.status === "contradicted").length;
	const verified = assertions.filter((claim) => claim.status === "verified").length;
	const checked = verified + contradicted;
	const requirements = new Map<string, boolean>();
	for (const claim of claims) {
		const requirement = claim.requirements?.trim();
		if (requirement) requirements.set(requirement, requirements.get(requirement) !== false && claim.status === "verified");
	}
	return {
		total,
		checked,
		verified,
		contradicted,
		pending: total - checked,
		hallucinationRate: checked > 0 ? contradicted / checked : undefined,
		coverage: total > 0 ? checked / total : undefined,
		acceptanceTotal: requirements.size,
		acceptanceVerified: Array.from(requirements.values()).filter(Boolean).length,
	};
}
