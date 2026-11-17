import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExternalAgents, type ExternalAgentOptions } from "../src/external-agents.ts";
import type {
	ExternalAdapter, ExternalApprovalRequest, ExternalSession, ExternalSessionOptions,
	ExternalTask, ExternalTaskResult, ExternalTurnResult,
} from "../src/external-types.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import type { WorktreeInfo } from "../src/worktree-types.ts";

class FakeAdapter implements ExternalAdapter {
	opens: ExternalSessionOptions[] = [];
	prompts: string[] = [];
	active = 0;
	maxActive = 0;
	closed = 0;
	decisions: string[] = [];
	responses: { decision: string; optionId?: string; answers?: Record<string, string | string[]> }[] = [];
	permissionCalls: ExternalApprovalRequest[] = [];
	releases = new Map<string, () => void>();
	openGate?: Promise<void>;
	async open(options: ExternalSessionOptions): Promise<ExternalSession> {
		this.opens.push(options);
		if (this.openGate) await this.openGate;
		const id = options.resumeSessionId ?? `native-session-${this.opens.length}`;
		options.onEvent({ type: "session", sessionId: id });
		let closed = false;
		let interrupted = false;
		let release: (() => void) | undefined;
		return {
			sessionId: id,
			run: async (prompt, signal): Promise<ExternalTurnResult> => {
				this.prompts.push(prompt); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
				const abort = () => { interrupted = true; release?.(); };
				signal?.addEventListener("abort", abort, { once: true });
				try {
					if (prompt.startsWith("hold")) await new Promise<void>((resolve) => { release = resolve; this.releases.set(prompt, resolve); if (signal?.aborted) abort(); });
					if (prompt.startsWith("ask")) {
						const request: ExternalApprovalRequest = { id: "native-tool-request", kind: prompt.includes("question") ? "question" : "command", toolName: "Bash", input: { command: "npm test" }, options: [{ id: "native-allow", label: "Allow", kind: "allow_once" }, { id: "native-deny", label: "Deny", kind: "reject_once" }] };
						this.permissionCalls.push(request);
						const decision = await options.onPermission(request);
						this.decisions.push(decision.decision);
						this.responses.push(decision);
						if (decision.decision === "cancel") interrupted = true;
					}
					if (prompt === "many-events") for (let index = 0; index < 2100; index++) options.onEvent({ type: "tool_update", id: `tool-${index}`, text: `event-${index}` });
					if (prompt === "large-output") options.onEvent({ type: "tool_update", id: "large", text: "x".repeat(300 * 1024) });
					const text = prompt === "large-output" ? "x".repeat(60 * 1024) : `result:${prompt}`;
					options.onEvent({ type: "text_delta", text });
					return { status: interrupted || signal?.aborted ? "cancelled" : "completed", sessionId: id, text };
				} finally {
					this.active--; this.releases.delete(prompt); signal?.removeEventListener("abort", abort);
				}
			},
			interrupt: async () => { interrupted = true; release?.(); },
			close: async () => { if (closed) return; closed = true; this.closed++; interrupted = true; release?.(); },
		};
	}
}

