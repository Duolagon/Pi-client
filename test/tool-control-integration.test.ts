import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
function assistant(snapshot: Snapshot, marker: string): boolean { return snapshot.messages.some((message) => message.role === "assistant" && content(message).includes(marker)); }
async function setup() {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await cp(join(here, "fixtures/delegation-provider.js"), join(fixture.agentDir, "extensions/delegation-provider.js"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "delegation-test", defaultModel: "delegation-test-1", thinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
	const git = async (...args: string[]) => exec("git", args, { cwd: project, env: gitEnv });
	await git("-c", "init.defaultBranch=main", "init");
	await git("add", "--", "seed.txt");
	await git("-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize delegation fixture");
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
		assert.ok(tools.filter((tool) => tool.modelVisible).every((tool) => ["read", "grep", "find", "ls", "TaskOutput", "TaskStop", "TaskList", "WorktreeList"].includes(tool.name)));
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
		assert.equal(snapshot.messages.filter((message) => "customType" in message && message.customType === "desktop_task_result").length, 1);
		await delay(300);
		assert.equal((await data.service.snapshot()).messages.filter((message) => "customType" in message && message.customType === "desktop_task_result").length, 1);
		await data.service.newConversation();
		const foreign = await run(data.service, `PARENT_FOREIGN ${child.id}`, "FOREIGN_RESULT DENIED");
		assert.ok(assistant(foreign, "Subagent task not found in this conversation"));
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("model TaskStop cancels only its own running child", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const snapshot = await run(data.service, "PARENT_CANCEL_TOOL", "PARENT_CANCEL_COMPLETE");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "cancelled");
		assert.ok(snapshot.messages.some((message) => message.role === "toolResult" && message.toolName === "TaskStop" && content(message).includes('"status":"cancelled"')));
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
		await data.service.command({ type: "abort" });
		const after = await data.service.listTasks();
		assert.equal(after.find((task) => task.id === child.id)?.status, "cancelled");
		assert.equal(after.find((task) => task.id === independent.id)?.status, "running");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});
