import type { CodingTier, MultiAgentSettings, MultiExecutorId } from "./shared.ts";
import { multiTierPromptSection } from "./multi-agent.ts";

/** Prompt section name the permission extension writes the tier text into. */
export const CODING_TIER_SECTION = "coding_tier";

export interface CodingTierRuntimeConfig {
	prompt: string;
	controller?: MultiAgentSettings["controller"];
}

/**
 * Host-enforced ceilings for one WorkflowRun. A script may ask for less; it cannot ask for more.
 * Standard keeps an unprompted fan-out small; ultracode is the user's standing opt-in to scale.
 */
export const WORKFLOW_LIMITS: Record<CodingTier, { maxAgents: number; maxCost: number }> = {
	standard: { maxAgents: 24, maxCost: 0.5 },
	ultracode: { maxAgents: 100, maxCost: 3 },
	// The multi tier delegates to external executors; their own accounts pay for them.
	multi: { maxAgents: 24, maxCost: 0.5 },
};

/**
 * The word "ultracode" in a prompt turns that one turn into an ultracode turn, like Claude Code's
 * keyword. It must stand alone among Latin letters (Chinese may touch it): `ultracode-ish`,
 * `/ultracode`, `@ultracode`, a path segment or a file name such as `ultracode.ts` do not count.
 * A sentence ending in "ultracode." still does.
 */
const KEYWORD = /(?<![A-Za-z0-9_/.@-])ultracode(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/gi;

/** Character ranges of the keyword in a prompt, for highlighting it while the user types. */
export function ultracodeKeywordRanges(text: string): Array<[number, number]> {
	return [...text.matchAll(KEYWORD)].map((match) => [match.index, match.index + match[0].length]);
}

export function mentionsUltracode(text: string): boolean {
	return ultracodeKeywordRanges(text).length > 0;
}

const MAX_TIER_SPANS = 200;

/** Open or close the span of ultracode turns at `now`; keep a bounded history. */
export function recordTierSpan(spans: Array<{ from: number; to?: number }> | undefined, on: boolean, now: number) {
	const next = [...(spans ?? [])];
	const open = next.at(-1) && next.at(-1)!.to === undefined;
	if (on && !open) next.push({ from: now });
	if (!on && open) next[next.length - 1] = { ...next.at(-1)!, to: now };
	return next.slice(-MAX_TIER_SPANS);
}

/** Whether a prompt sent at `at` ran on ultracode. */
export function ranOnUltracode(spans: ReadonlyArray<{ from: number; to?: number }> | undefined, at: number): boolean {
	return Boolean(spans?.some((span) => span.from <= at && (span.to === undefined || at <= span.to)));
}

export function codingTierOf(value: unknown): CodingTier {
	return value === "ultracode" || value === "multi" ? value : "standard";
}

/** Clamp a script's requested budget to the tier's ceiling and fill in absent limits. */
export function workflowBudgetFor(
	tier: CodingTier,
	requested: { maxCost?: unknown; maxTokens?: unknown; maxAgents?: unknown } | undefined,
): { maxCost: number; maxAgents: number; maxTokens?: number } {
	const limits = WORKFLOW_LIMITS[tier];
	const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	const cost = positive(requested?.maxCost);
	const agents = positive(requested?.maxAgents);
	const tokens = positive(requested?.maxTokens);
	return {
		maxCost: Math.min(limits.maxCost, cost ?? limits.maxCost),
		maxAgents: Math.min(limits.maxAgents, Math.floor(agents ?? limits.maxAgents)),
		...(tokens !== undefined ? { maxTokens: Math.floor(tokens) } : {}),
	};
}

/**
 * Text for the main conversation's system prompt. Standard says when orchestration is worth it;
 * ultracode makes it the default. Both name the budget the host will enforce.
 */
export function codingTierPromptSection(
	tier: unknown,
	turnOnly = false,
	multi?: { settings?: MultiAgentSettings; available: readonly MultiExecutorId[] },
): string {
	const current = codingTierOf(tier);
	if (current === "multi") return multiTierPromptSection(multi?.settings, multi?.available ?? [], turnOnly);
	const limits = WORKFLOW_LIMITS[current];
	if (current === "standard") {
		return [
			"# Orchestration (standard tier)",
			"Scale delegation to the task. Do small or tightly coupled work yourself. Use Agent calls, launched together in one message, when two to five pieces are independent or when a wide read would flood your context.",
			"Use WorkflowRun only when the user asks for orchestration, an exhaustive audit, or many agents, or when the work is a list of more than about eight independent units. Otherwise scout and act directly.",
			`A workflow here is capped by the host at ${limits.maxAgents} agents and $${limits.maxCost} per run. Size it to fit: one agent per unit, one refuter per finding (multi-refuter votes are for ultracode), and verify only findings that matter. Cost is counted as agents finish, so a wide parallel() can overshoot before the host cancels it.`,
			"The user can switch this conversation to the ultracode tier for exhaustive multi-agent work.",
		].join("\n");
	}
	return [
		"# Orchestration (ultracode tier)",
		turnOnly
			? "The user asked for ultracode in this message: for this turn, aim for the most exhaustive, correct result rather than the fastest or cheapest. The conversation returns to its selected tier afterwards."
			: "The user turned on ultracode for this conversation: aim for the most exhaustive, correct result rather than the fastest or cheapest. This opt-in is standing.",
		"For every substantive task, orchestrate: scout the work list yourself first (list the files, read the diff, find the units), then write a WorkflowRun script that fans out over it. For multi-phase work (understand, design, implement, review), run one workflow per phase and read each result before writing the next.",
		"Use the quality patterns: adversarially verify findings with independent refuters, give verifiers different lenses, use judge panels where the solution space is wide, loop until dry for discovery of unknown size, and end with a completeness critic.",
		"Agents that edit files in parallel need isolation: \"worktree\"; merge their results yourself afterwards.",
		"Work solo only on conversational turns, trivial mechanical edits, or work you have already verified.",
		`The host caps each workflow at ${limits.maxAgents} agents and $${limits.maxCost}, cancelling running agents once cost crosses the cap. Plan within that: when a task needs more, split it into several workflows and say so.`,
	].join("\n");
}
