import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KimiAdapter, assertKimiPolicy } from "../src/external-kimi.ts";
import type { ExternalAdapterEvent, ExternalApprovalRequest, ExternalApprovalResponse, ExternalSessionOptions } from "../src/external-types.ts";

async function fixture(settings: {
	env?: NodeJS.ProcessEnv;
	permission?: (request: ExternalApprovalRequest) => Promise<ExternalApprovalResponse>;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-kimi-acp-test-"));
	const executable = join(root, "kimi");
	const log = join(root, "protocol.jsonl");
	await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-kimi-acp.mjs"), executable);
	await chmod(executable, 0o700);
	const events: ExternalAdapterEvent[] = [];
	const approvals: ExternalApprovalRequest[] = [];
	const options: ExternalSessionOptions = {
		executable, cwd: root, env: { PATH: process.env.PATH, KIMI_TEST_LOG: log, ...settings.env },
		policy: { version: 1, mode: "ask", project: root, rules: [], disabledTools: ["Agent", "AgentSend", "WorktreeRemove"] },
		onEvent: (event) => events.push(event),
		onPermission: async (request) => { approvals.push(request); return settings.permission ? settings.permission(request) : { decision: "allow" }; },
	};
	return { root, events, approvals, options, records: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Kimi ACP negotiates manual mode, streams actual tool events, preserves approval IDs and continues its session", async () => {
	const data = await fixture();
	const session = await new KimiAdapter().open(data.options);
	try {
		const first = await session.run("tools");
		assert.equal(first.status, "completed");
		assert.match(first.text, /审批.*approve_once/);
		assert.equal(first.sessionId, "kimi-session-test");
		assert.equal(data.approvals[0].toolName, "bash");
		assert.equal(data.approvals[0].input.command, "printf test");
		assert.deepEqual(data.approvals[0].options?.map((item) => item.id), ["approve_once", "approve_always", "reject"]);
		assert.equal(data.events.filter((event) => event.type === "tool_start").length, 1);
		assert.equal(data.events.filter((event) => event.type === "tool_end").length, 1);
		assert.equal((await session.run("follow-up")).text, "turn 2: follow-up");
		const records = await data.records();
		assert.equal(records.filter((item) => item.method === "session/new").length, 1);
		assert.deepEqual(records.find((item) => item.method === "session/set_mode").params, { sessionId: session.sessionId, modeId: "default" });
		const caps = records.find((item) => item.method === "initialize").params.clientCapabilities;
		assert.equal(caps.terminal, false);
		assert.equal(caps.fs.writeTextFile, false);
	} finally { await session.close(); await data.cleanup(); }
});

test("Kimi deny and explicit option choices round-trip without inventing native option IDs", async () => {
	for (const response of [{ decision: "deny" }, { decision: "allow", optionId: "approve_always" }, { decision: "allow", optionId: "forged" }] as ExternalApprovalResponse[]) {
		const data = await fixture({ permission: async () => response });
		const session = await new KimiAdapter().open(data.options);
		try {
			const result = await session.run("tools");
			assert.match(result.text, response.decision === "deny" ? /"optionId":"reject"/ : response.optionId === "forged" ? /"outcome":"cancelled"/ : /"optionId":"approve_always"/);
		} finally { await session.close(); await data.cleanup(); }
	}
});

test("Kimi supports full form answers and original fallback question option IDs", async () => {
	const data = await fixture({ permission: async (request) => request.options ? { decision: "allow", optionId: "q0_opt_1" } : { decision: "allow", answers: { q0: "blue", q1: ["test", "docs"] } } });
	const session = await new KimiAdapter().open(data.options);
	try {
		assert.match((await session.run("form")).text, /"action":"accept".*"q0":"blue".*"q1":\["test","docs"\]/);
		assert.match((await session.run("question")).text, /"optionId":"q0_opt_1"/);
		assert.ok(data.approvals.every((request) => request.kind === "question"));
	} finally { await session.close(); await data.cleanup(); }
});

test("Kimi rejects malformed or undeclared form answers", async () => {
	const data = await fixture({ permission: async () => ({ decision: "allow", answers: { q0: "forged", q1: ["test"] } }) });
	const session = await new KimiAdapter().open(data.options);
	try { assert.match((await session.run("form")).text, /"action":"decline"/); }
	finally { await session.close(); await data.cleanup(); }
});

test("Kimi cancellation clears pending approval, waits for the native prompt and permits a later turn", async () => {
	let ready!: () => void;
	const waiting = new Promise<void>((resolve) => { ready = resolve; });
	const data = await fixture({ permission: async () => { ready(); return new Promise(() => {}); } });
	const session = await new KimiAdapter().open(data.options);
	try {
		const controller = new AbortController();
		const run = session.run("hang", controller.signal);
		await waiting;
		await assert.rejects(session.run("cannot overlap"), /active turn/);
		controller.abort();
		assert.equal((await run).status, "cancelled");
		assert.equal((await session.run("after cancellation")).status, "completed");
		assert.ok((await data.records()).some((record) => record.method === "session/cancel"));
	} finally { await session.close(); await data.cleanup(); }
});

test("Kimi restores an explicit native session and suppresses history replay", async () => {
	for (const load of [false, true]) {
		const data = await fixture({ env: load ? { KIMI_TEST_LOAD_ONLY: "1" } : {} });
		const session = await new KimiAdapter().open({ ...data.options, resumeSessionId: "saved-kimi-session" });
		try {
			assert.equal(session.sessionId, "saved-kimi-session");
			assert.equal((await session.run("new text")).text, "turn 1: new text");
			assert.ok(!JSON.stringify(data.events).includes("old replay"));
			assert.ok((await data.records()).some((record) => record.method === (load ? "session/load" : "session/resume")));
		} finally { await session.close(); await data.cleanup(); }
	}
});

test("Kimi refuses missing restoration capability and incompatible protocol versions", async () => {
	for (const env of [{ KIMI_TEST_PROTOCOL: "2" }, { KIMI_TEST_NO_RESTORE: "1" }]) {
		const data = await fixture({ env });
		try {
			await assert.rejects(new KimiAdapter().open({ ...data.options, resumeSessionId: "saved" }), /protocol version|restoring/);
		} finally { await data.cleanup(); }
	}
});

test("Kimi does not advertise or execute client filesystem and terminal requests", async () => {
	const data = await fixture();
	const session = await new KimiAdapter().open(data.options);
	try {
		for (const prompt of ["clientfs", "clientterminal"]) assert.equal((await session.run(prompt)).text, "CLIENT_REQUEST_REJECTED");
	} finally { await session.close(); await data.cleanup(); }
});

test("Kimi ignores another session's output and rejects refusal, malformed events and unattended mode changes", async () => {
	const data = await fixture();
	const session = await new KimiAdapter().open(data.options);
	try {
		assert.equal((await session.run("wrong-session")).text, "correct session");
		await assert.rejects(session.run("refusal"), /refused/);
		await assert.rejects(session.run("malformed"), /invalid JSONL|Invalid Kimi/);
	} finally { await session.close(); await data.cleanup(); }
	const next = await fixture();
	const other = await new KimiAdapter().open(next.options);
	try { await assert.rejects(other.run("auto-mode"), /invalid JSONL|unattended/); }
	finally { await other.close(); await next.cleanup(); }
});

test("Kimi fails closed before spawning for unsupported readonly or fine-grained policies", async () => {
	const data = await fixture();
	try {
		assert.doesNotThrow(() => assertKimiPolicy({ ...data.options, policy: { ...data.options.policy, rules: [{ id: "allow-tests", scope: "global", action: "allow", tool: "bash", command: { type: "prefix", argv: ["npm", "test"] } }] } }));
		await assert.rejects(new KimiAdapter().open({ ...data.options, policy: { ...data.options.policy, mode: "read" } }), /read-only/);
		await assert.rejects(new KimiAdapter().open({ ...data.options, policy: { ...data.options.policy, mode: "plan" } }), /read-only/);
		await assert.rejects(new KimiAdapter().open({ ...data.options, policy: { ...data.options.policy, disabledTools: ["bash"] } }), /fine-grained/);
		await assert.rejects(new KimiAdapter().open({ ...data.options, policy: { ...data.options.policy, rules: [{ id: "deny-env", scope: "global", action: "deny", tool: "read", path: "**\/.env" }] } }), /fine-grained/);
		await assert.rejects(readFile(join(data.root, "protocol.jsonl")), /ENOENT/);
	} finally { await data.cleanup(); }
});

test("Kimi applies the pinned model and thinking level through ACP config options", async () => {
	const data = await fixture({ env: { ACP_TEST_CONFIG: "1" } });
	const session = await new KimiAdapter().open({ ...data.options, model: "kimi-k3", effort: "high" });
	try {
		const sets = (await data.records()).filter((record) => record.method === "session/set_config_option").map((record) => record.params);
		assert.deepEqual(sets.map(({ configId, value }) => [configId, value]), [["model", "kimi-k3"], ["thinking", "high"]]);
	} finally { await session.close(); await data.cleanup(); }
	const wrong = await fixture({ env: { ACP_TEST_CONFIG: "1" } });
	try { await assert.rejects(new KimiAdapter().open({ ...wrong.options, model: "nope" }), /没有 nope.*kimi-k3/); }
	finally { await wrong.cleanup(); }
	const ignored = await fixture({ env: { ACP_TEST_CONFIG: "1", ACP_TEST_IGNORE_CONFIG: "thinking" } });
	try {
		await assert.rejects(new KimiAdapter().open({ ...ignored.options, resumeSessionId: "saved-kimi-session", model: "kimi-k3", effort: "high" }), /未确认将思考强度设为 high/);
		assert.ok(!(await ignored.records()).some((record) => record.method === "session/prompt"));
	} finally { await ignored.cleanup(); }
	// A CLI without config options cannot honor a pinned model; the task fails instead of using another one.
	const old = await fixture();
	try { await assert.rejects(new KimiAdapter().open({ ...old.options, effort: "high" }), /不支持通过 ACP 选择思考强度/); }
	finally { await old.cleanup(); }
});

test("Kimi confirms an existing legacy model without rewriting global CLI settings", async () => {
	const data = await fixture({ env: { ACP_TEST_LEGACY_MODEL: "1" } });
	try {
		const session = await new KimiAdapter().open({ ...data.options, model: "legacy,thinking" });
		await session.close();
		await assert.rejects(new KimiAdapter().open({ ...data.options, model: "legacy" }), /不支持通过 ACP 选择模型/);
		assert.ok(!(await data.records()).some((record) => record.method === "session/set_model"));
	} finally { await data.cleanup(); }
});

test("Kimi maps ACP auth_required to a structured login failure", async () => {
	const { ExternalFailure } = await import("../src/external-errors.ts");
	const data = await fixture({ env: { ACP_TEST_AUTH: "1" } });
	try {
		const error = await new KimiAdapter().open(data.options).catch((value: unknown) => value);
		assert.ok(error instanceof ExternalFailure);
		assert.equal(error.kind, "auth");
	} finally { await data.cleanup(); }
});
