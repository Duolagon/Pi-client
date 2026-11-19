import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { installControlHandlers } from "../src/control-ipc.ts";
import type { ControlEvent, PermissionCheckResult, PermissionSettings } from "../src/control-types.ts";
import type { DesktopToolInfo } from "../src/tool-control-types.ts";
import type { DelegatedTaskResult } from "../src/delegation-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function setup() {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"),
		toolControlExtension: join(source, "tool-control-extension.ts"),
		navigationExtension: join(source, "session-navigation-extension.ts"),
		historyEntry: join(source, "session-history-entry.ts"),
		env: fixture.env,
		initialProject: fixture.project,
	});
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	installControlHandlers((channel, action) => {
		assert.ok(!handlers.has(channel), `Duplicate control endpoint ${channel}`);
		handlers.set(channel, action);
	}, service);
	const events: ControlEvent[] = [];
	service.subscribeControls((event) => events.push(event));
	const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
		const handler = handlers.get(channel);
		assert.ok(handler, `Missing control endpoint ${channel}`);
		return (await handler(...args)) as T;
	};
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, service, invoke, events, handlers, id: snapshot.active!.id,
			cleanup: async () => { await service.close(); await fixture.cleanup(); } };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 15000) {
		if (await check()) return;
		await delay(20);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

test("control IPC lists real Pi tools, applies scoped overrides, and exposes fine-grained authorization", { timeout: 60000 }, async (t) => {
	const data = await setup();
	t.after(data.cleanup);
	assert.deepEqual([...data.handlers.keys()].sort(), [
		"pi:agents:list", "pi:agents:remove", "pi:agents:save",
		"pi:hooks:list", "pi:hooks:remove", "pi:hooks:save", "pi:hooks:test",
		"pi:mcp:list", "pi:mcp:remove", "pi:mcp:save",
		"pi:permissions:check", "pi:permissions:export-claude", "pi:permissions:import-claude",
		"pi:permissions:list", "pi:permissions:remove", "pi:permissions:upsert",
		"pi:skills:list", "pi:skills:remove", "pi:skills:save",
		"pi:task:result", "pi:tools:list", "pi:tools:set-enabled",
	]);
	let tools = await data.invoke<DesktopToolInfo[]>("pi:tools:list", data.id);
	assert.equal(tools.find((tool) => tool.name === "read")?.enabled, true);
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, true);
	assert.equal(tools.find((tool) => tool.name === "Agent")?.source, "desktop");
	assert.equal(tools.find((tool) => tool.name === "grep")?.source, "builtin");
	assert.ok(tools.every((tool) => typeof tool.description === "string" && tool.parameters && typeof tool.modelVisible === "boolean"));

	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "bash", enabled: false, scope: "global", conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, false);
	assert.equal((await data.invoke<PermissionCheckResult>("pi:permissions:check", { conversationId: data.id, toolName: "bash", input: { command: "node --version" } })).action, "deny");
	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "bash", enabled: true, scope: "project", project: data.fixture.project, conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, true);
	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "bash", enabled: false, conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, false);
	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "bash", enabled: null, conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, true);
	await data.invoke("pi:tools:set-enabled", { name: "bash", enabled: null, scope: "project", project: data.fixture.project, conversationId: data.id });
	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "bash", enabled: null, scope: "global", conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "bash")?.enabled, true);
	assert.equal(tools.find((tool) => tool.name === "bash")?.override, undefined);
	tools = await data.invoke<DesktopToolInfo[]>("pi:tools:set-enabled", { name: "grep", enabled: true, conversationId: data.id });
	assert.equal(tools.find((tool) => tool.name === "grep")?.modelVisible, true);

	const allow = { id: "allow-node", scope: "project", project: data.fixture.project, action: "allow", tool: "bash", command: { type: "prefix", argv: ["node", "--version"] } };
	let settings = await data.invoke<PermissionSettings>("pi:permissions:upsert", allow);
	assert.ok(settings.effective.rules.some((rule) => rule.id === allow.id));
	let check = await data.invoke<PermissionCheckResult>("pi:permissions:check", { conversationId: data.id, toolName: "bash", input: { command: "node --version" } });
	assert.equal(check.action, "allow");
	assert.equal(check.ruleId, allow.id);
	await data.invoke("pi:permissions:upsert", { id: "ask-node", scope: "conversation", conversationId: data.id, action: "ask", tool: "bash", command: { type: "exact", value: "node --version" } });
	check = await data.invoke<PermissionCheckResult>("pi:permissions:check", { conversationId: data.id, toolName: "bash", input: { command: "node --version" } });
	assert.equal(check.action, "ask");
	await data.invoke("pi:permissions:upsert", { id: "deny-node", scope: "global", action: "deny", tool: "bash", command: { type: "exact", value: "node --version" } });
	check = await data.invoke<PermissionCheckResult>("pi:permissions:check", { toolName: "bash", input: { command: "node --version" } });
	assert.equal(check.action, "deny");
	assert.equal(check.ruleId, "deny-node");
	await data.invoke("pi:permissions:remove", "deny-node");
	await data.invoke("pi:permissions:remove", "ask-node");
	settings = await data.invoke<PermissionSettings>("pi:permissions:list", data.id);
	assert.deepEqual(settings.rules.map((rule) => rule.id), [allow.id]);
	assert.equal((await data.invoke<PermissionCheckResult>("pi:permissions:check", { toolName: "bash", input: { command: "node --version; printf unexpected" } })).action, "ask");
	await data.invoke("pi:permissions:upsert", { id: "deny-secret-path", scope: "project", project: data.fixture.project, action: "deny", tool: "read", path: "secrets/**" });
	check = await data.invoke<PermissionCheckResult>("pi:permissions:check", { toolName: "read", input: { path: "secrets/credential.txt" } });
	assert.equal(check.action, "deny");
	assert.equal(check.ruleId, "deny-secret-path");
	assert.ok(data.events.some((event) => event.type === "tools_changed" && event.conversationIds.includes(data.id)));
	assert.ok(data.events.some((event) => event.type === "permissions_changed" && event.conversationIds.includes(data.id)));
	const stored = JSON.parse(await readFile(join(data.fixture.dataDir, "tool-settings.json"), "utf8"));
	assert.equal(stored.version, 1);
	assert.equal(stored.rules.length, 2);
	assert.equal(stored.tools.find((tool: { name: string }) => tool.name === "grep").enabled, true);
});

