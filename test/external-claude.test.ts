import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { ClaudeAdapter } from "../src/external-claude.ts";
import { ClaudeSdkHelper, type ClaudeHelperPacket } from "../src/external-claude-helper.ts";
import type { ExternalAdapterEvent, ExternalApprovalRequest, ExternalSessionOptions } from "../src/external-types.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";

const fixtureHelper = fileURLToPath(new URL("./fixtures/claude-helper.mjs", import.meta.url));
const basePolicy = (cwd: string): RuntimePermissionPolicy => ({ version: 1, mode: "auto", project: cwd, rules: [], disabledTools: [] });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-claude-adapter-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "seed.txt"), "seed");
	const env = { PATH: process.env.PATH, HOME: root };
	return { root, cwd, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function until(check: () => boolean, label: string) {
	const end = Date.now() + 3000;
	while (!check()) { if (Date.now() > end) throw new Error(label); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

function sdkHarness(policy: RuntimePermissionPolicy, options: { deny?: boolean; question?: boolean; slow?: boolean } = {}) {
	const packets: ClaudeHelperPacket[] = [];
	let config: Options | undefined;
	let factoryCalls = 0;
	let interrupt: (() => void) | undefined;
	let interrupted = false;
	let hookResult: unknown;
	const factory = ({ prompt, options: native }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
		config = native;
		factoryCalls++;
		const generator = (async function* () {
			yield { type: "system", subtype: "init", session_id: "sdk-session-1" };
			for await (const user of prompt) {
				const controller = new AbortController();
				const name = options.question ? "AskUserQuestion" : "Write";
				const args = options.question ? { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } : { file_path: join(policy.project, "target.txt"), content: "test" };
				hookResult = await native.hooks!.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: name, tool_input: args, tool_use_id: "native-write", session_id: "sdk-session-1", transcript_path: "", cwd: policy.project }, "native-write", { signal: controller.signal });
				if (options.slow) await new Promise<void>((resolve) => { interrupt = () => { interrupted = true; resolve(); }; });
				yield { type: "stream_event", session_id: "sdk-session-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sdk text" } } };
				yield { type: "user", session_id: "sdk-session-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-write", content: "done", is_error: false }] } };
				yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-session-1", result: String(user.message.content), usage: { input_tokens: 7, output_tokens: 3 } };
			}
		})();
		return Object.assign(generator, { initializationResult: async () => ({}), interrupt: async () => { interrupt?.(); }, close: () => { interrupt?.(); } }) as unknown as Query;
	};
	let helper: ClaudeSdkHelper;
	helper = new ClaudeSdkHelper((packet) => {
		packets.push(packet);
		if (packet.type === "permission") void helper.receive({ type: "permission_response", id: packet.request.id, response: { decision: options.deny ? "deny" : "allow", ...(options.question ? { answers: { "Which?": ["A", "B"] } } : {}) } });
	}, factory);
	return { helper, packets, get config() { return config; }, get factoryCalls() { return factoryCalls; }, get interrupted() { return interrupted; }, get hookResult() { return hookResult; } };
}

test("Claude SDK hooks authorize all tools before native auto-allow and retain one session across turns", async () => {
	const data = await fixture();
	const harness = sdkHarness(basePolicy(data.cwd));
	try {
		await harness.helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, resumeSessionId: "resumed-session", policy: basePolicy(data.cwd) } });
		await harness.helper.receive({ type: "run", id: "turn1", prompt: "first" });
		await until(() => harness.packets.some((packet) => packet.type === "response" && packet.id === "turn1"), "first result");
		await harness.helper.receive({ type: "run", id: "turn2", prompt: "continue" });
		await until(() => harness.packets.some((packet) => packet.type === "response" && packet.id === "turn2"), "second result");
		assert.equal(harness.factoryCalls, 1);
		assert.equal(harness.config!.resume, "resumed-session");
		assert.equal(harness.config!.pathToClaudeCodeExecutable, "/fake/claude");
		assert.equal(harness.config!.permissionMode, "default");
		assert.deepEqual(harness.config!.settingSources, ["user"]);
		assert.equal(harness.packets.filter((packet) => packet.type === "permission").length, 2);
		const request = harness.packets.find((packet) => packet.type === "permission");
		assert.equal(request?.type === "permission" && request.request.input.path, join(data.cwd, "target.txt"));
		assert.deepEqual(harness.hookResult, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
	} finally { await harness.helper.close(); await data.cleanup(); }
});

test("Claude SDK enables project and local settings only after explicit host trust", async () => {
	const data = await fixture();
	const policy = basePolicy(data.cwd);
	const harness = sdkHarness(policy);
	try {
		await harness.helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, policy, projectTrusted: true, maxBudgetUsd: 0.5 } });
		assert.deepEqual(harness.config!.settingSources, ["user", "project", "local"]);
		assert.equal(harness.config!.maxBudgetUsd, 0.5);
	} finally { await harness.helper.close(); await data.cleanup(); }
});

