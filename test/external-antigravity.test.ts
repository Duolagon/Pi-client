import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityAdapter, antigravityProfile } from "../src/external-antigravity.ts";
import { discoverExecutors } from "../src/external-executors.ts";
import type { ExternalAdapterEvent, ExternalApprovalRequest, ExternalSessionOptions } from "../src/external-types.ts";

// Antigravity's `agy acp` speaks ACP v1 like Kimi but exposes no session modes.
async function fixture(env: NodeJS.ProcessEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-agy-acp-test-"));
	const executable = join(root, "agy");
	const log = join(root, "protocol.jsonl");
	await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-kimi-acp.mjs"), executable);
	await chmod(executable, 0o700);
	const events: ExternalAdapterEvent[] = [];
	const approvals: ExternalApprovalRequest[] = [];
	const options: ExternalSessionOptions = {
		executable, cwd: root, env: { PATH: process.env.PATH, KIMI_TEST_LOG: log, ACP_TEST_NO_MODES: "1", ...env },
		policy: { version: 1, mode: "ask", project: root, rules: [], disabledTools: [] },
		onEvent: (event) => events.push(event),
		onPermission: async (request) => { approvals.push(request); return { decision: "allow" }; },
	};
	return { root, events, approvals, options, records: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Antigravity ACP starts without session modes, forwards approvals and continues its session", async () => {
	const data = await fixture();
	const session = await new AntigravityAdapter().open(data.options);
	try {
		const first = await session.run("tools");
		assert.equal(first.status, "completed");
		assert.equal(data.approvals[0].toolName, "bash");
		assert.equal((await session.run("follow-up")).text, "turn 2: follow-up");
		const records = await data.records();
		assert.equal(records.some((item) => item.method === "session/set_mode"), false);
		assert.equal(records.filter((item) => item.method === "session/new").length, 1);
	} finally { await session.close(); await data.cleanup(); }
});

test("Antigravity launches agy acp sandboxed, with telemetry disabled and no auto-approval flag", () => {
	assert.deepEqual(antigravityProfile.args, ["acp", "--sandbox", "--disable-telemetry"]);
	assert.equal(antigravityProfile.args.includes("--dangerously-skip-permissions"), false);
});

test("Antigravity explains how to sign in when agy reports Authentication required", async () => {
	const data = await fixture({ ACP_TEST_AUTH: "1" });
	try { await assert.rejects(new AntigravityAdapter().open(data.options), /Antigravity 未登录.*agy/); }
	finally { await data.cleanup(); }
});

test("Antigravity still refuses read-only and fine-grained policies before spawning", async () => {
	const data = await fixture();
	try {
		await assert.rejects(new AntigravityAdapter().open({ ...data.options, policy: { ...data.options.policy, mode: "read" } }), /Antigravity ACP does not provide an enforceable read-only/);
		await assert.rejects(new AntigravityAdapter().open({ ...data.options, policy: { ...data.options.policy, disabledTools: ["bash"] } }), /fine-grained/);
		await assert.rejects(new AntigravityAdapter().open({ ...data.options, policy: { ...data.options.policy, dontAsk: true } }), /dontAsk/);
		await assert.rejects(readFile(join(data.root, "protocol.jsonl")), /ENOENT/);
	} finally { await data.cleanup(); }
});

test("Antigravity fails closed when it advertises modes but no manual default mode", async () => {
	const data = await fixture({ ACP_TEST_NO_MODES: "0", ACP_TEST_ODD_MODES: "1" });
	try { await assert.rejects(new AntigravityAdapter().open(data.options), /manual\/default approval mode/); }
	finally { await data.cleanup(); }
});

test("Antigravity tolerates mode updates when it never advertised modes", async () => {
	const data = await fixture();
	const session = await new AntigravityAdapter().open(data.options);
	try {
		const next = session.run("auto-mode");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await session.interrupt();
		assert.equal((await next).status, "cancelled");
	} finally { await session.close(); await data.cleanup(); }
});

test("discovery finds agy under the antigravity executor and marks it writable-only", async () => {
	const data = await fixture();
	try {
		const executors = await discoverExecutors({ antigravity: { enabled: true, executable: data.options.executable } }, { PATH: process.env.PATH });
		const agy = executors.find((item) => item.id === "antigravity");
		assert.ok(agy);
		assert.equal(agy.available, true);
		assert.equal(agy.capabilities.transport, "acp");
		assert.equal(agy.capabilities.readOnly, false);
		assert.equal(agy.capabilities.approvalSemantics, "agent-rules");
	} finally { await data.cleanup(); }
});
