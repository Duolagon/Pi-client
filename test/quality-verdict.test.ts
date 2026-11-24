import assert from "node:assert/strict";
import { test } from "node:test";
import { collectVerificationEvidence, scoreTurn } from "../src/renderer/quality-verdict.ts";
import type { Message, MonitorRecord } from "../src/shared.ts";

let clock = 1000;
function at(): number {
	return clock++;
}

function assistant(content: Message extends { role: "assistant" } ? never : unknown, opts?: {
	stopReason?: "stop" | "error" | "aborted" | "toolUse";
	tools?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
}): Message {
	const tools = opts?.tools ?? [];
	return {
		role: "assistant",
		content: tools.map((t) => ({ type: "toolCall", id: t.id, name: t.name, arguments: t.arguments ?? {} })),
		usage: { input: 0, output: 0 },
		stopReason: opts?.stopReason ?? "stop",
		timestamp: at(),
	} as unknown as Message;
}

function toolResult(toolCallId: string, isError: boolean, details: Record<string, unknown> = { exitCode: isError ? 1 : 0 }): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
		details,
		timestamp: at(),
	} as unknown as Message;
}

function bashExec(command: string, exitCode: number | undefined, cancelled = false): Message {
	return { role: "bashExecution", command, output: "", exitCode, cancelled, truncated: false, timestamp: at() } as unknown as Message;
}

function edit(id = "e1"): { id: string; name: string; arguments?: Record<string, unknown> } {
	return { id, name: "Edit", arguments: { file_path: "a.ts" } };
}
function bash(id: string, command: string): { id: string; name: string; arguments?: Record<string, unknown> } {
	return { id, name: "Bash", arguments: { command } };
}

test("conversation-only turn yields no omen", () => {
	const v = scoreTurn([assistant(null)]);
	assert.equal(v.omen, "none");
});

test("edit + passing verify (agent Bash) = verified", () => {
	const msgs: Message[] = [
		assistant(null, { tools: [edit(), bash("b1", "npm run test:backend")] }),
		toolResult("e1", false),
		toolResult("b1", false),
	];
	const v = scoreTurn(msgs);
	assert.equal(v.omen, "verified");
	assert.equal(v.signals.verifyPassed, true);
});

test("a successful tool response without a recorded exit code cannot certify the check", () => {
	const msgs = [assistant(null, { tools: [edit(), bash("b1", "npm test")] }), toolResult("e1", false), toolResult("b1", false, {})];
	const verdict = scoreTurn(msgs);
	assert.equal(verdict.omen, "unverified");
	assert.equal(verdict.checks[0].status, "pending");
});

const checkShellId = "shell_0123456789ab";

function backgroundTestLaunch(): Message[] {
	return [
		assistant(null, { tools: [edit(), { id: "bg-test", name: "bash", arguments: { command: "npm test", run_in_background: true } }] }),
		toolResult("e1", false),
		// Previous clients populated exitCode on the launch acknowledgement. Existing sessions must stay accurate.
		toolResult("bg-test", false, { background: true, shell_id: checkShellId, status: "running", exitCode: 0 }),
	];
}

function shellEvent(details: Record<string, unknown>): Message {
	return {
		role: "custom",
		customType: "desktop_shell_event",
		content: "后台命令状态",
		display: true,
		details: { terminal: true, shell_id: checkShellId, ...details },
		timestamp: at(),
	} as Message;
}

test("a background check passes only after its own terminal exit with code zero", () => {
	const turn = backgroundTestLaunch();
	for (const later of [
		[],
		[shellEvent({ status: "completed", exit_code: 0, shell_id: "shell_other" })],
		[shellEvent({ status: "completed", exit_code: 0, terminal: false })],
		[shellEvent({ status: "completed", exit_code: null })],
	]) {
		const verdict = scoreTurn(turn, collectVerificationEvidence([...turn, ...later]));
		assert.equal(verdict.omen, "unverified");
		assert.equal(verdict.checks[0].status, "pending");
		assert.equal(verdict.checks[0].exitCode, undefined);
	}
	const evidence = collectVerificationEvidence([...turn, shellEvent({ status: "completed", exit_code: 0 })]);
	assert.equal(scoreTurn(turn, evidence).omen, "verified");
});

