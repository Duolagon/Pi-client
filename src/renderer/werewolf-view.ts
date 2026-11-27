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

export type WerewolfClaimCategory = "contradicted" | "gap" | "verified" | "unverified";

export function classifyWerewolfClaim(claim: WerewolfClaim): WerewolfClaimCategory {
	if (claim.status === "contradicted") return "contradicted";
	if (claim.status === "verified") return "verified";
	if (!claim.quote?.trim() && claim.requirements?.trim()) return "gap";
	return "unverified";
}

function formatProbeExpr(expr: unknown): string {
	if (!expr || typeof expr !== "object" || Array.isArray(expr)) return "?";
	const rec = expr as Record<string, unknown>;
	if ("literal" in rec) {
		const text = JSON.stringify(rec.literal);
		return text.length > 36 ? `${text.slice(0, 33)}…` : text;
	}
	if ("call" in rec && rec.call && typeof rec.call === "object") {
		const call = rec.call as { module?: unknown; exportName?: unknown; args?: unknown[] };
		const mod = typeof call.module === "string" ? call.module.split("/").pop() ?? call.module : "module";
		const fn = typeof call.exportName === "string" ? call.exportName : "fn";
		const args = Array.isArray(call.args) ? call.args.map(formatProbeExpr).join(", ") : "";
		return `${mod}::${fn}(${args})`;
	}
	if ("pick" in rec && rec.pick && typeof rec.pick === "object") {
		const pick = rec.pick as { from?: unknown; path?: Array<string | number> };
		const base = formatProbeExpr(pick.from);
		const suffix = Array.isArray(pick.path)
			? pick.path.map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${seg}`)).join("")
			: "";
		return `${base}${suffix}`;
	}
	return "?";
}

export interface FormattedProbeInfo {
	kind: "behavior" | "source";
	badge: string;
	formula: string;
}

export function parseProbeSignature(reproduction?: string): FormattedProbeInfo | undefined {
	if (!reproduction || !reproduction.trim().startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(reproduction) as Record<string, unknown>;
		if (parsed.kind === "source" && typeof parsed.file === "string") {
			return {
				kind: "source",
				badge: "源码取证",
				formula: `${parsed.file}${typeof parsed.exact === "string" ? ` · "${parsed.exact.slice(0, 42)}"` : ""}`,
			};
		}
		if (parsed.kind === "behavior" && typeof parsed.op === "string") {
			const opSymbols: Record<string, { sym: string; label: string }> = {
				equal: { sym: "===", label: "等价断言" },
				different: { sym: "!==", label: "不等断言" },
				contains: { sym: "∋", label: "包含断言" },
				omits: { sym: "∌", label: "排除断言" },
			};
			const meta = opSymbols[parsed.op] ?? { sym: parsed.op, label: "行为探针" };
			return {
				kind: "behavior",
				badge: meta.label,
				formula: `${formatProbeExpr(parsed.left)} ${meta.sym} ${formatProbeExpr(parsed.right)}`,
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function summarizeWerewolfSession(reviews: readonly WerewolfReview[]) {
	let pendingCount = 0;
	let wolfTurns = 0;
	let villagerTurns = 0;
	let unverifiedTurns = 0;
	let totalCheckedClaims = 0;
	let totalContradictedClaims = 0;
	let totalGapClaims = 0;
	for (const review of reviews) {
		if (review.status === "pending") {
			pendingCount++;
			continue;
		}
		if (review.status === "contradicted") wolfTurns++;
		else if (review.status === "verified") villagerTurns++;
		else unverifiedTurns++;
		for (const claim of review.claims) {
			if (claim.quote?.trim()) {
				if (claim.status === "verified" || claim.status === "contradicted") totalCheckedClaims++;
				if (claim.status === "contradicted") totalContradictedClaims++;
			} else if (claim.requirements?.trim() && claim.status !== "verified") {
				totalGapClaims++;
			}
		}
	}
	return {
		totalReviews: reviews.length,
		pendingCount,
		wolfTurns,
		villagerTurns,
		unverifiedTurns,
		totalCheckedClaims,
		totalContradictedClaims,
		totalGapClaims,
		hallucinationRate: totalCheckedClaims > 0 ? totalContradictedClaims / totalCheckedClaims : undefined,
	};
}

export function buildWerewolfConfrontPrompt(review: WerewolfReview, targetClaims?: readonly WerewolfClaim[]): string {
	const list = targetClaims ?? review.claims.filter((claim) => claim.status === "contradicted" || (!claim.quote?.trim() && Boolean(claim.requirements?.trim()) && claim.status !== "verified"));
	if (!list.length) return "";
	const lines: string[] = [
		"独立核验（狼人核验）发现上一轮回复存在以下与实测证据不符或尚未兑现的要求，请逐项核实并彻底修复：",
		"",
	];
	list.forEach((claim, index) => {
		const cat = classifyWerewolfClaim(claim);
		if (cat === "contradicted") {
			lines.push(`${index + 1}. 【与证据矛盾】${claim.description}`);
			if (claim.quote) lines.push(`   - 回复原话：「${claim.quote}」`);
			if (claim.requirements) lines.push(`   - 关联需求：${claim.requirements}`);
			if (claim.evidence?.expected !== undefined) lines.push(`   - 声称预期：${claim.evidence.expected}`);
			if (claim.evidence?.actual !== undefined) lines.push(`   - 实测结果：${claim.evidence.actual}`);
			if (claim.evidence?.source) lines.push(`   - 证据来源：${claim.evidence.source}`);
		} else {
			lines.push(`${index + 1}. 【交付缺口 / 待兑现要求】${claim.description}`);
			if (claim.requirements) lines.push(`   - 原始要求：${claim.requirements}`);
		}
		lines.push("");
	});
	lines.push("请基于真实代码与运行验证修正上述问题，并在回复中给出真实可复现的验证结果。");
	return lines.join("\n");
}
