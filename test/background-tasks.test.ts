import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent, Message, RpcSessionState } from "../src/shared.ts";
import type { DesktopTask, TaskEvent, TaskStatus } from "../src/task-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, env: gitEnv });
	return stdout.trim();
}

class EventLog {
	packets: DesktopEvent[] = [];
	private listeners = new Set<(packet: DesktopEvent) => void>();
	add(packet: DesktopEvent): void {
		this.packets.push(packet);
		for (const listener of this.listeners) listener(packet);
	}
	waitFor(conversationId: string, type: DesktopEvent["event"]["type"]): Promise<DesktopEvent> {
		return this.wait((packet) => packet.conversationId === conversationId && packet.event.type === type);
	}
	wait(predicate: (packet: DesktopEvent) => boolean): Promise<DesktopEvent> {
		const previous = this.packets.find(predicate);
		if (previous) return Promise.resolve(previous);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`Missing background event; received ${this.packets.map((packet) => `${packet.conversationId}:${packet.event.type}`).join(",")}`));
			}, 15000);
			const listener = (packet: DesktopEvent) => {
				if (!predicate(packet)) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(packet);
			};
			this.listeners.add(listener);
		});
	}
}

class TaskLog {
	events: TaskEvent[] = [];
	private listeners = new Set<(event: TaskEvent) => void>();
	add(event: TaskEvent): void {
		this.events.push(event);
		for (const listener of this.listeners) listener(event);
	}
	waitFor(id: string, status: TaskStatus): Promise<DesktopTask> {
		const previous = this.events.find(
			(event): event is Extract<TaskEvent, { type: "task_updated" }> => event.type === "task_updated" && event.task.id === id && event.task.status === status,
		);
		if (previous) return Promise.resolve(previous.task);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(
					new Error(
						`Task ${id} did not reach ${status}; received ${this.events
							.filter((event): event is Extract<TaskEvent, { type: "task_updated" }> => event.type === "task_updated")
							.map((event) => `${event.task.id}:${event.task.status}`)
							.join(",")}`,
					),
				);
			}, 15000);
			const listener = (event: TaskEvent) => {
				if (event.type !== "task_updated" || event.task.id !== id || event.task.status !== status) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(event.task);
			};
			this.listeners.add(listener);
		});
	}
}

async function setup(maxConcurrentTasks = 4) {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await git(project, "-c", "init.defaultBranch=main", "init");
	await git(project, "add", "--", "seed.txt");
	await git(project, "-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "feat: Initialize background task fixture");
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: project,
		maxConcurrentTasks,
	};
	const service = new DesktopService(options);
	const events = new EventLog();
	const tasks = new TaskLog();
	service.subscribe((packet) => events.add(packet));
	service.subscribeTasks((event) => tasks.add(event));
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, project, options, service, events, tasks, foregroundId: snapshot.active!.id };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