test("failed, stopped, and timed out background checks keep distinct outcomes", () => {
	const turn = backgroundTestLaunch();
	for (const [details, status] of [
		[{ status: "failed", exit_code: 1 }, "failed"],
		[{ status: "killed", reason: "user_stop" }, "stopped"],
		[{ status: "killed", reason: "timed_out" }, "timed_out"],
	] as const) {
		const verdict = scoreTurn(turn, collectVerificationEvidence([...turn, shellEvent(details)]));
		assert.equal(verdict.omen, "problem");
		assert.equal(verdict.checks[0].status, status);
	}
});

test("a live shell record shows a silent stop immediately", () => {
	const turn = backgroundTestLaunch();
	const monitor = {
		id: checkShellId, kind: "shell", status: "stopped", createdAt: turn[1].timestamp, updatedAt: at(),
	} as MonitorRecord;
	assert.equal(scoreTurn(turn, collectVerificationEvidence(turn, [monitor])).checks[0].status, "stopped");
});

test("edits in a later turn while a background check is running invalidate its result", () => {
	const turn = backgroundTestLaunch();
	const laterEdit = [assistant(null, { tools: [edit("e2")] }), toolResult("e2", false)];
	const completion = shellEvent({ status: "completed", exit_code: 0, started_at: turn[1].timestamp });
	const afterCompletion = [assistant(null, { tools: [edit("e3")] }), toolResult("e3", false)];
	assert.equal(scoreTurn(turn, collectVerificationEvidence([...turn, ...laterEdit, completion])).checks[0].status, "stale");
	assert.equal(scoreTurn(turn, collectVerificationEvidence([...turn, completion, ...afterCompletion])).checks[0].status, "passed");
});

test("edit + passing verify via ! bashExecution exit 0 = verified", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit()] }), toolResult("e1", false), bashExec("node --test test/foo.test.ts", 0)];
	assert.equal(scoreTurn(msgs).omen, "verified");
});

test("edit with no verification = unverified (never a fake pass)", () => {
	const v = scoreTurn([assistant(null, { tools: [edit()] }), toolResult("e1", false)]);
	assert.equal(v.omen, "unverified");
	assert.equal(v.signals.verifyRan, false);
});

test("failing verify (nonzero exit) = problem", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit()] }), bashExec("npm test", 1)];
	const v = scoreTurn(msgs);
	assert.equal(v.omen, "problem");
});

test("verify Bash tool whose result isError = problem", () => {
	const msgs: Message[] = [
		assistant(null, { tools: [edit(), bash("b1", "tsc --noEmit")] }),
		toolResult("b1", true),
	];
	assert.equal(scoreTurn(msgs).omen, "problem");
});

test("tool error anywhere = problem", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit(), bash("b1", "ls")] }), toolResult("b1", true)];
	assert.equal(scoreTurn(msgs).omen, "problem");
});

test("model error = problem", () => {
	assert.equal(scoreTurn([assistant(null, { stopReason: "error" })]).omen, "problem");
});

test("aborted by the user = no omen", () => {
	assert.equal(scoreTurn([assistant(null, { tools: [edit()] })]).omen, "none");
	assert.equal(scoreTurn([assistant(null, { stopReason: "aborted", tools: [edit()] })]).omen, "none");
});

test("non-verify bash command does not count as verification", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit(), bash("b1", "git status")] }), toolResult("e1", false), toolResult("b1", false)];
	assert.equal(scoreTurn(msgs).omen, "unverified");
});

test("cancelled verify = problem", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit()] }), bashExec("pytest", undefined, true)];
	assert.equal(scoreTurn(msgs).omen, "problem");
});

// Pi registers its built-in tools in lower case. These mirror the real demo turn:
// read → write → `node --test`, which must reach "verified".
test("Pi lowercase tool names: write + passing node --test = verified", () => {
	const msgs: Message[] = [
		assistant(null, {
			tools: [
				{ id: "r1", name: "read", arguments: { path: "src/greeting.mjs" } },
				{ id: "w1", name: "write", arguments: { path: "src/greeting.mjs" } },
				{ id: "b1", name: "bash", arguments: { command: "node --test test/greeting.test.mjs" } },
			],
		}),
		toolResult("r1", false),
		toolResult("w1", false),
		toolResult("b1", false),
	];
	const v = scoreTurn(msgs);
	assert.equal(v.signals.edited, true);
	assert.equal(v.signals.verifyPassed, true);
	assert.equal(v.omen, "verified");
});

