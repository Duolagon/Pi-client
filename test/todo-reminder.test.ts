import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissions from "../src/permission-extension.ts";
import { staleTodoReminder } from "../src/todo-reminder.ts";

test("only unfinished items appear in the current checklist reminder", () => {
	const completed = { content: "Done already", status: "completed" };
	const active = { content: "Still running", status: "in_progress" };
	assert.equal(staleTodoReminder("simple", []), undefined);
	assert.equal(staleTodoReminder("simple", [completed]), undefined);
	assert.equal(staleTodoReminder("shared", [completed, { content: "Removed", status: "deleted" }]), undefined);
	assert.match(staleTodoReminder("simple", [active, completed]) ?? "", /TodoWrite with the full checklist[\s\S]*Still running/);
	assert.doesNotMatch(staleTodoReminder("shared", [active, completed]) ?? "", /Done already|TodoWrite/);
});

test("stale reminders are attached once to tool output, with no reminder after completion", async () => {
	const original = process.env.PI_DESKTOP_HOST_URL;
	const originalToken = process.env.PI_DESKTOP_HOST_TOKEN;
	process.env.PI_DESKTOP_HOST_URL = "http://127.0.0.1:0";
	delete process.env.PI_DESKTOP_HOST_TOKEN;
	try {
		const hooks = new Map<string, (event: unknown) => Promise<unknown>>();
		const tools = new Map<string, { execute: (id: string, input: unknown) => Promise<unknown> }>();
		permissions({
			registerTool: (tool: { name: string; execute: (id: string, input: unknown) => Promise<unknown> }) => tools.set(tool.name, tool),
			registerProvider() {},
			on: (event: string, fn: (event: unknown) => Promise<unknown>) => hooks.set(event, fn),
		} as unknown as ExtensionAPI);
		assert.equal(hooks.has("context_with_system"), false);
		const write = tools.get("TodoWrite")!;
		await write.execute("todo", { todos: [{ id: "one", content: "First", status: "in_progress" }] });
		const emit = async (toolName = "read", details?: unknown) => hooks.get("tool_result")!({
			toolName, toolCallId: "call", input: { path: "fixture" }, content: [], details, isError: false,
		});
		const turn = [];
		for (let index = 0; index < 12; index++) turn.push(await emit());
		assert.equal(turn.filter(Boolean).length, 1);
		assert.match(JSON.stringify(turn[3]), /TodoWrite/);
		await write.execute("complete", { todos: [{ id: "one", content: "First", status: "completed" }] });
		for (let index = 0; index < 8; index++) assert.equal(await emit(), undefined);
		await emit("TodoList", { todos: [{ id: "s1", subject: "Shared", status: "in_progress" }] });
		for (let index = 0; index < 3; index++) assert.equal(await emit(), undefined);
		assert.match(JSON.stringify(await emit()), /TodoUpdate[\s\S]*Shared/);
		await emit("TodoUpdate", { todo: { id: "s1", subject: "Shared", status: "completed" } });
		for (let index = 0; index < 8; index++) assert.equal(await emit(), undefined);
	} finally {
		if (original === undefined) delete process.env.PI_DESKTOP_HOST_URL;
		else process.env.PI_DESKTOP_HOST_URL = original;
		if (originalToken === undefined) delete process.env.PI_DESKTOP_HOST_TOKEN;
		else process.env.PI_DESKTOP_HOST_TOKEN = originalToken;
	}
});
