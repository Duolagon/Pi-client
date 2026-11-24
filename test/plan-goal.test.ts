import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

async function setup() {
	const fixture = await createCoreFixture();
	await cp(
		fileURLToPath(new URL("./fixtures/plan-goal-provider.js", import.meta.url)),
		join(fixture.agentDir, "extensions", "faux-provider.js"),
	);
	const gate = join(fixture.root, "continue-child");
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
		toolControlExtension: fileURLToPath(new URL("../src/tool-control-extension.ts", import.meta.url)),
		initialProject: fixture.project,
		env: { ...fixture.env, HOME: fixture.root, PI_TEST_GOAL_CHILD_GATE: gate },
	};
	const service = new DesktopService(options);
	return { fixture, service, options, gate, close: async () => { await service.close(); await fixture.cleanup(); } };
}

function settled(service: DesktopService, conversationId: string): Promise<DesktopEvent> {
	return new Promise((resolve, reject) => {
		const unsubscribe = service.subscribe((event) => {
			if (event.conversationId === conversationId && event.event.type === "agent_settled") {
				clearTimeout(timer);
				unsubscribe();
				resolve(event);
			}
		});
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("Expected agent settlement")); }, 12000);
	});
}

test("Plan tool reports a missing body and can submit the actual per-conversation plan file", { timeout: 20000 }, async () => {
	const data = await setup();
	try {
		const { service } = data;
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		const id = initial.active!.id;
		const planTool = async () => (await service.listTools(id)).find((tool) => tool.name === "ExitPlanMode");
		assert.equal((await planTool())?.modelVisible, false);
		await service.setConversationPermission(id, "plan");
		const plan = await service.readPlan(id);
		assert.equal(plan.exists, false);
		assert.equal((await planTool())?.modelVisible, true);
		const completed = settled(service, id);
		await service.command({ type: "prompt", message: "PLAN_FILE_FIXTURE" }, id);
		await completed;
		const snapshot = await service.snapshot();
		const outcomes = snapshot.messages.filter((message) => message.role === "toolResult" && message.toolName === "ExitPlanMode");
		assert.equal(outcomes.length, 2);
		assert.equal(outcomes[0].isError, true);
		assert.ok(JSON.stringify(outcomes[0].content).includes(plan.relativePath));
		assert.equal(outcomes[1].isError, false, JSON.stringify(snapshot.messages.filter((message) => message.role === "toolResult")));
		assert.deepEqual(outcomes[1].details, { saved: true, planFile: plan.relativePath, content: "# Checked plan\n\n1. Verify the file." });
		assert.equal((await service.readPlan(id)).content, "# Checked plan\n\n1. Verify the file.");
		await service.writePlan("# Keep the parent plan", id);
		const clone = await service.cloneSession({ conversationId: id });
		assert.equal(clone.cancelled, false);
		assert.ok(clone.conversation);
		const cloneId = clone.conversation.id;
		const cloneTool = async () => (await service.listTools(cloneId)).find((tool) => tool.name === "ExitPlanMode");
		assert.equal((await cloneTool())?.modelVisible, false);
		await service.setConversationPermission(cloneId, "plan");
		assert.equal((await cloneTool())?.modelVisible, true);
		const cloneCompleted = settled(service, cloneId);
		await service.command({ type: "prompt", message: "PLAN_FILE_FIXTURE" }, cloneId);
		await cloneCompleted;
		assert.equal((await service.readPlan(cloneId)).content, "# Checked plan\n\n1. Verify the file.");
		assert.equal((await service.readPlan(id)).content, "# Keep the parent plan");
	} finally {
		await data.close();
	}
});

test("Goal uses its own budget and waits for a background child before continuing", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const { service } = data;
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		const id = initial.active!.id;
		await service.saveSettings({ permission: "auto", theme: "light" });
		const historical = settled(service, id);
		await service.command({ type: "prompt", message: "GOAL_HISTORY_FIXTURE" }, id);
		await historical;
		const past = (await service.snapshot()).stats?.cost ?? 0;
		assert.ok(past > 0.01, `The historical cost must exceed the new goal cap, actual ${past}`);
		const firstTurn = settled(service, id);
		await service.startGoal(id, { objective: "GOAL_WITH_CHILD", maxCostUsd: 0.01, maxTurns: 3 });
		await firstTurn;
		// The old eager follow-up would finish immediately and consume the remaining turns.
		await wait(350);
		const awaiting = await service.snapshot();
		assert.equal(awaiting.active?.goal?.baselineCostUsd, past);
		assert.equal(awaiting.active?.goal?.turnsUsed, 1);
		assert.equal(awaiting.active?.goal?.active, true);
		assert.equal((await service.listTasks())[0].status, "running");
		const finalTurn = settled(service, id);
		await writeFile(data.gate, "");
		await finalTurn;
		const done = await service.snapshot();
		assert.equal(done.active?.goal?.turnsUsed, 2);
		assert.equal(done.active?.goal?.status, "achieved");
	} finally {
		await data.close();
	}
});

