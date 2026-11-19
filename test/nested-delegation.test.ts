import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import { buildSubagentPanelState } from "../src/renderer/subagent-panel-state.ts";
import type { DesktopTask } from "../src/task-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
const toolControlPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/tool-control-extension.ts");
const navigationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-navigation-extension.ts");
const historyPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-history-entry.ts");

async function installNestedTestProvider(agentDir: string) {
	const file = join(agentDir, "extensions", "faux-provider.js");
	const original = await readFile(file, "utf8");
	const patched = original.replace(
		"\t\t\t} else {\n\t\t\t\tresponse = fauxAssistantMessage(`STREAM_COMPLETE ${model.id}: ${text}`);",
		`\t\t\t} else if (text.includes("NESTED_ROOT")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "child-delegator", prompt: "NESTED_CHILD", subagent_type: "general-purpose", run_in_background: false }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("ROOT_GOT=" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("NESTED_CHILD")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "grandchild-worker", prompt: "NESTED_GRANDCHILD", subagent_type: "general-purpose" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("CHILD_GOT=" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("NESTED_GRANDCHILD")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "depth3-denied", prompt: "hi", subagent_type: "Explore" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("GRAND_ERR=" + Boolean(results[0].isError) + ":" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("RO_TRY_WRITABLE")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "writable-grandchild", prompt: "hi", subagent_type: "general-purpose" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("RO_WRITABLE_ERR=" + Boolean(results[0].isError) + ":" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("RO_TRY_EXPLORE")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "explore-grandchild", prompt: "PLAIN_OK", subagent_type: "Explore" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("RO_EXPLORE_OK=" + !results[0].isError + ":" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("CHILD_APPROVAL_CHAIN")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("Agent", { description: "grand-approval", prompt: "GRAND_BASH_ASK", subagent_type: "general-purpose" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("CHILD_APPROVAL_DONE=" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("GRAND_BASH_ASK")) {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("bash", { command: "echo grand_approved" }), { stopReason: "toolUse" });
				} else {
					response = fauxAssistantMessage("GRAND_BASH=" + !results[0].isError + ":" + JSON.stringify(results[0].content));
				}
			} else if (text.includes("HOLD_OPEN")) {
				response = fauxAssistantMessage(fauxToolCall("Agent", { description: "grand-loop", prompt: "loop-tool-calls", subagent_type: "Explore" }), { stopReason: "toolUse" });
			} else {
				response = fauxAssistantMessage(\`STREAM_COMPLETE \${model.id}: \${text}\`);`,
	);
	assert.notEqual(patched, original, "failed to patch faux-provider for nested test");
	await writeFile(file, patched);
}

async function waitForSettled(service: DesktopService, conversationId: string, timeoutMs = 15000): Promise<void> {
	await new Promise<void>((resolveReady, rejectReady) => {
		const timer = setTimeout(() => {
			unsub();
			rejectReady(new Error(`Timed out waiting for ${conversationId} to settle`));
		}, timeoutMs);
		const unsub = service.subscribe((ev) => {
			if (ev.conversationId === conversationId && ev.event.type === "agent_settled") {
				clearTimeout(timer);
				unsub();
				resolveReady();
			}
		});
	});
}

