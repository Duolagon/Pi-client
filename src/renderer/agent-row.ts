import { formatCompactDuration, formatCompactTokens } from "../delegation-format.ts";
import type { DesktopTask, ExternalTask, TaskProgress, TaskProgressActivity } from "../shared.ts";

/** Tool names a child reports, shown the way Claude Code prints them: `Read(src/a.ts)`. */
const TOOL_LABEL: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

export function formatActivity(activity: TaskProgressActivity | undefined): string | undefined {
	if (!activity) return undefined;
	const label = TOOL_LABEL[activity.toolName] ?? activity.toolName;
	return activity.summary ? `${label}(${activity.summary})` : label;
}

export function isActiveTask(task: DesktopTask | ExternalTask): boolean {
	return task.status === "queued" || task.status === "running" || task.status === "waiting_for_input";
}

/**
 * Start of the child's current run. A resumed child keeps its first createdAt, so prefer the live
 * progress start, then the run baseline, then the last update (when a queued turn began).
 */
function runStartedAt(task: DesktopTask | ExternalTask, progress: TaskProgress | undefined): number {
	if (progress && progress.turn === ("turn" in task ? task.turn ?? 1 : 1)) return progress.startedAt;
	if ("statsAtTurnStart" in task && task.statsAtTurnStart) return task.statsAtTurnStart.startedAt;
	return (task.turn ?? 1) > 1 ? task.updatedAt : task.createdAt;
}

/** Elapsed time of a running child, ticking from its run's start rather than the last progress event. */
export function liveDurationMs(task: DesktopTask | ExternalTask, progress: TaskProgress | undefined, now: number): number {
	const current = progress && progress.turn === ("turn" in task ? task.turn ?? 1 : 1) ? progress : undefined;
	return Math.max(current?.durationMs ?? 0, now - runStartedAt(task, progress));
}

/** Duration of a finished child's last run. */
function finishedDurationMs(task: DesktopTask | ExternalTask): number {
	if ("stats" in task && task.stats?.durationMs !== undefined) return task.stats.durationMs;
	return Math.max(0, task.updatedAt - runStartedAt(task, undefined));
}

/**
 * Right-hand metrics of an Agent row: `12 次工具 · 18.2k tokens · 1m4s`. Running rows tick every
 * second; finished rows use the recorded stats.
 */
export function agentRowMetrics(task: DesktopTask | ExternalTask, progress: TaskProgress | undefined, now: number): string {
	const parts: string[] = [];
	if (isActiveTask(task)) {
		if (progress?.toolUses) parts.push(`${progress.toolUses} 次工具`);
		if (progress?.tokens.total) parts.push(`${formatCompactTokens(progress.tokens.total)} tokens`);
		parts.push(formatCompactDuration(liveDurationMs(task, progress, now)));
		return parts.join(" · ");
	}
	if (!("executor" in task)) {
		if (task.stats?.toolUses) parts.push(`${task.stats.toolUses} 次工具`);
		if (task.stats?.tokens.total) parts.push(`${formatCompactTokens(task.stats.tokens.total)} tokens`);
	}
	parts.push(formatCompactDuration(finishedDurationMs(task)));
	return parts.join(" · ");
}

const STOP_LABEL: Record<string, string> = {
	max_turns: "达轮次上限",
	user_stop: "已手动停止",
	parent_abort: "主会话中止",
	restart: "重启中断",
	error: "执行出错",
};

/**
 * The line under an Agent row (after `⎿`). While running it is the child's latest tool call; when
 * done it is a status word, like Claude Code's `Done` line.
 */
export function agentRowStatusLine(task: DesktopTask | ExternalTask, progress: TaskProgress | undefined): string {
	if (task.status === "waiting_for_input" || progress?.waitingForApproval) return "等待你审批…";
	if (task.status === "queued") return "排队中，等待空闲名额…";
	if (isActiveTask(task)) {
		const latest = "executor" in task ? lastLine(task.output) : formatActivity(progress?.recentActivities.at(-1));
		if (latest) return latest;
		if (task.runInBackground) return "在后台运行，完成后结果自动回传";
		return task.status === "running" && "executor" in task ? `${task.executor} 运行中…` : "启动中…";
	}
	if (task.status === "completed") {
		const stop = "stopReason" in task && task.stopReason && task.stopReason !== "model_stop" ? STOP_LABEL[task.stopReason] : undefined;
		return stop ? `完成 · ${stop}` : "完成";
	}
	if (task.status === "cancelled") return "已停止";
	if (task.status === "interrupted") return "已中断";
	const error = "error" in task && typeof task.error === "string" ? task.error.split("\n")[0].slice(0, 140) : "";
	return error ? `失败 · ${error}` : "失败";
}

function lastLine(text: string | undefined): string | undefined {
	const line = text?.trimEnd().split("\n").at(-1)?.trim();
	return line ? line.slice(0, 160) : undefined;
}

export type AgentRowState = "run" | "ok" | "err";

/** Header text of a group of agents launched from one message: `3 个 Agent 运行中`, `3 个 Agent 完成`. */
export function agentGroupTitle(states: AgentRowState[]): string {
	const count = states.length;
	const running = states.filter((state) => state === "run").length;
	const failed = states.filter((state) => state === "err").length;
	if (running > 0) return `${count} 个 Agent 运行中${running < count ? `（${count - running} 个已结束）` : ""}`;
	if (failed > 0) return `${count} 个 Agent 已结束 · ${failed} 个失败`;
	return `${count} 个 Agent 完成`;
}

/** Background children of one conversation that are still working; workflow steps count once per workflow. */
export function backgroundWork(
	tasks: DesktopTask[],
	externalTasks: ExternalTask[],
	conversationId: string | undefined,
): { agents: number; workflows: number } {
	if (!conversationId) return { agents: 0, workflows: 0 };
	const workflows = new Set<string>();
	let agents = 0;
	for (const task of tasks) {
		if (task.parentConversationId !== conversationId || !isActiveTask(task)) continue;
		if (task.workflowId) workflows.add(task.workflowId);
		else if (task.runInBackground) agents++;
	}
	for (const task of externalTasks)
		if (task.parentConversationId === conversationId && task.runInBackground && isActiveTask(task)) agents++;
	return { agents, workflows: workflows.size };
}
