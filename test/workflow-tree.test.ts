import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseOfStepKey } from "../src/workflow-service.ts";
import type { WorkflowRecord, WorkflowStepRecord } from "../src/workflow-types.ts";
import { plannedPhases, stepMetrics, workflowResultText, workflowSummary, workflowTree } from "../src/renderer/workflow-tree.ts";

function step(patch: Partial<WorkflowStepRecord> & { stepKey: string }): WorkflowStepRecord {
	return { label: patch.stepKey, status: "completed", startedAt: 0, ...patch };
}

function record(patch: Partial<WorkflowRecord> = {}): WorkflowRecord {
	return {
		id: "wf_1", conversationId: "c", rootConversationId: "c", project: "/p", title: "审查改动", script: "",
		status: "running", budget: { spentCost: 0, spentTokens: 0, spawnedAgents: 0 },
		phases: [], logs: [], journal: {}, steps: {}, createdAt: 0, updatedAt: 0,
		...patch,
	};
}

test("a step's phase comes from its key, and the innermost phase wins", () => {
	assert.equal(phaseOfStepKey("root#0"), undefined);
	assert.equal(phaseOfStepKey("root/phase:Review#0/par#0[1]"), "Review");
	assert.equal(phaseOfStepKey("root/phase:Review#0/phase:Verify#1#0"), "Verify");
	assert.equal(phaseOfStepKey("root/par#0[0]#1"), undefined);
});

test("the tree groups steps by phase, keeps the record's phase order and puts loose steps last", () => {
	const value = record({
		phases: [
			{ name: "Review", status: "completed", startedAt: 0 },
			{ name: "Verify", status: "running", startedAt: 1 },
		],
		steps: {
			a: step({ stepKey: "a", label: "审查 csv", phase: "Review", startedAt: 10, completedAt: 20 }),
			loose: step({ stepKey: "loose", label: "汇总", startedAt: 5 }),
			b: step({ stepKey: "b", label: "复核 csv", phase: "Verify", status: "running", startedAt: 30 }),
		},
	});
	const tree = workflowTree(value);
	assert.deepEqual(tree.map((group) => group.name), ["Review", "Verify", undefined]);
	assert.deepEqual(tree.map((group) => group.state), ["ok", "run", "ok"]);
	assert.deepEqual(tree[0].steps.map((item) => item.label), ["审查 csv"]);
	// A phase whose first step has not been recorded yet still gets a row.
	const pending = workflowTree(record({ phases: [{ name: "Find", status: "running", startedAt: 0 }] }));
	assert.deepEqual(pending.map((group) => [group.name, group.state, group.steps.length]), [["Find", "run", 0]]);
	// A record written before per-step rows existed renders without throwing.
	assert.deepEqual(workflowTree({ ...record(), steps: undefined as never }), []);
});

test("a failed step turns its phase red; metrics tick while a step runs", () => {
	const value = record({
		steps: {
			a: step({ stepKey: "a", phase: "Find", status: "failed", startedAt: 0, completedAt: 5_000, error: "boom" }),
			b: step({ stepKey: "b", phase: "Find", startedAt: 0, completedAt: 1_000 }),
		},
	});
	assert.equal(workflowTree(value)[0].state, "err");
	assert.equal(stepMetrics(step({ stepKey: "a", status: "running", startedAt: 1_000 }), 9_000), "8s");
	assert.equal(stepMetrics(step({ stepKey: "a", startedAt: 0, completedAt: 4_000, usage: { totalTokens: 1_200, cost: 0.01 } }), 0), "1.2k tokens · 4s");
	assert.equal(stepMetrics(step({ stepKey: "a", status: "replayed", startedAt: 0, completedAt: 0 }), 0), "已复用");
});

