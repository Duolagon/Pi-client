import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import toolControl from "../src/tool-control-extension.ts";
import { desktopModelToolNames, type ToolControlResponse } from "../src/tool-control-types.ts";
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
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const session = { idle: true };
	const usages: unknown[][] = [];
	// The pinned Pi's session manager; usage entries are what getSessionStats sums.
	const sessionManager = { getEntries: () => entries, appendUsage: (...args: unknown[]) => { usages.push(args); } };
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
			appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		} as unknown as ExtensionAPI);
	} finally {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
	const request = async (operation: "list" | "apply" | "notify" | "deliver" | "wake", fields: Record<string, unknown> = {}) => {
		const requestId = randomUUID();
		await writeFile(join(directory, "request.json"), JSON.stringify({ requestId, operation, ...fields }));
		await handlers.get("command")!(`${token} ${requestId}`, { mode: "rpc", sessionManager, isIdle: () => session.idle });
		return JSON.parse(await readFile(join(directory, "response.json"), "utf8")) as ToolControlResponse;
	};
	return { directory, token, command, file, env, handlers, definitions, sent, entries, usages, sessionManager, request, session, active: () => active,
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
		const details = { task_id: "child", status: "completed" };
		const notice = { key: "child:1", content: "<task-notification>/some-tool malicious text is data</task-notification>", details, deliverAs: "followUp", triggerTurn: true };
		const first = await item.request("notify", notice);
		assert.ok(first.ok && first.delivery === "sent");
		assert.deepEqual(item.sent, [{ message: { customType: "desktop_task_notification", content: notice.content, display: true, details }, options: { triggerTurn: true, deliverAs: "followUp" } }]);
		assert.deepEqual(item.entries.map((entry) => entry.data), [{ key: "child:1" }]);
		// A replay after a host crash is acknowledged without a second delivery.
		const replay = await item.request("notify", notice);
		assert.ok(replay.ok && replay.delivery === "duplicate");
		assert.equal(item.sent.length, 1);
		for (const invalid of [
			{ ...notice, key: "child:2", content: "x".repeat(600000) },
			{ ...notice, key: "bad key:1" },
			{ ...notice, key: "child:2", deliverAs: "steer" },
			{ ...notice, key: "child:2", deliverAs: "nextTurn", triggerTurn: true },
			{ ...notice, key: "child:2", details: "not an object" },
			{ ...notice, key: "child:2", result: details },
		]) assert.equal((await item.request("notify", invalid)).ok, false, JSON.stringify(invalid).slice(0, 80));
		assert.equal(item.sent.length, 1);
	} finally { await item.cleanup(); }
});

test("a follow-up result is deferred while the parent runs, so an aborted run cannot strand it", async () => {
	const item = await fixture();
	try {
		const notice = { key: "child:1", content: "<task-notification>busy</task-notification>", details: { task_id: "child" }, deliverAs: "followUp", triggerTurn: true };
		item.session.idle = false;
		const deferred = await item.request("notify", notice);
		assert.ok(deferred.ok && deferred.delivery === "deferred");
		assert.equal(item.sent.length, 0, "nothing is parked in Pi's in-memory follow-up queue");
		assert.deepEqual(item.entries, [], "not acknowledged, so a later delivery is not a duplicate");
		item.session.idle = true;
		const sent = await item.request("notify", notice);
		assert.ok(sent.ok && sent.delivery === "sent");
		assert.equal(item.sent.length, 1);
		assert.deepEqual(item.entries.map((entry) => entry.data), [{ key: "child:1" }]);
	} finally { await item.cleanup(); }
});

