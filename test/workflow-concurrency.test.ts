import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import type { WorkflowRecord } from "../src/workflow-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/permission-extension.ts");
const toolControlPath = resolve(here, "../src/tool-control-extension.ts");
const navigationPath = resolve(here, "../src/session-navigation-extension.ts");
const historyPath = resolve(here, "../src/session-history-entry.ts");
const workflowWorker = resolve(here, "../src/workflow-worker-entry.ts");

test("WorkflowRun parallel() wider than maxConcurrentSubagents waits for free slots instead of failing", { timeout: 90000 }, async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		workflowWorker,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		await service.saveSettings({ permission: "auto", theme: "light", maxConcurrentSubagents: 2 });
		const rootId = snap.active!.id;

		const active = new Set<string>();
		let peak = 0;
		const unsubTasks = service.subscribeTasks((event) => {
			if (event.type !== "task_updated" || event.task.parentConversationId !== rootId) return;
			if (["queued", "running", "waiting_for_input"].includes(event.task.status)) active.add(event.task.id);
			else active.delete(event.task.id);
			peak = Math.max(peak, active.size);
		});

		const script = `
			const outputs = await parallel([1, 2, 3, 4, 5].map((n) => () =>
				agent({ prompt: "wave item " + n, description: "item " + n, subagentType: "Explore" })));
			return outputs.length;
		`;
		const started = await service.startWorkflow(rootId, { title: "wide-parallel", script });
		const finished = await new Promise<WorkflowRecord>((resolveDone, rejectDone) => {
			const timer = setTimeout(() => { unsub(); rejectDone(new Error("workflow did not finish")); }, 80000);
			const check = (wf: WorkflowRecord) => {
				if (wf.id !== started.id || ["running", "waiting_for_approval"].includes(wf.status)) return;
				clearTimeout(timer);
				unsub();
				resolveDone(wf);
			};
			const unsub = service.subscribeWorkflows((event) => check(event.workflow));
			void service.listWorkflows(rootId).then((list) => list.forEach(check));
		});
		unsubTasks();

		assert.equal(finished.status, "completed", finished.error);
		assert.equal(finished.result, 5);
		assert.ok(peak <= 2, `peak concurrent subagents ${peak} exceeded cap 2`);
		const children = (await service.listTasks()).filter((t) => t.workflowId === started.id);
		assert.equal(children.length, 5);
		assert.ok(children.every((t) => t.status === "completed"));
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