test("the one-line summary reports the run's outcome and spend", () => {
	assert.match(workflowSummary(record()), /^运行中/);
	assert.match(workflowSummary(record({ status: "waiting_for_approval" })), /^等待审批/);
	assert.equal(
		workflowSummary(record({ status: "completed", updatedAt: 184_000, budget: { spentCost: 0.2134, spentTokens: 48_100, spawnedAgents: 12 } })),
		"完成 · 12 个 Agent · 48.1k tokens · $0.2134 · 3m4s",
	);
	assert.match(workflowSummary(record({ status: "failed", error: "Workflow cost budget exceeded\nmore" })), /失败 .*cost budget exceeded$/);
});

test("the approval card reads the planned phases out of the script", () => {
	const script = `phase('Review')\nawait agent('x')\nphase("Verify")\nphase('Review')\nphase(\`Synthesize\`)`;
	assert.deepEqual(plannedPhases(script), ["Review", "Verify", "Synthesize"]);
	assert.deepEqual(plannedPhases("const name = 'Review'; phase(name)"), [], "a computed phase name is not guessed");
});

test("a real run records its tool call and one step row per agent, grouped by phase", { timeout: 25000 }, async () => {
	const { DesktopService } = await import("../src/backend.ts");
	const { createCoreFixture } = await import("./fixtures/core-fixture.ts");
	const { cp } = await import("node:fs/promises");
	const { dirname, join, resolve } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const here = dirname(fileURLToPath(import.meta.url));
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		workflowWorker: resolve(here, "../src/workflow-worker-entry.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		await cp(join(here, "fixtures", "workflow-provider.js"), join(fixture.agentDir, "extensions", "faux-provider.js"));
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		await service.saveSettings({ permission: "auto", theme: "light" });
		const id = snapshot.active!.id;
		await service.command({
			type: "prompt",
			message: 'WORKFLOW_TEST_SCRIPT\nawait phase("Find", () => parallel([() => agent({ prompt: "read:seed.txt" }), () => agent({ prompt: "read:seed.txt" })]));\nreturn (await agent({ prompt: "read:seed.txt" })).output;',
		}, id);
		const deadline = Date.now() + 20_000;
		let run = (await service.listWorkflows(id))[0];
		while (Date.now() < deadline && (!run || run.status === "running")) {
			await new Promise((done) => setTimeout(done, 100));
			run = (await service.listWorkflows(id))[0];
		}
		assert.equal(run.status, "completed", run.error);
		assert.ok(run.toolCallId, "the run names the WorkflowRun call so the transcript can anchor its tree");
		const tree = workflowTree(run);
		assert.deepEqual(tree.map((group) => group.name), ["Find", undefined]);
		assert.equal(tree[0].steps.length, 2, "both parallel steps appear under their phase");
		assert.equal(tree[1].steps.length, 1, "the top-level step is listed on its own");
		for (const step of [...tree[0].steps, ...tree[1].steps]) {
			assert.equal(step.status, "completed");
			assert.ok(step.taskId, "each step row links to its child task");
			assert.ok(step.completedAt && step.completedAt >= step.startedAt);
		}
		assert.match(workflowSummary(run), /^完成 · 3 个 Agent/);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("a failed phase is red with its error; finished phases with no steps leave no placeholder", () => {
	const failed = workflowTree(record({
		status: "failed",
		phases: [{ name: "Verify", status: "failed", startedAt: 0, error: "boom" }],
		steps: { a: step({ stepKey: "a", phase: "Verify", startedAt: 1, completedAt: 2 }) },
	}));
	assert.deepEqual(failed.map((group) => [group.name, group.state, group.error]), [["Verify", "err", "boom"]]);
	// An outer phase that only wraps an inner one, and a phase that only logs, get no row once done.
	const nested = workflowTree(record({
		status: "completed",
		phases: [
			{ name: "Outer", status: "completed", startedAt: 0 },
			{ name: "Inner", status: "completed", startedAt: 1 },
			{ name: "Setup", status: "completed", startedAt: 3 },
		],
		steps: { a: step({ stepKey: "a", phase: "Inner", startedAt: 2, completedAt: 3 }) },
	}));
	assert.deepEqual(nested.map((group) => [group.name, group.pending ?? false]), [["Inner", false]]);
	// Only the newest running phase of a live run shows "preparing".
	const live = workflowTree(record({ phases: [{ name: "Find", status: "running", startedAt: 0 }] }));
	assert.deepEqual(live.map((group) => [group.name, group.pending]), [["Find", true]]);
});

test("a live run's clock ticks between events and a finished run shows what its script returned", () => {
	assert.equal(workflowSummary(record({ createdAt: 0, updatedAt: 500 }), 300_000), "运行中 · 5m0s");
	assert.equal(workflowResultText(record({ status: "completed", result: { verdict: "ok" } })), '{\n  "verdict": "ok"\n}');
	assert.equal(workflowResultText(record({ status: "completed", result: null })), undefined);
	assert.match(workflowResultText(record({ status: "completed", result: "x".repeat(30_000) }))!, /已截断，共 30000 字符$/);
});

test("step rows keep any phase name, link their task while running, keep labels on replay and settle on stop", { timeout: 25000 }, async () => {
	const { WorkflowService } = await import("../src/workflow-service.ts");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { dirname, join, resolve } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const here = dirname(fileURLToPath(import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "pi-wf-steps-"));
	let release: (() => void) | undefined;
	let started = 0;
	const service = new WorkflowService({
		dataDir: () => dir,
		callbacks: {
			workerPath: () => resolve(here, "../src/workflow-worker-entry.ts"),
			permissionMode: () => "auto",
			runAgentStep: async (req, signal) => {
				started += 1;
				req.onTaskStarted?.(`task_${req.stepKey}`);
				if (req.prompt === "hang") {
					await new Promise<void>((done, fail) => {
						release = done;
						signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
					});
				}
				return { taskId: `task_${req.stepKey}`, output: "ok", usage: { totalTokens: 10, cost: 0 } };
			},
		},
	});
	try {
		const wf = await service.start({
			conversationId: "c", rootConversationId: "c", project: dir,
			input: {
				script: `
					await phase("fix/lint #1", () => agent({ prompt: "a", description: "修 lint" }));
					await phase("Outer", () => phase("Inner", () => agent({ prompt: "b", description: "内层" })));
					return agent({ prompt: "hang", description: "挂起" });
				`,
			},
		});
		const deadline = Date.now() + 15_000;
		const hanging = () => Object.values(service.get(wf.id)?.steps ?? {}).find((row) => row.label === "挂起");
		while (Date.now() < deadline && !hanging()?.taskId) await new Promise((done) => setTimeout(done, 50));
		const running = hanging()!;
		assert.equal(running.status, "running");
		assert.ok(running.taskId, "a running step links to its child task before it finishes");
		const rows = Object.values(service.get(wf.id)!.steps);
		assert.equal(rows.find((row) => row.label === "修 lint")?.phase, "fix/lint #1", "a phase name with / and # survives");
		assert.equal(rows.find((row) => row.label === "内层")?.phase, "Inner");

		const stopped = await service.stop(wf.id);
		assert.equal(stopped.status, "cancelled");
		assert.ok(Object.values(stopped.steps).every((row) => row.status !== "running"), "stop settles every running row");

		// Resume replays the finished steps from the journal and keeps their labels.
		release?.();
		const before = started;
		// The stopped run needs a moment to unwind before it can resume.
		for (let tries = 0; ; tries++) {
			try { await service.resume(wf.id); break; } catch (error) {
				if (tries > 100 || !String(error).includes("already running")) throw error;
				await new Promise((done) => setTimeout(done, 50));
			}
		}
		const replayDeadline = Date.now() + 15_000;
		while (Date.now() < replayDeadline && service.get(wf.id)?.steps[running.stepKey]?.status !== "running") {
			await new Promise((done) => setTimeout(done, 50));
		}
		const replayed = Object.values(service.get(wf.id)!.steps).filter((row) => row.status === "replayed");
		assert.deepEqual(replayed.map((row) => row.label).sort(), ["修 lint", "内层"].sort());
		assert.equal(started, before + 1, "only the unfinished step runs again");
		await service.stop(wf.id);
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