test("P7 real Pi: maxDepth=2, slot borrowing with maxConcurrentTasks=1, depth 3 rejection, read-only enforcement & concurrency limit", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	await installNestedTestProvider(fixture.agentDir);
	await exec("git", ["-c", "init.defaultBranch=main", "init"], { cwd: fixture.project });
	await exec("git", ["add", "-A"], { cwd: fixture.project });
	await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@invalid", "-c", "commit.gpgSign=false", "commit", "-m", "init"], { cwd: fixture.project });

	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		maxConcurrentTasks: 1,
		maxBorrowedSlots: 4,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const initSnap = await service.initialize();
		assert.equal(initSnap.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });

		// Validate settings bounds and persist maxSubagentDepth=2 and maxConcurrentSubagents=2.
		await assert.rejects(service.saveSettings({ permission: "auto", theme: "light", maxSubagentDepth: 4 }));
		await assert.rejects(service.saveSettings({ permission: "auto", theme: "light", maxConcurrentSubagents: 21 }));
		const saved = await service.saveSettings({ permission: "auto", theme: "light", maxSubagentDepth: 2, maxConcurrentSubagents: 2 });
		assert.equal(saved.settings.maxSubagentDepth, 2);
		assert.equal(saved.settings.maxConcurrentSubagents, 2);

		const rootId = initSnap.active!.id;

		// 1. 3-tier foreground chain (Root -> depth 1 -> depth 2) runs without deadlock even when maxConcurrentTasks=1,
		// defaults depth >= 1 child to foreground even in git worktree mode, propagates result back up, and blocks depth 3.
		const settledRoot = waitForSettled(service, rootId);
		await service.command({ type: "prompt", message: "NESTED_ROOT" });
		await settledRoot;

		const rootSnap = await service.snapshot();
		const lastAssistant = [...rootSnap.messages].reverse().find((m) => m.role === "assistant");
		const rootText = JSON.stringify(lastAssistant?.content ?? "");
		assert.match(rootText, /ROOT_GOT=.*CHILD_GOT=.*GRAND_ERR=true:/, `expected nested chain output up to root, saw: ${rootText}`);
		assert.match(rootText, /Tool Agent not found|Subagent nesting limit reached/);

		const allTasks = await service.listTasks();
		const depth1Task = allTasks.find((t) => t.parentConversationId === rootId && t.delegationDepth === 1);
		assert.ok(depth1Task, "depth-1 child created");
		const depth2Task = allTasks.find((t) => t.parentConversationId === depth1Task.conversationId && t.delegationDepth === 2);
		assert.ok(depth2Task, "depth-2 grandchild created");
		assert.equal(depth2Task.runInBackground, false, "depth >= 1 delegator defaults child to foreground");
		assert.deepEqual(depth2Task.model, depth1Task.model, "grandchild inherits depth-1 child's model");

		// Layer 2 (policy + tool listing) and Layer 3 (ModelDelegation) both block depth 2 -> depth 3.
		assert.equal((await service.checkPermission({ conversationId: depth2Task.conversationId, toolName: "Agent", input: { description: "d3", prompt: "hi", subagent_type: "Explore" } })).action, "deny");

		const grandSnap = await service.taskSnapshot(depth2Task.id);
		assert.ok(grandSnap.active?.sessionFile, "grandchild recorded session file");
		const grandMeta = JSON.parse(await readFile(grandSnap.active!.sessionFile!.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { depth: number; parent: string };
		assert.equal(grandMeta.depth, 2);
		assert.equal(grandMeta.parent, depth1Task.conversationId);

		// Also verify host-layer delegation directly blocks depth 2 -> depth 3 with native error text.
		const delegation = (service as unknown as {
			delegation: {
				handle: (ctx: { conversationId: string; toolCallId: string }, tool: string, input: unknown) => Promise<{
					text: string;
					details: { task_id: string; output: string };
				}>;
			};
		}).delegation;
		await assert.rejects(
			() => delegation.handle({ conversationId: depth2Task.conversationId, toolCallId: "d3-direct" }, "Agent", { description: "d3", prompt: "hi", subagent_type: "Explore" }),
			/Subagent nesting limit reached \(depth 2\)\. Complete this task directly/,
		);

		// 2. Read-only depth-1 child cannot spawn a writable depth-2 child, but CAN spawn a read-only Explore grandchild.
		const roWritable = await delegation.handle(
			{ conversationId: rootId, toolCallId: "ro-parent-1" },
			"Agent",
			{ description: "ro tries writable", prompt: "RO_TRY_WRITABLE", subagent_type: "Explore", run_in_background: false },
		);
		assert.match(roWritable.details.output, /RO_WRITABLE_ERR=true:/);

		const roExplore = await delegation.handle(
			{ conversationId: rootId, toolCallId: "ro-parent-2" },
			"Agent",
			{ description: "ro tries explore", prompt: "RO_TRY_EXPLORE", subagent_type: "Explore", run_in_background: false },
		);
		assert.match(roExplore.details.output, /RO_EXPLORE_OK=true:.*STREAM_COMPLETE/);

		// 3. Concurrency cap (`maxConcurrentSubagents=2`) enforces native "Do not retry" message on 3rd active subagent.
		const c1 = await delegation.handle({ conversationId: rootId, toolCallId: "cap-1" }, "Agent", { description: "slow 1", prompt: "slow-stream", subagent_type: "Explore", run_in_background: true });
		const c2 = await delegation.handle({ conversationId: rootId, toolCallId: "cap-2" }, "Agent", { description: "slow 2", prompt: "slow-stream", subagent_type: "Explore", run_in_background: true });
		await assert.rejects(
			() => delegation.handle({ conversationId: rootId, toolCallId: "cap-3" }, "Agent", { description: "slow 3", prompt: "slow-stream", subagent_type: "Explore", run_in_background: true }),
			/Concurrent subagent limit reached\. You can run 2 subagents at once\. Do not retry; wait for a running agent to finish\./,
		);
		await service.cancelTask(c1.details.task_id, "user_stop");
		await service.cancelTask(c2.details.task_id, "user_stop");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("P7 real Pi: grandchild approval bubbles to root childApprovals, root abort cascades descendants, and SubagentPanel renders tree", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	await installNestedTestProvider(fixture.agentDir);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const initSnap = await service.initialize();
		assert.equal(initSnap.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		await service.saveSettings({ permission: "ask", theme: "light", maxSubagentDepth: 2 });
		const rootId = initSnap.active!.id;
		await service.upsertPermission({
			id: "allow-agent-calls",
			scope: "project",
			project: fixture.project,
			action: "allow",
			tool: "Agent",
		});

		const delegation = (service as unknown as {
			delegation: {
				handle: (ctx: { conversationId: string; toolCallId: string }, tool: string, input: unknown) => Promise<{
					text: string;
					details: { task_id: string; output: string };
				}>;
			};
		}).delegation;

		// 1. Child runs bash-requiring grandchild; grandchild's bash prompt surfaces on root snapshot.childApprovals with depth=2.
		const pendingChildPromise = delegation.handle(
			{ conversationId: rootId, toolCallId: "approval-parent-call" },
			"Agent",
			{ description: "child-approval-relay", prompt: "CHILD_APPROVAL_CHAIN", subagent_type: "general-purpose", run_in_background: false },
		);

		let grandApproval: { taskId: string; depth: number; request: { id: string } } | undefined;
		for (let i = 0; i < 120; i++) {
			const snap = await service.snapshot();
			grandApproval = snap.childApprovals?.find((item) => item.depth === 2);
			if (grandApproval) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(grandApproval, "grandchild approval surfaced on root snapshot.childApprovals");
		assert.equal(grandApproval.depth, 2);

		await service.respond({ type: "extension_ui_response", id: grandApproval.request.id, confirmed: true }, grandApproval.taskId);
		const approvalResult = await pendingChildPromise;
		assert.match(approvalResult.details.output, /CHILD_APPROVAL_DONE=.*GRAND_BASH=true:.*grand_approved/);

		// 2. Root abort recursively cancels running child AND grandchild.
		const childHoldPromise = delegation.handle(
			{ conversationId: rootId, toolCallId: "abort-cascade-call" },
			"Agent",
			{ description: "cascade-child", prompt: "HOLD_OPEN", subagent_type: "general-purpose", run_in_background: false },
		);
		let activeChild: DesktopTask | undefined;
		let activeGrandchild: DesktopTask | undefined;
		for (let i = 0; i < 100; i++) {
			const tasks = await service.listTasks();
			activeChild = tasks.find((t) => t.parentToolCallId === "abort-cascade-call");
			if (activeChild) activeGrandchild = tasks.find((t) => t.parentConversationId === activeChild!.conversationId);
			if (activeChild && activeGrandchild && activeGrandchild.status === "running") break;
			await new Promise((r) => setTimeout(r, 80));
		}
		assert.ok(activeChild && activeGrandchild, "child and grandchild both became active");

		await service.cancelTask(activeChild.id, "parent_abort");
		await childHoldPromise.catch(() => {});

		const afterCancel = await service.listTasks();
		assert.equal(afterCancel.find((t) => t.id === activeChild!.id)?.status, "cancelled");
		assert.equal(afterCancel.find((t) => t.id === activeGrandchild!.id)?.status, "cancelled");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("P7 unit: buildSubagentPanelState renders depth 1-3 hierarchy and descendant counts; maxSubagentDepth persists", async () => {
	const now = 100_000;
	const mkTask = (id: string, parent: string, depth: number, extra: Partial<DesktopTask> = {}): DesktopTask => ({
		id,
		conversationId: id,
		project: "/project",
		workingDirectory: "/project",
		title: id,
		prompt: "p",
		status: "running",
		createdAt: now - depth * 100,
		updatedAt: now - depth * 100,
		revision: 1,
		turn: 1,
		parentConversationId: parent,
		parentToolCallId: `tc-${id}`,
		subagentType: "Explore",
		delegationDepth: depth,
		readOnly: true,
		runInBackground: false,
		...extra,
	});
	const panel = buildSubagentPanelState(
		[
			mkTask("child-1", "root", 1),
			mkTask("grand-1", "child-1", 2),
			mkTask("great-1", "grand-1", 3),
			mkTask("child-2", "root", 1, { status: "completed", updatedAt: now - 5_000 }),
		],
		[],
		{},
		"root",
		now,
	);
	assert.equal(panel.completedHintCount, 1);
	assert.deepEqual(
		panel.rows.map((r) => ({ id: r.id, depth: r.depth, descendantCount: r.descendantCount })),
		[
			{ id: "child-1", depth: 1, descendantCount: 2 },
			{ id: "grand-1", depth: 2, descendantCount: 1 },
			{ id: "great-1", depth: 3, descendantCount: 0 },
		],
	);

	// Persisted maxSubagentDepth & maxConcurrentSubagents reload cleanly.
	const root = await mkdtemp(join(tmpdir(), "pi-p7-store-"));
	try {
		const project = join(root, "project");
		const dataDir = join(root, "data");
		await stat(await fixturePathOrCreate(project, dataDir));
		await writeFile(
			join(dataDir, "desktop.json"),
			JSON.stringify({
				projects: [{ path: project, name: "project" }],
				conversations: [{ id: "root", title: "Root", project, updatedAt: 1 }],
				activeId: "root",
				settings: { permission: "ask", theme: "light", maxSubagentDepth: 3, maxConcurrentSubagents: 12, connections: {} },
				keys: {},
				tasks: [],
			}),
		);
		const reloaded = new DesktopService({
			dataDir,
			executable: process.execPath,
			historyEntry: historyPath,
			env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
		});
		const snap = await reloaded.initialize();
		assert.equal(snap.settings.maxSubagentDepth, 3);
		assert.equal(snap.settings.maxConcurrentSubagents, 12);
		await reloaded.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function fixturePathOrCreate(project: string, dataDir: string): Promise<string> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(project, { recursive: true });
	await mkdir(dataDir, { recursive: true });
	return dataDir;
}
