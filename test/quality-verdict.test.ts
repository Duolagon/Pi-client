import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreTurn } from "../src/renderer/quality-verdict.ts";
import type { Message } from "../src/shared.ts";

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

function toolResult(toolCallId: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
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

test("edit + passing verify (agent Bash) = grail", () => {
	const msgs: Message[] = [
		assistant(null, { tools: [edit(), bash("b1", "npm run test:backend")] }),
		toolResult("b1", false),
	];
	const v = scoreTurn(msgs);
	assert.equal(v.omen, "grail");
	assert.equal(v.signals.verifyPassed, true);
});

test("edit + passing verify via ! bashExecution exit 0 = grail", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit()] }), bashExec("node --test test/foo.test.ts", 0)];
	assert.equal(scoreTurn(msgs).omen, "grail");
});

test("edit with no verification = unverified (never a fake pass)", () => {
	const v = scoreTurn([assistant(null, { tools: [edit()] })]);
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
	assert.equal(scoreTurn([assistant(null, { tools: [edit()] }, )]).omen, "unverified");
	assert.equal(scoreTurn([assistant(null, { stopReason: "aborted", tools: [edit()] })]).omen, "none");
});

test("non-verify bash command does not count as verification", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit(), bash("b1", "git status")] }), toolResult("b1", false)];
	assert.equal(scoreTurn(msgs).omen, "unverified");
});

test("cancelled verify = problem", () => {
	const msgs: Message[] = [assistant(null, { tools: [edit()] }), bashExec("pytest", undefined, true)];
	assert.equal(scoreTurn(msgs).omen, "problem");
});

// Pi registers its built-in tools in lower case. These mirror the real demo turn:
// read → write → `node --test`, which must reach the grail.
test("Pi lowercase tool names: write + passing node --test = grail", () => {
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
	assert.equal(v.omen, "grail");
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
	assert.equal(scoreTurn([assistant(null, { tools: [edit()] }), denied]).omen, "unverified");
});