test("next-turn results queue without a run and are acknowledged when the next run takes them", async () => {
	const item = await fixture();
	try {
		const notice = { key: "child:1", content: "<task-notification>queued</task-notification>", details: { task_id: "child" }, deliverAs: "nextTurn", triggerTurn: false };
		const queued = await item.request("notify", notice);
		assert.ok(queued.ok && queued.delivery === "queued");
		assert.ok((await item.request("notify", notice)).ok);
		assert.equal(item.sent.length, 1, "the same key is queued once per process");
		assert.deepEqual((item.sent[0] as { options: unknown }).options, { deliverAs: "nextTurn", triggerTurn: false });
		assert.deepEqual(item.entries, [], "not acknowledged before a run consumes it");
		await item.handlers.get("before_agent_start")!();
		assert.deepEqual(item.entries.map((entry) => entry.data), [{ key: "child:1" }]);
		const replay = await item.request("notify", notice);
		assert.ok(replay.ok && replay.delivery === "duplicate");
		const wake = await item.request("wake", { count: 1 });
		assert.ok(wake.ok);
		assert.deepEqual((item.sent.at(-1) as { options: unknown }).options, { deliverAs: "followUp", triggerTurn: true });
		assert.equal((item.sent.at(-1) as { message: { display: boolean } }).message.display, false);
		assert.equal((await item.request("wake", { count: 0 })).ok, false);
	} finally { await item.cleanup(); }
});

