#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) { process.stdout.write("fake-acp 1.0\n"); process.exit(0); }
const line = createInterface({ input: process.stdin });
let session = "kimi-session-test";
let prompt;
let turns = 0;
const callbacks = new Map();
const log = (value) => { if (process.env.KIMI_TEST_LOG) appendFileSync(process.env.KIMI_TEST_LOG, JSON.stringify(value) + "\n"); };
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, data) => send({ id, result: data });
const update = (value, id = session) => send({ method: "session/update", params: { sessionId: id, update: value } });
const text = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const modes = { currentModeId: "yolo", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] };
if (process.env.ACP_TEST_ODD_MODES === "1") modes.availableModes = [{ id: "manual", name: "Manual" }, { id: "auto", name: "Auto" }];
const finish = (reason = "end_turn") => { const current = prompt; prompt = undefined; if (current) result(current.id, { stopReason: reason }); };
const ask = (id, method, params, handler) => { callbacks.set(id, handler); send({ id, method, params: { sessionId: session, ...params } }); };

line.on("line", (raw) => {
	const message = JSON.parse(raw);
	log(message);
	if (!message.method) { callbacks.get(message.id)?.(message); callbacks.delete(message.id); return; }
	if (message.method === "initialize" && process.env.ACP_TEST_AUTH === "1")
		return send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
	if (message.method === "initialize") return result(message.id, {
		protocolVersion: process.env.KIMI_TEST_PROTOCOL === "2" ? 2 : 1,
		agentInfo: { name: "Kimi Code CLI", version: "test" },
		agentCapabilities: { loadSession: process.env.KIMI_TEST_NO_RESTORE !== "1", sessionCapabilities: { ...(process.env.KIMI_TEST_LOAD_ONLY === "1" || process.env.KIMI_TEST_NO_RESTORE === "1" ? {} : { resume: {} }), close: {} } },
	});
	if (message.method === "session/new") return result(message.id, process.env.ACP_TEST_NO_MODES === "1" ? { sessionId: session } : { sessionId: session, modes });
	if (message.method === "session/resume" || message.method === "session/load") {
		session = message.params.sessionId;
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replay should not appear" } });
		return result(message.id, { modes });
	}
	if (message.method === "session/set_mode") return result(message.id, {});
	if (message.method === "session/close") return result(message.id, {});
	if (message.method === "session/cancel") return finish("cancelled");
	if (message.method !== "session/prompt") return send({ id: message.id, error: { code: -32601, message: "Unknown fake method" } });
	prompt = message;
	turns++;
	const request = message.params.prompt[0].text;
	if (request === "auto-mode") { update({ sessionUpdate: "current_mode_update", currentModeId: "auto" }); return; }
	if (request === "malformed") { update({ sessionUpdate: "tool_call", title: "Bash" }); return; }
	if (request === "wrong-session") {
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unrelated" } }, "other-session");
		text("correct session"); return finish();
	}
	if (request === "refusal") return finish("refusal");
	if (request === "clientfs" || request === "clientterminal") {
		ask("unsupported-client", request === "clientfs" ? "fs/read_text_file" : "terminal/create", { path: "/must/not/read", command: "must-not-execute" }, (response) => { text(response.error ? "CLIENT_REQUEST_REJECTED" : "UNEXPECTED_CLIENT_ACCESS"); finish(); });
		return;
	}
	if (request === "form") {
		ask("question-form", "elicitation/create", {
			mode: "form", message: "Pick color and targets", requestedSchema: { type: "object", properties: {
				q0: { type: "string", oneOf: [{ const: "blue" }, { const: "green" }] },
				q1: { type: "array", minItems: 1, items: { anyOf: [{ const: "test" }, { const: "docs" }] } },
			}, required: ["q0", "q1"] },
		}, (response) => { text(JSON.stringify(response.result)); finish(); });
		return;
	}
	if (request === "question") {
		ask("question-choice", "session/request_permission", { toolCall: { toolCallId: "question-tool", title: "AskUserQuestion", content: [{ type: "content", content: { type: "text", text: "Choose color" } }] }, options: [
			{ optionId: "q0_opt_0", name: "Blue", kind: "allow_once" }, { optionId: "q0_opt_1", name: "Green", kind: "allow_once" }, { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
		] }, (response) => { text(JSON.stringify(response.result)); finish(); });
		return;
	}
	if (request === "tools" || request === "hang") {
		const id = `${turns}:bash-call`;
		update({ sessionUpdate: "tool_call", toolCallId: id, title: "Bash", kind: "execute", status: "in_progress", rawInput: { command: "printf test" } });
		ask(`approval-${turns}`, "session/request_permission", { toolCall: { toolCallId: id, title: "Bash", content: [{ type: "content", content: { type: "text", text: "Requesting approval to execute printf test" } }] }, options: [
			{ optionId: "approve_once", name: "Approve once", kind: "allow_once" }, { optionId: "approve_always", name: "Approve session", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
		] }, (response) => {
			if (request === "hang") return;
			update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: "native tool output" } }] });
			text(`审批 ${JSON.stringify(response.result)}`); finish();
		});
		return;
	}
	text(`turn ${turns}: ${request}`);
	finish();
});