test("Claude read-only tool ceiling and denied policy cannot be bypassed by host approval", async () => {
	const data = await fixture();
	const policy = { ...basePolicy(data.cwd), mode: "read" as const };
	const harness = sdkHarness(policy);
	try {
		await harness.helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, policy } });
		await harness.helper.receive({ type: "run", id: "turn", prompt: "write denied" });
		await until(() => harness.packets.some((packet) => packet.type === "response" && packet.id === "turn"), "result");
		assert.deepEqual(harness.config!.tools, ["Read", "Grep", "Glob", "LS"]);
		assert.equal(harness.config!.permissionMode, "plan");
		assert.equal(harness.packets.filter((packet) => packet.type === "permission").length, 0);
		assert.equal((harness.hookResult as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
		const decision = await harness.config!.canUseTool!("Bash", { command: "echo bypass" }, { toolUseID: "shell", signal: new AbortController().signal });
		assert.equal(decision?.behavior, "deny");
	} finally { await harness.helper.close(); await data.cleanup(); }
});

test("Claude question answers and cancellation retain the original native tool context", async () => {
	const data = await fixture();
	const harness = sdkHarness(basePolicy(data.cwd), { question: true, slow: true });
	try {
		await harness.helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, policy: basePolicy(data.cwd) } });
		await harness.helper.receive({ type: "run", id: "turn", prompt: "question" });
		await until(() => Boolean(harness.hookResult), "question authorization");
		assert.deepEqual((harness.hookResult as { hookSpecificOutput: { updatedInput: { answers: unknown } } }).hookSpecificOutput.updatedInput.answers, { "Which?": "A, B" });
		await harness.helper.receive({ type: "interrupt", id: "stop" });
		await until(() => harness.packets.some((packet) => packet.type === "response" && packet.id === "turn"), "cancelled result");
		const result = harness.packets.find((packet) => packet.type === "response" && packet.id === "turn");
		assert.equal(result?.type === "response" && result.ok && (result.value as { status: string }).status, "cancelled");
		assert.equal(harness.interrupted, true);
	} finally { await harness.helper.close(); await data.cleanup(); }
});

test("Claude helper validates configuration and protocol requests without starting a model", async () => {
	const packets: ClaudeHelperPacket[] = [];
	const helper = new ClaudeSdkHelper((packet) => packets.push(packet), () => { throw new Error("must not start"); });
	await helper.receive({ type: "init", id: "invalid", config: { executable: "relative", cwd: "/project", policy: basePolicy("/project") } });
	assert.equal(packets[0].type === "response" && packets[0].ok, false);
	await helper.receive({ type: "init", id: "invalid-trust", config: { executable: "/fake/claude", cwd: "/project", policy: basePolicy("/project"), projectTrusted: "true" } });
	assert.equal(packets[1].type === "response" && !packets[1].ok && packets[1].error, "Invalid Claude project trust");
	await helper.close();
});

test("Claude adapter transports real helper process framing, approvals, streaming and continuing sessions", async () => {
	const data = await fixture();
	const events: ExternalAdapterEvent[] = [];
	const approvals: ExternalApprovalRequest[] = [];
	const session = await new ClaudeAdapter().open({ executable: "/fake/claude", cwd: data.cwd, env: data.env, policy: basePolicy(data.cwd), helperPath: fixtureHelper, onEvent: (event) => events.push(event), onPermission: async (request) => { approvals.push(request); return { decision: "allow" }; } });
	try {
		assert.equal((await session.run("first")).text, "中文 hello first");
		assert.equal((await session.run("follow-up")).text, "中文 hello follow-up");
		assert.equal(session.sessionId, "claude-wire-session");
		assert.equal(approvals.length, 2);
		assert.ok(events.some((event) => event.type === "text_delta" && event.text.includes("中文")));
	} finally { await session.close(); await data.cleanup(); }
});

test("Claude adapter cancellation resolves a turn and allows further collaboration", async () => {
	const data = await fixture();
	let approve: ((value: { decision: "allow" }) => void) | undefined;
	const session = await new ClaudeAdapter().open({ executable: "/fake/claude", cwd: data.cwd, env: data.env, policy: basePolicy(data.cwd), helperPath: fixtureHelper, resumeSessionId: "existing-claude-session", onEvent() {}, onPermission: () => new Promise((resolve) => { approve = resolve; }) });
	try {
		const controller = new AbortController();
		const turn = session.run("wait", controller.signal);
		await until(() => Boolean(approve), "pending approval");
		controller.abort();
		assert.equal((await turn).status, "cancelled");
		approve?.({ decision: "allow" });
		assert.equal(session.sessionId, "existing-claude-session");
	} finally { await session.close(); await data.cleanup(); }
});

