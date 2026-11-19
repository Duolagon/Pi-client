import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent, Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { buildPtyHelper } from "../scripts/build-pty.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
let helperDirectory: string, ptyHelper: string;
before(async () => {
	helperDirectory = await mkdtemp(join(tmpdir(), "pi-delegation-pty-"));
	ptyHelper = await buildPtyHelper(join(helperDirectory, "pty-host"));
});
after(async () => { await rm(helperDirectory, { recursive: true, force: true }); });
async function until<T>(read: () => Promise<T>, predicate: (result: T) => boolean, label: string, timeout = 15000): Promise<T> {
	const started = Date.now();
	let result: T;
	do {
		result = await read();
		if (predicate(result)) return result;
		await delay(30);
	} while (Date.now() - started < timeout);
	throw new Error(`Timed out: ${label}; latest ${JSON.stringify(result).slice(-1800)}`);
}
function content(message: Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function notifications(snapshot: Snapshot): Message[] {
	return snapshot.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification");
}
function assistant(snapshot: Snapshot, marker: string): boolean { return snapshot.messages.some((message) => message.role === "assistant" && content(message).includes(marker)); }
async function setup(options_: { git?: boolean; userMemory?: string; piSettings?: Record<string, unknown> } = {}) {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await cp(join(here, "fixtures/delegation-provider.js"), join(fixture.agentDir, "extensions/delegation-provider.js"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "delegation-test", defaultModel: "delegation-test-1", thinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false }, ...options_.piSettings }));
	if (options_.userMemory !== undefined) {
		// An isolated HOME holds the user's ~/.claude/CLAUDE.md for this test only.
		const home = join(fixture.root, "home");
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(join(home, ".claude", "CLAUDE.md"), options_.userMemory);
		fixture.env.HOME = home;
	}
	const git = async (...args: string[]) => exec("git", args, { cwd: project, env: gitEnv });
	if (options_.git !== false) {
		await git("-c", "init.defaultBranch=main", "init");
		await git("add", "--", "seed.txt");
		await git("-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize delegation fixture");
	}
	const options = { dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry, permissionExtension: resolve(here, "../src/permission-extension.ts"), toolControlExtension: resolve(here, "../src/tool-control-extension.ts"), ptyHelperPath: ptyHelper, env: fixture.env, initialProject: project };
	const service = new DesktopService(options);
	const packets: DesktopEvent[] = [];
	service.subscribe((packet) => packets.push(packet));
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		await service.saveSettings({ permission: "auto", theme: "light" });
		return { fixture, project, options, service, packets, parentId: initial.active!.id };
	} catch (error) { await service.close(); await fixture.cleanup(); throw error; }
}
async function run(service: DesktopService, message: string, marker: string) {
	await service.command({ type: "prompt", message });
	return until(() => service.snapshot(), (snapshot) => assistant(snapshot, marker) && !snapshot.state?.isStreaming, marker);
}

test("real Pi tool inventory and toggles persist and deny actual shell and file writes", { timeout: 45000 }, async () => {
	const data = await setup();
	let current = data.service;
	try {
		const initial = await current.listTools();
		assert.deepEqual(initial.filter((tool) => tool.source === "builtin" && tool.modelVisible).map((tool) => tool.name).sort(), ["bash", "edit", "read", "write"]);
		assert.equal(initial.find((tool) => tool.name === "Agent")?.source, "desktop");
		assert.ok(!(await current.snapshot()).commands.some((command) => command.name.startsWith("desktop-tools-")));
		await current.setToolEnabled({ name: "bash", enabled: false, scope: "global" });
		await current.setToolEnabled({ name: "grep", enabled: true, scope: "conversation" });
		await run(current, "PROBE_BASH", "PROBE_BASH_DENIED");
		await assert.rejects(access(join(data.project, "bash-probe.txt")));
		await current.upsertPermission({ id: "deny-a-real-file", scope: "project", project: data.project, action: "deny", tool: "write", path: "denied.txt" });
		await run(current, "PROBE_WRITE", "PROBE_WRITE_DENIED");
		await assert.rejects(access(join(data.project, "denied.txt")));
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		await current.initialize();
		const restored = await current.listTools();
		assert.equal(restored.find((tool) => tool.name === "bash")?.enabled, false);
		assert.equal(restored.find((tool) => tool.name === "grep")?.modelVisible, true);
		assert.equal((await current.permissionSettings()).effective.rules.find((rule) => rule.id === "deny-a-real-file")?.action, "deny");
		await current.setToolEnabled({ name: "bash", enabled: null, scope: "global" });
		assert.equal((await current.listTools()).find((tool) => tool.name === "bash")?.modelVisible, true);
		await run(current, "PROBE_BASH enabled", "PROBE_BASH_ALLOWED");
		assert.equal(await readFile(join(data.project, "bash-probe.txt"), "utf8"), "actual-command");
	} finally { await current.close(); await data.fixture.cleanup(); }
});

