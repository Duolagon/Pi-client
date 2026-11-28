import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopTask, ExternalTask, TaskProgress } from "../src/shared.ts";
import { agentGroupTitle, agentRowMetrics, agentRowStatusLine, backgroundWork, formatActivity, liveDurationMs } from "../src/renderer/agent-row.ts";

function task(patch: Partial<DesktopTask> = {}): DesktopTask {
	return {
		id: "t1", conversationId: "child", project: "/p", workingDirectory: "/p", title: "audit", prompt: "audit",
		status: "running", createdAt: 1_000, updatedAt: 1_000, revision: 1, parentConversationId: "parent", turn: 1,
		...patch,
	} as DesktopTask;
}

function progress(patch: Partial<TaskProgress> = {}): TaskProgress {
	return {
		taskId: "t1", status: "running", turn: 1, toolUses: 0, cost: 0, startedAt: 1_000, durationMs: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, recentActivities: [],
		...patch,
	};
}

test("the latest child tool call is shown the way Claude Code prints it", () => {
	assert.equal(formatActivity({ toolName: "read", summary: "src/a.ts", startedAt: 0 }), "Read(src/a.ts)");
	assert.equal(formatActivity({ toolName: "find", summary: "**/*.ts", startedAt: 0 }), "Glob(**/*.ts)");
	assert.equal(formatActivity({ toolName: "WebSearch", startedAt: 0 }), "WebSearch");
	const running = progress({ recentActivities: [{ toolName: "bash", summary: "npm test", startedAt: 0 }, { toolName: "grep", summary: "TODO", startedAt: 1 }] });
	assert.equal(agentRowStatusLine(task(), running), "Grep(TODO)");
	assert.equal(agentRowStatusLine(task(), progress()), "启动中…");
	assert.equal(agentRowStatusLine(task({ runInBackground: true }), progress()), "在后台运行，完成后结果自动回传");
	assert.equal(agentRowStatusLine(task({ status: "queued" }), undefined), "排队中，等待空闲名额…");
	assert.equal(agentRowStatusLine(task(), progress({ waitingForApproval: true })), "等待你审批…");
});

test("finished rows say how they ended", () => {
	assert.equal(agentRowStatusLine(task({ status: "completed" }), undefined), "完成");
	assert.equal(agentRowStatusLine(task({ status: "completed", stopReason: "max_turns" }), undefined), "完成 · 达轮次上限");
	assert.equal(agentRowStatusLine(task({ status: "failed", error: "boom\nstack" }), undefined), "失败 · boom");
	assert.equal(agentRowStatusLine(task({ status: "cancelled" }), undefined), "已停止");
});

test("running metrics tick from the start time; finished metrics use recorded stats", () => {
	const live = progress({ toolUses: 3, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 18_200 }, durationMs: 2_000 });
	assert.equal(liveDurationMs(task(), live, 65_000), 64_000, "ticks past the last throttled event");
	assert.equal(agentRowMetrics(task(), live, 65_000), "3 次工具 · 18.2k tokens · 1m4s");
	const done = task({
		status: "completed",
		stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 900 }, cost: 0, toolUses: 2, startedAt: 0, durationMs: 8_000 },
	});
	assert.equal(agentRowMetrics(done, undefined, 99_000), "2 次工具 · 900 tokens · 8s");
});

test("a fan-out header counts running and failed agents from each row's state", () => {
	assert.equal(agentGroupTitle(["run", "run"]), "2 个 Agent 运行中");
	assert.equal(agentGroupTitle(["run", "ok", "ok"]), "3 个 Agent 运行中（2 个已结束）");
	assert.equal(agentGroupTitle(["ok", "err"]), "2 个 Agent 已结束 · 1 个失败", "a call rejected before it got a task does not keep the group running");
	assert.equal(agentGroupTitle(["ok", "ok"]), "2 个 Agent 完成");
});

test("a resumed child times its current run, not its whole life", () => {
	const resumed = task({ turn: 2, createdAt: 0, updatedAt: 500_000, statsAtTurnStart: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, toolCalls: 0, startedAt: 600_000 } });
	assert.equal(liveDurationMs(resumed, undefined, 610_000), 10_000, "uses the run baseline before any progress arrives");
	assert.equal(liveDurationMs(resumed, progress({ turn: 1, startedAt: 0, durationMs: 99_000 }), 610_000), 10_000, "ignores progress left over from turn 1");
	assert.equal(liveDurationMs(task({ turn: 3, createdAt: 0, updatedAt: 700_000 }), undefined, 705_000), 5_000, "falls back to the last update for a queued resumed turn");
	const external = { id: "x", executor: "codex", parentConversationId: "parent", status: "completed", createdAt: 0, updatedAt: 900_000, turn: 2, output: "" } as unknown as ExternalTask;
	assert.equal(agentRowMetrics(external, undefined, 0), "0s", "a finished resumed external task does not span every turn");
});

test("an external executor shows its latest output line while it runs", () => {
	const external = { id: "x", executor: "codex", parentConversationId: "parent", status: "running", createdAt: 0, updatedAt: 0, turn: 1, output: "reading files\nrunning npm test\n" } as unknown as ExternalTask;
	assert.equal(agentRowStatusLine(external, undefined), "running npm test");
	assert.equal(agentRowStatusLine({ ...external, output: "" } as ExternalTask, undefined), "codex 运行中…");
});

test("the footer counts background agents and each workflow once, never foreground or other conversations", () => {
	const tasks = [
		task({ id: "a", runInBackground: true }),
		task({ id: "b", runInBackground: false }),
		task({ id: "c", runInBackground: true, status: "completed" }),
		task({ id: "d", workflowId: "wf1", runInBackground: true }),
		task({ id: "e", workflowId: "wf1", runInBackground: true }),
		task({ id: "f", workflowId: "wf2", runInBackground: true, status: "queued" }),
		task({ id: "g", runInBackground: true, parentConversationId: "other" }),
	];
	const external = [
		{ id: "x", parentConversationId: "parent", status: "running", createdAt: 0, updatedAt: 0, runInBackground: true },
		{ id: "y", parentConversationId: "parent", status: "running", createdAt: 0, updatedAt: 0, runInBackground: false },
	] as unknown as ExternalTask[];
	assert.deepEqual(backgroundWork(tasks, external, "parent"), { agents: 2, workflows: 2 }, "a foreground external agent is not background work");
	assert.deepEqual(backgroundWork(tasks, external, undefined), { agents: 0, workflows: 0 });
});
