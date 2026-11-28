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
import { candidateDelta, groupExternalComparisons } from "../src/renderer/external-comparisons.ts";
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
	const opened: { executor: ExternalProvider; cwd: string; resume?: string; nativeId: string; cap?: number; env: NodeJS.ProcessEnv; model?: string; effort?: string; mode: string }[] = [];
	const prompts: { nativeId: string; prompt: string }[] = [];
	let serial = 0;
	const create = (executor: ExternalProvider): ExternalAdapter => ({
		async open(options: ExternalSessionOptions) {
			const nativeId = options.resumeSessionId ?? `${executor}-native-${++serial}`;
			opened.push({ executor, cwd: options.cwd, resume: options.resumeSessionId, nativeId, cap: options.maxBudgetUsd, env: options.env,
				model: options.model, effort: options.effort, mode: options.policy.mode });
			options.onEvent({ type: "session", sessionId: nativeId });
			let stopped: (() => void) | undefined;
			return {
				sessionId: nativeId,
				async run(prompt, signal): Promise<ExternalTurnResult> {
					prompts.push({ nativeId, prompt });
					if (prompt.startsWith("Review this patch independently")) {
						const file = join(options.cwd, "forbidden-review-write.txt");
						const decision = await options.onPermission({ id: "review-writing", kind: "file", toolName: "write", input: { path: file, content: "fixture" } }, signal);
						assert.equal(decision.decision, "deny", "independent review must enforce a read-only policy");
						return { status: "completed", text: "INDEPENDENT_REVIEW_REPORT", sessionId: nativeId };
					}
					if (prompt.startsWith("STRUCTURED_OUTPUT")) {
						if (executor === "claude") {
							assert.equal(options.outputSchema?.type, "object");
							return { status: "completed", text: "", structuredOutput: { count: 7 }, sessionId: nativeId };
						}
						assert.equal(executor === "codex" ? options.outputSchema?.type : prompt.includes("JSON Schema"), executor === "codex" ? "object" : true);
						return { status: "completed", text: '{"count":7}', sessionId: nativeId };
					}
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
					const path = join(options.cwd, prompt === "REVIEW_FOLLOWUP" ? "followup-result.txt" : "external-result.txt");
					options.onEvent({ type: "tool_start", id: "native-write", name: "write", input: { path } });
					const decision = await options.onPermission({ id: "native-request", kind: "file", toolName: "write", input: { path, content: prompt } }, signal);
					if (signal?.aborted) return { status: "cancelled", text: "external cancelled", sessionId: nativeId };
					if (decision.decision === "allow") await appendFile(path, prompt === "ORIGINAL_CANDIDATE_REQUIREMENT"
						? "same candidate change\n" : `${executor}:${prompt}\n`);
					options.onEvent({ type: "tool_end", id: "native-write", isError: decision.decision !== "allow" });
					const result = `IMPLEMENTATION_REPORT ${executor}:${decision.decision}:${prompt}:${nativeId}`;
					options.onEvent({ type: "text_delta", text: result });
					return { status: "completed", text: result, sessionId: nativeId };
				},
				async interrupt() { stopped?.(); },
				async close() { stopped?.(); },
			};
		},
	});
	return { values: { codex: create("codex"), claude: create("claude"), kimi: create("kimi") }, opened, prompts };
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

