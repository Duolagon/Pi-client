import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService, type ServiceOptions } from "../src/backend.ts";
import type { DesktopTask, Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { buildPtyHelper } from "../scripts/build-pty.mjs";

// SendMessage against real Pi processes and a local scripted model (test/fixtures/resume-provider.js).
const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
let helperDirectory: string, ptyHelper: string;
before(async () => {
	helperDirectory = await mkdtemp(join(tmpdir(), "pi-resume-pty-"));
	ptyHelper = await buildPtyHelper(join(helperDirectory, "pty-host"));
});
after(async () => { await rm(helperDirectory, { recursive: true, force: true }); });

async function until<T>(read: () => Promise<T>, predicate: (result: T) => boolean, label: string, timeout = 20000): Promise<T> {
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
function assistantText(snapshot: Snapshot, marker: string): string | undefined {
	return snapshot.messages.filter((message) => message.role === "assistant").map(content).findLast((text) => text.includes(marker));
}
function notifications(snapshot: Snapshot, taskId: string): Array<{ turn: number; status: string }> {
	return snapshot.messages.flatMap((message) => {
		if (!("customType" in message) || message.customType !== "desktop_task_notification") return [];
		const details = (message as { details?: { task_id?: string; turn?: number; status?: string } }).details;
		return details?.task_id === taskId ? [{ turn: details.turn!, status: details.status! }] : [];
	});
}

async function setup() {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await cp(join(here, "fixtures/resume-provider.js"), join(fixture.agentDir, "extensions/resume-provider.js"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "resume-test", defaultModel: "resume-test-1", thinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
	const git = async (...args: string[]) => exec("git", args, { cwd: project, env: gitEnv });
	await git("-c", "init.defaultBranch=main", "init");
	await git("add", "--", "seed.txt");
	await git("-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize resume fixture");
	const options: ServiceOptions = {
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"), toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		ptyHelperPath: ptyHelper, env: fixture.env, initialProject: project,
		// Reading a reaped child's transcript uses the saved session, without a Pi process.
		historyEntry: resolve(here, "../src/session-history-entry.ts"),
		// Tests reap explicitly instead of waiting for the timer.
		childRuntimeReapIntervalMs: 0,
	};
	const service = new DesktopService(options);
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		await service.saveSettings({ permission: "auto", theme: "light" });
		return { fixture, project, options, service, parentId: initial.active!.id };
	} catch (error) { await service.close(); await fixture.cleanup(); throw error; }
}
async function say(service: DesktopService, message: string, marker: string): Promise<string> {
	await service.command({ type: "prompt", message });
	const snapshot = await until(() => service.snapshot(), (value) => Boolean(assistantText(value, marker)) && !value.state?.isStreaming, marker);
	return assistantText(snapshot, marker)!;
}
const child = async (service: DesktopService, name: string): Promise<DesktopTask> =>
	(await service.listTasks()).find((task) => task.name === name)!;
const runtimes = (service: DesktopService) => (service as unknown as { runtimes: Map<string, unknown> }).runtimes;

test("SendMessage continues a finished child with its history, after its process was reaped, and notifies each background turn once", { timeout: 90000 }, async () => {
	const data = await setup();
	try {
		// SendMessage is declared to the parent model; the AgentSend alias is callable but not declared.
		assert.match(await say(data.service, "PARENT_TOOLS_PROBE", "PARENT_TOOLS"), /sendmessage:yes agentsend:no agent:yes/);
		const started = await say(data.service, "PARENT_START tok123 fg", "PARENT_STARTED");
		assert.match(started, /CHILD_REMEMBERED tok123/);
		const first = await child(data.service, "memo");
		assert.equal(first.status, "completed");
		assert.equal(first.turn, 1);
		assert.match(started, new RegExp(`use SendMessage with to: ${first.id}`));

		// (a) The next turn sees the first turn: the child repeats the token from its own history.
		const recalled = await say(data.service, `PARENT_SEND ${first.id} fg CHILD_RECALL`, "PARENT_SENT");
		assert.match(recalled, /CHILD_RECALLED tok123 prefix:yes turns:2/);
		let task = await child(data.service, "memo");
		assert.equal(task.turn, 2);
		assert.equal(task.status, "completed");
		assert.equal(task.pendingMessage, undefined);

		// (b) An idle finished child is reaped; a message by name restarts it with its session.
		assert.ok(runtimes(data.service).has(task.conversationId));
		assert.equal(await data.service.reapIdleChildRuntimes({ idleMs: 0 }), 1);
		assert.equal(runtimes(data.service).has(task.conversationId), false);
		// Reading the result or the transcript of a reaped child does not restart it.
		assert.match((await data.service.delegatedTaskResult(task.id)).output, /CHILD_RECALLED tok123/);
		assert.ok((await data.service.taskSnapshot(task.id)).messages.length > 0);
		assert.equal(runtimes(data.service).has(task.conversationId), false);
		const restarted = await say(data.service, "PARENT_SEND memo fg CHILD_RECALL after reaping", "PARENT_SENT");
		assert.match(restarted, /CHILD_RECALLED tok123 prefix:yes turns:3/);

		// (h) Background turns are each delivered to the parent exactly once.
		const launched = await say(data.service, "PARENT_SEND memo bg CHILD_RECALL in the background", "PARENT_SENT");
		assert.match(launched, /Agent resumed in the background/);
		await until(() => data.service.snapshot(), (value) => notifications(value, task.id).length === 1 && !value.state?.isStreaming, "turn 4 notification");
		await say(data.service, "PARENT_SEND memo bg CHILD_RECALL once more", "PARENT_SENT");
		const delivered = await until(() => data.service.snapshot(), (value) => notifications(value, task.id).length === 2 && !value.state?.isStreaming, "turn 5 notification");
		assert.deepEqual(notifications(delivered, task.id), [{ turn: 4, status: "completed" }, { turn: 5, status: "completed" }]);
		await delay(500);
		assert.equal(notifications(await data.service.snapshot(), task.id).length, 2);
		task = await child(data.service, "memo");
		assert.equal(task.turn, 5);
		assert.equal(task.notifiedTurn, 5);
		assert.ok(task.turnCalls && task.turnCalls.length === 4);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("SendMessage resumes a child interrupted by an app restart", { timeout: 90000 }, async () => {
	const data = await setup();
	let current = data.service;
	try {
		await say(current, "PARENT_START_SLOW tok777", "PARENT_STARTED");
		const running = await until(() => child(current, "slowmemo"), (task) => task?.status === "running", "slow child running");
		await until(() => current.taskSnapshot(running.id), (value) => value.messages.some((message) => message.role === "user"), "child prompt persisted");
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		await current.initialize();
		const interrupted = await child(current, "slowmemo");
		assert.equal(interrupted.status, "interrupted");
		assert.equal(interrupted.stopReason, "restart");
		assert.match(interrupted.error ?? "", /可用 SendMessage 继续/);
		const recalled = await say(current, `PARENT_SEND ${interrupted.id} fg CHILD_RECALL`, "PARENT_SENT");
		assert.match(recalled, /CHILD_RECALLED tok777 prefix:yes/);
		const resumed = await child(current, "slowmemo");
		assert.equal(resumed.status, "completed");
		assert.equal(resumed.turn, 2);
	} finally { await current.close(); await data.fixture.cleanup(); }
});

test("another conversation cannot continue a child, and the user's resumed turn keeps the parent's revocations", { timeout: 90000 }, async () => {
	const data = await setup();
	try {
		await say(data.service, "PARENT_START tokD fg", "PARENT_STARTED");
		const first = await child(data.service, "memo");
		// (d) A different conversation addresses neither the id nor the name.
		await data.service.newConversation();
		const foreign = await say(data.service, `PARENT_SEND ${first.id} fg CHILD_RECALL`, "PARENT_SENT");
		assert.match(foreign, /PARENT_SENT ERROR .*not found in this conversation/);
		const byName = await say(data.service, "PARENT_SEND memo fg CHILD_RECALL", "PARENT_SENT");
		assert.match(byName, /PARENT_SENT ERROR .*not found in this conversation/);
		assert.equal((await child(data.service, "memo")).turn, 1);
		await data.service.selectConversation(data.parentId);

		// (g) After the parent's mode became read-only, the continued child cannot write.
		await data.service.saveSettings({ permission: "read", theme: "light" });
		const sent = await data.service.sendToTask({ taskId: first.id, message: "CHILD_WRITE_PROBE" });
		assert.equal(sent.status, "resumed");
		const probed = await until(() => child(data.service, "memo"), (task) => task.turn === 2 && task.status === "completed", "write probe turn");
		assert.match(probed.result?.text ?? "", /CHILD_WRITE_DENIED/);
		await assert.rejects(access(join(probed.workingDirectory, "resume-write.txt")));
		// The user's own turn is not delivered to the parent unless asked.
		assert.equal(probed.notifySuppressed, true);
		assert.equal(notifications(await data.service.snapshot(), first.id).length, 0);
		await assert.rejects(data.service.sendToTask({ taskId: first.id, message: " " }), /消息内容无效/);
		// A message typed into the finished child's own conversation is its next turn, sent as typed.
		const direct = await data.service.command({ type: "prompt", message: "CHILD_RECALL typed by the user" }, first.conversationId) as { disposition: string };
		assert.equal(direct.disposition, "started");
		const typed = await until(() => child(data.service, "memo"), (task) => task.turn === 3 && task.status === "completed", "typed turn");
		assert.match(typed.result?.text ?? "", /CHILD_RECALLED tokD prefix:no/);
		assert.equal(typed.notifySuppressed, true);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("SendMessage to a running child reaches it before its next model call", { timeout: 90000 }, async () => {
	const data = await setup();
	try {
		await say(data.service, "PARENT_STEER_START", "PARENT_STARTED");
		const running = await until(() => child(data.service, "steer"), (task) => task?.status === "running", "steerable child running");
		await until(() => data.service.taskSnapshot(running.id), (value) => value.messages.filter((message) => message.role === "toolResult").length >= 2, "child tool rounds");
		// (f) The message is steered into the running run, marked as coming from the parent.
		const sent = await say(data.service, "PARENT_SEND steer bg STEER_TOKEN_abc", "PARENT_SENT");
		assert.match(sent, /Message delivered to the running agent/);
		const done = await until(() => child(data.service, "steer"), (task) => task.status === "completed", "steered child completes", 30000);
		assert.match(done.result?.text ?? "", /CHILD_STEERED STEER_TOKEN_abc prefix:yes/);
		assert.equal(done.turn, 1);
		// Its single turn is delivered once.
		const delivered = await until(() => data.service.snapshot(), (value) => notifications(value, done.id).length === 1 && !value.state?.isStreaming, "steered notification");
		assert.deepEqual(notifications(delivered, done.id), [{ turn: 1, status: "completed" }]);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});
