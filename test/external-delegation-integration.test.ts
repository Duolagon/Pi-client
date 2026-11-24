import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, chmod, cp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent, Message, Snapshot } from "../src/shared.ts";
import type { ExternalAdapter, ExternalEvent, ExternalProvider, ExternalSessionOptions, ExternalTurnResult } from "../src/external-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function text(message: Message): string { return !("content" in message) ? "" : typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"); }
function contains(snapshot: Snapshot, marker: string): boolean { return snapshot.messages.some((message) => message.role === "assistant" && text(message).includes(marker)); }
async function until<T>(read: () => Promise<T> | T, check: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
	const started = Date.now(); let value!: T;
	do { value = await read(); if (check(value)) return value; await delay(25); } while (Date.now() - started < timeout);
	throw new Error(`Timed out ${label}: ${String(JSON.stringify(value)).slice(-2200)}`);
}

function adapters() {
	const opened: { executor: ExternalProvider; cwd: string; resume?: string; nativeId: string; cap?: number; env: NodeJS.ProcessEnv }[] = [];
	let serial = 0;
	const create = (executor: ExternalProvider): ExternalAdapter => ({
		async open(options: ExternalSessionOptions) {
			const nativeId = options.resumeSessionId ?? `${executor}-native-${++serial}`;
			opened.push({ executor, cwd: options.cwd, resume: options.resumeSessionId, nativeId, cap: options.maxBudgetUsd, env: options.env });
			options.onEvent({ type: "session", sessionId: nativeId });
			let stopped: (() => void) | undefined;
			return {
				sessionId: nativeId,
				async run(prompt, signal): Promise<ExternalTurnResult> {
					if (prompt === "BLOCK") return new Promise((resolve) => {
						stopped = () => resolve({ status: "cancelled", text: "external cancelled", sessionId: nativeId });
						signal?.addEventListener("abort", stopped, { once: true });
						if (signal?.aborted) stopped();
					});
					if (prompt === "SLOW_DONE") await delay(400, undefined, { signal });
					if (prompt.startsWith("BILL ")) {
						options.onEvent({ type: "usage", inputTokens: 7, outputTokens: 3, sessionCostUsd: Number(prompt.slice(5)) });
						return { status: "completed", text: "accounted", sessionId: nativeId };
					}
					const path = join(options.cwd, "external-result.txt");
					options.onEvent({ type: "tool_start", id: "native-write", name: "write", input: { path } });
					const decision = await options.onPermission({ id: "native-request", kind: "file", toolName: "write", input: { path, content: prompt } }, signal);
					if (signal?.aborted) return { status: "cancelled", text: "external cancelled", sessionId: nativeId };
					if (decision.decision === "allow") await appendFile(path, `${executor}:${prompt}\n`);
					options.onEvent({ type: "tool_end", id: "native-write", isError: decision.decision !== "allow" });
					const result = `${executor}:${decision.decision}:${prompt}:${nativeId}`;
					options.onEvent({ type: "text_delta", text: result });
					return { status: "completed", text: result, sessionId: nativeId };
				},
				async interrupt() { stopped?.(); },
				async close() { stopped?.(); },
			};
		},
	});
	return { values: { codex: create("codex"), claude: create("claude"), kimi: create("kimi") }, opened };
}

