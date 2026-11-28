import { truncateText } from "./delegation-limits.ts";
import type { ExternalAdapterEvent, ExternalPlanStep } from "./external-types.ts";

/** Codex calls each entry a step; ACP and Claude Code TodoWrite call it content. */
export function externalPlan(value: unknown, field: "step" | "content", explanation?: unknown): Extract<ExternalAdapterEvent, { type: "plan" }> | undefined {
	if (!Array.isArray(value)) return;
	const steps: ExternalPlanStep[] = [];
	for (const entry of value.slice(0, 64)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const text = record[field];
		const status = record.status === "inProgress" ? "in_progress" : record.status;
		if (typeof text !== "string" || !text.trim() || (status !== "pending" && status !== "in_progress" && status !== "completed")) continue;
		steps.push({ text: truncateText(text.trim(), 1024), status });
	}
	if (value.length && !steps.length) return;
	return {
		type: "plan", steps,
		...(typeof explanation === "string" && explanation.trim() ? { explanation: truncateText(explanation.trim(), 8000) } : {}),
	};
}
