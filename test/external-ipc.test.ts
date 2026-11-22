import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopService } from "../src/backend.ts";
import { installExternalHandlers } from "../src/external-ipc.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import type {
	ExternalAdapter, ExternalApprovalResponse, ExternalEvent, ExternalExecutor,
	ExternalReplay, ExternalSessionOptions, ExternalTask, ExternalTaskResult, ExternalTurnResult,
} from "../src/external-types.ts";

const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

class IPCAdapter implements ExternalAdapter {
	opens: ExternalSessionOptions[] = [];
	responses: ExternalApprovalResponse[] = [];
	async open(options: ExternalSessionOptions) {
		this.opens.push(options);
		const id = options.resumeSessionId ?? `native-ipc-${this.opens.length}`;
		options.onEvent({ type: "session", sessionId: id });
		let interrupted = false;
		let release: (() => void) | undefined;
		return {
			sessionId: id,
			run: async (prompt: string, signal?: AbortSignal): Promise<ExternalTurnResult> => {
				const abort = () => { interrupted = true; release?.(); };
				signal?.addEventListener("abort", abort, { once: true });
				try {
					if (prompt.startsWith("hold")) await new Promise<void>((resolve) => { release = resolve; if (signal?.aborted) abort(); });
					if (prompt === "ask-write" || prompt === "ask-question") {
						const path = join(options.cwd, "external-ipc.txt");
						const response = await options.onPermission({ id: "native-approval", kind: prompt === "ask-question" ? "question" : "file", toolName: prompt === "ask-question" ? "AskUserQuestion" : "Write",
							input: prompt === "ask-question" ? { question: "Choose output" } : { file_path: path, content: "approved external write\n" },
							options: [{ id: "native:allow once", label: "Allow", kind: "allow_once" }, { id: "native:deny", label: "Deny", kind: "reject_once" }] });
						this.responses.push(response);
						if (response.decision === "cancel") interrupted = true;
						if (prompt === "ask-write" && response.decision === "allow") await writeFile(path, "approved external write\n");
					}
					const text = `external IPC result: ${prompt}`;
					options.onEvent({ type: "text_delta", text });
					return { status: interrupted || signal?.aborted ? "cancelled" : "completed", text, sessionId: id };
				} finally { signal?.removeEventListener("abort", abort); }
			},
			interrupt: async () => { interrupted = true; release?.(); },
			close: async () => { interrupted = true; release?.(); },
		};
	}
}

async function setup() {
	const fixture = await createCoreFixture();
	await exec("git", ["init", fixture.project]);
	await exec("git", ["add", "seed.txt"], { cwd: fixture.project });
	await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "test: Prepare isolated external IPC fixture"], { cwd: fixture.project });
	const binary = join(fixture.root, "external-version-fixture");
	await writeFile(binary, "#!/bin/sh\nprintf 'External fixture 1.0\\n'\n", { mode: 0o700 });
	const adapter = new IPCAdapter();
	const service = new DesktopService({ dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"), toolControlExtension: join(source, "tool-control-extension.ts"),
		navigationExtension: join(source, "session-navigation-extension.ts"), env: fixture.env, initialProject: fixture.project,
		externalAdapters: { codex: adapter, claude: adapter, kimi: adapter } });
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	let allowedSender = true;
	let guardCalls = 0;
	installExternalHandlers((channel, action) => {
		assert.ok(!handlers.has(channel));
		handlers.set(channel, async (...args) => { guardCalls++; if (!allowedSender) throw new Error("Untrusted renderer rejected by host gate"); return action(...args); });
	}, service);
	const events: ExternalEvent[] = [];
	service.subscribeExternal((event) => events.push(event));
	const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
		const handler = handlers.get(channel); assert.ok(handler, `Missing ${channel}`); return await handler(...args) as T;
	};
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		for (const id of ["codex", "claude", "kimi", "antigravity"]) await invoke("pi:external:configure", { id, executable: binary });
		return { fixture, service, adapter, invoke, handlers, events, id: snapshot.active!.id, binary,
			guardCalls: () => guardCalls, setSender: (value: boolean) => { allowedSender = value; },
			cleanup: async () => { await service.close(); await fixture.cleanup(); } };
	} catch (error) { await service.close(); await fixture.cleanup(); throw error; }
}

async function until<T>(get: () => T | Promise<T>, check: (value: T) => boolean, label: string): Promise<T> {
	const end = Date.now() + 15000;
	for (;;) { const value = await get(); if (check(value)) return value; if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(15); }
}
const terminal = (task: ExternalTask) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status);