async function setup(permission: "auto" | "ask" = "auto", maxConcurrentTasks = 4) {
	const fixture = await createCoreFixture(); const project = await realpath(fixture.project);
	await cp(join(here, "fixtures/external-delegation-provider.js"), join(fixture.agentDir, "extensions/external-delegation-provider.js"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "external-delegation-test", defaultModel: "external-parent", thinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
	const git = (...args: string[]) => exec("git", args, { cwd: project, env: gitEnv });
	await git("-c", "init.defaultBranch=main", "init"); await git("add", "--", "seed.txt");
	await git("-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize external delegation fixture");
	const executable = join(fixture.root, "external-version");
	await writeFile(executable, "#!/usr/bin/env node\nconsole.log('external-fixture 1.0.0');\n", { mode: 0o700 }); await chmod(executable, 0o700);
	const native = adapters();
	const options = { dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry, permissionExtension: resolve(here, "../src/permission-extension.ts"), toolControlExtension: resolve(here, "../src/tool-control-extension.ts"), env: fixture.env, initialProject: project, externalAdapters: native.values, maxConcurrentTasks };
	const service = new DesktopService(options);
	const packets: DesktopEvent[] = []; const external: ExternalEvent[] = [];
	service.subscribe((event) => packets.push(event)); service.subscribeExternal((event) => external.push(event));
	try {
		const initial = await service.initialize(); assert.equal(initial.engineStatus, "ready", initial.engineError);
		await service.saveSettings({ permission, theme: "light" });
		for (const id of ["codex", "claude", "kimi"] as const) await service.configureExternal({ id, executable, enabled: true });
		if (permission === "ask") await service.upsertPermission({ id: "allow-parent-delegation", scope: "global", action: "allow", tool: "Agent" });
		return { fixture, project, options, service, native, packets, external, parentId: initial.active!.id };
	} catch (error) { await service.close(); await fixture.cleanup(); throw error; }
}
async function run(service: DesktopService, prompt: string, marker: string) {
	await service.command({ type: "prompt", message: prompt });
	return until(() => service.snapshot(), (snapshot) => contains(snapshot, marker) && !snapshot.state?.isStreaming, marker);
}

test("real Pi model discovers local executors, delegates to each native adapter and continues its native session", { timeout: 60000 }, async () => {
	const data = await setup();
	try {
		for (const provider of ["codex", "claude", "kimi"] as const) {
			const result = await run(data.service, `EXTERNAL_CONTINUE ${provider}`, "EXTERNAL_CONTINUE_COMPLETE");
			const tasks = data.service.listExternal(result.active!.id); const task = tasks.find((item) => item.executor === provider)!;
			assert.ok(task, `No external ${provider} task for ${result.active!.id}`); assert.equal(task.status, "completed", task.error); assert.equal(task.turn, 2);
			assert.ok(task.worktreeId); assert.notEqual(task.workingDirectory, data.project);
			assert.equal(await readFile(join(task.workingDirectory, "external-result.txt"), "utf8"), `${provider}:WRITE first\n${provider}:WRITE second\n`);
			await assert.rejects(access(join(data.project, "external-result.txt")));
			const opened = data.native.opened.filter((item) => item.executor === provider);
			assert.equal(opened.length, 2); assert.equal(opened[1].resume, opened[0].nativeId); assert.equal(opened[1].cwd, opened[0].cwd);
			assert.equal(task.nativeSessionId, opened[0].nativeId);
			assert.ok(result.messages.some((message) => message.role === "toolResult" && message.toolName === "AgentSend" && text(message).includes(`${provider}:allow:WRITE second`)));
			assert.ok(result.messages.some((message) => message.role === "toolResult" && message.toolName === "AgentExecutors" && !message.isError && text(message).includes("external-fixture")));
			const replay = await data.service.replayExternal(task.id); assert.ok(replay.events.some((event) => event.event.type === "tool_start"));
			if (provider !== "kimi") await data.service.newConversation();
		}
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("native approval waits on the external task, resumes after a response and hands back once", { timeout: 45000 }, async () => {
	const data = await setup("ask");
	try {
		const pending = await run(data.service, "EXTERNAL_APPROVAL claude", "EXTERNAL_APPROVAL_RETURNED");
		const [task] = data.service.listExternal(data.parentId);
		assert.equal(task.status, "waiting_for_input"); assert.equal(task.pendingApprovals.length, 1);
		assert.equal(data.service.pendingApprovalCount(), 1);
		await assert.rejects(access(join(task.workingDirectory, "external-result.txt")));
		assert.ok(contains(pending, '"pending_approvals":1'));
		await data.service.respondExternal(task.id, task.pendingApprovals[0].id, { decision: "allow" });
		await until(() => data.service.externalSnapshot(task.id), (value) => value.status === "completed", "native task complete");
		const completed = await until(() => data.service.snapshot(), (value) => contains(value, "EXTERNAL_HANDBACK_COMPLETE") && !value.state?.isStreaming, "approval handback");
		assert.equal(data.service.pendingApprovalCount(), 0);
		assert.equal(completed.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification").length, 1);
		await until(() => data.service.listCheckpoints(data.parentId),
			(checkpoints) => checkpoints.some((checkpoint) => checkpoint.label === "后台唤醒" && checkpoint.status === "ready"), "async checkpoint sealed");
		const [checkpoint] = await data.service.listCheckpoints(task.id);
		assert.deepEqual(checkpoint.changes.map((change) => change.path), ["external-result.txt"]);
		await assert.rejects(data.service.checkpointDiff(checkpoint.id, data.parentId));
		assert.equal((await data.service.restoreCheckpoint(checkpoint.id, task.id)).status, "restored");
		await assert.rejects(access(join(task.workingDirectory, "external-result.txt")));
		await assert.rejects(data.service.respondExternal(task.id, task.pendingApprovals[0].id, { decision: "allow" }), /失效/);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("external USD budgets reserve sibling shares and account for cumulative native usage", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const proxy = "http://127.0.0.1:11784";
		await data.service.saveSettings({ permission: "auto", theme: "light", maxCostUsd: 2, proxy, noProxy: "localhost" });
		await assert.rejects(data.service.startExternal({
			executor: "codex", description: "unsupported budget", prompt: "BLOCK",
		}), /无法执行.*费用上限/);
		const first = await data.service.startExternal({ executor: "claude", description: "first budget", prompt: "BLOCK" });
		const second = await data.service.startExternal({ executor: "claude", description: "second budget", prompt: "BLOCK" });
		const opened = await until(() => data.native.opened, (items) => items.length === 2, "two budget allocations");
		assert.ok(opened.every((item) => item.cap && item.cap < 2));
		assert.ok(opened.reduce((sum, item) => sum + (item.cap ?? 0), 0) < 2);
		assert.ok(opened.every((item) => item.env.HTTPS_PROXY === proxy && item.env.NO_PROXY === "localhost"));
		await data.service.cancelExternal(first.id);
		await data.service.cancelExternal(second.id);
		const billed = await data.service.startExternal({ executor: "claude", description: "usage", prompt: "BILL 0.25" });
		await until(() => data.service.externalSnapshot(billed.id), (item) => item.status === "completed", "first usage");
		await data.service.sendExternal({ taskId: billed.id, message: "BILL 0.42" });
		await until(() => data.service.externalSnapshot(billed.id), (item) => item.status === "completed" && item.turn === 2, "second usage");
		const external = (await data.service.usageStats()).models.find((model) => model.key === "external/claude");
		assert.equal(external?.input, 14);
		assert.equal(external?.output, 6);
		assert.equal(external?.cost, 0.42);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("a foreground teammate settles idle and is woken by the next message after its runtime is reaped", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await data.service.saveSettings({ permission: "auto", theme: "light", agentTeams: true });
		await run(data.service, "TEAM_BOOT", "TEAM_BOOT_COMPLETE");
		const team = await until(() => data.service.getTeam(data.parentId),
			(value) => value?.members.some((member) => member.name === "reviewer" && member.status === "idle") === true, "foreground teammate idle");
		const memberId = team?.members.find((member) => member.name === "reviewer")?.conversationId!;
		assert.ok(memberId);
		await until(() => data.service.reapIdleChildRuntimes({ idleMs: 0 }), (count) => count === 1, "teammate runtime reaped");
		await run(data.service, "TEAM_SEND", "TEAM_SEND_COMPLETE");
		await until(() => data.service.listTasks(),
			(tasks) => tasks.some((task) => task.id === memberId && task.turn === 2 && task.status === "completed"), "fresh team turn completed");
		const teammate = await data.service.taskSnapshot(memberId);
		assert.ok(contains(teammate, "TEAM_MEMBER_WOKE"));
		assert.equal((await data.service.getTeam(data.parentId))?.messages[0].pendingConversationIds, undefined);
		assert.equal((await data.service.deleteTeam(data.parentId, "test-team")).deleted, true);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("an external Agent call rejects model and name it cannot honour and warns about ignored team fields", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const result = await run(data.service, "EXTERNAL_PARAMS codex", "EXTERNAL_PARAMS_COMPLETE");
		const answer = result.messages.filter((message) => message.role === "assistant").map(text).find((value) => value.includes("EXTERNAL_PARAMS_COMPLETE"))!;
		const [model, name, team] = answer.replace("EXTERNAL_PARAMS_COMPLETE ", "").split("\n");
		assert.match(model, /^error:.*External executors use their own configured model/);
		assert.match(name, /^error:.*External executors cannot be named/);
		assert.match(team, /^ok:/);
		assert.match(team, /Parameter 'mode' is not supported by this client and was ignored/);
		assert.match(team, /Parameter 'team_name' is not supported by this client and was ignored/);
		assert.equal(data.service.listExternal(data.parentId).length, 1, "only the valid call started an external task");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("background native results reach the parent once and another conversation cannot continue the task", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "EXTERNAL_BACKGROUND codex", "EXTERNAL_BACKGROUND_LAUNCHED");
		const completed = await until(() => data.service.snapshot(), (value) => contains(value, "EXTERNAL_HANDBACK_COMPLETE") && !value.state?.isStreaming, "native background handback");
		const [task] = data.service.listExternal(data.parentId); assert.equal(task.status, "completed");
		assert.equal(completed.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification").length, 1);
		await data.service.newConversation();
		const denied = await run(data.service, `EXTERNAL_FOREIGN ${task.id}`, "EXTERNAL_FOREIGN_COMPLETE DENIED");
		assert.ok(contains(denied, "没有该外部子任务"));
		assert.equal(data.service.externalSnapshot(task.id).turn, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("TaskStop cancels an external child; Esc keeps background externals and stop-all stops them, preserving an independent Pi task", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "EXTERNAL_CANCEL_TOOL kimi", "EXTERNAL_CANCEL_COMPLETE");
		assert.equal(data.service.listExternal(data.parentId)[0].status, "cancelled");
		const independent = await data.service.startTask({ message: "PI_MANUAL_SLOW", isolation: "worktree" });
		await until(() => data.service.taskSnapshot(independent.id), (snapshot) => Boolean(snapshot.state?.isStreaming), "independent Pi task started");
		await run(data.service, "EXTERNAL_BLOCK codex", "EXTERNAL_BLOCK_LAUNCHED");
		await until(() => data.service.listExternal(data.parentId), (tasks) => tasks.some((task) => task.executor === "codex" && task.status === "running"), "external child started");
		await data.service.command({ type: "abort" });
		// Esc only interrupts foreground work; the background external child keeps running.
		assert.equal(data.service.listExternal(data.parentId).find((task) => task.executor === "codex")?.status, "running");
		assert.deepEqual(await data.service.stopAllTasks(data.parentId), { stopped: 1 });
		assert.ok(data.service.listExternal(data.parentId).every((task) => task.status === "cancelled"));
		assert.equal((await data.service.listTasks()).find((task) => task.id === independent.id)?.status, "running");
		// The user-stopped background child is reported to the parent exactly once.
		const reported = await until(() => data.service.snapshot(), (value) => contains(value, "EXTERNAL_HANDBACK_COMPLETE") && !value.state?.isStreaming, "stopped external reported");
		assert.ok(contains(reported, "<status>stopped</status>"));
		assert.equal(reported.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification").length, 1);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("external queue wakes after a Pi task releases the shared concurrency slot", { timeout: 45000 }, async () => {
	const data = await setup("auto", 1);
	try {
		const independent = await data.service.startTask({ message: "PI_MANUAL_SLOW", isolation: "worktree" });
		await until(() => data.service.taskSnapshot(independent.id), (snapshot) => Boolean(snapshot.state?.isStreaming), "Pi capacity occupied");
		await run(data.service, "EXTERNAL_BLOCK codex", "EXTERNAL_BLOCK_LAUNCHED");
		const [task] = data.service.listExternal(data.parentId); assert.equal(task.status, "queued");
		await data.service.cancelTask(independent.id);
		await until(() => data.service.externalSnapshot(task.id), (value) => value.status === "running", "external queue resumes after Pi cancellation", 5000);
		await data.service.cancelExternal(task.id);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("desktop restart preserves the external native session and worktree for an explicit later message", { timeout: 45000 }, async () => {
	const data = await setup(); let current = data.service;
	try {
		await run(current, "EXTERNAL_CONTINUE codex", "EXTERNAL_CONTINUE_COMPLETE");
		const [original] = current.listExternal(data.parentId);
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const restored = await current.initialize(); assert.equal(restored.engineStatus, "ready", restored.engineError);
		assert.equal(current.externalSnapshot(original.id).nativeSessionId, original.nativeSessionId);
		await current.sendExternal({ taskId: original.id, message: "WRITE third" });
		const completed = await until(() => current.externalSnapshot(original.id), (task) => task.status === "completed", "resumed external task after restart");
		assert.equal(completed.nativeSessionId, original.nativeSessionId); assert.equal(completed.turn, 3);
		assert.equal(data.native.opened.at(-1)?.resume, original.nativeSessionId);
		assert.equal(await readFile(join(completed.workingDirectory, "external-result.txt"), "utf8"), "codex:WRITE first\ncodex:WRITE second\ncodex:WRITE third\n");
		const replay = await current.replayExternal(original.id, original.eventSequence);
		assert.ok(replay.events.length); assert.ok(replay.events.every((event) => event.sequence > original.eventSequence && event.turn === 3));
	} finally { await current.close(); await data.fixture.cleanup(); }
});

test("a running external task durably records its native session before completion", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "EXTERNAL_BLOCK codex", "EXTERNAL_BLOCK_LAUNCHED");
		const task = await until(() => data.service.listExternal(data.parentId)[0], (value) => Boolean(value?.nativeSessionId) && value.status === "running", "native session established");
		await until(async () => {
			const stored = JSON.parse(await readFile(join(data.fixture.dataDir, "external-agents.json"), "utf8"));
			return stored.tasks.find((item: { task: { id: string } }) => item.task.id === task.id)?.task.nativeSessionId;
		}, (value) => value === task.nativeSessionId, "running native session persisted", 2500);
		await data.service.cancelExternal(task.id);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});
