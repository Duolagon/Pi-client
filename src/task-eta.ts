/**
 * Pure duration formatting and ETA estimation helpers for checklists, background shells/monitors,
 * and running foreground tools. Kept dependency-free so renderer components and Node tests share it.
 */

export interface TimedTodoLike {
	id: string;
	status: "pending" | "in_progress" | "completed" | string;
	estimatedSeconds?: number;
	startedAt?: number;
	completedAt?: number;
}

export interface TodoTiming {
	label?: string;
	elapsedMs?: number;
	estimatedMs?: number;
	actualMs?: number;
	overdue: boolean;
}

export interface ChecklistEta {
	remainingMs?: number;
	approximate: boolean;
	anyOverdue: boolean;
	activeElapsedMs?: number;
	summaryLabel?: string;
}

export interface MonitorTiming {
	elapsedMs: number;
	idleMs: number;
	stale: boolean;
	elapsedLabel: string;
	activityLabel?: string;
	timeoutLabel?: string;
}

/** Compact human-readable duration, e.g. `12s`, `3m 20s`, `1h 15m`. */
export function formatDurationBrief(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Compact digital stopwatch for active timers, e.g. `00:45`, `04:12`, `1:15:02`. */
export function formatDurationClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compute per-item elapsed/ETA label for a checklist item. */
export function computeTodoTiming(item: TimedTodoLike, now: number, isRunning = true): TodoTiming {
	const estimatedMs =
		typeof item.estimatedSeconds === "number" && Number.isFinite(item.estimatedSeconds) && item.estimatedSeconds > 0
			? item.estimatedSeconds * 1000
			: undefined;

	if (item.status === "completed") {
		const actualMs =
			typeof item.startedAt === "number" &&
			typeof item.completedAt === "number" &&
			item.startedAt > 0 &&
			item.completedAt >= item.startedAt
				? item.completedAt - item.startedAt
				: undefined;
		return {
			actualMs,
			estimatedMs,
			overdue: false,
			label: actualMs !== undefined ? `用时 ${formatDurationBrief(actualMs)}` : undefined,
		};
	}

	if (item.status === "in_progress") {
		if (!isRunning) {
			return {
				estimatedMs,
				overdue: false,
				label: estimatedMs !== undefined ? `已暂停 · 预计 ~${formatDurationBrief(estimatedMs)}` : "已暂停",
			};
		}
		const elapsedMs = typeof item.startedAt === "number" && item.startedAt > 0 ? Math.max(0, now - item.startedAt) : undefined;
		const overdue = elapsedMs !== undefined && estimatedMs !== undefined && elapsedMs > estimatedMs;
		let label: string | undefined;
		if (elapsedMs !== undefined && estimatedMs !== undefined) {
			label = overdue
				? `已跑 ${formatDurationClock(elapsedMs)} · 超出预计 ${formatDurationBrief(estimatedMs)}`
				: `已跑 ${formatDurationClock(elapsedMs)} / 预计 ~${formatDurationBrief(estimatedMs)}`;
		} else if (elapsedMs !== undefined) {
			label = `已跑 ${formatDurationClock(elapsedMs)}`;
		} else if (estimatedMs !== undefined) {
			label = `预计 ~${formatDurationBrief(estimatedMs)}`;
		}
		return { elapsedMs, estimatedMs, overdue, label };
	}

	return {
		estimatedMs,
		overdue: false,
		label: estimatedMs !== undefined ? `预计 ~${formatDurationBrief(estimatedMs)}` : undefined,
	};
}

/**
 * Compute aggregate remaining ETA for an entire checklist.
 * Uses explicit `estimatedSeconds` when present, and softly extrapolates missing items from the
 * average actual duration of completed items (marking `approximate: true` so users know it's rough).
 */
export function computeChecklistEta(items: readonly TimedTodoLike[], now: number, isRunning = true): ChecklistEta {
	const completedDurations: number[] = [];
	let activeElapsedMs: number | undefined;
	for (const item of items) {
		if (item.status === "completed" && item.startedAt && item.completedAt && item.completedAt >= item.startedAt) {
			completedDurations.push(item.completedAt - item.startedAt);
		}
		if (isRunning && item.status === "in_progress" && item.startedAt && activeElapsedMs === undefined) {
			activeElapsedMs = Math.max(0, now - item.startedAt);
		}
	}
	const avgCompletedMs =
		completedDurations.length > 0
			? completedDurations.reduce((sum, d) => sum + d, 0) / completedDurations.length
			: undefined;

	const openItems = items.filter((item) => item.status !== "completed" && item.status !== "deleted");
	if (openItems.length === 0) return { approximate: false, anyOverdue: false };

	let totalRemainingMs = 0;
	let hasEstimate = false;
	let approximate = false;
	let anyOverdue = false;

	for (const item of openItems) {
		const estMs =
			typeof item.estimatedSeconds === "number" && Number.isFinite(item.estimatedSeconds) && item.estimatedSeconds > 0
				? item.estimatedSeconds * 1000
				: undefined;
		const elapsedMs =
			isRunning && item.status === "in_progress" && typeof item.startedAt === "number" && item.startedAt > 0
				? Math.max(0, now - item.startedAt)
				: 0;

		if (estMs !== undefined) {
			hasEstimate = true;
			if (isRunning && item.status === "in_progress" && elapsedMs > estMs) anyOverdue = true;
			totalRemainingMs += Math.max(0, estMs - elapsedMs);
		} else if (avgCompletedMs !== undefined) {
			hasEstimate = true;
			approximate = true;
			totalRemainingMs += Math.max(0, avgCompletedMs - elapsedMs);
		} else {
			approximate = true;
		}
	}

	if (!hasEstimate) {
		return {
			approximate: false,
			anyOverdue: false,
			activeElapsedMs,
			summaryLabel: activeElapsedMs !== undefined ? `当前已跑 ${formatDurationClock(activeElapsedMs)}` : undefined,
		};
	}

	let summaryLabel: string | undefined;
	if (totalRemainingMs <= 0) {
		summaryLabel = anyOverdue ? "已超预计" : undefined;
	} else if (approximate) {
		summaryLabel = `约剩 ~${formatDurationBrief(totalRemainingMs)}`;
	} else {
		summaryLabel = `预计剩余 ~${formatDurationBrief(totalRemainingMs)}`;
	}

	return {
		remainingMs: totalRemainingMs,
		approximate,
		anyOverdue,
		activeElapsedMs,
		summaryLabel,
	};
}

/**
 * Determine whether a checklist from an earlier turn is stale/abandoned and should stay hidden
 * (even when a new turn starts running) until the model creates or updates a fresh checklist.
 */
export function isChecklistStale(opts: {
	isRunning: boolean;
	completedUserTurnsAfterLastUpdate: number;
	userTurnsAfterLastUpdate: number;
	allCompleted: boolean;
	staleAgeMs?: number;
}): boolean {
	if (opts.allCompleted) return true;
	// Once at least one subsequent user turn has already completed without updating this checklist,
	// the checklist is abandoned and must never resurrect on future turns.
	if (opts.completedUserTurnsAfterLastUpdate >= 1) return true;
	// If idle and any subsequent user message already exists, hide immediately.
	if (!opts.isRunning && opts.userTurnsAfterLastUpdate >= 1) return true;
	// If a new user turn started hours after the last update, do not resurrect an ancient checklist.
	if (opts.userTurnsAfterLastUpdate >= 1 && typeof opts.staleAgeMs === "number" && opts.staleAgeMs > 2 * 60 * 60 * 1000) {
		return true;
	}
	return false;
}

/** Compute live elapsed + silence/activity status for a background shell or monitor. */
export function computeMonitorTiming(
	mon: { status: string; createdAt?: number; updatedAt?: number; timeoutMs?: number },
	now: number,
): MonitorTiming {
	const createdAt = typeof mon.createdAt === "number" && mon.createdAt > 0 ? mon.createdAt : now;
	const updatedAt = typeof mon.updatedAt === "number" && mon.updatedAt > 0 ? mon.updatedAt : createdAt;
	const isRunning = mon.status === "running";
	const endTime = isRunning ? now : updatedAt;
	const elapsedMs = Math.max(0, endTime - createdAt);
	const idleMs = isRunning ? Math.max(0, now - updatedAt) : 0;
	const stale = isRunning && idleMs >= 120_000;

	const elapsedLabel = isRunning ? `已运行 ${formatDurationBrief(elapsedMs)}` : `用时 ${formatDurationBrief(elapsedMs)}`;
	const activityLabel = isRunning
		? stale
			? `静默 ${formatDurationBrief(idleMs)}`
			: idleMs < 5000
				? "刚刚有输出"
				: `${formatDurationBrief(idleMs)} 前有输出`
		: undefined;
	const timeoutLabel =
		isRunning && typeof mon.timeoutMs === "number" && mon.timeoutMs > 0 && mon.timeoutMs < 24 * 60 * 60 * 1000
			? `上限 ${formatDurationBrief(mon.timeoutMs)}`
			: undefined;

	return { elapsedMs, idleMs, stale, elapsedLabel, activityLabel, timeoutLabel };
}

/** Format a live running foreground tool timer badge (e.g. `已运行 01:42` or `已运行 01:42 / 上限 5m`). */
export function formatRunningToolTimer(startedAt: number | undefined, timeoutSeconds: number | undefined, now: number): string | undefined {
	if (typeof startedAt !== "number" || startedAt <= 0) return undefined;
	const elapsedMs = Math.max(0, now - startedAt);
	const clock = formatDurationClock(elapsedMs);
	if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
		return `已运行 ${clock} / 上限 ${formatDurationBrief(timeoutSeconds * 1000)}`;
	}
	return `已运行 ${clock}`;
}