test("Restart persists the stopped state of an interrupted goal", { timeout: 18000 }, async () => {
	const data = await setup();
	try {
		const { service } = data;
		const initial = await service.initialize();
		await service.close();
		const file = join(data.options.dataDir, "desktop.json");
		const stored = JSON.parse(await readFile(file, "utf8"));
		stored.conversations[0].goal = {
			objective: "Do not auto-resume this objective",
			maxTurns: 4,
			turnsUsed: 1,
			status: "running",
			startedAt: Date.now(),
			active: true,
		};
		await writeFile(file, JSON.stringify(stored));
		const restarted = new DesktopService({ ...data.options, initialProject: undefined });
		try {
			const next = await restarted.initialize();
			assert.equal(next.active?.id, initial.active?.id);
			assert.equal(next.active?.goal?.status, "stopped");
			assert.equal(next.active?.goal?.active, false);
			const persisted = JSON.parse(await readFile(file, "utf8"));
			assert.equal(persisted.conversations[0].goal.status, "stopped");
		} finally { await restarted.close(); }
	} finally { await data.fixture.cleanup(); }
});

test("file references persist across prompts and restart, and sensitive files stay outside the saved message", { timeout: 20000 }, async () => {
	const data = await setup();
	let service = data.service;
	try {
		const { project } = data.fixture;
		await mkdir(join(project, "src"));
		await mkdir(join(project, ".claude", "rules"), { recursive: true });
		await writeFile(join(project, "AGENTS.md"), "NATIVE_INSTRUCTIONS");
		await writeFile(join(project, "CLAUDE.md"), "LARGE_DESKTOP_INSTRUCTION_START\n" + "x".repeat(32 * 1024) + "\nLARGE_DESKTOP_INSTRUCTION_END");
		await writeFile(join(project, ".claude", "rules", "paths.md"), "---\npaths: src/**\n---\nPATH_SCOPED_CONTEXT");
		await writeFile(join(project, "src", "keep.txt"), "FROZEN_FILE_CONTENT");
		await writeFile(join(project, "src", "skip.txt"), "DENIED_FILE_CONTENT");
		const initial = await service.initialize();
		const id = initial.active!.id;
		await service.setProjectTrust({ project: initial.active!.project, decision: "trusted" });
		await service.upsertPermission({ id: "file-reference-deny", scope: "conversation", conversationId: id, action: "deny", tool: "read", path: "src/skip.txt" });
		assert.deepEqual(await service.checkFileReferences(id, ["src/keep.txt", "src/skip.txt"]), ["ready", "unavailable"]);
		const first = settled(service, id);
		await service.command({ type: "prompt", message: "WORKSPACE_CONTEXT_FIRST @src/keep.txt @src/skip.txt" }, id);
		await first;
		const snapshot = await service.snapshot();
		const rawUser = snapshot.messages.findLast((message) => message.role === "user");
		assert.match(JSON.stringify(rawUser), /FROZEN_FILE_CONTENT/);
		assert.doesNotMatch(JSON.stringify(rawUser), /DENIED_FILE_CONTENT/);
		assert.match(JSON.stringify(snapshot.messages.at(-1)), /WORKSPACE_CONTEXT_READY/);
		assert.equal((await service.sessionForkMessages(id)).messages.at(-1)?.text, "WORKSPACE_CONTEXT_FIRST @src/keep.txt @src/skip.txt");
		const report = await service.contextReport(id);
		assert.equal(report.sources.find(({ id }) => id === "AGENTS.md")?.promptState, "native");
		assert.equal(report.sources.find(({ id }) => id === "CLAUDE.md")?.promptState, "truncated");
		assert.equal(report.sources.find(({ id }) => id === ".claude/rules/paths.md")?.promptState, "conditional");
		await writeFile(join(project, "src", "keep.txt"), "FRESH_DISK_CONTENT");
		await service.close();
		service = new DesktopService({ ...data.options, initialProject: undefined });
		await service.initialize();
		const followup = settled(service, id);
		await service.command({ type: "prompt", message: "WORKSPACE_CONTEXT_NEXT" }, id);
		await followup;
		assert.match(JSON.stringify((await service.snapshot()).messages.at(-1)), /WORKSPACE_CONTEXT_PRESERVED/);
	} finally {
		await service.close();
		await data.fixture.cleanup();
	}
});
