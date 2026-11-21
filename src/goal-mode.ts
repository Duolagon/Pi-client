/**
 * /goal autonomous continuation mode.
 *
 * Keeps a conversation progressing toward an explicit objective across multiple turns
 * until the assistant emits `<goal-achieved/>`, or until a turn cap, cost cap, or user
 * stop halts it.
 */

export interface GoalState {
	objective: string;
	maxTurns: number;
	turnsUsed: number;
	maxCostUsd?: number;
	active: boolean;
	status: "running" | "achieved" | "stopped" | "max_turns" | "max_cost";
	startedAt: number;
	finishedAt?: number;
	stopReason?: string;
}

export const DEFAULT_GOAL_MAX_TURNS = 8;
export const MAX_GOAL_TURNS = 50;
export const GOAL_COMPLETE_MARKER = "<goal-achieved/>";

export type ParsedGoalCommand =
	| { action: "status" }
	| { action: "stop" }
	| { action: "start"; objective: string; maxTurns: number; maxCostUsd?: number };

export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
	const trimmed = rawArgs.trim();
	if (!trimmed) return { action: "status" };
	if (/^(?:stop|off|cancel|end|停止)$/i.test(trimmed)) return { action: "stop" };

	let rest = trimmed;
	let maxTurns = DEFAULT_GOAL_MAX_TURNS;
	let maxCostUsd: number | undefined;

	// Extract --max-turns / -n and --max-cost / -c flags anywhere in the arguments.
	rest = rest.replace(/(?:^|\s)(?:--max-turns|-n)(?:=|\s+)(\d+)(?=\s|$)/gi, (_m, val: string) => {
		const parsed = Number(val);
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_GOAL_TURNS) {
			throw new Error(`--max-turns 需为 1–${MAX_GOAL_TURNS} 的整数。`);
		}
		maxTurns = parsed;
		return " ";
	});
	rest = rest.replace(/(?:^|\s)(?:--max-cost|-c)(?:=|\s+)(\d+(?:\.\d+)?)(?=\s|$)/gi, (_m, val: string) => {
		const parsed = Number(val);
		if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 100000) {
			throw new Error("--max-cost 需为 0.01–100000 之间的美元数额。");
		}
		maxCostUsd = parsed;
		return " ";
	});

	const objective = rest.trim();
	if (!objective) {
		throw new Error("请提供目标描述，例如：/goal --max-turns 8 修复所有单元测试并通过类型检查");
	}
	return { action: "start", objective: objective.slice(0, 4000), maxTurns, maxCostUsd };
}

export function isGoalAchieved(assistantText: string): boolean {
	if (!assistantText) return false;
	return /(?:<goal-achieved\s*\/?>|<goal-complete\s*\/?>|\[GOAL_ACHIEVED\])/i.test(assistantText);
}

export function buildGoalInitialPrompt(goal: GoalState): string {
	const budgetParts = [`最多 ${goal.maxTurns} 轮`];
	if (goal.maxCostUsd !== undefined) budgetParts.push(`费用上限 $${goal.maxCostUsd}`);
	return [
		`[目标模式已启动（${budgetParts.join("，")}）]`,
		`目标：${goal.objective}`,
		"",
		"请逐步推进并验证结果。只有在目标完全达成且验证通过后，才在回复末尾单独输出 `<goal-achieved/>`；如果本轮尚未完成，说明当前进展与下一步计划，系统会自动继续下一轮。",
	].join("\n");
}

export function buildGoalContinuePrompt(goal: GoalState): string {
	const remaining = Math.max(0, goal.maxTurns - goal.turnsUsed);
	return [
		`[目标模式自动继续 · 第 ${goal.turnsUsed + 1}/${goal.maxTurns} 轮，剩余 ${remaining} 轮]`,
		`当前目标尚未标记完成：${goal.objective}`,
		"请基于已有进展继续执行并验证；完成后在回复末尾单独输出 `<goal-achieved/>`。",
	].join("\n");
}

export function evaluateGoalContinuation(
	goal: GoalState,
	assistantText: string,
	spentUsd: number,
	now = Date.now(),
): { next: GoalState; shouldContinue: boolean; continuePrompt?: string } {
	if (!goal.active) {
		return { next: goal, shouldContinue: false };
	}
	const turnsUsed = goal.turnsUsed + 1;
	if (isGoalAchieved(assistantText)) {
		return {
			next: {
				...goal,
				turnsUsed,
				active: false,
				status: "achieved",
				finishedAt: now,
				stopReason: `目标已完成（共 ${turnsUsed} 轮）。`,
			},
			shouldContinue: false,
		};
	}
	if (goal.maxCostUsd !== undefined && Number.isFinite(spentUsd) && spentUsd >= goal.maxCostUsd) {
		return {
			next: {
				...goal,
				turnsUsed,
				active: false,
				status: "max_cost",
				finishedAt: now,
				stopReason: `已达到目标费用上限（$${spentUsd.toFixed(2)} / $${goal.maxCostUsd.toFixed(2)}），已停止自动继续。`,
			},
			shouldContinue: false,
		};
	}
	if (turnsUsed >= goal.maxTurns) {
		return {
			next: {
				...goal,
				turnsUsed,
				active: false,
				status: "max_turns",
				finishedAt: now,
				stopReason: `已达到目标轮数上限（${turnsUsed}/${goal.maxTurns} 轮），已停止自动继续。`,
			},
			shouldContinue: false,
		};
	}
	const next: GoalState = {
		...goal,
		turnsUsed,
		active: true,
		status: "running",
	};
	return {
		next,
		shouldContinue: true,
		continuePrompt: buildGoalContinuePrompt(next),
	};
}
