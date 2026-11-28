import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CodexAdapter, assertCodexPolicy } from "../src/external-codex.ts";
import type { ExternalAdapterEvent, ExternalApprovalRequest, ExternalApprovalResponse, ExternalSessionOptions } from "../src/external-types.ts";

async function fixture(extra: NodeJS.ProcessEnv = {}, permission?: (request: ExternalApprovalRequest, signal?: AbortSignal) => Promise<ExternalApprovalResponse>) {
	const root = await mkdtemp(join(tmpdir(), "pi-external-codex-"));
	const executable = join(root, "codex-fixture");
	await copyFile(fileURLToPath(new URL("./fixtures/external-codex.mjs", import.meta.url)), executable);
	await chmod(executable, 0o700);
	const events: ExternalAdapterEvent[] = [];
	const requests: ExternalApprovalRequest[] = [];
	const options: ExternalSessionOptions = {
		executable, cwd: root, env: { PATH: process.env.PATH, HOME: root, ...extra },
		policy: { version: 1, mode: "ask", rules: [], disabledTools: ["Agent", "AgentSend"], project: root },
		onEvent: (event) => events.push(event), onPermission: async (request, signal) => { requests.push(request); return permission ? permission(request, signal) : { decision: "allow" }; },
	};
	return { root, options, events, requests, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Codex adapter streams Unicode exactly once, reports usage and reuses the native thread", async () => {
	const data = await fixture();
	const session = await new CodexAdapter().open(data.options);
	try {
		assert.equal(session.sessionId, "thread-fixture");
		assert.equal((await session.run("first")).text, "你好 🌍 first");
		assert.equal((await session.run("second")).text, "你好 🌍 second");
		assert.equal(data.events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "你好 🌍 first你好 🌍 second");
		assert.ok(data.events.some((event) => event.type === "usage" && event.inputTokens === 10));
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex routes command/file approvals with original ids and denies all files if one is rejected", async () => {
	const data = await fixture({}, async (request) => ({ decision: typeof request.input.path === "string" && request.input.path.endsWith("two.txt") ? "deny" : "allow" }));
	const session = await new CodexAdapter().open(data.options);
	try {
		assert.equal((await session.run("approve")).text, "approved");
		assert.equal(await readFile(join(data.root, "tool.txt"), "utf8"), "native tool ran\n");
		assert.equal(data.requests[0].toolName, "bash");
		assert.match(data.requests[0].id, /^server-/);
		assert.ok(data.events.some((event) => event.type === "tool_start" && event.name === "commandExecution"));
		assert.equal((await session.run("file")).text, "files denied");
		assert.equal(data.requests.filter((request) => request.kind === "file").length, 2);
		await assert.rejects(access(join(data.root, "one.txt")));
		await assert.rejects(access(join(data.root, "two.txt")));
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex command rejection prevents execution and foreign-thread requests never reach approval UI", async () => {
	const data = await fixture({}, async () => ({ decision: "deny" }));
	const session = await new CodexAdapter().open(data.options);
	try {
		assert.equal((await session.run("approve")).text, "denied");
		await assert.rejects(access(join(data.root, "tool.txt")));
		const before = data.requests.length;
		assert.equal((await session.run("foreign")).text, "foreign denied");
		assert.equal(data.requests.length, before);
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex cancellation clears a pending approval and waits for native interruption", async () => {
	let requested!: () => void;
	const observed = new Promise<void>((resolve) => { requested = resolve; });
	const data = await fixture({}, async () => { requested(); return new Promise(() => {}); });
	const session = await new CodexAdapter().open(data.options);
	try {
		const controller = new AbortController();
		const result = session.run("wait", controller.signal);
		await observed;
		controller.abort();
		assert.equal((await result).status, "cancelled");
		assert.equal((await session.run("after-cancel")).status, "completed");
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex native request withdrawal aborts its approval signal without cancelling the entire turn", async () => {
	let aborted = false;
	const data = await fixture({}, async (_request, signal) => new Promise((resolve) => {
		assert.ok(signal);
		signal.addEventListener("abort", () => { aborted = true; resolve({ decision: "cancel" }); }, { once: true });
	}));
	const session = await new CodexAdapter().open(data.options);
	try {
		const result = await session.run("withdraw");
		assert.equal(aborted, true); assert.equal(result.status, "completed"); assert.equal(result.text, "denied");
		await assert.rejects(access(join(data.root, "tool.txt")));
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex resumes an explicit native thread and maps question answers without permitting sandbox escalation", async () => {
	const data = await fixture({}, async (request) => ({ decision: "allow", ...(request.kind === "question" ? { answers: { color: "Blue" } } : {}) }));
	data.options.resumeSessionId = "thread-resumed";
	const session = await new CodexAdapter().open(data.options);
	try {
		assert.equal(session.sessionId, "thread-resumed");
		assert.deepEqual(JSON.parse((await session.run("question")).text), { answers: { color: { answers: ["Blue"] } } });
		assert.deepEqual(JSON.parse((await session.run("permissions")).text), { permissions: {}, scope: "turn" });
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex refuses unenforceable native policies and read-only MCP or sandbox downgrades", async () => {
	const data = await fixture();
	try {
		assert.doesNotThrow(() => assertCodexPolicy({ policy: { ...data.options.policy, rules: [{ id: "allow-tests", scope: "global", action: "allow", tool: "bash", command: { type: "exact", value: "npm test" } }] } }));
		assert.throws(() => assertCodexPolicy({ policy: { ...data.options.policy, disabledTools: ["read"] } }), /unsupported_policy/);
		assert.throws(() => assertCodexPolicy({ policy: { ...data.options.policy, rules: [{ id: "secret", scope: "global", action: "deny", tool: "read", path: ".env" }] } }), /unsupported_policy/);
		for (const mode of ["read", "plan"] as const) {
			data.options.policy.mode = mode;
			data.options.env.CODEX_FIXTURE_MCP = "1";
			await assert.rejects(new CodexAdapter().open(data.options), /without MCP/);
			delete data.options.env.CODEX_FIXTURE_MCP;
			data.options.env.CODEX_FIXTURE_BAD_SANDBOX = "1";
			await assert.rejects(new CodexAdapter().open(data.options), /sandbox/);
			delete data.options.env.CODEX_FIXTURE_BAD_SANDBOX;
		}
	} finally { await data.cleanup(); }
});

test("Codex malformed output, process exit, and native failed turns reject without hanging", async () => {
	for (const prompt of ["invalid", "exit", "fail"]) {
		const data = await fixture();
		const session = await new CodexAdapter().open(data.options);
		try {
			await assert.rejects(session.run(prompt), (error: Error) => {
				assert.match(error.message, /protocol|exited|failure/);
				assert.doesNotMatch(error.message, /private stdout/);
				return true;
			});
		}
		finally { await session.close(); await data.cleanup(); }
	}
});

test("installed Codex completes an isolated no-model App Server handshake", { timeout: 30000 }, async (context) => {
	const executable = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
	try { await access(executable); } catch { context.skip("Codex CLI is not installed"); return; }
	const data = await fixture();
	const codexHome = join(data.root, "codex-home");
	await mkdir(codexHome);
	await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n');
	data.options.executable = executable;
	data.options.env = { PATH: process.env.PATH, HOME: data.root, CODEX_HOME: codexHome, XDG_CONFIG_HOME: data.root, XDG_DATA_HOME: data.root };
	data.options.policy.mode = "read";
	let session;
	try { session = await new CodexAdapter().open(data.options); assert.ok(session.sessionId); }
	finally { await session?.close(); await data.cleanup(); }
});

test("Codex passes the pinned model and effort, and rejects ones the installed CLI does not offer", async () => {
	const log = join(await mkdtemp(join(tmpdir(), "pi-codex-log-")), "log.jsonl");
	const data = await fixture({ CODEX_FIXTURE_LOG: log });
	const session = await new CodexAdapter().open({ ...data.options, model: "fixture-large", effort: "max" });
	try {
		await session.run("hello");
		const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(calls.find((call) => call.method === "thread/start").params.model, "fixture-large");
		const turn = calls.find((call) => call.method === "turn/start").params;
		assert.equal(turn.model, "fixture-large");
		assert.equal(turn.effort, "max");
		assert.equal(calls.find((call) => call.method === "model/list").params.modelProvider, "fixture-provider");
	} finally { await session.close(); await data.cleanup(); }
	for (const [model, effort, pattern] of [["missing-model", undefined, /没有模型 missing-model.*fixture-large/], ["fixture-small", "high", /不支持思考强度 high.*low/]] as const) {
		const next = await fixture();
		try { await assert.rejects(new CodexAdapter().open({ ...next.options, model, effort }), pattern); }
		finally { await next.cleanup(); }
	}
	// An App Server without model/list still starts; Codex validates the model itself then.
	const old = await fixture({ CODEX_FIXTURE_NO_MODEL_LIST: "1" });
	const tolerant = await new CodexAdapter().open({ ...old.options, model: "anything" });
	await tolerant.close(); await old.cleanup();
});

test("Codex checks an effort-only setting against the actual thread model", async () => {
	const data = await fixture({ CODEX_FIXTURE_EFFECTIVE_MODEL: "fixture-small" });
	try {
		await assert.rejects(new CodexAdapter().open({ ...data.options, effort: "max", resumeSessionId: "saved-thread" }), /fixture-small 不支持思考强度 max/);
		await assert.rejects(new CodexAdapter().open({ ...data.options, model: "fixture-large" }), /未确认使用模型 fixture-large/);
	} finally { await data.cleanup(); }
});

test("Codex reports structured failures, retry diagnostics and per-turn usage", async () => {
	const { ExternalFailure, describeExternalFailure } = await import("../src/external-errors.ts");
	const data = await fixture();
	const session = await new CodexAdapter().open(data.options);
	try {
		const error = await session.run("quota").catch((value: unknown) => value);
		assert.ok(error instanceof ExternalFailure);
		assert.equal(error.kind, "quota");
		assert.match(error.message, /usage limit[\s\S]*resets at 5pm/);
		assert.match(describeExternalFailure("codex", error).message, /额度/);
		assert.ok(data.events.some((event) => event.type === "diagnostic" && /正在重试/.test(event.message)));
		assert.equal((await session.run("usage")).text, "usage reported");
		// Cumulative thread totals become this turn's share: 1040-1000 input, 250-200 output.
		const usage = data.events.filter((event) => event.type === "usage").at(-1);
		assert.deepEqual(usage, { type: "usage", inputTokens: 40, outputTokens: 50 });
	} finally { await session.close(); await data.cleanup(); }
});

test("Codex keeps a redacted stderr tail for a crashed process", async () => {
	const data = await fixture({ OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwx" });
	const session = await new CodexAdapter().open(data.options);
	try {
		await assert.rejects(session.run("stderr-exit"), /exited/);
		const tail = session.diagnostics?.() ?? "";
		assert.match(tail, /config broken/);
		assert.doesNotMatch(tail, /abcdefghijklmnop|qrstuvwx/);
	} finally { await session.close(); await data.cleanup(); }
});