test("Claude adapter rejects process failure, malformed frames and missing helper", async () => {
	const data = await fixture();
	const options: ExternalSessionOptions = { executable: "/fake/claude", cwd: data.cwd, env: data.env, policy: basePolicy(data.cwd), helperPath: fixtureHelper, onEvent() {}, onPermission: async () => ({ decision: "deny" }) };
	try {
		await assert.rejects(new ClaudeAdapter().open({ ...options, helperPath: undefined }), /helper/);
		for (const prompt of ["broken", "exit"]) {
			const session = await new ClaudeAdapter().open(options);
			await assert.rejects(session.run(prompt), /protocol|exited/);
			await session.close();
		}
	} finally { await data.cleanup(); }
});

test("Claude helper owns an approval deadline shorter than the native hook timeout and denies on timeout", async () => {
	const data = await fixture();
	const packets: ClaudeHelperPacket[] = [];
	let outcome: unknown;
	const helper = new ClaudeSdkHelper((packet) => packets.push(packet), ({ prompt, options }) => {
		const generator = (async function* () {
			for await (const _ of prompt) {
				outcome = await options.hooks!.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo test" }, tool_use_id: "deadline", session_id: "test", transcript_path: "", cwd: data.cwd }, "deadline", { signal: new AbortController().signal });
				yield { type: "result", subtype: "success", result: "denied", is_error: false, session_id: "test", usage: {} };
			}
		})();
		return Object.assign(generator, { initializationResult: async () => ({}), close() {}, interrupt: async () => {} }) as unknown as Query;
	}, 10);
	try {
		await helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, policy: basePolicy(data.cwd) } });
		await helper.receive({ type: "run", id: "run", prompt: "authorization deadline" });
		await until(() => Boolean(outcome), "deadline denied");
		assert.equal((outcome as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
		assert.ok(packets.some((packet) => packet.type === "permission_cancelled" && /timed out/.test(packet.reason)));
	} finally { await helper.close(); await data.cleanup(); }
});

test("Claude closing the host clears pending approvals and terminates native descendants in its managed group", { skip: process.platform === "win32" }, async () => {
	const data = await fixture();
	let pid: number | undefined;
	let approvalCancelled = false;
	let approvalEntered = false;
	const session = await new ClaudeAdapter().open({ executable: "/fake/claude", cwd: data.cwd, env: data.env, policy: basePolicy(data.cwd), helperPath: fixtureHelper,
		onEvent(event) { if (event.type === "diagnostic" && event.message.startsWith("CHILD_PID:")) pid = Number(event.message.slice(10)); },
		onPermission: (_request, signal) => new Promise((resolve) => { approvalEntered = true; signal?.addEventListener("abort", () => { approvalCancelled = true; resolve({ decision: "cancel" }); }, { once: true }); }),
	});
	try {
		const turn = session.run("wait-child").catch((error: unknown) => error);
		await until(() => Boolean(pid) && approvalEntered, "native descendant and pending approval started");
		await session.close();
		await turn;
		assert.equal(approvalCancelled, true);
		await until(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, "native descendant stopped");
	} finally { await session.close(); await data.cleanup(); }
});

test("Claude helper passes the pinned model and effort to the SDK and rejects malformed ones", async () => {
	const data = await fixture();
	let seen: { model?: string; effort?: string } | undefined;
	const factory = ({ options }: { options: { model?: string; effort?: string } }) => {
		seen = { model: options.model, effort: options.effort };
		const generator = (async function* () {})();
		return Object.assign(generator, { initializationResult: async () => ({}), close() {}, interrupt: async () => {} }) as unknown as Query;
	};
	const helper = new ClaudeSdkHelper(() => {}, factory as never);
	try {
		await helper.receive({ type: "init", id: "init", config: { executable: "/fake/claude", cwd: data.cwd, policy: basePolicy(data.cwd), model: "opus", effort: "xhigh" } });
		assert.deepEqual(seen, { model: "opus", effort: "xhigh" });
	} finally { await helper.close(); }
	const packets: ClaudeHelperPacket[] = [];
	const bad = new ClaudeSdkHelper((packet) => packets.push(packet), factory as never);
	try {
		await bad.receive({ type: "init", id: "bad", config: { executable: "/fake/claude", cwd: data.cwd, policy: basePolicy(data.cwd), effort: "ultra" } });
		assert.ok(packets.some((packet) => packet.type === "response" && !packet.ok && /Invalid Claude effort/.test(packet.error)));
	} finally { await bad.close(); await data.cleanup(); }
});
