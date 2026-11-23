import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	computeChecklistEta,
	computeMonitorTiming,
	computeTodoTiming,
	formatDurationBrief,
	formatDurationClock,
	formatRunningToolTimer,
	isChecklistStale,
} from "../src/task-eta.ts";
import { TodoService } from "../src/todo-service.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("duration formatters produce compact readable strings", () => {
	assert.equal(formatDurationBrief(0), "0s");
	assert.equal(formatDurationBrief(45_000), "45s");
	assert.equal(formatDurationBrief(200_000), "3m 20s");
	assert.equal(formatDurationBrief(4_500_000), "1h 15m");
	assert.equal(formatDurationClock(45_000), "00:45");
	assert.equal(formatDurationClock(252_000), "04:12");
	assert.equal(formatDurationClock(4_502_000), "1:15:02");
});

test("computeTodoTiming handles pending, in_progress, overdue, and completed states", () => {
	const now = 2_000_000;
	const pending = computeTodoTiming({ id: "1", status: "pending", estimatedSeconds: 600 }, now);
	assert.equal(pending.label, "预计 ~10m");
	assert.equal(pending.overdue, false);

	const running = computeTodoTiming({ id: "2", status: "in_progress", startedAt: now - 125_000, estimatedSeconds: 900 }, now);
	assert.equal(running.label, "已跑 02:05 / 预计 ~15m");
	assert.equal(running.overdue, false);

	const overdue = computeTodoTiming({ id: "3", status: "in_progress", startedAt: now - 1_110_000, estimatedSeconds: 900 }, now);
	assert.equal(overdue.label, "已跑 18:30 · 超出预计 15m");
	assert.equal(overdue.overdue, true);

	const done = computeTodoTiming({ id: "4", status: "completed", startedAt: now - 200_000, completedAt: now }, now);
	assert.equal(done.label, "用时 3m 20s");
});

test("computeChecklistEta sums explicit estimates and extrapolates missing items from completed average", () => {
	const now = 10_000_000;
	const explicit = computeChecklistEta(
		[
			{ id: "1", status: "in_progress", startedAt: now - 60_000, estimatedSeconds: 300 }, // 4m left
			{ id: "2", status: "pending", estimatedSeconds: 600 }, // 10m left
		],
		now,
	);
	assert.equal(explicit.approximate, false);
	assert.equal(explicit.summaryLabel, "预计剩余 ~14m");

	const extrapolated = computeChecklistEta(
		[
			{ id: "1", status: "completed", startedAt: now - 120_000, completedAt: now }, // 2m actual
			{ id: "2", status: "pending" }, // extrapolated 2m
			{ id: "3", status: "pending" }, // extrapolated 2m
		],
		now,
	);
	assert.equal(extrapolated.approximate, true);
	assert.equal(extrapolated.summaryLabel, "约剩 ~4m");

	// Never show misleading "约剩 ~0s" when an item runs longer than the completed average
	const zeroRemaining = computeChecklistEta(
		[
			{ id: "1", status: "completed", startedAt: now - 60_000, completedAt: now }, // 1m avg
			{ id: "2", status: "in_progress", startedAt: now - 3_600_000 }, // 1h elapsed
		],
		now,
	);
	assert.equal(zeroRemaining.summaryLabel, undefined);

	// Idle session must show "已暂停" instead of an endlessly ticking 21-hour stopwatch
	const paused = computeTodoTiming({ id: "2", status: "in_progress", startedAt: now - 3_600_000 }, now, false);
	assert.equal(paused.label, "已暂停");

	// Stale checklist from earlier turns must stay hidden even when a brand-new turn starts running
	assert.equal(
		isChecklistStale({ isRunning: true, completedUserTurnsAfterLastUpdate: 1, userTurnsAfterLastUpdate: 2, allCompleted: false }),
		true,
	);
	assert.equal(
		isChecklistStale({ isRunning: false, completedUserTurnsAfterLastUpdate: 1, userTurnsAfterLastUpdate: 1, allCompleted: false }),
		true,
	);
	// Immediate follow-up turn (within 2h, 0 prior completed turns after update) stays visible while running
	assert.equal(
		isChecklistStale({ isRunning: true, completedUserTurnsAfterLastUpdate: 0, userTurnsAfterLastUpdate: 1, allCompleted: false, staleAgeMs: 60_000 }),
		false,
	);
	// Ancient checklist (>2h old) does not resurrect on a new turn
	assert.equal(
		isChecklistStale({ isRunning: true, completedUserTurnsAfterLastUpdate: 0, userTurnsAfterLastUpdate: 1, allCompleted: false, staleAgeMs: 3 * 3600 * 1000 }),
		true,
	);
	assert.equal(
		isChecklistStale({ isRunning: true, completedUserTurnsAfterLastUpdate: 0, userTurnsAfterLastUpdate: 0, allCompleted: true }),
		true,
	);
});

test("computeMonitorTiming detects silence/stale status and timeout ceiling", () => {
	const now = 2_000_000;
	const active = computeMonitorTiming({ status: "running", createdAt: now - 180_000, updatedAt: now - 10_000, timeoutMs: 900_000 }, now);
	assert.equal(active.stale, false);
	assert.equal(active.elapsedLabel, "已运行 3m");
	assert.equal(active.activityLabel, "10s 前有输出");
	assert.equal(active.timeoutLabel, "上限 15m");

	const stale = computeMonitorTiming({ status: "running", createdAt: now - 300_000, updatedAt: now - 150_000 }, now);
	assert.equal(stale.stale, true);
	assert.equal(stale.activityLabel, "静默 2m 30s");

	assert.equal(formatRunningToolTimer(now - 102_000, 300, now), "已运行 01:42 / 上限 5m");
});

test("TodoService persists estimatedSeconds and auto-stamps startedAt/completedAt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-todo-eta-"));
	try {
		validateDesktopToolInput("TodoCreate", { subject: "Run eval", description: "AB eval", estimatedSeconds: 900 });
		assert.throws(() => validateDesktopToolInput("TodoCreate", { subject: "Bad", description: "Bad", estimatedSeconds: 0 }), /estimatedSeconds/);

		const svc = new TodoService({ dataDir: () => dir });
		const created = await svc.create("conv-1", { subject: "Run eval", description: "AB eval", estimatedSeconds: 900 });
		assert.equal(created.estimatedSeconds, 900);
		assert.equal(created.startedAt, undefined);

		const started = await svc.update("conv-1", { id: created.id, status: "in_progress" });
		assert.ok(typeof started.startedAt === "number" && started.startedAt > 0);
		assert.equal(started.completedAt, undefined);

		const completed = await svc.update("conv-1", { id: created.id, status: "completed", estimatedSeconds: 1200 });
		assert.equal(completed.estimatedSeconds, 1200);
		assert.ok(typeof completed.completedAt === "number" && completed.completedAt >= (started.startedAt ?? 0));

		const reloaded = await svc.get("conv-1", { id: created.id });
		assert.equal(reloaded?.estimatedSeconds, 1200);
		assert.equal(reloaded?.startedAt, started.startedAt);
		assert.equal(reloaded?.completedAt, completed.completedAt);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
