#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

if (process.argv.includes("--version")) {
	process.stdout.write("codex-cli 0.171.0\n");
	process.exit(0);
}

const pending = new Map();
const input = createInterface({ input: process.stdin });
let serial = 0;
let threadId;
let active;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\r\n`);
const response = (id, result) => send({ id, result });
const notification = (method, params) => send({ method, params });
const request = (method, params) => new Promise((resolve) => {
	const id = `server-${++serial}`;
	pending.set(id, resolve);
	send({ id, method, params });
});
const complete = (text, status = "completed") => {
	if (!active) return;
	const { id } = active;
	if (text) notification("item/completed", { threadId, turnId: id, item: { id: `message-${id}`, type: "agentMessage", text, phase: "final_answer" } });
	notification("turn/completed", { threadId, turn: { id, status, error: status === "failed" ? { message: "scripted native failure" } : null } });
	active = undefined;
};
async function run(prompt, turnId) {
	const base = { threadId, turnId };
	if (prompt === "invalid") { process.stdout.write("NOT_JSON private stdout\n"); return; }
	if (prompt === "exit") process.exit(3);
	if (prompt === "fail") { complete("", "failed"); return; }
	if (prompt === "structured output") {
		notification("item/completed", { ...base, item: { id: "progress", type: "agentMessage", text: "Working on the report", phase: "commentary" } });
		complete('{"count":3}'); return;
	}
	if (prompt === "quota") {
		notification("error", { ...base, willRetry: true, error: { message: "temporary 503", codexErrorInfo: "serverOverloaded", additionalDetails: null } });
		notification("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded", additionalDetails: "resets at 5pm" } } });
		active = undefined; return;
	}
	if (prompt === "stderr-exit") {
		process.stderr.write("fatal: config broken sk-abcdefghijklmnop");
		setTimeout(() => process.stderr.write("qrstuvwx\n", () => process.exit(5)), 20);
		return;
	}
	if (prompt === "usage") {
		notification("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { inputTokens: 1010, outputTokens: 220 }, last: { inputTokens: 10, outputTokens: 20 } } });
		notification("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { inputTokens: 1040, outputTokens: 250 }, last: { inputTokens: 30, outputTokens: 30 } } });
		complete("usage reported"); return;
	}
	if (prompt === "foreign") {
		const result = await request("item/commandExecution/requestApproval", { ...base, threadId: "another-thread", itemId: "foreign", command: "touch foreign.txt" });
		complete(result?.error ? "foreign denied" : "foreign accepted");
		return;
	}
	if (["approve", "wait", "withdraw"].includes(prompt)) {
		const item = { id: `cmd-${turnId}`, type: "commandExecution", command: "printf native-tool", cwd: process.cwd(), status: "inProgress" };
		notification("item/started", { ...base, item });
		const waiting = request("item/commandExecution/requestApproval", { ...base, itemId: item.id, command: item.command });
		if (prompt === "withdraw") {
			const requestId = `server-${serial}`;
			setTimeout(() => notification("serverRequest/resolved", { threadId, requestId }), 20);
		}
		const approval = await waiting;
		if (!active || active.id !== turnId) return;
		const allowed = approval?.result?.decision === "accept";
		if (allowed) await writeFile(join(process.cwd(), "tool.txt"), "native tool ran\n");
		notification("item/commandExecution/outputDelta", { ...base, itemId: item.id, delta: allowed ? "native-tool" : "denied" });
		notification("item/completed", { ...base, item: { ...item, status: allowed ? "completed" : "declined", aggregatedOutput: "tool output" } });
		complete(allowed ? "approved" : "denied");
		return;
	}
	if (prompt === "file") {
		const item = { id: `edit-${turnId}`, type: "fileChange", status: "inProgress", changes: [{ path: join(process.cwd(), "one.txt"), diff: "+one" }, { path: join(process.cwd(), "two.txt"), diff: "+two" }] };
		notification("item/started", { ...base, item });
		const result = await request("item/fileChange/requestApproval", { ...base, itemId: item.id });
		const allowed = result?.result?.decision === "accept";
		if (allowed) await Promise.all(item.changes.map((change) => writeFile(change.path, change.diff)));
		notification("item/completed", { ...base, item: { ...item, status: allowed ? "completed" : "declined" } });
		complete(allowed ? "files allowed" : "files denied");
		return;
	}
	if (prompt === "question") {
		const result = await request("item/tool/requestUserInput", { ...base, questions: [{ id: "color", question: "Choose color", options: [{ label: "Blue" }] }] });
		complete(JSON.stringify(result?.result)); return;
	}
	if (prompt === "permissions") {
		const result = await request("item/permissions/requestApproval", { ...base, permissions: { fileSystem: { write: ["/"] } } });
		complete(JSON.stringify(result?.result)); return;
	}
	if (prompt === "slow-start") return;
	const text = `你好 🌍 ${prompt}`;
	const itemId = `message-${turnId}`;
	const data = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { ...base, itemId, delta: text } })}\n`);
	const split = data.indexOf(Buffer.from("🌍")) + 1;
	process.stdout.write(data.subarray(0, split));
	setTimeout(() => {
		process.stdout.write(data.subarray(split));
		notification("thread/tokenUsage/updated", { ...base, tokenUsage: { last: { inputTokens: 10, outputTokens: 20 } } });
		complete(text);
	}, 5);
}
input.on("line", (line) => {
	void (async () => {
		const message = JSON.parse(line);
		if (!message.method) {
			const resolve = pending.get(message.id);
			pending.delete(message.id);
			resolve?.(message); return;
		}
		if (process.env.CODEX_FIXTURE_LOG) await appendFile(process.env.CODEX_FIXTURE_LOG, `${JSON.stringify({ method: message.method, params: message.params, args: process.argv.slice(2) })}\n`);
		if (message.method === "initialize") response(message.id, { userAgent: "scripted-codex" });
		else if (message.method === "initialized") return;
		else if (["thread/start", "thread/resume"].includes(message.method)) {
			threadId = message.params.threadId ?? "thread-fixture";
			const model = process.env.CODEX_FIXTURE_EFFECTIVE_MODEL ?? message.params.model ?? "fixture-large";
			response(message.id, { thread: { id: threadId }, model, modelProvider: "fixture-provider", sandbox: { type: process.env.CODEX_FIXTURE_BAD_SANDBOX ? "dangerFullAccess" : message.params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" }, approvalPolicy: "untrusted", approvalsReviewer: "user" });
		} else if (message.method === "model/list") {
			if (process.env.CODEX_FIXTURE_NO_MODEL_LIST) send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
			else response(message.id, { data: [
				{ id: "m1", model: "fixture-large", displayName: "Large", hidden: false, isDefault: true, defaultReasoningEffort: "medium",
					supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }, { reasoningEffort: "max", description: "" }] },
				{ id: "m2", model: "fixture-small", displayName: "Small", hidden: false, isDefault: false, defaultReasoningEffort: "low",
					supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] },
			], nextCursor: null });
		} else if (message.method === "mcpServerStatus/list") response(message.id, { data: process.env.CODEX_FIXTURE_MCP ? [{ name: "native-mcp", tools: {} }] : [], nextCursor: null });
		else if (message.method === "turn/start") {
			active = { id: `turn-${++serial}` };
			notification("turn/started", { threadId, turn: active });
			response(message.id, { turn: active });
			void run(message.params.input[0].text, active.id);
		} else if (message.method === "turn/interrupt") {
			response(message.id, {}); complete("", "interrupted");
		} else if (message.method === "turn/steer" && !process.env.CODEX_FIXTURE_NO_STEER) {
			if (!active || message.params.threadId !== threadId || message.params.expectedTurnId !== active.id)
				send({ id: message.id, error: { code: -32602, message: "No matching active turn" } });
			else {
				response(message.id, { turnId: active.id });
				complete(`added: ${message.params.input[0].text}`);
			}
		} else send({ id: message.id, error: { code: -32601, message: "Unknown fake method" } });
	})().catch(() => process.exit(4));
});
