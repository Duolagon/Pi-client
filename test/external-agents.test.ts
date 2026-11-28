import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KimiAdapter } from "../src/external-kimi.ts";
import { ExternalAgents, type ExternalAgentOptions } from "../src/external-agents.ts";
import type {
	ExternalAdapter, ExternalApprovalRequest, ExternalSession, ExternalSessionOptions,
	ExternalTask, ExternalTaskResult, ExternalTurnResult,
} from "../src/external-types.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import type { WorktreeInfo } from "../src/worktree-types.ts";

class FakeAdapter implements ExternalAdapter {
	structuredReplies: Array<Pick<ExternalTurnResult, "text" | "structuredOutput">> = [];
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
					const structured = this.structuredReplies.shift();
					if (structured) {
						options.onEvent({ type: "text_delta", text: structured.text });
						return { status: "completed", sessionId: id, ...structured };
					}
					if (prompt.startsWith("hold")) await new Promise<void>((resolve) => { release = resolve; this.releases.set(prompt, resolve); if (signal?.aborted) abort(); });
					if (prompt.startsWith("ask")) {
						const write = prompt === "ask write";
						const request: ExternalApprovalRequest = {
							id: "native-tool-request",
							kind: write ? "file" : prompt.includes("question") ? "question" : "command",
							toolName: write ? "Write" : "Bash",
								input: write ? { file_path: join(options.cwd, "draft.txt"), content: "sample" }
									: prompt === "ask unspecified" ? {} : { command: prompt === "ask lint" ? "npm run lint" : "npm test" },
								options: [{ id: "native-allow", label: "Allow", kind: "allow_once" }, { id: "native-deny", label: "Deny", kind: "reject_once" },
									...(prompt === "ask session" ? [{ id: "native-always", label: "Always allow", kind: "allow_always" }] : [])],
						};
						this.permissionCalls.push(request);
						const decision = await options.onPermission(request);
						this.decisions.push(decision.decision);
						this.responses.push(decision);
						if (decision.decision === "cancel") interrupted = true;
					}
					if (prompt === "many-events") for (let index = 0; index < 2100; index++) options.onEvent({ type: "tool_update", id: `tool-${index}`, text: `event-${index}` });
					if (prompt === "large-output") options.onEvent({ type: "tool_update", id: "large", text: "x".repeat(300 * 1024) });
					if (prompt === "diagnostic-failure") {
						options.onEvent({ type: "diagnostic", message: `Native diagnostic: ${options.env.SAMPLE_AUTH_TOKEN}` });
						throw new Error(`Native request failed: ${options.env.SAMPLE_AUTH_TOKEN}`);
					}
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
	let trusted = false;
	const trees: WorktreeInfo[] = [];
	let activity = 0;
	const options: ExternalAgentOptions = {
		dataDir, env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin", PI_DESKTOP_KEY_OPENAI: "local-fixture-desktop-secret", PI_DESKTOP_CONNECTIONS: "local-fixture-connections", PI_CODING_AGENT_DIR: "local-fixture-pi-dir", SAFE_FIXTURE: "preserved" },
		nodeExecutable: process.execPath, claudeHelperPath: join(root, "helper.mjs"), adapters: { codex: adapter, claude: adapter, kimi: adapter, antigravity: adapter },
		maxConcurrent: config.maxConcurrent, project: (owner) => { if (!["parent-a", "parent-b", "nested-child"].includes(owner)) throw new Error("unknown parent"); return project; },
		isProjectTrusted: (path) => path === project && trusted,
		policy: () => structuredClone(current), delegated: (owner) => owner === "nested-child",
		createWorktree: async (input) => {
			const id = `tree-${trees.length + 1}`; const path = join(root, id); await mkdir(path);
			const tree: WorktreeInfo = { id, repository: project, path, branch: `test/${id}`, baseRef: "HEAD", baseCommit: "fixture", createdAt: Date.now(), conversationId: input.conversationId, status: "ready" };
			trees.push(tree); return tree;
		},
		listWorktrees: async () => structuredClone(trees), canStart: config.canStart ?? (() => true), capacity: config.capacity ?? (() => 4),
		// Mirrors the host outbox: deliver each pending turn once and record it.
		flushNotifications: (owner) => {
			for (const { task } of manager.pendingNotifications(owner)) {
				notifications.push({ owner, result: { task_id: task.id, status: task.status, turn: task.turn, output: task.output, error: task.error } as ExternalTaskResult });
				void manager.markNotified(task.id, task.turn);
			}
		},
		onActivityChange: () => { activity++; },
	};
	const manager = new ExternalAgents(options);
	await manager.initialize();
	for (const id of ["codex", "claude", "kimi"] as const) await manager.configure({ id, executable: binary });
	return { root, project, dataDir, binary, adapter, manager, options, notifications, trees, activity: () => activity,
		setPolicy: (policy: Partial<RuntimePermissionPolicy>) => { current = { ...current, ...policy }; },
		setTrusted: (value: boolean) => { trusted = value; },
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

test("ACP follow-ups queue for the same native session and both background results survive restart", async () => {
	const data = await setup();
	data.options.flushNotifications = () => {};
	try {
		const first = await data.manager.start({ executor: "kimi", description: "Follow-up", prompt: "hold-next", run_in_background: true }, "parent-a");
		const release = await until(() => data.adapter.releases.get("hold-next"), Boolean, "first turn begins");
		assert.equal((await data.manager.send({ taskId: first.id, message: "second" })).sendDisposition, "queued");
		assert.equal((await data.manager.send({ taskId: first.id, message: "third" })).pendingMessages, 2);
		release!();
		await until(() => data.manager.snapshot(first.id), (task) => task.turn === 2 && terminal(task), "follow-up completes");
		assert.deepEqual(data.adapter.prompts, ["hold-next", "second\n\nthird"]);
		assert.equal(data.adapter.opens[1].resumeSessionId, data.manager.snapshot(first.id).nativeSessionId);
		assert.deepEqual(data.manager.pendingNotifications("parent-a").map((notice) => notice.task.turn), [1, 2]);
		await data.manager.close();
		const restored = new ExternalAgents(data.options);
		try {
			await restored.initialize();
			assert.deepEqual(restored.pendingNotifications("parent-a").map((notice) => notice.task.turn), [1, 2]);
			await restored.markNotified(first.id, 1);
			assert.deepEqual(restored.pendingNotifications("parent-a").map((notice) => notice.task.turn), [2]);
		} finally { await restored.close(); }
	} finally { await data.cleanup(); }
});

test("a queued ACP follow-up uses the open native session when restoration is unavailable", async () => {
	const data = await setup();
	const protocolLog = join(data.root, "acp-turns.jsonl");
	const binary = join(data.root, "kimi-fixture.mjs");
	const fixture = new URL("./fixtures/fake-kimi-acp.mjs", import.meta.url).href;
	data.options.adapters.kimi = new KimiAdapter();
	Object.assign(data.options.env, { KIMI_TEST_NO_RESTORE: "1", KIMI_TEST_LOG: protocolLog });
	try {
		await writeFile(binary, `#!${process.execPath}\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
		await data.manager.configure({ id: "kimi", executable: binary });
		const initial = await data.manager.start({ executor: "kimi", description: "queue", prompt: "question" }, "parent-a");
		const waiting = await until(() => data.manager.snapshot(initial.id), task => task.pendingApprovals.length > 0, "first prompt");
		assert.equal((await data.manager.send({ taskId: initial.id, message: "follow-up" })).sendDisposition, "queued");
		await data.manager.respond(initial.id, waiting.pendingApprovals[0].id, { decision: "allow", optionId: "q0_opt_0" });
		const last = await until(() => data.manager.snapshot(initial.id), task => task.turn === 2 && terminal(task), "second result");
		assert.equal(last.status, "completed", last.error);
		assert.equal(last.supportsResume, false);
		const requests = (await readFile(protocolLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		assert.equal(requests.filter(item => item.method === "session/new").length, 1);
		assert.deepEqual(requests.filter(item => item.method === "session/prompt").map(item => item.params.prompt[0].text), ["question", "follow-up"]);
		assert.equal(requests.filter(item => item.method === "session/close").length, 1);
		await assert.rejects(data.manager.send({ taskId: initial.id, message: "after close" }), /无法恢复/);
		assert.equal(data.manager.snapshot(initial.id).turn, 2);
	} finally { await data.cleanup(); }
});

test("an incompatible checked executable stays unavailable to task starts and after restart", async () => {
	const data = await setup();
	try {
		const checked = (await data.manager.executors({ verifyCompatibility: true })).find(item => item.id === "claude")!;
		assert.equal(checked.compatibility, "incompatible", "fixture implements --version but does not speak stream-json");
		assert.equal((await data.manager.executors()).find(item => item.id === "claude")!.available, false);
		const input = { executor: "claude" as const, prompt: "test", description: "test" };
		await assert.rejects(data.manager.start(input, "parent-a"), /不兼容/);
		assert.equal(data.trees.length, 0);
		await data.manager.close();
		const restored = new ExternalAgents(data.options);
		try {
			await restored.initialize();
			await assert.rejects(restored.start(input, "parent-a"), /不兼容/);
			const replacement = join(data.root, "upgraded-cli");
			await writeFile(replacement, "#!/bin/sh\necho fixture-upgraded\n", { mode: 0o700 });
			const executors = await restored.configure({ id: "claude", executable: replacement });
			assert.equal(executors.find(item => item.id === "claude")!.compatibility, "unverified");
			assert.equal(executors.find(item => item.id === "claude")!.available, true);
		} finally { await restored.close(); }
	} finally { await data.cleanup(); }
});

test("native cumulative token and cost reports are accounted as per-turn deltas", async () => {
	const data = await setup();
	const reports = [
		{ inputTokens: 7, outputTokens: 3, cachedInputTokens: 50, cacheWriteTokens: 10, costUsd: 0.25 },
		{ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		{ inputTokens: 22, outputTokens: 11, cachedInputTokens: 130, cacheWriteTokens: 10, costUsd: 0.5 },
	];
	data.options.adapters.claude = {
		async open(options) {
			return {
				sessionId: "cumulative-fixture",
				async run() {
					const { costUsd, ...sessionTokens } = reports.shift()!;
					options.onEvent({ type: "usage", sessionTokens, sessionCostUsd: costUsd });
					if (!costUsd) throw new Error("SDK startup error");
					return { status: "completed", text: "complete" };
				},
				async interrupt() {},
				async close() {},
			};
		},
	};
	try {
		const task = await data.manager.start({ executor: "claude", description: "Usage", prompt: "first" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "first usage");
		assert.deepEqual((await data.manager.result(task.id)).usage, {
			inputTokens: 7, outputTokens: 3, cachedInputTokens: 50, cacheWriteTokens: 10, costUsd: 0.25,
		});
		await data.manager.send({ taskId: task.id, message: "second" });
		await until(() => data.manager.snapshot(task.id), (value) => value.turn === 2 && value.status === "failed", "zeroed failure");
		await data.manager.send({ taskId: task.id, message: "retry" });
		await until(() => data.manager.snapshot(task.id), (value) => value.turn === 3 && terminal(value), "resumed usage");
		assert.deepEqual((await data.manager.result(task.id)).usage, {
			inputTokens: 15, outputTokens: 8, cachedInputTokens: 80, cacheWriteTokens: 0, costUsd: 0.25,
		});
		const [record] = data.manager.usageRecords();
		assert.deepEqual([record.input, record.output, record.cacheRead, record.cacheWrite, record.cost, record.samples], [22, 11, 130, 10, 0.5, 2]);
	} finally { await data.cleanup(); }
});

const structuredSchema = {
	type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false,
};

test("ACP structured output prompts with the schema and retries once in the same native session", async () => {
	const data = await setup();
	try {
		data.adapter.structuredReplies.push({ text: '{"count":"1"}' }, { text: '```json\n{"count":1}\n```' });
		const task = await data.manager.start({
			executor: "kimi", description: "Structured", prompt: "Count files", output_schema: structuredSchema,
		}, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "validated structured output");
		const result = await data.manager.result(task.id);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.structured_output, { count: 1 });
		assert.equal(data.adapter.opens.length, 1);
		assert.equal(data.adapter.opens[0].outputSchema, undefined);
		assert.equal(data.adapter.prompts.length, 2);
		assert.match(data.adapter.prompts[0], /^Count files[\s\S]+JSON Schema/);
		assert.match(data.adapter.prompts[1], /Reformat your existing answer only/);
		assert.ok(data.adapter.prompts.every((prompt) => prompt.includes(JSON.stringify(structuredSchema))));

		data.adapter.structuredReplies.push({ text: "not JSON" }, { text: '{"count":"2"}' });
		await data.manager.send({ taskId: task.id, message: "Count again" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "invalid structured output");
		const failed = await data.manager.result(task.id);
		assert.equal(data.adapter.prompts.length, 4);
		assert.equal(failed.status, "failed");
		assert.match(failed.error!, /after one retry/);
		assert.equal(failed.structured_output, undefined);
	} finally { await data.cleanup(); }
});

test("native structured output uses the native schema and validates the attachment from Claude", async () => {
	const data = await setup();
	try {
		data.adapter.structuredReplies.push({ text: "Claude final text", structuredOutput: { count: 3 } });
		const resultTask = await data.manager.start({
			executor: "claude", description: "Structured", prompt: "Count files", output_schema: structuredSchema,
		}, "parent-a");
		await until(() => data.manager.snapshot(resultTask.id), terminal, "native structured output");
		assert.deepEqual((await data.manager.result(resultTask.id)).structured_output, { count: 3 });
		assert.deepEqual(data.adapter.opens[0].outputSchema, structuredSchema);
		assert.deepEqual(data.adapter.prompts, ["Count files"]);
		data.adapter.structuredReplies.push({ text: "missing attachment" });
		await data.manager.send({ taskId: resultTask.id, message: "Count again" }, "parent-a");
		await until(() => data.manager.snapshot(resultTask.id), terminal, "native output rejection");
		assert.equal((await data.manager.result(resultTask.id)).status, "failed");
		assert.deepEqual(data.adapter.prompts, ["Count files", "Count again"]);
	} finally { await data.cleanup(); }
});

test("a queued follow-up has no change summary from the previous turn, even if cancelled", async () => {
	let canStart = true;
	const data = await setup({ canStart: () => canStart });
	try {
		const changes = { files: [], truncated: false, additions: 0, deletions: 0 };
		data.options.beginCheckpoint = async () => async () => changes;
		const task = await data.manager.start({ executor: "codex", description: "Changes", prompt: "first" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "first turn");
		assert.deepEqual((await data.manager.result(task.id)).changes, changes);
		canStart = false;
		assert.equal((await data.manager.send({ taskId: task.id, message: "second" })).status, "queued");
		await data.manager.cancel(task.id);
		const cancelled = await data.manager.result(task.id);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.changes, undefined);
	} finally { await data.cleanup(); }
});

test("diagnostics and task errors redact credentials from the native environment", async () => {
	const data = await setup();
	try {
		const value = "fixture-value-1234";
		data.options.networkEnv = () => ({ SAMPLE_AUTH_TOKEN: value });
		const task = await data.manager.start({ executor: "codex", description: "Diagnostics", prompt: "diagnostic-failure" }, "parent-a");
		const failed = await until(() => data.manager.snapshot(task.id), terminal, "native failure");
		assert.equal(failed.status, "failed");
		assert.equal(failed.error, "Native request failed: [REDACTED]");
		const events = await data.manager.replay(task.id);
		assert.ok(events.events.some(({ event }) => event.type === "diagnostic" && event.message === "Native diagnostic: [REDACTED]"));
		assert.ok(!JSON.stringify(events).includes(value));
	} finally { await data.cleanup(); }
});

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

test("session approvals match exact operations and send only one-time responses to the native agent", async () => {
	const data = await setup();
	try {
		const task = await data.manager.start({ executor: "claude", description: "Session approval", prompt: "ask session" }, "parent-a");
		const waiting = (label: string) => until(() => data.manager.snapshot(task.id), (value) => value.status === "waiting_for_input", label);
		const settled = (turn: number) => until(() => data.manager.snapshot(task.id), (value) => value.turn === turn && terminal(value), "approved turn " + turn);
		let pending = (await waiting("session approval")).pendingApprovals[0];
		await assert.rejects(data.manager.respond(task.id, pending.id, { decision: "allow", optionId: "native-always" }), /单次|会话|长期/);
		await data.manager.respond(task.id, pending.id, { decision: "allow", rememberForSession: true });
		await settled(1);
		assert.deepEqual(data.adapter.responses, [{ decision: "allow", optionId: "native-allow" }]);

		await data.manager.send({ taskId: task.id, message: "ask repeat" }, "parent-a");
		await settled(2);
		assert.deepEqual(data.adapter.responses[1], { decision: "allow", optionId: "native-allow" });

		await data.manager.send({ taskId: task.id, message: "ask lint" }, "parent-a");
		pending = (await waiting("different operation")).pendingApprovals[0];
		await data.manager.respond(task.id, pending.id, { decision: "deny" });
		await settled(3);
		await data.manager.send({ taskId: task.id, message: "ask unspecified" }, "parent-a");
		pending = (await waiting("operation without exact input")).pendingApprovals[0];
		await assert.rejects(data.manager.respond(task.id, pending.id, { decision: "allow", rememberForSession: true }), /单次/);
		await data.manager.respond(task.id, pending.id, { decision: "deny" });
		await settled(4);

		data.setPolicy({ rules: [{ id: "deny-remembered", scope: "conversation", conversationId: "parent-a", action: "deny", tool: "bash" }] });
		await data.manager.send({ taskId: task.id, message: "ask repeat" }, "parent-a");
		await settled(5);
		assert.deepEqual(data.adapter.decisions, ["allow", "allow", "deny", "deny", "deny"]);
	} finally { await data.cleanup(); }
});

test("external acceptEdits allows Worktree edits and keeps shell approval when the parent later switches to auto", async () => {
	const data = await setup();
	try {
		data.setPolicy({ mode: "acceptEdits" });
		const task = await data.manager.start({ executor: "claude", description: "Check edit policy", prompt: "ask write" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "worktree write approved");
		assert.equal(data.adapter.opens[0]?.policy.mode, "acceptEdits");
		assert.deepEqual(data.adapter.decisions, ["allow"]);

		data.setPolicy({ mode: "auto" });
		await data.manager.send({ taskId: task.id, message: "ask shell command" }, "parent-a");
		const pending = await until(() => data.manager.snapshot(task.id), (state) => state.status === "waiting_for_input", "shell command requires approval");
		assert.equal(data.adapter.opens.at(-1)?.policy.mode, "acceptEdits");
		await data.manager.respond(task.id, pending.pendingApprovals[0].id, { decision: "deny" });
		await until(() => data.manager.snapshot(task.id), terminal, "shell command denied");
		assert.deepEqual(data.adapter.decisions, ["allow", "deny"]);
	} finally { await data.cleanup(); }
});

test("external Plan launches on a read-only ceiling and never auto-approves shell commands", async () => {
	const data = await setup();
	try {
		data.setPolicy({ mode: "plan" });
		const task = await data.manager.start({ executor: "codex", description: "Inspect plan", prompt: "ask shell command" }, "parent-a");
		const completed = await until(() => data.manager.snapshot(task.id), terminal, "plan command blocked");
		assert.equal(task.readOnly, true);
		assert.equal(task.worktreeId, undefined);
		assert.equal(data.adapter.opens[0]?.policy.mode, "plan");
		assert.deepEqual(data.adapter.decisions, ["deny"]);
		assert.equal(completed.pendingApprovals.length, 0);
	} finally { await data.cleanup(); }
});

test("Claude Worktree runs reevaluate the original project trust on explicit continuation", async () => {
	const data = await setup();
	try {
		data.setTrusted(true);
		const task = await data.manager.start({ executor: "claude", description: "Trusted project", prompt: "hold trust" }, "parent-a");
		await until(() => data.adapter.releases.has("hold trust"), Boolean, "trusted native run");
		assert.equal(data.manager.activeClaudeInProject(data.project), true);
		assert.equal(task.workingDirectory, data.trees[0].path);
		assert.equal(data.adapter.opens[0]?.projectTrusted, true);
		data.adapter.releases.get("hold trust")!();
		await until(() => data.manager.activeClaudeInProject(data.project), (running) => !running, "session closed");

		data.setTrusted(false);
		await data.manager.send({ taskId: task.id, message: "continue without project settings" }, "parent-a");
		await until(() => data.manager.snapshot(task.id), terminal, "continuation after trust change");
		assert.equal(data.adapter.opens.at(-1)?.projectTrusted, false);
		assert.equal(data.adapter.opens.at(-1)?.cwd, task.workingDirectory);
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

test("every external background stop except the parent's own reaches the parent once, after the output is recorded", async () => {
	const data = await setup();
	try {
		// A user stop of a running turn is delivered with the output the turn produced.
		const stopped = await data.manager.start({ executor: "codex", description: "User stop", prompt: "hold user", run_in_background: true }, "parent-a", "call-user");
		await until(() => data.adapter.releases.has("hold user"), Boolean, "user-stop task running");
		await data.manager.cancel(stopped.id, "parent-a", "user_stop");
		const userStop = await until(() => data.notifications.filter((item) => item.result.task_id === stopped.id), (items) => items.length > 0, "user stop delivered");
		assert.equal(userStop.length, 1);
		assert.equal(userStop[0].result.status, "cancelled");
		assert.equal(userStop[0].result.output, "result:hold user", "delivered after the run recorded its output");
		// A host permission change stops the task and tells the parent why.
		const revoked = await data.manager.start({ executor: "codex", description: "Revoked", prompt: "hold policy", run_in_background: true }, "parent-a", "call-policy");
		await until(() => data.adapter.releases.has("hold policy"), Boolean, "policy task running");
		await data.manager.invalidatePolicies();
		const policy = await until(() => data.notifications.filter((item) => item.result.task_id === revoked.id), (items) => items.length > 0, "policy stop delivered");
		assert.equal(policy[0].result.status, "cancelled");
		assert.match(policy[0].result.error ?? "", /权限已更改/);
		// The parent's own TaskStop and abort are not reported back.
		for (const [prompt, reason] of [["hold model", "model_stop"], ["hold abort", "parent_abort"]] as const) {
			const task = await data.manager.start({ executor: "codex", description: reason, prompt, run_in_background: true }, "parent-a", `call-${reason}`);
			await until(() => data.adapter.releases.has(prompt), Boolean, `${reason} running`);
			await data.manager.cancel(task.id, "parent-a", reason);
			await until(() => data.manager.snapshot(task.id), terminal, `${reason} stopped`);
			await delay(50);
			assert.equal(data.notifications.filter((item) => item.result.task_id === task.id).length, 0, reason);
			assert.equal(data.manager.pendingNotifications("parent-a").length, 0);
		}
		await delay(50);
		assert.equal(data.notifications.length, 2);
	} finally { await data.cleanup(); }
});

test("an external background turn lost to an app restart is reported once; legacy interrupted records are not replayed", async () => {
	const data = await setup();
	const task = await data.manager.start({ executor: "codex", description: "Restarted", prompt: "hold restart notify", run_in_background: true }, "parent-a", "call-restart");
	await until(() => data.adapter.releases.has("hold restart notify"), Boolean, "native started");
	await data.manager.close();
	let after = new ExternalAgents(data.options);
	try {
		await after.initialize();
		const pending = after.pendingNotifications("parent-a");
		assert.equal(pending.length, 1);
		assert.equal(pending[0].task.status, "interrupted");
		assert.equal(pending[0].stopReason, "restart");
		await after.markNotified(task.id, 1);
		assert.equal(after.pendingNotifications("parent-a").length, 0);
		await after.close();
		// A record interrupted before stop reasons existed was never meant to notify.
		const file = join(data.dataDir, "external-agents.json");
		const stored = JSON.parse(await readFile(file, "utf8"));
		for (const record of stored.tasks) { delete record.stopReason; delete record.notifiedTurn; }
		await writeFile(file, JSON.stringify(stored));
		after = new ExternalAgents(data.options);
		await after.initialize();
		assert.equal(after.pendingNotifications("parent-a").length, 0);
	} finally { await after.close(); await data.cleanup(); }
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

test("external children under a dontAsk parent deny unapproved commands without an approval prompt", async () => {
	const data = await setup();
	try {
		data.setPolicy({ mode: "ask", dontAsk: true });
		const task = await data.manager.start({ executor: "codex", description: "No prompt", prompt: "ask dontAsk" }, "parent-a", "call-dont-ask");
		const state = await until(() => data.manager.snapshot(task.id), terminal, "dontAsk task finished");
		assert.equal(state.status, "completed");
		assert.deepEqual(data.adapter.decisions, ["deny"]);
		assert.equal(state.pendingApprovals.length, 0);
	} finally { await data.cleanup(); }
});

test("native settings are scoped to the originating multi task and stay pinned after restart", async () => {
	const data = await setup();
	let usesMultiSettings = true;
	let pin = { model: "configured-model", effort: "high" };
	data.options.usesMultiSettings = () => usesMultiSettings;
	data.options.executorModel = () => pin;
	const resumed = new ExternalAgents(data.options);
	try {
		const first = await data.manager.start({ executor: "codex", description: "Multi", prompt: "first" }, "parent-a");
		await until(() => data.manager.snapshot(first.id), terminal, "first multi turn");
		assert.equal(data.adapter.opens[0].model, pin.model);
		assert.equal(data.adapter.opens[0].effort, pin.effort);
		await data.manager.close();
		usesMultiSettings = false;
		pin = { model: "updated-model", effort: "medium" };
		await resumed.initialize();
		await resumed.send({ taskId: first.id, message: "continue" }, "parent-a");
		await until(() => resumed.snapshot(first.id), terminal, "continued multi turn");
		assert.equal(data.adapter.opens[1].resumeSessionId, "native-session-1");
		assert.equal(data.adapter.opens[1].model, "configured-model");
		assert.equal(data.adapter.opens[1].effort, "high");
		const standard = await resumed.start({ executor: "codex", description: "Standard", prompt: "ordinary" }, "parent-a");
		await until(() => resumed.snapshot(standard.id), terminal, "ordinary turn");
		assert.equal(data.adapter.opens[2].model, undefined);
		assert.equal(data.adapter.opens[2].effort, undefined);
	} finally { await resumed.close(); await data.cleanup(); }
});
