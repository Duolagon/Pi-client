import { formatCompactDuration, formatCompactTokens } from "../delegation-format.ts";
import type { WorkflowRecord, WorkflowStepRecord } from "../workflow-types.ts";

export type WorkflowTreeState = "run" | "ok" | "err";

/** Phase groups in the order their steps first appear, with the loose top-level steps last. */
export interface WorkflowTreeGroup {
	name?: string;
	state: WorkflowTreeState;
	steps: WorkflowStepRecord[];
	/** Why the phase failed, when its body threw. */
	error?: string;
	/** A running phase with no step yet: show a "preparing" row. */
	pending?: boolean;
}

export function stepState(step: WorkflowStepRecord): WorkflowTreeState {
	if (step.status === "running") return "run";
	return step.status === "failed" ? "err" : "ok";
}

export function workflowState(record: WorkflowRecord): WorkflowTreeState {
	if (record.status === "running" || record.status === "waiting_for_approval") return "run";
	return record.status === "completed" ? "ok" : "err";
}

/**
 * Steps grouped by their phase. A phase is shown as soon as one of its steps exists, so the tree
 * grows while the run proceeds. Named phases keep the order of the record's own phase list.
 */
export function workflowTree(record: WorkflowRecord): WorkflowTreeGroup[] {
	const steps = Object.values(record.steps ?? {}).sort((left, right) => left.startedAt - right.startedAt);
	const order = new Map<string, number>();
	record.phases.forEach((phase, index) => { if (!order.has(phase.name)) order.set(phase.name, index); });
	const groups = new Map<string, WorkflowTreeGroup>();
	for (const step of steps) {
		const key = step.phase ?? "";
		if (!order.has(key) && key) order.set(key, order.size + record.phases.length);
		const group = groups.get(key) ?? { ...(step.phase ? { name: step.phase } : {}), state: "ok" as WorkflowTreeState, steps: [] };
		group.steps.push(step);
		groups.set(key, group);
	}
	// The latest run of each phase name decides its status; a body that threw marks it failed.
	const latest = new Map<string, WorkflowRecord["phases"][number]>();
	for (const phase of record.phases) latest.set(phase.name, phase);
	for (const [key, group] of groups) {
		const states = group.steps.map(stepState);
		const phase = key ? latest.get(key) : undefined;
		group.state = states.includes("run") ? "run" : states.includes("err") || phase?.status === "failed" ? "err" : "ok";
		if (phase?.status === "failed" && phase.error) group.error = phase.error;
	}
	// A phase with no step of its own gets a row only while it is the newest thing running, or when
	// it failed. A finished phase that only logged, or one that only wraps nested phases, has none.
	const lastStepAt = steps.at(-1)?.startedAt ?? -Infinity;
	for (const [name, phase] of latest) {
		if (groups.has(name)) continue;
		if (phase.status === "failed") groups.set(name, { name, state: "err", steps: [], ...(phase.error ? { error: phase.error } : {}) });
		else if (phase.status === "running" && phase.startedAt >= lastStepAt && workflowState(record) === "run") {
			groups.set(name, { name, state: "run", steps: [], pending: true });
		}
	}
	return [...groups.entries()]
		.sort(([left], [right]) => (left ? order.get(left) ?? 0 : Number.MAX_SAFE_INTEGER) - (right ? order.get(right) ?? 0 : Number.MAX_SAFE_INTEGER))
		.map(([, group]) => group);
}

/** Right-hand metrics of one step row: tokens and duration, ticking while it runs. */
export function stepMetrics(step: WorkflowStepRecord, now: number): string {
	const parts: string[] = [];
	if (step.usage?.totalTokens) parts.push(`${formatCompactTokens(step.usage.totalTokens)} tokens`);
	if (step.status === "replayed") parts.push("已复用");
	else parts.push(formatCompactDuration(Math.max(0, (step.completedAt ?? now) - step.startedAt)));
	return parts.join(" · ");
}

/** One-line summary of a finished run: `完成 · 12 个 Agent · 48.1k tokens · $0.21 · 3m4s`. */
export function workflowSummary(record: WorkflowRecord, now = Date.now()): string {
	const state = workflowState(record);
	const label = state === "run"
		? record.status === "waiting_for_approval" ? "等待审批" : "运行中"
		: record.status === "completed" ? "完成" : record.status === "cancelled" ? "已停止" : "失败";
	const parts = [label];
	if (record.budget.spawnedAgents) parts.push(`${record.budget.spawnedAgents} 个 Agent`);
	if (record.budget.spentTokens) parts.push(`${formatCompactTokens(record.budget.spentTokens)} tokens`);
	if (record.budget.spentCost) parts.push(`$${record.budget.spentCost.toFixed(4)}`);
	// A live run's clock keeps going between events; a finished one stops at its last update.
	parts.push(formatCompactDuration(Math.max(0, (state === "run" ? now : record.updatedAt) - record.createdAt)));
	if (state === "err" && record.error) parts.push(record.error.split("\n")[0].slice(0, 120));
	return parts.join(" · ");
}

const MAX_RESULT_CHARS = 20_000;

/** The value a finished script returned, as text the tree can show; cut long values visibly. */
export function workflowResultText(record: WorkflowRecord): string | undefined {
	if (record.status !== "completed" || record.result === undefined || record.result === null) return undefined;
	let text: string;
	try {
		text = typeof record.result === "string" ? record.result : JSON.stringify(record.result, null, 2) ?? "";
	} catch {
		text = String(record.result);
	}
	if (!text.trim()) return undefined;
	return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… 已截断，共 ${text.length} 字符` : text;
}

/** Phase titles a script declares, read statically so the approval card can show the plan. */
export function plannedPhases(script: string): string[] {
	const names: string[] = [];
	for (const match of script.matchAll(/\bphase\(\s*(['"`])([^'"`\n]{1,60})\1/g)) {
		const name = match[2].trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names.slice(0, 12);
}