test("model Agent delegates to real read-only Pi child and returns its result to the parent model", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_EXPLORE", "PARENT_EXPLORE_COMPLETE");
		const tasks = await data.service.listTasks();
		assert.equal(tasks.length, 1);
		const child = tasks[0];
		assert.equal(child.parentConversationId, data.parentId);
		assert.equal(child.subagentType, "Explore");
		assert.equal(child.readOnly, true);
		assert.equal(child.status, "completed");
		assert.ok(child.parentToolCallId);
		assert.ok(assistant(snapshot, "CHILD_EXPLORE_COMPLETE read:ok,write:error,bash:error,Agent:error"));
		const tools = await data.service.listTools(child.conversationId);
		assert.ok(tools.filter((tool) => tool.modelVisible).every((tool) => ["read", "grep", "find", "ls", "TaskOutput", "TaskStop", "TaskList", "WorktreeList", "TodoGet", "TodoList"].includes(tool.name)));
		assert.ok(!tools.find((tool) => tool.name === "Agent")?.enabled);
		assert.ok(!tools.find((tool) => tool.name === "bash")?.enabled);
		await assert.rejects(access(join(data.project, "child-forbidden.txt")));
		await assert.rejects(access(join(data.project, "child-command-forbidden.txt")));
		const output = await data.service.delegatedTaskResult(child.id);
		assert.equal(output.status, "completed");
		assert.equal(output.parent_tool_call_id, child.parentToolCallId);
		assert.match(output.output, /read:ok/);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("model general-purpose Agent writes in its worktree and returns structured result", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_IMPLEMENT", "PARENT_IMPLEMENT_COMPLETE");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "completed");
		assert.equal(child.readOnly, false);
		assert.ok(child.worktreeId);
		assert.notEqual(child.workingDirectory, data.project);
		assert.equal(await readFile(join(child.workingDirectory, "child-output.txt"), "utf8"), "real child worktree write\n");
		await assert.rejects(access(join(data.project, "child-output.txt")));
		assert.ok(assistant(snapshot, "CHILD_IMPLEMENT_COMPLETE write:ok"));
		assert.ok(snapshot.messages.some((message) => message.role === "toolResult" && message.toolName === "Agent" && content(message).includes(child.id)));
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("background child result automatically reaches parent once and other models cannot read it", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "PARENT_BACKGROUND", "BACKGROUND_LAUNCHED");
		const snapshot = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "background handback", 20000);
		const [child] = await data.service.listTasks();
		assert.equal(child.runInBackground, true);
		assert.equal(child.status, "completed");
		assert.equal(snapshot.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification").length, 1);
		await delay(300);
		assert.equal((await data.service.snapshot()).messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification").length, 1);
		await data.service.newConversation();
		const foreign = await run(data.service, `PARENT_FOREIGN ${child.id}`, "FOREIGN_RESULT DENIED");
		assert.ok(assistant(foreign, "Subagent task not found in this conversation"));
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("model TaskStop cancels only its own running child and is not notified again", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_CANCEL_TOOL", "PARENT_CANCEL_COMPLETE");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "cancelled");
		assert.equal(child.stopReason, "model_stop");
		assert.equal(child.notifySuppressed, true);
		assert.ok(snapshot.messages.some((message) => message.role === "toolResult" && message.toolName === "TaskStop" && content(message).includes('"status":"cancelled"')));
		await delay(500);
		const after = await data.service.snapshot();
		assert.equal(notifications(after).length, 0, "the TaskStop result already told the model");
		assert.equal(after.pendingTaskNotifications, undefined);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a result finished while the parent was stopped waits for the user and is delivered once", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "PARENT_BACKGROUND", "BACKGROUND_LAUNCHED");
		// Leaving the idle parent stops its runtime; the child keeps running.
		await data.service.newConversation();
		const [child] = await until(() => data.service.listTasks(), (tasks) => tasks[0]?.status === "completed", "child completed without parent");
		assert.equal(child.notifiedTurn, undefined);
		const reopened = await data.service.selectConversation(data.parentId);
		assert.equal(reopened.pendingTaskNotifications, 1);
		await delay(600);
		const idle = await data.service.snapshot();
		assert.ok(!idle.state?.isStreaming, "reopening never starts a run");
		assert.ok(!assistant(idle, "BACKGROUND_HANDBACK_COMPLETE"));
		assert.equal(notifications(idle).length, 0, "queued for the next turn, not appended yet");
		assert.equal((await data.service.listTasks())[0].notifiedTurn, undefined);
		assert.deepEqual(await data.service.deliverTaskNotifications(data.parentId), { pending: 0 });
		const delivered = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "delivered on request");
		assert.equal(notifications(delivered).length, 1);
		assert.equal((await data.service.listTasks())[0].notifiedTurn, 1);
		assert.equal(delivered.pendingTaskNotifications, undefined);
		await delay(300);
		assert.equal(notifications(await data.service.snapshot()).length, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a child interrupted by an app restart is reported once with the parent's next message", { timeout: 60000 }, async () => {
	const data = await setup();
	let current = data.service;
	try {
		await run(current, "PARENT_BACKGROUND_LONG", "BACKGROUND_LAUNCHED");
		await until(() => current.listTasks(), (tasks) => tasks[0]?.status === "running", "long child running");
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const restored = await current.initialize();
		assert.equal(restored.active?.id, data.parentId);
		assert.equal(restored.pendingTaskNotifications, 1);
		const [child] = await current.listTasks();
		assert.equal(child.status, "interrupted");
		assert.equal(child.stopReason, "restart");
		await delay(500);
		assert.ok(!assistant(await current.snapshot(), "BACKGROUND_HANDBACK_COMPLETE"), "a restored parent is not woken");
		const answered = await run(current, "PARENT_NEXT_MESSAGE", "BACKGROUND_HANDBACK_COMPLETE");
		const handback = answered.messages.find((message) => message.role === "assistant" && content(message).includes("BACKGROUND_HANDBACK_COMPLETE"))!;
		assert.match(content(handback), /<status>stopped<\/status>/);
		assert.match(content(handback), /desktop app restarted/);
		assert.equal(notifications(answered).length, 1);
		assert.equal((await current.listTasks())[0].notifiedTurn, 1);
		// A second restart finds nothing left to deliver.
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const again = await current.initialize();
		assert.equal(again.pendingTaskNotifications, undefined);
	} finally { await current.close(); await data.fixture.cleanup(); }
});

test("a user stop in the task drawer reports the stopped child to a live parent", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "PARENT_BACKGROUND_LONG", "BACKGROUND_LAUNCHED");
		const [child] = await until(() => data.service.listTasks(), (tasks) => tasks[0]?.status === "running", "long child running");
		// Let the child stream part of its answer before the user stops it.
		await delay(3000);
		await data.service.cancelTask(child.id);
		const snapshot = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "stopped handback");
		const handback = snapshot.messages.find((message) => message.role === "assistant" && content(message).includes("BACKGROUND_HANDBACK_COMPLETE"))!;
		assert.match(content(handback), /<status>stopped<\/status>/);
		assert.match(content(handback), /stopped by the user/);
		// The stop is delivered after the child recorded what it had done, not as an empty result.
		assert.match(content(handback), /CHILD_SLOW_COMPLETE independent work/);
		assert.doesNotMatch(content(handback), /returned no output/);
		assert.equal(notifications(snapshot).length, 1);
		const [stopped] = await data.service.listTasks();
		assert.equal(stopped.stopReason, "user_stop");
		assert.equal(stopped.notifiedTurn, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("Esc on the parent leaves a background child running to completion", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "PARENT_BACKGROUND", "BACKGROUND_LAUNCHED");
		await data.service.command({ type: "abort" });
		assert.equal((await data.service.listTasks())[0].status, "running");
		const snapshot = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "handback after Esc");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "completed");
		assert.equal(notifications(snapshot).length, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a child that finishes while the parent streams survives Esc on the parent and is delivered once", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await data.service.command({ type: "prompt", message: "PARENT_STREAMING_BACKGROUND" });
		const [child] = await until(() => data.service.listTasks(), (tasks) => tasks[0]?.status === "completed", "quick child completed", 30000);
		await delay(300);
		const streaming = await data.service.snapshot();
		assert.ok(streaming.state?.isStreaming, "the parent is still mid-run");
		assert.equal((await data.service.listTasks())[0].notifiedTurn, undefined, "not counted as delivered while only Pi's memory would hold it");
		await data.service.command({ type: "abort" });
		const snapshot = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "handback after Esc", 20000);
		assert.match(content(snapshot.messages.find((message) => message.role === "assistant" && content(message).includes("BACKGROUND_HANDBACK_COMPLETE"))!), /CHILD_QUICK_COMPLETE quick result/);
		assert.equal(notifications(snapshot).length, 1);
		assert.equal((await data.service.listTasks()).find((task) => task.id === child.id)?.notifiedTurn, 1);
		await delay(300);
		assert.equal(notifications(await data.service.snapshot()).length, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a result whose automatic retries ran out is delivered when the parent's next run settles", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "PARENT_BACKGROUND", "BACKGROUND_LAUNCHED");
		const [running] = await data.service.listTasks();
		assert.equal(running.status, "running");
		// Simulate five failed control calls for this result.
		(data.service as unknown as { notifyAttempts: Map<string, number> }).notifyAttempts.set(`${running.id}:1`, 5);
		await until(() => data.service.listTasks(), (tasks) => tasks[0]?.status === "completed", "child completed");
		const held = await until(() => data.service.snapshot(), (value) => value.pendingTaskNotifications === 1, "held after exhausted retries");
		assert.equal(notifications(held).length, 0);
		await run(data.service, "PARENT_PING", "UNEXPECTED_PROMPT");
		const delivered = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "delivered after settle", 20000);
		assert.equal(notifications(delivered).length, 1);
		assert.equal((await data.service.listTasks())[0].notifiedTurn, 1);
		assert.equal(delivered.pendingTaskNotifications, undefined);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("model creates, safely merges, and removes an idle owned worktree while its parent is running", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_WORKTREE", "WORKTREE_COMPLETE");
		const results = snapshot.messages.filter((message) => message.role === "toolResult");
		assert.deepEqual(results.map((message) => [message.toolName, Boolean(message.isError)]), [["WorktreeCreate", false], ["WorktreeMerge", false], ["WorktreeRemove", false]]);
		assert.match(content(results[1]), /"status":"up-to-date"/);
		assert.equal((await data.service.listWorktrees()).length, 0);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("model worktree merge and removal remain blocked by another terminal", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const terminal = await data.service.createTerminal({ conversationId: data.parentId, shell: "/bin/sh" });
		const snapshot = await run(data.service, "PARENT_WORKTREE terminal-active", "WORKTREE_COMPLETE");
		const results = snapshot.messages.filter((message) => message.role === "toolResult");
		assert.match(content(results[1]), /"status":"blocked"/);
		assert.equal(results[2].isError, true);
		assert.equal((await data.service.listWorktrees()).length, 1);
		await data.service.closeTerminal(terminal.id);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("active shared child blocks model worktree mutations and stopping parent preserves independent tasks", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const independent = await data.service.startTask({ message: "CHILD_SLOW_LONG independent" });
		await until(() => data.service.taskSnapshot(independent.id), (snapshot) => Boolean(snapshot.state?.isStreaming), "independent task started");
		const snapshot = await run(data.service, "PARENT_WORKTREE_CHILD", "WORKTREE_CHILD_COMPLETE");
		const results = snapshot.messages.filter((message) => message.role === "toolResult");
		assert.match(content(results[2]), /"status":"blocked"/);
		assert.equal(results[3].isError, true);
		const tasks = await data.service.listTasks();
		const child = tasks.find((task) => task.parentConversationId === data.parentId)!;
		assert.equal(child.status, "running");
		// Esc stops only foreground children; the background child and the manual task keep running.
		await data.service.command({ type: "abort" });
		const after = await data.service.listTasks();
		assert.equal(after.find((task) => task.id === child.id)?.status, "running");
		assert.equal(after.find((task) => task.id === independent.id)?.status, "running");
		// "停止全部后台子 Agent" stops only this conversation's own background children.
		await assert.rejects(data.service.stopAllTasks("missing-conversation"), /会话不存在/);
		assert.deepEqual(await data.service.stopAllTasks(data.parentId), { stopped: 1 });
		const stopped = await data.service.listTasks();
		assert.equal(stopped.find((task) => task.id === child.id)?.status, "cancelled");
		assert.equal(stopped.find((task) => task.id === child.id)?.stopReason, "user_stop");
		assert.equal(stopped.find((task) => task.id === independent.id)?.status, "running");
		await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "stopped child reported");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("Agent defaults to the background and returns at once; the result arrives once as a notification", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_DEFAULT_BACKGROUND", "PARENT_DEFAULT_LAUNCHED");
		const [child] = await data.service.listTasks();
		assert.equal(child.subagentType, "general-purpose", "an omitted subagent_type is general-purpose");
		assert.equal(child.runInBackground, true);
		assert.ok(child.worktreeId, "a writable child in Git keeps worktree isolation");
		const launched = snapshot.messages.find((message) => message.role === "toolResult" && message.toolName === "Agent")!;
		assert.match(content(launched), /^Async agent launched successfully\./);
		assert.ok(content(launched).includes(`agentId: ${child.id}`));
		const delivered = await until(() => data.service.snapshot(), (value) => assistant(value, "BACKGROUND_HANDBACK_COMPLETE") && !value.state?.isStreaming, "default background handback", 30000);
		assert.equal(notifications(delivered).length, 1);
		const [finished] = await data.service.listTasks();
		assert.equal(finished.status, "completed");
		await delay(300);
		const final = await data.service.snapshot();
		assert.equal(notifications(final).length, 1);
		// The background child's run is counted into the parent's session once, like a foreground one.
		assert.ok(finished.stats && finished.stats.tokens.total > 0);
		const stats = await data.service.command({ type: "get_session_stats" }) as { tokens: { total: number } };
		const own = final.messages
			.filter((message) => message.role === "assistant")
			.reduce((sum, message) => sum + ((message as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0), 0);
		assert.equal(stats.tokens.total, own + finished.stats.tokens.total, "the parent's statistics include the background child's tokens exactly once");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a foreground Agent result has the agentId trailer and usage, and child tokens count into the parent session", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_IMPLEMENT", "PARENT_IMPLEMENT_COMPLETE");
		const [child] = await data.service.listTasks();
		assert.ok(child.stats && child.stats.tokens.total > 0, "the child's run usage is recorded");
		assert.ok(child.stats.toolUses >= 1);
		const result = snapshot.messages.find((message) => message.role === "toolResult" && message.toolName === "Agent")!;
		const text = content(result);
		assert.match(text, /CHILD_IMPLEMENT_COMPLETE write:ok/);
		assert.ok(text.includes(`agentId: ${child.id}`));
		assert.match(text, /worktreePath: /);
		assert.match(text, new RegExp(`<usage>subagent_tokens: ${child.stats.tokens.total}\\ntool_uses: ${child.stats.toolUses}\\nduration_ms: \\d+</usage>`));
		assert.equal((result as { usage?: { totalTokens: number } }).usage?.totalTokens, child.stats.tokens.total);
		const stats = await data.service.command({ type: "get_session_stats" }) as { tokens: { total: number } };
		const own = snapshot.messages
			.filter((message) => message.role === "assistant")
			.reduce((sum, message) => sum + ((message as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0), 0);
		assert.ok(stats.tokens.total >= own + child.stats.tokens.total, "the parent's session statistics include the child's tokens");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("agent definitions are listed to the parent and become the child's system prompt, not its first message", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		await data.service.saveAgent({ name: "prober", description: "Probes where its definition lands", prompt: "PROBE_DEFINITION_BODY Report the probe.", tools: ["read"], scope: "user" });
		await run(data.service, "PARENT_LISTING", "PARENT_LISTING_COMPLETE");
		const listed = await data.service.snapshot();
		assert.ok(assistant(listed, "PARENT_LISTING_COMPLETE listing:yes probe:yes explore:yes"), JSON.stringify(listed.messages.filter((message) => message.role === "assistant").map(content)));
		const custom = await run(data.service, "PARENT_PROBE_DEFINITION", "PARENT_PROBE_DEFINITION_COMPLETE");
		assert.ok(assistant(custom, "CHILD_PROMPT_PROBE_COMPLETE system:yes builtin:no user:no listing:no"));
		const builtin = await run(data.service, "PARENT_PROBE_BUILTIN", "PARENT_PROBE_BUILTIN_COMPLETE");
		assert.ok(assistant(builtin, "CHILD_PROMPT_PROBE_COMPLETE system:no builtin:yes user:no listing:no"));
		const tasks = await data.service.listTasks();
		for (const task of tasks) {
			assert.equal(task.prompt, "CHILD_PROMPT_PROBE", "the first user message carries only the task");
			assert.equal(task.systemPromptFile, join(data.fixture.dataDir, "agent-prompts", `${task.id}.md`));
			assert.equal((await stat(task.systemPromptFile!)).mode & 0o777, 0o600);
		}
		// A removed definition disappears from the next turn's listing.
		await data.service.removeAgent({ name: "prober", scope: "user" });
		await run(data.service, "PARENT_LISTING again", "PARENT_LISTING_COMPLETE listing:yes probe:no");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("the agent listing is a prompt section next to user memory, not a forced replacement prompt", { timeout: 45000 }, async () => {
	const data = await setup({ userMemory: "USER_MEMORY_MARKER Always answer briefly.\n" });
	try {
		const first = await run(data.service, "PARENT_MEMORY_PROBE", "PARENT_MEMORY_PROBE_COMPLETE");
		assert.ok(assistant(first, "PARENT_MEMORY_PROBE_COMPLETE listing:yes memory:yes tools:yes"), JSON.stringify(first.messages.filter((message) => message.role === "assistant").map(content)));
		// A later run keeps both: nothing is frozen into a per-run opaque prompt.
		await data.service.command({ type: "prompt", message: "PARENT_MEMORY_PROBE again" });
		const second = await until(() => data.service.snapshot(), (value) => value.messages.filter((message) => message.role === "assistant" && content(message).includes("PARENT_MEMORY_PROBE_COMPLETE")).length === 2 && !value.state?.isStreaming, "second probe");
		const answers = second.messages.filter((message) => message.role === "assistant").map(content).filter((text) => text.includes("PARENT_MEMORY_PROBE_COMPLETE"));
		assert.deepEqual(answers, ["PARENT_MEMORY_PROBE_COMPLETE listing:yes memory:yes tools:yes", "PARENT_MEMORY_PROBE_COMPLETE listing:yes memory:yes tools:yes"]);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("outside Git a writable Agent defaults to the foreground and writes the shared project while the parent waits", { timeout: 45000 }, async () => {
	const data = await setup({ git: false });
	try {
		const snapshot = await run(data.service, "PARENT_DEFAULT_BACKGROUND", "PARENT_DEFAULT_LAUNCHED");
		const [child] = await data.service.listTasks();
		assert.equal(child.runInBackground, false);
		assert.equal(child.worktreeId, undefined);
		assert.equal(child.workingDirectory, data.project);
		assert.equal(child.status, "completed");
		assert.equal(await readFile(join(data.project, "child-output.txt"), "utf8"), "real child worktree write\n");
		assert.ok(assistant(snapshot, "PARENT_DEFAULT_LAUNCHED CHILD_IMPLEMENT_COMPLETE write:ok"));
		await delay(300);
		assert.equal(notifications(await data.service.snapshot()).length, 0, "a foreground result is not delivered again");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a foreground shared writer outlasts Pi's HTTP idle timeout instead of being cancelled", { timeout: 60000 }, async () => {
	// Pi's fetch dispatcher would time the tool host request out after httpIdleTimeoutMs.
	const data = await setup({ git: false, piSettings: { httpIdleTimeoutMs: 1000 } });
	try {
		const snapshot = await run(data.service, "PARENT_FOREGROUND_SLOW", "PARENT_FOREGROUND_SLOW_COMPLETE");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "completed", JSON.stringify({ status: child.status, stopReason: child.stopReason, error: child.error }));
		assert.equal(child.runInBackground, false);
		assert.ok((child.stats?.durationMs ?? 0) > 1500, `the child ran longer than the client timeout (${child.stats?.durationMs} ms)`);
		assert.ok(assistant(snapshot, "PARENT_FOREGROUND_SLOW_COMPLETE Agent:ok:CHILD_SLOW_COMPLETE"), JSON.stringify(snapshot.messages.filter((message) => message.role === "assistant").map(content)));
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a shared writer is refused when the parent writes in the same tool batch; a read-only agent is not", { timeout: 60000 }, async () => {
	const data = await setup({ git: false });
	try {
		const refused = await run(data.service, "PARENT_MIXED_BATCH", "PARENT_MIXED_BATCH_COMPLETE");
		assert.ok(assistant(refused, "PARENT_MIXED_BATCH_COMPLETE Agent:error:A writable subagent in this shared directory must be the only file-changing tool call in its message"),
			JSON.stringify(refused.messages.filter((message) => message.role === "assistant").map(content)));
		assert.ok(assistant(refused, "write:ok"));
		assert.deepEqual(await data.service.listTasks(), [], "no child started beside the parent's write");
		await assert.rejects(access(join(data.project, "child-output.txt")));
		await data.service.command({ type: "prompt", message: "PARENT_MIXED_BATCH EXPLORE" });
		const allowed = await until(() => data.service.snapshot(), (value) => value.messages.filter((message) => message.role === "assistant" && content(message).includes("PARENT_MIXED_BATCH_COMPLETE")).length === 2 && !value.state?.isStreaming, "read-only beside a write");
		const answer = allowed.messages.filter((message) => message.role === "assistant").map(content).filter((text) => text.includes("PARENT_MIXED_BATCH_COMPLETE")).at(-1)!;
		assert.match(answer, /Agent:ok:CHILD_QUICK_COMPLETE/);
		assert.equal((await data.service.listTasks())[0].readOnly, true);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("the background default and foreground wait are validated settings", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await assert.rejects(data.service.saveSettings({ permission: "auto", theme: "light", foregroundSubagentTimeoutMs: -1 }), /前台子 Agent 等待时长无效/);
		await assert.rejects(data.service.saveSettings({ permission: "auto", theme: "light", foregroundSubagentTimeoutMs: 1.5 }), /前台子 Agent 等待时长无效/);
		const saved = await data.service.saveSettings({ permission: "auto", theme: "light", subagentDefaultBackground: false, foregroundSubagentTimeoutMs: 0 });
		assert.equal(saved.settings.subagentDefaultBackground, false);
		assert.equal(saved.settings.foregroundSubagentTimeoutMs, 0);
		// With the default switched off, an Agent call without run_in_background waits for its result.
		const snapshot = await run(data.service, "PARENT_DEFAULT_BACKGROUND", "PARENT_DEFAULT_LAUNCHED");
		const [child] = await data.service.listTasks();
		assert.equal(child.runInBackground, false);
		assert.ok(child.worktreeId);
		assert.ok(assistant(snapshot, "PARENT_DEFAULT_LAUNCHED CHILD_IMPLEMENT_COMPLETE write:ok"));
		await data.service.close();
		const reopened = new DesktopService({ ...data.options, initialProject: undefined });
		data.service = reopened;
		const restored = await reopened.initialize();
		assert.equal(restored.settings.subagentDefaultBackground, false);
		assert.equal(restored.settings.foregroundSubagentTimeoutMs, 0);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});