function text(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function approval(events: EventLog, conversationId: string) {
	const packet = await events.wait((item) => item.conversationId === conversationId && item.event.type === "extension_ui_request" && item.event.method === "confirm");
	if (packet.event.type !== "extension_ui_request" || packet.event.method !== "confirm") throw new Error("Expected tool approval");
	return packet.event;
}

test("two isolated real Pi tasks keep streaming while foreground selection changes", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await writeFile(join(data.project, "seed.txt"), "user staged content\n");
		await git(data.project, "add", "--", "seed.txt");
		await writeFile(join(data.project, "seed.txt"), "user unstaged content\n");
		await writeFile(join(data.project, "user-new.txt"), "keep original untracked\n");
		const status = await git(data.project, "status", "--porcelain=v1");
		const index = await readFile(join(data.project, ".git", "index"));
		const first = await data.service.startTask({ message: "slow-stream task-one" });
		const second = await data.service.startTask({ project: data.project, message: "slow-stream task-two" });
		await Promise.all([data.events.waitFor(first.conversationId, "message_update"), data.events.waitFor(second.conversationId, "message_update")]);
		assert.notEqual(first.workingDirectory, second.workingDirectory);
		assert.notEqual(first.workingDirectory, data.project);
		assert.ok(first.worktreeId && second.worktreeId);
		const running = await data.service.listTasks();
		assert.equal(running.filter((item) => item.status === "running").length, 2);
		assert.equal((await data.service.snapshot()).active?.id, data.foregroundId);
		const firstSnapshot = await data.service.taskSnapshot(first.id);
		const secondSnapshot = await data.service.taskSnapshot(second.id);
		assert.equal(firstSnapshot.active?.id, first.conversationId);
		assert.equal(secondSnapshot.active?.id, second.conversationId);
		assert.equal(firstSnapshot.state?.isStreaming, true);
		assert.equal(secondSnapshot.state?.isStreaming, true);
		assert.ok(firstSnapshot.messages.some((message) => message.role === "user" && text(message).includes("task-one")));
		assert.ok(!firstSnapshot.messages.some((message) => message.role === "user" && text(message).includes("task-two")));
		assert.ok(secondSnapshot.messages.some((message) => message.role === "user" && text(message).includes("task-two")));
		const fresh = await data.service.newConversation();
		assert.notEqual(fresh.active?.id, data.foregroundId);
		await data.service.selectConversation(first.conversationId);
		assert.equal((await data.service.taskSnapshot(second.id)).state?.isStreaming, true);
		await data.service.selectConversation(fresh.active!.id);
		assert.equal((await data.service.taskSnapshot(first.id)).state?.isStreaming, true);
		const state = await data.service.command({ type: "get_state" }, first.conversationId) as RpcSessionState;
		assert.equal(state.sessionId, firstSnapshot.state?.sessionId);
		assert.ok(!JSON.stringify(state).includes("desktop-runtime-secret"));
		await data.service.command({ type: "abort" }, first.conversationId);
		await data.events.waitFor(first.conversationId, "agent_settled");
		assert.equal((await data.service.listTasks()).find((item) => item.id === first.id)?.status, "cancelled");
		assert.equal((await data.service.taskSnapshot(second.id)).state?.isStreaming, true);
		await data.service.cancelTask(second.id);
		await data.events.waitFor(second.conversationId, "agent_settled");
		assert.equal((await data.service.listTasks()).find((item) => item.id === second.id)?.status, "cancelled");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "user unstaged content\n");
		assert.equal(await git(data.project, "status", "--porcelain=v1"), status);
		assert.deepEqual(await readFile(join(data.project, ".git", "index")), index);
		assert.equal(await readFile(join(first.workingDirectory, "seed.txt"), "utf8"), "seed-content\n");
		assert.equal(await readFile(join(second.workingDirectory, "seed.txt"), "utf8"), "seed-content\n");
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("background tool approvals stay attached to their own conversation and worktree", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		const first = await data.service.startTask({ message: "deny-write approval-one" });
		const second = await data.service.startTask({ message: "deny-write approval-two" });
		const [firstApproval, secondApproval] = await Promise.all([approval(data.events, first.conversationId), approval(data.events, second.conversationId)]);
		assert.notEqual(firstApproval.id, secondApproval.id);
		assert.equal((await data.service.taskSnapshot(first.id)).pendingUI[0]?.id, firstApproval.id);
		assert.equal((await data.service.taskSnapshot(second.id)).pendingUI[0]?.id, secondApproval.id);
		assert.ok((await data.service.listTasks()).every((task) => task.status === "waiting_for_input"));
		await assert.rejects(data.service.respond({ type: "extension_ui_response", id: firstApproval.id, confirmed: true }, second.conversationId), /失效/);
		await data.service.respond({ type: "extension_ui_response", id: firstApproval.id, confirmed: true }, first.conversationId);
		await data.tasks.waitFor(first.id, "completed");
		assert.equal((await data.service.taskSnapshot(second.id)).pendingUI[0]?.id, secondApproval.id);
		await data.service.respond({ type: "extension_ui_response", id: secondApproval.id, confirmed: false }, second.conversationId);
		await data.tasks.waitFor(second.id, "completed");
		assert.equal(await readFile(join(first.workingDirectory, "denied.txt"), "utf8"), "must not exist\n");
		await assert.rejects(access(join(second.workingDirectory, "denied.txt")));
		await assert.rejects(access(join(data.project, "denied.txt")));
		assert.ok((await data.service.taskSnapshot(first.id)).messages.some((message) => message.role === "assistant" && text(message).includes("WRITE_ALLOWED")));
		assert.ok((await data.service.taskSnapshot(second.id)).messages.some((message) => message.role === "assistant" && text(message).includes("WRITE_DENIED")));
		assert.equal((await data.service.snapshot()).active?.id, data.foregroundId);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("task concurrency cap queues work and supports queued and running cancellation", { timeout: 60000 }, async () => {
	const data = await setup(1);
	try {
		const first = await data.service.startTask({ message: "slow-stream occupies-slot" });
		await data.events.waitFor(first.conversationId, "message_update");
		const second = await data.service.startTask({ message: "complete after previous cancellation" });
		const third = await data.service.startTask({ message: "slow-stream queued-never-started" });
		const before = await data.service.listTasks();
		assert.equal(before.find((item) => item.id === first.id)?.status, "running");
		assert.equal(before.find((item) => item.id === second.id)?.status, "queued");
		assert.equal(before.find((item) => item.id === third.id)?.status, "queued");
		assert.equal((await data.service.cancelTask(third.id)).status, "cancelled");
		assert.equal((await data.service.cancelTask(first.id)).status, "cancelled");
		await data.events.waitFor(first.conversationId, "agent_settled");
		await data.tasks.waitFor(second.id, "completed");
		await data.events.waitFor(second.conversationId, "agent_settled");
		assert.ok(!data.events.packets.some((packet) => packet.conversationId === third.conversationId && packet.event.type === "agent_start"));
		assert.equal((await data.service.taskSnapshot(third.id)).messages.length, 0);
		assert.equal((await data.service.listTasks()).find((item) => item.id === second.id)?.status, "completed");
		assert.ok((await data.service.taskSnapshot(second.id)).messages.some((message) => message.role === "assistant" && text(message).includes("complete after previous cancellation")));
		await assert.rejects(data.service.taskSnapshot("unknown-task"), /不存在/);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("restarting marks unfinished tasks interrupted without replaying their prompts", { timeout: 60000 }, async () => {
	const data = await setup(1);
	let current = data.service;
	try {
		const running = await current.startTask({ message: "slow-stream interrupted-by-close" });
		await data.events.waitFor(running.conversationId, "message_update");
		const queued = await current.startTask({ message: "slow-stream queued-before-close" });
		assert.equal((await current.listTasks()).find((task) => task.id === queued.id)?.status, "queued");
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const restoredEvents = new EventLog();
		current.subscribe((packet) => restoredEvents.add(packet));
		await current.initialize();
		const restored = await current.listTasks();
		assert.equal(restored.find((task) => task.id === running.id)?.status, "interrupted");
		assert.equal(restored.find((task) => task.id === queued.id)?.status, "interrupted");
		assert.equal((await current.taskSnapshot(queued.id)).messages.length, 0);
		const snapshot = await current.taskSnapshot(running.id);
		assert.equal(snapshot.state?.isStreaming, false);
		assert.ok(!restoredEvents.packets.some((packet) => packet.event.type === "agent_start"));
		assert.equal(restored.find((task) => task.id === running.id)?.worktreeId, running.worktreeId);
		assert.equal((await current.listWorktrees()).length, 2);
	} finally {
		await current.close();
		await data.fixture.cleanup();
	}
});

test("live task_progress increments toolUses monotonically and final task.stats matches get_session_stats", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await data.service.saveSettings({ permission: "auto", theme: "light" });
		const task = await data.service.startTask({ message: "read-write-bash progress tracking" });
		await data.tasks.waitFor(task.id, "completed");
		const progressEvents = data.tasks.events.filter(
			(event): event is Extract<TaskEvent, { type: "task_progress" }> => event.type === "task_progress" && event.taskId === task.id,
		);
		assert.ok(progressEvents.length >= 1, "expected at least one task_progress event");
		for (let i = 1; i < progressEvents.length; i++) {
			assert.ok(progressEvents[i].progress.toolUses >= progressEvents[i - 1].progress.toolUses, "toolUses must be monotonic");
		}
		const finished = (await data.service.listTasks()).find((item) => item.id === task.id)!;
		const snap = await data.service.taskSnapshot(task.id);
		assert.ok(finished.stats, "expected recorded task.stats on completion");
		assert.equal(finished.stats.toolUses, snap.stats?.toolCalls ?? 3);
		assert.equal(finished.stats.tokens.total, snap.stats?.tokens.total ?? 0);
		assert.ok(finished.stats.toolUses >= 3, `expected >= 3 tool calls, got ${finished.stats.toolUses}`);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("childApprovals surface to the parent, respond is idempotent and rejects foreign ids, and delegatedOnly rules apply only to descendants", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		const otherRoot = (await data.service.newConversation()).active!.id;
		await data.service.selectConversation(data.foregroundId);

		// Spawn two delegated children under foregroundId and one under otherRoot.
		const childA = await data.service.startTask(
			{ message: "read-write-bash child-a", isolation: "worktree" },
			{
				parentConversationId: data.foregroundId,
				parentToolCallId: "call-a",
				subagentType: "general-purpose",
				delegationDepth: 1,
				readOnly: false,
				runInBackground: true,
				name: "alpha",
			},
		);
		const childB = await data.service.startTask(
			{ message: "read-write-bash child-b", isolation: "worktree" },
			{
				parentConversationId: data.foregroundId,
				parentToolCallId: "call-b",
				subagentType: "general-purpose",
				delegationDepth: 1,
				readOnly: false,
				runInBackground: true,
				name: "beta",
			},
		);
		const foreignChild = await data.service.startTask(
			{ message: "slow-stream foreign-child", isolation: "worktree" },
			{
				parentConversationId: otherRoot,
				parentToolCallId: "call-foreign",
				subagentType: "general-purpose",
				delegationDepth: 1,
				readOnly: false,
				runInBackground: true,
			},
		);

		const reqA = await approval(data.events, childA.conversationId);
		const parentSnap = await data.service.snapshot();
		assert.ok(parentSnap.childApprovals?.some((item) => item.taskId === childA.id && item.request.id === reqA.id && item.name === "alpha"));
		const listedA = (await data.service.listTasks()).find((t) => t.id === childA.id);
		assert.equal(listedA?.pendingApprovals?.[0]?.id, reqA.id);

		// pendingApprovals is runtime-only and never persisted to desktop.json.
		const rawStore = JSON.parse(await readFile(join(data.fixture.dataDir, "desktop.json"), "utf8"));
		assert.equal(rawStore.tasks.find((t: { id: string }) => t.id === childA.id)?.pendingApprovals, undefined);

		// Responding with a request id that belongs to childA against childB or otherRoot throws.
		await assert.rejects(
			data.service.respond({ type: "extension_ui_response", id: reqA.id, confirmed: true }, otherRoot),
			/不属于当前会话|已失效/,
		);
		await assert.rejects(
			data.service.respond({ type: "extension_ui_response", id: "non-existent-req-id", confirmed: true }, childA.conversationId),
			/不属于当前会话|已失效/,
		);

		// Add a delegatedOnly rule on the root conversation: sibling children inherit it, but the root itself and otherRoot do not.
		await data.service.upsertPermission({
			id: "tree-allow-write",
			scope: "conversation",
			conversationId: data.foregroundId,
			delegatedOnly: true,
			action: "allow",
			tool: "write",
		});
		assert.equal(
			(await data.service.checkPermission({ conversationId: childB.conversationId, toolName: "write", input: { path: "generated.txt" } })).action,
			"allow",
			"sibling child in the same delegation tree inherits delegatedOnly rule",
		);
		assert.equal(
			(await data.service.checkPermission({ conversationId: data.foregroundId, toolName: "write", input: { path: "generated.txt" } })).action,
			"ask",
			"root conversation itself is not relaxed by delegatedOnly rule",
		);
		assert.equal(
			(await data.service.checkPermission({ conversationId: otherRoot, toolName: "write", input: { path: "generated.txt" } })).action,
			"ask",
			"other root conversation is unaffected",
		);
		assert.equal(
			(await data.service.checkPermission({ conversationId: foreignChild.conversationId, toolName: "write", input: { path: "generated.txt" } })).action,
			"ask",
			"descendant of another root conversation is unaffected",
		);

		// First respond succeeds; a duplicate respond with the same id is a no-op (idempotent).
		await data.service.respond({ type: "extension_ui_response", id: reqA.id, confirmed: true }, childA.id);
		await data.service.respond({ type: "extension_ui_response", id: reqA.id, confirmed: true }, childA.conversationId);

		// stopAllTasks stops only foregroundId's active background children, leaving foreignChild running.
		const stopped = await data.service.stopAllTasks(data.foregroundId);
		assert.ok(stopped.stopped >= 1);
		const afterStop = await data.service.listTasks();
		assert.equal(afterStop.find((t) => t.id === foreignChild.id)?.status, "running");
		await data.service.cancelTask(foreignChild.id);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});