async function setup(config: { maxConcurrent?: number; capacity?: () => number; canStart?: (task: ExternalTask) => boolean } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-external-manager-test-")));
	const project = join(root, "project");
	const dataDir = join(root, "desktop");
	await mkdir(project); await mkdir(dataDir);
	const binary = join(root, "native-agent");
	await writeFile(binary, "#!/bin/sh\nprintf 'fixture-native 1.0\\n'\n", { mode: 0o700 });
	const adapter = new FakeAdapter();
	const notifications: { owner: string; result: ExternalTaskResult }[] = [];
	let current: RuntimePermissionPolicy = { version: 1, project, mode: "ask", rules: [], disabledTools: [] };
	const trees: WorktreeInfo[] = [];
	let activity = 0;
	const options: ExternalAgentOptions = {
		dataDir, env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin", PI_DESKTOP_KEY_OPENAI: "local-fixture-desktop-secret", PI_DESKTOP_CONNECTIONS: "local-fixture-connections", PI_CODING_AGENT_DIR: "local-fixture-pi-dir", SAFE_FIXTURE: "preserved" },
		nodeExecutable: process.execPath, claudeHelperPath: join(root, "helper.mjs"), adapters: { codex: adapter, claude: adapter, kimi: adapter },
		maxConcurrent: config.maxConcurrent, project: (owner) => { if (!["parent-a", "parent-b", "nested-child"].includes(owner)) throw new Error("unknown parent"); return project; },
		policy: () => structuredClone(current), delegated: (owner) => owner === "nested-child",
		createWorktree: async (input) => {
			const id = `tree-${trees.length + 1}`; const path = join(root, id); await mkdir(path);
			const tree: WorktreeInfo = { id, repository: project, path, branch: `test/${id}`, baseRef: "HEAD", baseCommit: "fixture", createdAt: Date.now(), conversationId: input.conversationId, status: "ready" };
			trees.push(tree); return tree;
		},
		listWorktrees: async () => structuredClone(trees), canStart: config.canStart ?? (() => true), capacity: config.capacity ?? (() => 4),
		notify: async (owner, result) => { notifications.push({ owner, result }); }, onActivityChange: () => { activity++; },
	};
	const manager = new ExternalAgents(options);
	await manager.initialize();
	for (const id of ["codex", "claude", "kimi"] as const) await manager.configure({ id, executable: binary });
	return { root, project, dataDir, binary, adapter, manager, options, notifications, trees, activity: () => activity,
		setPolicy: (policy: Partial<RuntimePermissionPolicy>) => { current = { ...current, ...policy }; },
		cleanup: async () => { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

async function until<T>(get: () => T | Promise<T>, check: (value: T) => boolean, label: string): Promise<T> {
	const end = Date.now() + 10000;
	for (;;) {
		const value = await get(); if (check(value)) return value;
		if (Date.now() > end) throw new Error(`Timed out: ${label}`);
		await delay(10);
	}
}
const terminal = (task: ExternalTask) => ["completed", "cancelled", "failed", "interrupted"].includes(task.status);

test("external manager queues work by capacity, binds ownership and restores the exact native session for continuation", async () => {
	const data = await setup({ maxConcurrent: 1 });
	try {
		const first = await data.manager.start({ executor: "codex", description: "First", prompt: "hold-one", run_in_background: true }, "parent-a", "call-one");
		await until(() => data.adapter.releases.has("hold-one"), Boolean, "first native run");
		const second = await data.manager.start({ executor: "claude", description: "Second", prompt: "second" }, "parent-b", "call-two");
		assert.equal(data.manager.snapshot(second.id).status, "queued");
		assert.equal(data.manager.countRunning(), 1);
		assert.equal(data.manager.activeInPath(data.trees[0].path), true);
		data.adapter.releases.get("hold-one")!();
		await until(() => data.manager.snapshot(second.id), terminal, "second native run");
		await until(() => data.notifications.length, (count) => count === 1, "background handback");
		assert.equal(data.adapter.maxActive, 1);
		assert.equal(data.notifications[0].owner, "parent-a");
		assert.equal(data.notifications[0].result.task_id, first.id);
		const savedId = data.manager.snapshot(first.id).nativeSessionId;
		await data.manager.send({ taskId: first.id, message: "continued", runInBackground: true }, "parent-a");
		await until(() => data.manager.snapshot(first.id), terminal, "continued turn");
		await until(() => data.notifications.length, (count) => count === 2, "continued handback");
		assert.equal(data.adapter.opens.at(-1)?.resumeSessionId, savedId);
		assert.equal(data.manager.snapshot(first.id).turn, 2);
		assert.equal((await data.manager.result(first.id, {}, "parent-a")).output, "result:continued");
		data.manager.pump(); data.manager.pump(); await delay(30);
		assert.equal(data.notifications.length, 2);
		assert.ok(data.activity() > 0);
		assert.equal(data.adapter.opens[0].env.SAFE_FIXTURE, "preserved");
		assert.ok(Object.keys(data.adapter.opens[0].env).every((name) => !name.startsWith("PI_DESKTOP_") && !name.startsWith("PI_CODING_")));
		await assert.rejects(data.manager.result(first.id, {}, "parent-b"), /没有该外部/);
		await assert.rejects(data.manager.send({ taskId: first.id, message: "cross owner" }, "parent-b"), /没有该外部/);
		await assert.rejects(data.manager.cancel(first.id, "parent-b"), /没有该外部/);
		await assert.rejects(data.manager.start({ executor: "codex", description: "Recursive", prompt: "cannot recurse" }, "nested-child"), /不能再委派/);
	} finally { await data.cleanup(); }
});

test("external manager exposes native approvals, preserves option IDs, and rechecks a later parent revocation", async () => {
	const data = await setup();
	try {
		const task = await data.manager.start({ executor: "claude", description: "Approve", prompt: "ask tool" }, "parent-a");
		let state = await until(() => data.manager.snapshot(task.id), (task) => task.status === "waiting_for_input", "approval");
		assert.equal((await data.manager.result(task.id, { block: true, timeout: 60000 })).pending_approvals, 1);
		await assert.rejects(data.manager.respond(task.id, state.pendingApprovals[0].id, { decision: "allow", optionId: "forged" }), /选项无效/);
		await data.manager.respond(task.id, state.pendingApprovals[0].id, { decision: "allow", optionId: "native-allow" });
		await until(() => data.manager.snapshot(task.id), terminal, "approved completion");
		assert.deepEqual(data.adapter.decisions, ["allow"]);
		await data.manager.send({ taskId: task.id, message: "ask second tool" }, "parent-a");
		state = await until(() => data.manager.snapshot(task.id), (task) => task.status === "waiting_for_input", "second approval");
		data.setPolicy({ rules: [{ id: "live-deny", scope: "conversation", conversationId: "parent-a", action: "deny", tool: "bash" }] });
		await assert.rejects(data.manager.respond(task.id, state.pendingApprovals[0].id, { decision: "allow" }), /拒绝|deny|规则/);
		await until(() => data.manager.snapshot(task.id), terminal, "revoked completion");
		assert.deepEqual(data.adapter.decisions, ["allow", "deny"]);
		assert.equal(data.manager.snapshot(task.id).pendingApprovals.length, 0);
		await assert.rejects(data.manager.respond(task.id, state.pendingApprovals[0].id, { decision: "allow" }), /已失效/);
	} finally { await data.cleanup(); }
});

test("external cancellation clears approvals, cancels queued work and preserves unrelated parents", async () => {
	const data = await setup({ maxConcurrent: 1 });
	try {
		const first = await data.manager.start({ executor: "claude", description: "Waiting", prompt: "ask cancellation" }, "parent-a");
		await until(() => data.manager.snapshot(first.id), (task) => task.status === "waiting_for_input", "waiting approval");
		const queued = await data.manager.start({ executor: "codex", description: "Queued", prompt: "never run" }, "parent-a");
		const unrelated = await data.manager.start({ executor: "codex", description: "Other parent", prompt: "other-parent" }, "parent-b");
		await data.manager.cancelChildren("parent-a");
		assert.equal(data.manager.snapshot(first.id).status, "cancelled");
		assert.equal(data.manager.snapshot(first.id).pendingApprovals.length, 0);
		assert.equal(data.manager.snapshot(queued.id).status, "cancelled");
		await until(() => data.manager.snapshot(unrelated.id), terminal, "unrelated completion");
		assert.equal(data.manager.snapshot(unrelated.id).status, "completed");
		assert.ok(!data.adapter.prompts.includes("never run"));
		assert.equal(data.adapter.decisions[0], "cancel");
	} finally { await data.cleanup(); }
});

test("external manager persists interrupted tasks without replay and resumes only after an explicit new instruction", async () => {
	const data = await setup();
	const task = await data.manager.start({ executor: "codex", description: "Interrupt", prompt: "hold restart" }, "parent-a");
	await until(() => data.adapter.releases.has("hold restart"), Boolean, "native started");
	const nativeId = data.manager.snapshot(task.id).nativeSessionId;
	await data.manager.close();
	const after = new ExternalAgents(data.options);
	try {
		await after.initialize();
		assert.equal(after.snapshot(task.id).status, "interrupted");
		await delay(30);
		assert.deepEqual(data.adapter.prompts, ["hold restart"]);
		await after.send({ taskId: task.id, message: "explicit continuation" }, "parent-a");
		await until(() => after.snapshot(task.id), terminal, "resumed completion");
		assert.equal(data.adapter.opens.at(-1)?.resumeSessionId, nativeId);
		assert.deepEqual(data.adapter.prompts, ["hold restart", "explicit continuation"]);
		assert.equal(after.snapshot(task.id).turn, 2);
		const persisted = await readFile(join(data.dataDir, "external-agents.json"), "utf8");
		assert.ok(!persisted.includes("local-fixture-desktop-secret"));
	} finally { await after.close(); await data.cleanup(); }
});

test("external events and final output are bounded, sequence replay survives restart and ignores already-seen events", async () => {
	const data = await setup();
	try {
		const task = await data.manager.start({ executor: "codex", description: "Many events", prompt: "many-events" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "many events");
		const replay = await data.manager.replay(task.id);
		assert.ok(replay.events.length <= 2000);
		assert.equal(replay.truncated, true);
		assert.ok(replay.events.every((event, index, list) => !index || event.sequence > list[index - 1].sequence));
		assert.deepEqual((await data.manager.replay(task.id, replay.latestSequence)).events, []);
		const large = await data.manager.start({ executor: "claude", description: "Large result", prompt: "large-output" }, "parent-a");
		await until(() => data.manager.snapshot(large.id), terminal, "large result");
		const result = await data.manager.result(large.id);
		assert.equal(result.output.length, 48 * 1024);
		assert.equal(result.truncated, true);
		assert.ok((await data.manager.replay(large.id)).events.some((event) => event.event.type === "diagnostic"));
		await data.manager.close();
		const reopened = new ExternalAgents(data.options);
		try {
			await reopened.initialize();
			const history = await reopened.replay(task.id, replay.latestSequence - 2);
			assert.ok(history.events.every((event) => event.sequence > replay.latestSequence - 2));
			assert.equal(history.latestSequence, replay.latestSequence);
		} finally { await reopened.close(); }
	} finally { await data.cleanup(); }
});

test("external permissions retain the spawn ceiling, map absolute paths into the worktree, and revoke protocols without hooks", async () => {
	let mayStart = false;
	const data = await setup({ canStart: () => mayStart });
	try {
		data.setPolicy({ rules: [{ id: "initial-deny", scope: "global", action: "deny", tool: "bash" }, { id: "path-deny", scope: "global", action: "deny", tool: "write", path: join(data.project, "private.txt") }] });
		const task = await data.manager.start({ executor: "claude", description: "Ceiling", prompt: "ask inherited" }, "parent-a");
		data.setPolicy({ mode: "auto", rules: [] });
		mayStart = true; data.manager.pump();
		await until(() => data.manager.snapshot(task.id), terminal, "ceiling enforcement");
		assert.equal(data.adapter.decisions[0], "deny");
		assert.ok(data.adapter.opens[0].policy.rules.some((rule) => rule.path === join(task.workingDirectory, "private.txt")));
		assert.equal(data.adapter.opens[0].policy.mode, "ask");
		assert.ok(data.adapter.opens[0].policy.disabledTools.includes("Agent"));
		const running = await data.manager.start({ executor: "codex", description: "Revoked", prompt: "hold revocation" }, "parent-a");
		await until(() => data.adapter.releases.has("hold revocation"), Boolean, "revocation task");
		await data.manager.invalidatePolicies();
		assert.equal(data.manager.snapshot(running.id).status, "cancelled");
		assert.match(data.manager.snapshot(running.id).error ?? "", /权限已更改/);
	} finally { await data.cleanup(); }
});

test("external task input and executor settings reject recursion, unsafe shared writes and invalid ownership", async () => {
	const data = await setup();
	try {
		await assert.rejects(data.manager.start({ executor: "kimi", description: "Readonly", prompt: "Read", subagent_type: "Explore" }, "parent-a"), /无法强制只读/);
		await assert.rejects(data.manager.start({ executor: "codex", description: "Shared", prompt: "Write", isolation: "shared" }, "parent-a"), /必须使用独立/);
		await assert.rejects(data.manager.start({ executor: "codex", description: "Missing tree", prompt: "Write", worktree_id: "missing" }, "parent-a"), /不属于/);
		await assert.rejects(data.manager.configure({ id: "codex", executable: "/not/a/real/executable" }), /ENOENT/);
		const first = await data.manager.start({ executor: "claude", description: "Unique", prompt: "hold duplicate" }, "parent-a", "same-call");
		const repeated = await data.manager.start({ executor: "claude", description: "Unique retry", prompt: "must not run" }, "parent-a", "same-call");
		assert.equal(first.id, repeated.id);
		await assert.rejects(data.manager.configure({ id: "claude", enabled: false }), /先停止/);
		await data.manager.cancel(first.id);
		await assert.rejects(data.manager.result(first.id, { block: true, timeout: 60001 }), /等待上限/);
		await assert.rejects(data.manager.replay(first.id, -1), /输出序号/);
	} finally { await data.cleanup(); }
});

test("cancelling an external task while adapter startup is pending never runs the cancelled prompt", async () => {
	const data = await setup();
	let release!: () => void;
	data.adapter.openGate = new Promise<void>((resolve) => { release = resolve; });
	try {
		const task = await data.manager.start({ executor: "codex", description: "Starting", prompt: "must not run after cancellation" }, "parent-a");
		await until(() => data.adapter.opens.length, (count) => count === 1, "adapter startup");
		await data.manager.cancel(task.id, "parent-a");
		release();
		await until(() => data.adapter.closed, (count) => count === 1, "late-started session cleanup");
		assert.equal(data.manager.snapshot(task.id).status, "cancelled");
		assert.deepEqual(data.adapter.prompts, []);
	} finally { release(); await data.cleanup(); }
});

test("human questions stay pending in auto mode and retain native options and structured answers", async () => {
	const data = await setup();
	try {
		data.setPolicy({ mode: "auto" });
		const task = await data.manager.start({ executor: "claude", description: "Human question", prompt: "ask question" }, "parent-a");
		const pending = await until(() => data.manager.snapshot(task.id), (state) => state.status === "waiting_for_input", "human question");
		assert.equal(pending.pendingApprovals[0].kind, "question");
		await data.manager.respond(task.id, pending.pendingApprovals[0].id, { decision: "allow", optionId: "native-allow", answers: { q0: "choice", q1: ["one", "two"] } });
		await until(() => data.manager.snapshot(task.id), terminal, "question completion");
		assert.deepEqual(data.adapter.responses[0], { decision: "allow", optionId: "native-allow", answers: { q0: "choice", q1: ["one", "two"] } });
	} finally { await data.cleanup(); }
});

test("external crash recovery advances event sequences past the durable log before an explicit continuation", async () => {
	const data = await setup();
	const task = await data.manager.start({ executor: "codex", description: "Crash sequence", prompt: "first durable turn" }, "parent-a");
	await until(() => data.manager.snapshot(task.id), terminal, "durable first turn");
	await data.manager.close();
	const path = join(data.dataDir, "external-agents.json");
	const logPath = join(data.dataDir, "external-events", `${task.id}.jsonl`);
	const before = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const oldMaximum = Math.max(...before.map((event) => event.sequence));
	assert.ok(oldMaximum > 3);
	const stored = JSON.parse(await readFile(path, "utf8"));
	const saved = stored.tasks.find((entry: { task: { id: string } }) => entry.task.id === task.id);
	// Model a crash after event append but before the matching task-index write.
	saved.task.eventSequence = oldMaximum - 3;
	saved.task.status = "running";
	await writeFile(path, JSON.stringify(stored));
	const resumed = new ExternalAgents(data.options);
	try {
		await resumed.initialize();
		assert.equal(resumed.snapshot(task.id).status, "interrupted");
		assert.ok(resumed.snapshot(task.id).eventSequence >= oldMaximum);
		const events: number[] = [];
		resumed.subscribe((event) => { if (event.taskId === task.id) events.push(event.sequence); });
		await resumed.send({ taskId: task.id, message: "explicit continuation after crash" }, "parent-a");
		await until(() => resumed.snapshot(task.id), terminal, "continued after crash");
		assert.ok(events.length > 0);
		assert.ok(events.every((sequence) => sequence > oldMaximum));
		const replay = await resumed.replay(task.id, oldMaximum);
		assert.ok(replay.events.length > 0);
		assert.ok(replay.events.every((event) => event.sequence > oldMaximum && event.turn === 2));
		assert.equal(new Set(replay.events.map((event) => event.sequence)).size, replay.events.length);
		await resumed.close();
		const after = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(new Set(after.map((event) => event.sequence)).size, after.length);
	} finally { await resumed.close(); await data.cleanup(); }
});