test("external Agent and TaskOutput return the validated structured result through the real tool host", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		for (const executor of ["codex", "claude", "kimi"]) {
			const snapshot = await run(data.service, `EXTERNAL_STRUCTURED ${executor}`, "EXTERNAL_STRUCTURED_COMPLETE");
			assert.ok(contains(snapshot, 'EXTERNAL_STRUCTURED_COMPLETE [{"count":7},{"count":7}]'));
			if (executor !== "kimi") await data.service.newConversation();
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

test("an external Agent call applies its model and effort, rejects invalid identifiers and names, and warns about ignored team fields", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const result = await run(data.service, "EXTERNAL_PARAMS codex", "EXTERNAL_PARAMS_COMPLETE");
		const answer = result.messages.filter((message) => message.role === "assistant").map(text).find((value) => value.includes("EXTERNAL_PARAMS_COMPLETE"))!;
		const [model, invalidModel, name, team] = answer.replace("EXTERNAL_PARAMS_COMPLETE ", "").split("\n");
		assert.match(model, /^ok:.*"status":"completed"/);
		assert.ok(data.native.opened.some((item) => item.executor === "codex" && item.model === "fixture-model" && item.effort === "high"));
		assert.match(invalidModel, /^error:.*模型标识无效/);
		assert.match(name, /^error:.*External executors cannot be named/);
		assert.match(team, /^ok:/);
		assert.match(team, /Parameter 'mode' is not supported by this client and was ignored/);
		assert.match(team, /Parameter 'team_name' is not supported by this client and was ignored/);
		assert.equal(data.service.listExternal(data.parentId).length, 2, "only the valid calls started external tasks");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("Agent review_of gives a different read-only executor the requirement and patch and checks task ownership", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const requirement = "ORIGINAL_REVIEW_REQUIREMENT";
		const launched = await data.service.startExternal({ executor: "codex", description: "Implement fixture", prompt: requirement });
		await until(() => data.service.externalSnapshot(launched.id), (task) => task.status === "completed", "implementation complete");
		await data.service.sendExternal({ taskId: launched.id, message: "REVIEW_FOLLOWUP" });
		const implementation = await until(() => data.service.externalSnapshot(launched.id),
			(task) => task.turn === 2 && task.status === "completed", "second change complete");
		assert.match(implementation.output, /IMPLEMENTATION_REPORT/);
		const reviewed = await run(data.service, `EXTERNAL_REVIEW ${implementation.id}`, "EXTERNAL_REVIEW_COMPLETE");
		assert.ok(contains(reviewed, "EXTERNAL_REVIEW_COMPLETE ALLOWED"));
		assert.ok(contains(reviewed, "INDEPENDENT_REVIEW_REPORT"));
		const review = data.service.listExternal(data.parentId).find((task) => task.reviewOf === implementation.id);
		assert.ok(review);
		assert.equal(review.executor, "claude");
		assert.equal(review.readOnly, true);
		assert.equal(review.subagentType, "Explore");
		assert.equal(review.worktreeId, undefined);
		const native = data.native.opened.find((item) => item.nativeId === review.nativeSessionId);
		assert.equal(native?.mode, "read");
		assert.equal(native?.model, "fixture-review-model");
		assert.equal(native?.effort, "medium");
		const prompt = data.native.prompts.find((item) => item.nativeId === review.nativeSessionId)?.prompt;
		assert.ok(prompt);
		assert.ok(prompt.includes(JSON.stringify(requirement)));
		assert.ok(prompt.includes("external-result.txt"));
		assert.ok(prompt.includes(`+codex:${requirement}`));
		assert.ok(prompt.includes("followup-result.txt"));
		assert.ok(prompt.includes("+codex:REVIEW_FOLLOWUP"));
		assert.doesNotMatch(prompt, /IMPLEMENTATION_REPORT|REVIEW_CALLER_COMMENT/);
		await assert.rejects(access(join(review.workingDirectory, "forbidden-review-write.txt")));
		await assert.rejects(data.service.reviewExternal({ taskId: implementation.id, executor: "kimi" }), /只读执行器/);

		await data.service.newConversation();
		const foreign = await run(data.service, `EXTERNAL_REVIEW ${implementation.id}`, "EXTERNAL_REVIEW_COMPLETE");
		assert.ok(contains(foreign, "EXTERNAL_REVIEW_COMPLETE DENIED"));
		assert.ok(contains(foreign, "没有该外部子任务"));
		assert.equal(data.service.listExternal(data.parentId).length, 2);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("candidate comparison requires a user action, limits the batch and reuses the original requirement in separate worktrees", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		const requirement = "ORIGINAL_CANDIDATE_REQUIREMENT";
		const source = await data.service.startExternal({ executor: "codex", description: "Implement fixture", prompt: requirement });
		await until(() => data.service.externalSnapshot(source.id), (task) => task.status === "completed", "implementation complete");
		await data.service.sendExternal({ taskId: source.id, message: "IMPLEMENTATION_FOLLOWUP" });
		await until(() => data.service.externalSnapshot(source.id), (task) => task.turn === 2 && task.status === "completed", "follow-up complete");

		const refused = await run(data.service, "EXTERNAL_CANDIDATES", "EXTERNAL_CANDIDATES_COMPLETE");
		assert.ok(contains(refused, "EXTERNAL_CANDIDATES_COMPLETE DENIED"));
		assert.ok(contains(refused, "需要用户在外部任务详情中主动启动"));
		const candidates = [
			{ executor: "codex", model: "candidate-one", effort: "high" },
			{ executor: "claude", model: "candidate-two", effort: "medium" },
			{ executor: "kimi", model: "candidate-three", effort: "low" },
		] as const;
		await assert.rejects(data.service.compareExternal({ taskId: source.id, candidates: [...candidates, candidates[0]] }), /2 或 3 个候选/);
		assert.equal(data.service.listExternal(data.parentId).length, 1);
		const comparison = await data.service.compareExternal({ taskId: source.id, candidates: [...candidates] });
		assert.equal(comparison.tasks.length, 3);
		assert.deepEqual(comparison.errors, undefined);
		assert.ok(comparison.tasks.every((task) => task.comparisonId === comparison.comparisonId && task.parentConversationId === data.parentId));
		const finished = await Promise.all(comparison.tasks.map((task) => until(
			() => data.service.externalSnapshot(task.id), (value) => value.status === "completed", "candidate complete",
		)));
		assert.equal(new Set([source, ...finished].map((task) => task.workingDirectory)).size, 4);
		assert.equal(new Set([source, ...finished].map((task) => task.worktreeId)).size, 4);
		for (const task of finished) {
			assert.ok(task.worktreeId);
			const launch = data.native.opened.find((item) => item.nativeId === task.nativeSessionId);
			const candidate = candidates.find((item) => item.executor === task.executor);
			assert.equal(launch?.model, candidate?.model);
			assert.equal(launch?.effort, candidate?.effort);
			assert.equal(data.native.prompts.find((item) => item.nativeId === task.nativeSessionId)?.prompt, requirement);
			assert.equal(await readFile(join(task.workingDirectory, "external-result.txt"), "utf8"), "same candidate change\n");
		}
		await assert.rejects(access(join(data.project, "external-result.txt")));
		const deltas = new Map(await Promise.all(finished.map(async task => {
			const diff = await data.service.externalDiff(task.id, task.changes!.checkpointId!, undefined, false);
			return [task.id, candidateDelta(diff)] as const;
		})));
		assert.deepEqual(groupExternalComparisons(finished, deltas).map((group) => group.length), [3], "identical patches share one rendered candidate");
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("background native results reach the parent once and another conversation cannot continue the task", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await run(data.service, "EXTERNAL_BACKGROUND codex", "EXTERNAL_BACKGROUND_LAUNCHED");
		const completed = await until(() => data.service.snapshot(), (value) => contains(value, "EXTERNAL_HANDBACK_COMPLETE") && !value.state?.isStreaming, "native background handback");
		const [task] = data.service.listExternal(data.parentId); assert.equal(task.status, "completed");
		const notifications = completed.messages.filter((message) => "customType" in message && message.customType === "desktop_task_notification");
		assert.equal(notifications.length, 1);
		assert.match(text(notifications[0]), /<changes files="1" additions="1" deletions="0">[\s\S]+added\s+external-result\.txt \+1 -0/);
		assert.deepEqual(task.changes?.files, [{ path: "external-result.txt", status: "added", additions: 1, deletions: 0 }]);
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

test("multi dispatches the default writer, pins continuations and sends the diff to the configured read-only reviewer", { timeout: 45000 }, async () => {
	const data = await setup();
	const { service } = data;
	try {
		await service.saveSettings({ permission: "auto", theme: "light", multiAgent: {
			implementation: "kimi", executors: { kimi: { model: "Kimi For Coding/k3.1-pro", effort: "low" }, codex: { model: "writer", effort: "high" } },
			reviewer: { executor: "codex", model: "review-model", effort: "medium" }, allowed: ["kimi", "codex"],
		} });
		await service.updateConversationMeta(data.parentId, { codingTier: "multi" });
		await run(service, "MULTI_AUTO_WRITE", "PROFILE_WRITE_DONE");
		const writer = service.listExternal(data.parentId)[0];
		assert.equal(writer.executor, "kimi");
		assert.equal(writer.model, "Kimi For Coding/k3.1-pro");
		assert.ok(writer.changes?.files.length);
		const review = await service.reviewExternal({ taskId: writer.id });
		await until(() => service.externalSnapshot(review.id), t => t.status === "completed", "profile review");
		assert.deepEqual([review.executor, review.model, review.effort, review.readOnly], ["codex", "review-model", "medium", true]);
		await service.saveSettings({ permission: "auto", theme: "light", multiAgent: { executors: { kimi: { model: "new", effort: "high" } } } });
		await service.sendExternal({ taskId: writer.id, message: "WRITE more" });
		await until(() => service.externalSnapshot(writer.id), t => t.status === "completed" && t.turn === 2, "pinned continuation");
		assert.equal(data.native.opened.at(-1)?.model, writer.model);
		assert.equal(data.native.opened.at(-1)?.effort, "low");
	} finally { await service.close(); await data.fixture.cleanup(); }
});

test("applying a saved profile validates native resources before replacing settings and survives service restart", { timeout: 45000 }, async () => {
	const data = await setup();
	let service = data.service;
	try {
		const executable = join(data.fixture.root, "catalog-codex");
		await cp(join(here, "fixtures/external-codex.mjs"), executable);
		await chmod(executable, 0o700);
		await service.configureExternal({ id: "codex", executable, enabled: true });
		for (const id of ["claude", "kimi"] as const) await service.configureExternal({ id, enabled: false });
		const config = { allowed: ["codex"], implementation: "codex", executors: { codex: { model: "fixture-large", effort: "high" } } } as const;
		const mutable = { ...config, allowed: [...config.allowed] };
		await service.updateMultiProfile({ type: "save", name: "开发", config: mutable });
		await service.updateMultiProfile({ type: "apply", name: "开发", config: mutable });
		await assert.rejects(service.updateMultiProfile({ type: "apply", name: "失效方案", config: { ...mutable, executors: { codex: { model: "gone" } } } }), /未被当前 CLI 列出/);
		await service.close();
		service = new DesktopService(data.options);
		const next = await service.initialize();
		assert.equal(next.settings.multiProfiles?.active, "开发");
		assert.deepEqual(next.settings.multiProfiles?.saved[0].config, mutable);
		assert.deepEqual(next.settings.multiAgent, mutable);
	} finally { await service.close(); await data.fixture.cleanup(); }
});
