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
		try { await assert.rejects(session.run(prompt), /protocol|exited|failure/); }
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