test("external IPC exposes all endpoints through the host gate, continues exact native sessions and routes parent-scoped events", { timeout: 45000 }, async (t) => {
	const data = await setup(); t.after(data.cleanup);
	assert.deepEqual([...data.handlers.keys()].sort(), ["pi:external:cancel", "pi:external:configure", "pi:external:executors", "pi:external:list", "pi:external:replay", "pi:external:respond", "pi:external:result", "pi:external:send", "pi:external:snapshot", "pi:external:start"]);
	const executors = await data.invoke<ExternalExecutor[]>("pi:external:executors");
	assert.equal(executors.length, 4); assert.ok(executors.every((item) => item.available && item.version === "External fixture 1.0"));
	data.setSender(false);
	await assert.rejects(data.invoke("pi:external:executors"), /Untrusted renderer/);
	data.setSender(true);
	const first = await data.invoke<ExternalTask>("pi:external:start", { executor: "codex", description: "First external task", prompt: "first", conversationId: data.id });
	let snapshot = await until(() => data.invoke<ExternalTask>("pi:external:snapshot", first.id), terminal, "first external task");
	assert.equal(snapshot.status, "completed"); assert.ok(snapshot.worktreeId); assert.equal(snapshot.parentConversationId, data.id);
	const nativeId = snapshot.nativeSessionId;
	const result = await data.invoke<ExternalTaskResult>("pi:external:result", first.id, { block: true, timeout: 100 });
	assert.equal(result.output, "external IPC result: first"); assert.equal(result.native_session_id, nativeId);
	await data.invoke("pi:external:send", { taskId: first.id, message: "continue implementation" });
	snapshot = await until(() => data.invoke<ExternalTask>("pi:external:snapshot", first.id), (task) => terminal(task) && task.turn === 2, "continued task");
	assert.equal(snapshot.nativeSessionId, nativeId); assert.equal(data.adapter.opens.at(-1)?.resumeSessionId, nativeId);
	const other = await data.service.newConversation();
	const second = await data.invoke<ExternalTask>("pi:external:start", { executor: "claude", description: "Another parent", prompt: "second", conversationId: other.active!.id });
	await until(() => data.invoke<ExternalTask>("pi:external:snapshot", second.id), terminal, "other parent task");
	assert.deepEqual((await data.invoke<ExternalTask[]>("pi:external:list", data.id)).map((task) => task.id), [first.id]);
	assert.equal((await data.invoke<ExternalTask[]>("pi:external:list")).length, 2);
	const replay = await data.invoke<ExternalReplay>("pi:external:replay", first.id, 0);
	assert.ok(replay.events.some((packet) => packet.event.type === "text_delta"));
	assert.ok(replay.events.every((packet) => packet.taskId === first.id && packet.parentConversationId === data.id));
	assert.deepEqual((await data.invoke<ExternalReplay>("pi:external:replay", first.id, replay.latestSequence)).events, []);
	assert.ok(data.events.some((packet) => packet.event.type === "task_updated" && packet.taskId === second.id));
	await data.invoke("pi:external:configure", { id: "kimi", enabled: false });
	await assert.rejects(data.invoke("pi:external:start", { executor: "kimi", description: "Disabled", prompt: "must not run" }), /停用/);
	assert.ok(data.guardCalls() >= 15);
});

test("external IPC approvals keep native choices and answers, allow foreground Pi work while pending and clear on cancellation", { timeout: 45000 }, async (t) => {
	const data = await setup(); t.after(data.cleanup);
	const task = await data.invoke<ExternalTask>("pi:external:start", { executor: "claude", description: "Approve a write", prompt: "ask-write" });
	const waiting = await until(() => data.invoke<ExternalTask>("pi:external:snapshot", task.id), (task) => task.status === "waiting_for_input", "external write approval");
	await assert.rejects(readFile(join(waiting.workingDirectory, "external-ipc.txt")), /ENOENT/);
	const started = Date.now();
	const pending = await data.invoke<ExternalTaskResult>("pi:external:result", task.id, { block: true, timeout: 60000 });
	assert.equal(pending.pending_approvals, 1); assert.ok(Date.now() - started < 1000);
	assert.equal((await data.service.snapshot()).active?.id, data.id);
	await data.service.command({ type: "prompt", message: "foreground remains usable while external waits" });
	await until(() => data.service.snapshot(), (snapshot) => !snapshot.state?.isStreaming && snapshot.messages.some((message) => message.role === "assistant"), "foreground Pi completion");
	await assert.rejects(data.invoke("pi:external:respond", task.id, waiting.pendingApprovals[0].id, { decision: "allow", optionId: "forged-native-choice" }), /选项无效/);
	await data.invoke("pi:external:respond", task.id, waiting.pendingApprovals[0].id, { decision: "allow", optionId: "native:allow once" });
	await until(() => data.invoke<ExternalTask>("pi:external:snapshot", task.id), terminal, "approved write");
	assert.equal(await readFile(join(waiting.workingDirectory, "external-ipc.txt"), "utf8"), "approved external write\n");
	assert.equal(data.adapter.responses[0].optionId, "native:allow once");
	await data.invoke("pi:external:send", { taskId: task.id, message: "ask-question" });
	const question = await until(() => data.invoke<ExternalTask>("pi:external:snapshot", task.id), (task) => task.status === "waiting_for_input", "native question");
	await data.invoke("pi:external:respond", task.id, question.pendingApprovals[0].id, { decision: "allow", optionId: "native:allow once", answers: { q0: "selected", q1: ["tests", "docs"] } });
	await until(() => data.invoke<ExternalTask>("pi:external:snapshot", task.id), terminal, "question completion");
	assert.deepEqual(data.adapter.responses[1].answers, { q0: "selected", q1: ["tests", "docs"] });
	await data.invoke("pi:external:send", { taskId: task.id, message: "hold until cancelled" });
	await until(() => data.invoke<ExternalTask>("pi:external:snapshot", task.id), (task) => task.status === "running", "running continuation");
	const cancelled = await data.invoke<ExternalTask>("pi:external:cancel", task.id);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.pendingApprovals.length, 0);
	await assert.rejects(data.invoke("pi:external:respond", task.id, question.pendingApprovals[0].id, { decision: "allow" }), /失效/);
});