test("task result IPC returns the persisted result of a real isolated Pi child and rejects manual tasks", { timeout: 45000 }, async (t) => {
	const data = await setup();
	t.after(data.cleanup);
	const child = await data.service.startTask({ project: data.fixture.project, message: "IPC delegated child result", isolation: "shared" }, {
		parentConversationId: data.id, parentToolCallId: "ipc-agent-call", subagentType: "Explore", delegationDepth: 1,
		readOnly: true, runInBackground: true,
	});
	await waitFor(async () => (await data.service.listTasks()).find((task) => task.id === child.id)?.status === "completed", "delegated Pi child");
	const result = await data.invoke<DelegatedTaskResult>("pi:task:result", child.id, { block: true, timeout: 100 });
	assert.equal(result.task_id, child.id);
	assert.equal(result.status, "completed");
	assert.equal(result.parent_conversation_id, data.id);
	assert.equal(result.parent_tool_call_id, "ipc-agent-call");
	assert.match(result.output, /IPC delegated child result/);
	assert.equal(result.read_only, true);
	assert.equal(result.pending_approvals, 0);
	const manual = await data.service.startTask({ project: data.fixture.project, message: "manual task", isolation: "shared" });
	await assert.rejects(data.invoke("pi:task:result", manual.id), /不是模型委派/);
	await data.service.cancelTask(manual.id);
});

test("control IPC rejects malformed objects, scopes, booleans, selectors, payloads and wait limits", { timeout: 45000 }, async (t) => {
	const data = await setup();
	t.after(data.cleanup);
	const invalid: Array<[string, ...unknown[]]> = [
		["pi:tools:list", "../outside"],
		["pi:tools:list", []],
		["pi:tools:set-enabled", null],
		["pi:tools:set-enabled", []],
		["pi:tools:set-enabled", { name: "bash", enabled: "false" }],
		["pi:tools:set-enabled", { name: "bash", enabled: 0 }],
		["pi:tools:set-enabled", { name: "bash" }],
		["pi:tools:set-enabled", { name: "bash", enabled: false, scope: "workspace" }],
		["pi:tools:set-enabled", { name: "bash", enabled: false, scope: ["global"] }],
		["pi:tools:set-enabled", { name: "bash", enabled: false, scope: "project", project: "." }],
		["pi:tools:set-enabled", { name: "not-registered", enabled: true }],
		["pi:tools:set-enabled", { name: "bash", enabled: false, conversationId: "missing-id" }],
		["pi:permissions:list", "../outside"],
		["pi:permissions:upsert", { id: "x", scope: "global", project: data.fixture.project, action: "allow", tool: "read" }],
		["pi:permissions:upsert", { id: "x", scope: "project", action: "allow", tool: "read" }],
		["pi:permissions:upsert", { id: "x", scope: "conversation", action: "allow", tool: "read" }],
		["pi:permissions:upsert", { id: "x", scope: "conversation", conversationId: "missing-id", action: "allow", tool: "read" }],
		["pi:permissions:upsert", { id: "x", scope: "global", action: "allow", tool: "bash", command: { type: "prefix", argv: [] } }],
		["pi:permissions:upsert", { id: "x", scope: "global", action: "allow", tool: "bash", command: { type: "exact", value: "node --version; echo injected" } }],
		["pi:permissions:remove", ""],
		["pi:permissions:check", { toolName: "read", input: [] }],
		["pi:permissions:check", { toolName: "read", input: null }],
		["pi:permissions:check", { toolName: "read", input: { path: "x".repeat(3 * 1024 * 1024 + 1) } }],
		["pi:task:result", "id", { block: "true" }],
		["pi:task:result", "id", { timeout: "1" }],
		["pi:task:result", "id", { timeout: -1 }],
		["pi:task:result", "id", { timeout: 60001 }],
		["pi:task:result", "id", { timeout: 0.5 }],
		["pi:task:result", "id", { timeout: Number.NaN }],
		["pi:task:result", "id", []],
	];
	for (const [channel, ...args] of invalid) await assert.rejects(data.invoke(channel, ...args), `${channel} accepted ${JSON.stringify(args).slice(0, 180)}`);
	assert.equal((await data.invoke<PermissionSettings>("pi:permissions:list")).rules.length, 0);
	assert.equal((await data.invoke<DesktopToolInfo[]>("pi:tools:list")).find((tool) => tool.name === "bash")?.enabled, true);
});
