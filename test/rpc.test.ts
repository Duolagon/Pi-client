import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "../src/rpc.ts";

const directory = dirname(fileURLToPath(import.meta.url));
function child(scenario: string) {
	return new AgentProcess({
		executable: process.execPath,
		entry: join(directory, "fixtures/rpc-child.mjs"),
		cwd: directory,
		args: [],
		env: { ...process.env, PI_RPC_TEST_SCENARIO: scenario },
		onEvent: () => {},
	});
}

test("RPC framing preserves Unicode separators and split multibyte UTF-8 with CRLF", async () => {
	const process = child("framing");
	try {
		const result = await process.request<{ text: string }>({ type: "get_state" });
		assert.equal(result.text, "中文\u2028line\u2029tail");
	} finally {
		await process.stop();
	}
});

test("RPC command rejection is returned without poisoning later requests", async () => {
	const process = child("error");
	try {
		await assert.rejects(process.request({ type: "get_state" }), /Expected rejection/);
		await assert.rejects(process.request({ type: "get_messages" }), /Expected rejection/);
	} finally {
		await process.stop();
	}
});

test("RPC subprocess exit rejects in-flight requests promptly", async () => {
	const process = child("exit");
	try {
		await assert.rejects(process.request({ type: "get_state" }), /43/);
	} finally {
		await process.stop();
	}
});

test("RPC shutdown rejects pending requests and remains idempotent", async () => {
	const process = child("hang");
	const rejection = assert.rejects(process.request({ type: "get_state" }), /关闭|closed|stop/i);
	await process.stop();
	await rejection;
	await process.stop();
});

test("RPC executable startup failures reject a request", async () => {
	const process = new AgentProcess({
		executable: join(directory, "does-not-exist"),
		entry: "missing",
		cwd: directory,
		args: [],
		env: {},
		onEvent: () => {},
	});
	await assert.rejects(process.request({ type: "get_state" }), /ENOENT/);
	await process.stop();
});