test("external IPC rejects malformed fields, enums, local paths, owner IDs, waits and approval answers without starting tasks", { timeout: 45000 }, async (t) => {
	const data = await setup(); t.after(data.cleanup);
	const start = { executor: "codex", description: "Valid", prompt: "valid" };
	const invalid: Array<[string, ...unknown[]]> = [
		["pi:external:configure", null], ["pi:external:configure", []],
		["pi:external:configure", { id: ["codex"] }], ["pi:external:configure", { id: "unknown" }],
		["pi:external:configure", { id: "codex", enabled: "true" }], ["pi:external:configure", { id: "codex", executable: "relative/path" }],
		["pi:external:configure", { id: "codex", executable: [data.binary] }], ["pi:external:configure", { id: "codex", command: "sh -c bad" }],
		["pi:external:start", null], ["pi:external:start", []], ["pi:external:start", { ...start, executor: ["codex"] }],
		["pi:external:start", { ...start, subagent_type: ["Explore"] }], ["pi:external:start", { ...start, isolation: ["worktree"] }],
		["pi:external:start", { ...start, run_in_background: 1 }], ["pi:external:start", { ...start, conversationId: "../outside" }],
		["pi:external:start", { ...start, conversationId: [] }], ["pi:external:start", { ...start, conversationId: "missing-owner" }],
		["pi:external:start", { ...start, worktree_id: "../outside" }], ["pi:external:start", { ...start, cwd: "/arbitrary" }],
		["pi:external:start", { ...start, description: " " }], ["pi:external:start", { ...start, prompt: "x".repeat(2 * 1024 * 1024 + 1) }],
		["pi:external:list", "../outside"], ["pi:external:list", [data.id]], ["pi:external:snapshot", "../outside"],
		["pi:external:send", { taskId: "external-x", message: "valid", runInBackground: "true" }], ["pi:external:send", { taskId: "external-x", message: "valid", parent: data.id }],
		["pi:external:result", "external-x", { block: "true" }], ["pi:external:result", "external-x", { timeout: -1 }],
		["pi:external:result", "external-x", { timeout: 60001 }], ["pi:external:result", "external-x", { timeout: 0.5 }], ["pi:external:result", "external-x", { timeout: Number.NaN }],
		["pi:external:result", "external-x", { owner: data.id }], ["pi:external:cancel", []],
		["pi:external:respond", "external-x", "request-x", { decision: ["allow"] }], ["pi:external:respond", "external-x", "request-x", { decision: "allow", optionId: [] }],
		["pi:external:respond", "external-x", "request-x", { decision: "allow", answers: [] }], ["pi:external:respond", "external-x", "request-x", { decision: "allow", answers: { q0: 42 } }],
		["pi:external:respond", "external-x", "request-x", { decision: "allow", answers: { q0: ["valid", 42] } }],
		["pi:external:respond", "external-x", "request-x", { decision: "allow", answers: { q0: "x".repeat(32769) } }],
		["pi:external:respond", "external-x", "request-x", { decision: "allow", unknown: true }],
		["pi:external:replay", "external-x", -1], ["pi:external:replay", "external-x", 0.5], ["pi:external:replay", "external-x", "1"],
	];
	for (const [channel, ...args] of invalid) await assert.rejects(data.invoke(channel, ...args), `${channel} accepted malformed input`);
	assert.deepEqual(await data.invoke("pi:external:list"), []);
	assert.equal(data.adapter.opens.length, 0);
});
