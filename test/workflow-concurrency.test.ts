import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

async function withScriptedWorkflow(
	git: boolean,
	fn: (service: DesktopService, fixture: Awaited<ReturnType<typeof createCoreFixture>>, conversationId: string) => Promise<void>,
) {
	const fixture = await createCoreFixture();
	const env = { ...fixture.env, HOME: fixture.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		workflowWorker,
		env,
		initialProject: fixture.project,
	});
	try {
		if (git) {
			const runGit = (...args: string[]) => execFileSync("git", args, { cwd: fixture.project, env });
			runGit("init", "-q", "-b", "main");
			runGit("add", "seed.txt");
			runGit("-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "Initialize fixture");
		}
		await cp(join(here, "fixtures", "workflow-provider.js"), join(fixture.agentDir, "extensions", "faux-provider.js"));
		const snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		await service.saveSettings({ permission: "auto", theme: "light" });
		await fn(service, fixture, snap.active!.id);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
}

async function waitForWorkflow(service: DesktopService, conversationId: string, deadline: number, predicate: (wf: WorkflowRecord) => boolean) {
	while (Date.now() < deadline) {
		const workflow = (await service.listWorkflows(conversationId)).find(predicate);
		if (workflow) return workflow;
		await delay(30);
	}
	throw new Error("workflow did not reach the expected state");
}

test("a synchronous model workflow can run writable steps in its waiting parent's non-Git directory", { timeout: 18000 }, async () => {
	await withScriptedWorkflow(false, async (service, fixture, conversationId) => {
		await service.command({
			type: "prompt",
			message: 'WORKFLOW_TEST_SCRIPT\nreturn (await agent({ prompt: "write:workflow-shared.txt" })).output;',
		}, conversationId);
		const finished = await waitForWorkflow(service, conversationId, Date.now() + 12000, (wf) => ["completed", "failed"].includes(wf.status));
		assert.equal(finished.status, "completed", finished.error);
		assert.equal(finished.result, "write-ok");
		assert.equal(await readFile(join(fixture.project, "workflow-shared.txt"), "utf8"), "workflow-step-output\n");
	});
});

test("sequential workflow steps see uncommitted files in their worktree and parallel branches stay isolated", { timeout: 28000 }, async () => {
	await withScriptedWorkflow(true, async (service, fixture, conversationId) => {
		const script = `
			const first = await agent({ prompt: "write:from-workflow.txt" });
			const next = await phase("verify", () => agent({ prompt: "read:from-workflow.txt", subagentType: "Explore" }));
			const independent = await parallel(["left", "right"].map((label) => async () => {
				const write = await agent({ prompt: "write:" + label + ".txt" });
				const read = await agent({ prompt: "read:" + label + ".txt" });
				return { write: write.worktreeId, read: read.worktreeId, output: read.output };
			}));
			return { write: first.worktreeId, read: next.worktreeId, directory: next.workingDirectory, output: next.output, independent };
		`;
		await service.command({ type: "prompt", message: "WORKFLOW_TEST_SCRIPT\n" + script }, conversationId);
		const finished = await waitForWorkflow(service, conversationId, Date.now() + 20000, (wf) => ["completed", "failed"].includes(wf.status));
		assert.equal(finished.status, "completed", finished.error);
		const result = finished.result as {
			write: string;
			read: string;
			directory: string;
			output: string;
			independent: { write: string; read: string; output: string }[];
		};
		assert.match(result.output, /workflow-step-output/);
		assert.ok(result.write);
		assert.equal(result.read, result.write);
		assert.equal(await readFile(join(result.directory, "from-workflow.txt"), "utf8"), "workflow-step-output\n");
		assert.equal(new Set([result.write, ...result.independent.map((step) => step.write)]).size, 3);
		for (const step of result.independent) {
			assert.equal(step.read, step.write);
			assert.match(step.output, /workflow-step-output/);
		}
		await assert.rejects(readFile(join(fixture.project, "from-workflow.txt"), "utf8"), { code: "ENOENT" });
	});
});

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