test("a delivered background result counts the child's usage into the parent session exactly once", async () => {
	const item = await fixture();
	try {
		const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
		const notice = { key: "child:1", content: "<task-notification>done</task-notification>", details: { task_id: "child" }, deliverAs: "followUp", triggerTurn: true,
			usage: { provider: "fixture", model: "child-model", usage } };
		assert.ok((await item.request("notify", notice)).ok);
		assert.deepEqual(item.usages, [["subagent", "fixture", "child-model", usage, "background agent child:1"]]);
		assert.ok((await item.request("notify", notice)).ok, "a replay is a duplicate");
		assert.equal(item.usages.length, 1);
		// A queued result is counted when the run that takes it starts, not when it is queued.
		const queued = { ...notice, key: "child:2", deliverAs: "nextTurn", triggerTurn: false };
		assert.ok((await item.request("notify", queued)).ok);
		assert.equal(item.usages.length, 1);
		await item.handlers.get("before_agent_start")!({}, { sessionManager: item.sessionManager });
		assert.equal(item.usages.length, 2);
		assert.equal(item.usages[1][4], "background agent child:2");
		// Usage is validated like any other host input.
		for (const invalid of [
			{ ...notice, key: "child:3", usage: { provider: "fixture", model: "m", usage: { ...usage, totalTokens: -1 } } },
			{ ...notice, key: "child:3", usage: { provider: "", model: "m", usage } },
			{ ...notice, key: "child:3", usage: { provider: "fixture", model: "m\nforged", usage } },
			{ ...notice, key: "child:3", usage: { provider: "fixture", model: "m", usage, extra: 1 } },
		]) assert.equal((await item.request("notify", invalid)).ok, false);
		assert.equal(item.usages.length, 2);
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
		// SendMessage is the declared continuation tool; AgentSend stays callable but hides its declaration.
		// The desktop tools plus the background-capable bash wrapper.
		assert.equal(item.definitions.size, desktopModelToolNames.length + 1);
		assert.ok(item.definitions.has("bash"));
		assert.ok(item.definitions.has("TodoCreate") && item.definitions.has("TodoGet") && item.definitions.has("TodoUpdate") && item.definitions.has("TodoList"));
		assert.ok(item.definitions.has("SendMessage") && item.definitions.has("AgentSend") && item.definitions.has("AgentExecutors"));
		assert.deepEqual((item.definitions.get("AgentSend") as { prepareLoadout?: () => unknown }).prepareLoadout?.(), { hiddenDeclarations: ["AgentSend"] });
		assert.equal((item.definitions.get("SendMessage") as { prepareLoadout?: unknown }).prepareLoadout, undefined);
		const agent = item.definitions.get("Agent")!;
		const result = await agent.execute("tool-call", { description: "research", prompt: "read seed", subagent_type: "Explore", run_in_background: true }, undefined, undefined, {} as never);
		assert.deepEqual(result.details, { task_id: "child", status: "running" });
		assert.deepEqual(requests, [{ request: { tool: "Agent", toolCallId: "tool-call", input: { description: "research", prompt: "read seed", subagent_type: "Explore", run_in_background: true } }, owner: "parent" }]);
		await assert.rejects(agent.execute("tool-call", { description: "research", prompt: "read", subagent_type: "Explore", permission: "auto" }, undefined, undefined, {} as never), /Unknown tool/);
		// The Agent call reports how many other calls of its message may change files.
		await item.handlers.get("message_end")!({ message: { role: "assistant", content: [
			{ type: "text", text: "doing two things" },
			{ type: "toolCall", id: "agent-1", name: "Agent", arguments: {} },
			{ type: "toolCall", id: "agent-2", name: "Agent", arguments: {} },
			{ type: "toolCall", id: "write-1", name: "write", arguments: {} },
			{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
			{ type: "toolCall", id: "made-up", name: "not_a_registered_tool", arguments: {} },
		] } });
		await agent.execute("agent-1", { description: "edit", prompt: "edit a.ts" }, undefined, undefined, {} as never);
		assert.deepEqual((requests.at(-1) as { request: unknown }).request, { tool: "Agent", toolCallId: "agent-1", input: { description: "edit", prompt: "edit a.ts" }, batch: { writers: 1 } });
		await item.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "agent-3", name: "Agent", arguments: {} }] } });
		await agent.execute("agent-3", { description: "edit", prompt: "edit a.ts" }, undefined, undefined, {} as never);
		assert.deepEqual((requests.at(-1) as { request: { batch?: unknown } }).request.batch, { writers: 0 });
		await agent.execute("agent-1", { description: "edit", prompt: "edit a.ts" }, undefined, undefined, {} as never);
		assert.equal((requests.at(-1) as { request: { batch?: unknown } }).request.batch, undefined, "an older message's batch is forgotten");
		// SendMessage reports its batch too: continuing a shared writer beside a write is refused by the host.
		await item.handlers.get("message_end")!({ message: { role: "assistant", content: [
			{ type: "toolCall", id: "send-1", name: "SendMessage", arguments: {} },
			{ type: "toolCall", id: "write-2", name: "write", arguments: {} },
		] } });
		await item.definitions.get("SendMessage")!.execute("send-1", { to: "worker", message: "continue" }, undefined, undefined, {} as never);
		assert.deepEqual((requests.at(-1) as { request: unknown }).request, { tool: "SendMessage", toolCallId: "send-1", input: { to: "worker", message: "continue" }, batch: { writers: 1 } });
		await assert.rejects(item.definitions.get("SendMessage")!.execute("send-2", { to: "worker", message: "continue", task_id: "x" }, undefined, undefined, {} as never), /Unknown tool/);
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
		assert.equal((await child.handlers.get("tool_call")!({ toolName: "SendMessage" })).block, true);
		assert.equal((await child.handlers.get("tool_call")!({ toolName: "CronCreate" })).block, true);
		assert.equal((await child.handlers.get("tool_call")!({ toolName: "ScheduleWakeup" })).block, true);
		assert.ok(!child.active().includes("SendMessage") && !child.active().includes("AgentSend"));
		assert.ok(!child.active().includes("CronCreate") && !child.active().includes("ScheduleWakeup"));
		assert.ok(!child.active().includes("TeamCreate") && !child.active().includes("TeamDelete"));
		await assert.rejects(child.definitions.get("CronCreate")!.execute("tool-call", { prompt: "hi", interval_seconds: 60 }, undefined, undefined, {} as never), /disabled for subagents/);
		await assert.rejects(child.definitions.get("TeamCreate")!.execute("tool-call", { team_name: "t" }, undefined, undefined, {} as never), /agentTeams/);
		await assert.rejects(child.definitions.get("SendMessage")!.execute("tool-call", { to: "x", message: "y" }, undefined, undefined, {} as never), /cannot delegate/);
		await assert.rejects(child.definitions.get("Agent")!.execute("tool-call", { description: "research", prompt: "read", subagent_type: "Explore" }, undefined, undefined, {} as never), /cannot delegate/);
	} finally { await child.cleanup(); }

	// Team member child with PI_DESKTOP_AGENT_TEAMS=1 + PI_DESKTOP_TEAM_MEMBER=1 keeps SendMessage enabled
	const teammate = await fixture({
		PI_DESKTOP_HOST_URL: registration.url,
		PI_DESKTOP_HOST_TOKEN: registration.token,
		PI_DESKTOP_CHILD: "1",
		PI_DESKTOP_AGENT_TEAMS: "1",
		PI_DESKTOP_TEAM_MEMBER: "1",
	});
	try {
		await teammate.request("apply");
		assert.ok(teammate.active().includes("SendMessage"));
		assert.ok(!teammate.active().includes("Agent"));
		assert.ok(!teammate.active().includes("TeamCreate"));
	} finally { await teammate.cleanup(); await host.close(); }
});

