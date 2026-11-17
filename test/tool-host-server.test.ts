import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { ToolHostServer } from "../src/tool-host-server.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("loopback tool host authenticates and binds calls to the registered conversation", async () => {
	const calls: unknown[] = [];
	const host = new ToolHostServer({ handle: async (request, context) => {
		calls.push({ request, conversationId: context.conversationId, toolCallId: context.toolCallId });
		return { task_id: "child", status: "running" };
	} });
	const url = await host.start();
	const first = host.register("parent-one");
	const second = host.register("parent-two");
	const body = JSON.stringify({ tool: "TaskList", toolCallId: "call-1", input: {} });
	const invoke = (token?: string, extra?: Record<string, string>) => fetch(`${url}/invoke`, {
		method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body,
	});
	try {
		assert.equal((await invoke()).status, 401);
		assert.equal((await invoke("0".repeat(64))).status, 401);
		assert.equal((await invoke(first.token, { origin: "http://127.0.0.1" })).status, 403);
		const rebound = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(`${url}/invoke`, { method: "POST", headers: { host: "evil.example", "content-type": "application/json", authorization: `Bearer ${first.token}` } }, (response) => {
				response.resume(); response.on("end", () => resolve(response.statusCode!));
			});
			request.once("error", reject); request.end(body);
		});
		assert.equal(rebound, 403);
		assert.equal((await fetch(`${url}/invoke`)).status, 404);
		assert.deepEqual(await (await invoke(first.token)).json(), { ok: true, data: { task_id: "child", status: "running" } });
		assert.equal((await invoke(second.token)).status, 200);
		assert.deepEqual(calls, [
			{ request: { tool: "TaskList", toolCallId: "call-1", input: {} }, conversationId: "parent-one", toolCallId: "call-1" },
			{ request: { tool: "TaskList", toolCallId: "call-1", input: {} }, conversationId: "parent-two", toolCallId: "call-1" },
		]);
		host.revoke(first.token);
		assert.equal((await invoke(first.token)).status, 401);
	} finally { await host.close(); }
});

test("tool host rejects invalid schemas and privilege escalation fields before invoking services", async () => {
	let calls = 0;
	const host = new ToolHostServer({ handle: async () => { calls++; return {}; } });
	const url = await host.start();
	const { token } = host.register("parent");
	try {
		for (const payload of [
			{ tool: "Unknown", toolCallId: "call", input: {} },
			{ tool: "TaskList", toolCallId: "call", input: {}, conversationId: "victim" },
			{ tool: "TaskList", toolCallId: "call", input: { project: "/other" } },
			{ tool: "Agent", toolCallId: "call", input: { prompt: "do it", description: "a", subagent_type: "general-purpose", permission: "auto" } },
			{ tool: "TaskOutput", toolCallId: "call", input: { task_id: "id", timeout: 60001 } },
			{ tool: "TaskOutput", toolCallId: "call", input: { task_id: "id", timeout: 1.5 } },
			{ tool: "TaskStop", toolCallId: "", input: { task_id: "id" } },
		]) {
			const response = await fetch(`${url}/invoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
			assert.equal(response.status, 400);
			assert.equal((await response.json()).ok, false);
		}
		assert.equal(calls, 0);
	} finally { await host.close(); }
	assert.deepEqual(validateDesktopToolInput("Agent", { description: "independent work", prompt: "read seed", subagent_type: "Explore", isolation: "shared", worktree_id: "tree" }), {
		description: "independent work", prompt: "read seed", subagent_type: "Explore", isolation: "shared", worktree_id: "tree",
	});
});

test("revoking a session aborts pending host operations", async () => {
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let aborted!: () => void;
	const stopped = new Promise<void>((resolve) => { aborted = resolve; });
	const host = new ToolHostServer({ handle: async (_request, context) => {
		started();
		await new Promise<void>((resolve) => { context.signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }); });
		return {};
	} });
	const url = await host.start();
	const { token } = host.register("parent");
	const controller = new AbortController();
	const response = fetch(`${url}/invoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ tool: "TaskOutput", toolCallId: "call", input: { task_id: "child", block: true } }), signal: controller.signal }).catch(() => undefined);
	try {
		await ready;
		host.revoke(token);
		await stopped;
	} finally { controller.abort(); await response; await host.close(); }
});
