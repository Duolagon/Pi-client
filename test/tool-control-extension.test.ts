import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import toolControl from "../src/tool-control-extension.ts";
import type { ToolControlResponse } from "../src/tool-control-types.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { RpcHarness } from "./fixtures/rpc-harness.ts";

function tool(name: string, exposure = "direct", path = `builtin:${name}`): ToolInfo {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure, sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" } } as ToolInfo;
}

async function fixture(extra: Record<string, string> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-desktop-tools-"));
	const token = randomBytes(32).toString("hex");
	const command = `desktop-tools-${randomBytes(16).toString("hex")}`;
	const file = join(directory, "tools.json");
	await writeFile(file, JSON.stringify({ overrides: {} }));
	const env: Record<string, string> = { PI_DESKTOP_TOOLS_DIR: directory, PI_DESKTOP_TOOLS_TOKEN: token, PI_DESKTOP_TOOLS_COMMAND: command, PI_DESKTOP_TOOLS_FILE: file, ...extra };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	const handlers = new Map<string, Function>();
	const definitions = new Map<string, ToolDefinition>();
	const all: ToolInfo[] = [tool("read"), tool("bash"), tool("edit"), tool("write"), tool("grep"), tool("mcp__docs__read", "codemode", "builtin:mcp"), tool("custom", "deferred", "/extensions/custom.ts")];
	let active = ["read", "bash", "edit", "write"];
	const sent: unknown[] = [];
	Object.assign(process.env, env);
	try {
		toolControl({
			registerTool(definition: ToolDefinition) {
				definitions.set(definition.name, definition);
				all.push(tool(definition.name, definition.exposure, "/runtime/tool-control-extension.mjs"));
				if (definition.defaultActive !== false) active.push(definition.name);
			},
			registerCommand(name: string, definition: { handler: Function }) { assert.equal(name, command); handlers.set("command", definition.handler); },
			on(event: string, handler: Function) { handlers.set(event, handler); },
			getAllTools() { return all; }, getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
			sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
		} as unknown as ExtensionAPI);
	} finally {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
	const request = async (operation: "list" | "apply" | "notify", result?: unknown) => {
		const requestId = randomUUID();
		await writeFile(join(directory, "request.json"), JSON.stringify({ requestId, operation, ...(operation === "notify" ? { result } : {}) }));
		await handlers.get("command")!(`${token} ${requestId}`, { mode: "rpc" });
		return JSON.parse(await readFile(join(directory, "response.json"), "utf8")) as ToolControlResponse;
	};
	return { directory, token, command, file, env, handlers, definitions, sent, request, active: () => active,
		write: (overrides: Record<string, boolean>) => writeFile(file, JSON.stringify({ overrides })),
		cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("tool inventory reports actual registry source and model visibility separately", async () => {
	const item = await fixture();
	try {
		const response = await item.request("list");
		assert.equal(response.ok, true);
		if (!response.ok) return;
		assert.equal(response.tools.find((entry) => entry.name === "read")?.modelVisible, true);
		assert.equal(response.tools.find((entry) => entry.name === "grep")?.enabled, false);
		assert.deepEqual(response.tools.filter((entry) => ["mcp__docs__read", "custom"].includes(entry.name)).map((entry) => [entry.source, entry.enabled, entry.modelVisible]), [["mcp", true, false], ["extension", true, false]]);
	} finally { await item.cleanup(); }
});

test("tool overrides alter actual loadout and guard stale and nested calls immediately", async () => {
	const item = await fixture();
	try {
		await item.write({ bash: false, grep: true, mcp__docs__read: false });
		const response = await item.request("apply");
		assert.equal(response.ok, true);
		assert.ok(!item.active().includes("bash"));
		assert.ok(item.active().includes("grep"));
		assert.deepEqual(await item.handlers.get("tool_call")!({ toolName: "bash" }), { block: true, reason: "此工具已被客户端禁用。" });
		assert.equal((await item.handlers.get("tool_call")!({ toolName: "mcp__docs__read" })).block, true);
		await item.write({ edit: false });
		assert.equal((await item.handlers.get("tool_call")!({ toolName: "edit" })).block, true);
		await item.handlers.get("before_agent_start")!();
		assert.ok(item.active().includes("bash"));
		assert.ok(!item.active().includes("grep"));
		await writeFile(item.file, "broken");
		assert.equal((await item.handlers.get("tool_call")!({ toolName: "read" })).block, true);
		const invalid = await item.request("apply");
		assert.equal(invalid.ok, false);
	} finally { await item.cleanup(); }
});

test("private tool controls authenticate before file access and notification uses custom messages", async () => {
	const item = await fixture();
	try {
		await assert.rejects(item.handlers.get("command")!(`${"0".repeat(64)} ${randomUUID()}`, { mode: "rpc" }), /requires a host request/);
		const result = { task_id: "child", status: "completed", output: "/some-tool malicious text is data" };
		assert.equal((await item.request("notify", result)).ok, true);
		assert.deepEqual(item.sent, [{ message: { customType: "desktop_task_result", content: JSON.stringify(result), display: true, details: result }, options: { triggerTurn: true, deliverAs: "followUp" } }]);
		assert.equal((await item.request("notify", "x".repeat(600000))).ok, false);
	} finally { await item.cleanup(); }
});

test("model tools validate inputs, use authenticated host calls, and clamp child capabilities", async (context) => {
	const requests: unknown[] = [];
	const host = new ToolHostServer({ handle: async (request, context) => { requests.push({ request, owner: context.conversationId }); return { task_id: "child", status: "running" }; } });
	context.after(() => host.close());
	await host.start();
	const registration = host.register("parent");
	const item = await fixture({ PI_DESKTOP_HOST_URL: registration.url, PI_DESKTOP_HOST_TOKEN: registration.token });
	try {
		assert.equal(item.definitions.size, 10);
		assert.ok(item.definitions.has("AgentSend") && item.definitions.has("AgentExecutors"));
		const agent = item.definitions.get("Agent")!;
		const result = await agent.execute("tool-call", { description: "research", prompt: "read seed", subagent_type: "Explore", run_in_background: true }, undefined, undefined, {} as never);
		assert.deepEqual(result.details, { task_id: "child", status: "running" });
		assert.deepEqual(requests, [{ request: { tool: "Agent", toolCallId: "tool-call", input: { description: "research", prompt: "read seed", subagent_type: "Explore", run_in_background: true } }, owner: "parent" }]);
		await assert.rejects(agent.execute("tool-call", { description: "research", prompt: "read", subagent_type: "Explore", permission: "auto" }, undefined, undefined, {} as never), /Unknown tool/);
		const inventory = await item.request("list");
		assert.ok(inventory.ok && inventory.tools.find((entry) => entry.name === "Agent")?.source === "desktop");
	} finally { await item.cleanup(); }
	const child = await fixture({ PI_DESKTOP_HOST_URL: registration.url, PI_DESKTOP_HOST_TOKEN: registration.token, PI_DESKTOP_CHILD: "1", PI_DESKTOP_READ_ONLY_CHILD: "1" });
	try {
		await child.write({ bash: true, Agent: true });
		await child.request("apply");
		assert.ok(!child.active().includes("bash"));
		assert.ok(!child.active().includes("Agent"));
		assert.equal((await child.handlers.get("tool_call")!({ toolName: "custom" })).block, true);
		assert.equal((await child.handlers.get("tool_call")!({ toolName: "Agent" })).block, true);
		await assert.rejects(child.definitions.get("Agent")!.execute("tool-call", { description: "research", prompt: "read", subagent_type: "Explore" }, undefined, undefined, {} as never), /cannot delegate/);
	} finally { await child.cleanup(); await host.close(); }
});

test("real Pi exposes desktop tools and applies a host command without requesting a model", { timeout: 30000 }, async () => {
	const core = await createCoreFixture();
	const host = new ToolHostServer({ handle: async () => ({}) });
	await host.start();
	const registration = host.register("parent");
	const item = await fixture({ PI_DESKTOP_HOST_URL: registration.url, PI_DESKTOP_HOST_TOKEN: registration.token });
	const harness = new RpcHarness({ executable: process.execPath, entry: core.entry, cwd: core.project,
		args: ["--extension", resolve(dirname(fileURLToPath(import.meta.url)), "../src/tool-control-extension.ts")],
		env: { ...core.env, ...item.env }, onEvent: () => {} });
	try {
		const requestId = randomUUID();
		await item.write({ bash: false, grep: true });
		await writeFile(join(item.directory, "request.json"), JSON.stringify({ requestId, operation: "apply" }));
		const response = await harness.request<{ disposition: string }>({ type: "prompt", message: `/${item.command} ${item.token} ${requestId}` });
		assert.equal(response.disposition, "handled");
		const inventory = JSON.parse(await readFile(join(item.directory, "response.json"), "utf8")) as ToolControlResponse;
		assert.equal(inventory.ok, true);
		if (!inventory.ok) return;
		assert.equal(inventory.tools.find((entry) => entry.name === "Agent")?.modelVisible, true);
		assert.equal(inventory.tools.find((entry) => entry.name === "bash")?.enabled, false);
		assert.equal(inventory.tools.find((entry) => entry.name === "grep")?.modelVisible, true);
		assert.ok(!harness.events.some((event) => event.type === "agent_start"));
	} finally { await harness.stop(); await item.cleanup(); await host.close(); await core.cleanup(); }
});