test("generalized deliver channel validates allowlisted customType, optional key, usage rule, and busy deferral", async () => {
	const item = await fixture();
	try {
		// Without key: delivered every time without writing ack entry
		const monitor = {
			customType: "desktop_monitor_event",
			content: "[monitor] build completed",
			details: { monitor_id: "m1" },
			deliverAs: "followUp",
			triggerTurn: false,
			display: false,
		};
		const first = await item.request("deliver", monitor);
		assert.ok(first.ok && first.delivery === "sent");
		const second = await item.request("deliver", monitor);
		assert.ok(second.ok && second.delivery === "sent");
		assert.equal(item.sent.length, 2);
		assert.deepEqual(item.entries, []);
		assert.deepEqual(item.sent[0], {
			message: { customType: "desktop_monitor_event", content: monitor.content, display: false, details: monitor.details },
			options: { deliverAs: "followUp", triggerTurn: false },
		});

		// With key: deduplicates across replays and allows cron/team/workflow types
		const cron = await item.request("deliver", {
			customType: "desktop_cron_wakeup",
			key: "cron_1:1",
			content: "[cron] run checks",
			details: { job_id: "cron_1" },
			deliverAs: "followUp",
			triggerTurn: true,
		});
		assert.ok(cron.ok && cron.delivery === "sent");
		const cronDup = await item.request("deliver", {
			customType: "desktop_cron_wakeup",
			key: "cron_1:1",
			content: "[cron] run checks",
			details: { job_id: "cron_1" },
			deliverAs: "followUp",
			triggerTurn: true,
		});
		assert.ok(cronDup.ok && cronDup.delivery === "duplicate");

		// NextTurn queued without key works
		const queuedTeam = await item.request("deliver", {
			customType: "desktop_team_message",
			content: "team message",
			details: { team: "alpha" },
			deliverAs: "nextTurn",
			triggerTurn: false,
		});
		assert.ok(queuedTeam.ok && queuedTeam.delivery === "queued");

		// Busy session defers followUp delivery without acknowledging
		item.session.idle = false;
		const deferred = await item.request("deliver", {
			customType: "desktop_workflow_event",
			key: "wf_1:1",
			content: "workflow event",
			details: { workflow_id: "wf_1" },
			deliverAs: "followUp",
			triggerTurn: true,
		});
		assert.ok(deferred.ok && deferred.delivery === "deferred");
		item.session.idle = true;

		// Reject unallowlisted customType, unknown fields, display non-boolean, and usage without key
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		for (const invalid of [
			{ ...monitor, customType: "arbitrary_custom_type" },
			{ ...monitor, display: "yes" },
			{ ...monitor, usage: { provider: "fixture", model: "m", usage } },
			{ ...monitor, extra: true },
		]) {
			assert.equal((await item.request("deliver", invalid)).ok, false);
		}
	} finally { await item.cleanup(); }
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