test("Pi lowercase tool names: edit without verification = unverified", () => {
	const msgs: Message[] = [assistant(null, { tools: [{ id: "e1", name: "edit", arguments: { path: "a.ts" } }] }), toolResult("e1", false)];
	assert.equal(scoreTurn(msgs).omen, "unverified");
});

test("Pi lowercase tool names: failing bash verify = problem", () => {
	const msgs: Message[] = [
		assistant(null, {
			tools: [
				{ id: "w1", name: "write", arguments: { path: "a.ts" } },
				{ id: "b1", name: "bash", arguments: { command: "npm test" } },
			],
		}),
		toolResult("w1", false),
		toolResult("b1", true),
	];
	assert.equal(scoreTurn(msgs).omen, "problem");
});

test("read-only Pi turn yields no omen", () => {
	const msgs: Message[] = [assistant(null, { tools: [{ id: "r1", name: "read", arguments: { path: "a.ts" } }] }), toolResult("r1", false)];
	assert.equal(scoreTurn(msgs).omen, "none");
});

test("a write the user denied is not a tool error", () => {
	const denied = {
		role: "toolResult",
		toolCallId: "e1",
		toolName: "write",
		content: [{ type: "text", text: "用户未批准此操作。" }],
		isError: true,
		timestamp: at(),
	} as unknown as Message;
	assert.equal(scoreTurn([assistant(null, { tools: [edit()] }), denied]).omen, "none");
});

test("a passing check becomes stale after a later edit", () => {
	const result = scoreTurn([
		assistant(null, { tools: [bash("b1", "npm test")] }),
		toolResult("b1", false),
		assistant(null, { tools: [edit()] }),
		toolResult("e1", false),
	]);
	assert.equal(result.label, "改动后待验证");
	assert.deepEqual(result.checks.map(({ command, status }) => ({ command, status })), [{ command: "npm test", status: "stale" }]);
});

test("echo and compound shell lines cannot certify changes", () => {
	const result = scoreTurn([
		assistant(null, { tools: [edit()] }),
		toolResult("e1", false),
		bashExec('echo "npm test"', 0),
		bashExec("npm test || true", 0),
	]);
	assert.equal(result.signals.verifyRan, false);
	assert.equal(result.omen, "unverified");
});

test("later shell writes make checks stale while Git diff does not", () => {
	const checked = [assistant(null, { tools: [edit(), bash("test", "npm test")] }), toolResult("e1", false), toolResult("test", false)];
	assert.equal(scoreTurn([...checked, bashExec("git diff --stat", 0)]).checks[0].status, "passed");
	assert.equal(scoreTurn([...checked, bashExec("git status && git diff --stat", 0)]).checks[0].status, "passed");
	assert.equal(scoreTurn([...checked, bashExec('find src -name "*.ts"', 0)]).checks[0].status, "passed");
	assert.equal(scoreTurn([...checked, bashExec("printf x > src/a.ts", 0)]).checks[0].status, "stale");
	assert.equal(scoreTurn([...checked, bashExec("npx prettier --write src/a.ts", 0)]).checks[0].status, "stale");
});

test("a successful retry and verification supersede earlier failures", () => {
	const result = scoreTurn([
		assistant(null, { tools: [edit("failed-edit")] }), toolResult("failed-edit", true),
		bashExec("npm test", 1),
		assistant(null, { tools: [edit("fixed-edit")] }), toolResult("fixed-edit", false),
		bashExec("npm test", 0),
	]);
	assert.equal(result.omen, "verified");
	assert.deepEqual(result.checks.map((check) => check.status), ["stale", "passed"]);
	assert.equal(result.signals.toolErrors, 0);
});

test("a passing check does not resolve a failed operation on an unrelated path", () => {
	const result = scoreTurn([
		assistant(null, { tools: [{ id: "missing", name: "edit", arguments: { path: "different.ts" } }] }),
		toolResult("missing", true),
		assistant(null, { tools: [edit("ok")] }),
		toolResult("ok", false),
		bashExec("npm test", 0),
	]);
	assert.equal(result.omen, "problem");
	assert.equal(result.signals.toolErrors, 1);
});

test("an edit still running when a check starts invalidates the result", () => {
	const check = toolResult("test", false);
	assert.equal(check.role, "toolResult");
	const result = scoreTurn([
		assistant(null, { tools: [edit(), bash("test", "npm test")] }),
		toolResult("e1", false),
		{ ...check, timestamp: clock + 10, durationMs: 30 },
	]);
	assert.equal(result.checks[0].status, "stale");
});
