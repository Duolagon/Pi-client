import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissions from "../src/permission-extension.ts";
import { ToolHostServer, type HookBridgeRequest } from "../src/tool-host-server.ts";

test("hook preflight routes exact events and picks up current configured and agent hooks", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pi-hook-fastpath-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const config = join(project, ".pi", "hooks.json");
	const definition = join(project, ".pi", "agents", "custom.md");
	await mkdir(join(project, ".pi", "agents"), { recursive: true });
	await mkdir(agentDir);
	context.after(() => rm(root, { recursive: true, force: true }));
	const requests: HookBridgeRequest[] = [];
	const host = new ToolHostServer({
		handle: async () => ({}),
		handleHook: async (request) => {
			requests.push(request);
			return { blocked: false };
		},
	});
	await host.start();
	context.after(() => host.close());
	const registered = host.register("test-hook-fastpath");
	const env = {
		PI_CODING_AGENT_DIR: agentDir,
		PI_DESKTOP_HOOK_HOME: root,
		PI_DESKTOP_HOST_URL: registered.url,
		PI_DESKTOP_HOST_TOKEN: registered.token,
		PI_DESKTOP_HOOK_FASTPATH: "1",
		PI_DESKTOP_TRUST_PROJECT: project,
		PI_DESKTOP_HOOK_PROJECT_TRUSTED: "1",
		PI_DESKTOP_CHILD: "0",
		PI_DESKTOP_AGENT_HOOK_TYPE: "",
		PI_DESKTOP_AGENT_HOOK_PROJECT: project,
		PI_DESKTOP_AGENT_HOOK_PROJECT_TRUSTED: "1",
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	context.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	permissions({
		registerTool() {},
		registerProvider() {},
		on(event: string, handler: (event: unknown) => unknown) {
			const listeners = handlers.get(event) ?? [];
			listeners.push(handler);
			handlers.set(event, listeners);
		},
	} as unknown as ExtensionAPI);
	const fire = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload);
	};
	const toolResult = (isError: boolean) => fire("tool_result", {
		toolName: "read", toolCallId: "read", input: { path: "example.ts" }, isError,
		content: [{ type: "text", text: "example output" }],
	});
	const stop = () => fire("agent_before_settle", {
		outcome: "completed", context: { contextMessages: [], canContinue: true },
	});

	await toolResult(false);
	await stop();
	assert.equal(requests.length, 0);
	await writeFile(config, JSON.stringify({
		hooks: {
			PostToolUse: [{ matcher: "read", hooks: [{ type: "unknown" }] }],
			PostToolUseFailure: [{ command: "printf example" }],
			SubagentStop: [{ command: "printf example" }],
		},
	}));
	await toolResult(false);
	await stop();
	assert.equal(requests.length, 0);
	await toolResult(true);
	assert.deepEqual(requests.map(({ phase, isError }) => [phase, isError]), [["post", true]]);
	process.env.PI_DESKTOP_HOOK_PROJECT_TRUSTED = "0";
	await toolResult(true);
	assert.equal(requests.length, 1, "untrusted project configuration is ignored");
	process.env.PI_DESKTOP_HOOK_PROJECT_TRUSTED = "1";
	process.env.PI_DESKTOP_CHILD = "1";
	await stop();
	assert.equal(requests.at(-1)?.phase, "stop");
	assert.equal(requests.length, 2);

	await rm(config);
	process.env.PI_DESKTOP_AGENT_HOOK_TYPE = "custom";
	await writeFile(definition, "---\nname: custom\ndescription: Example agent\n---\n\nExample instructions.\n");
	await toolResult(false);
	await stop();
	assert.equal(requests.length, 2);
	await writeFile(definition + ".tmp", [
		"---", "name: custom", "description: Example agent", "hooks:", "  PostToolUse:",
		"    - command: printf example", "  Stop:", "    - command: printf example",
		"---", "", "Example instructions.", "",
	].join("\n"));
	await rename(definition + ".tmp", definition);
	await toolResult(true);
	assert.equal(requests.length, 2, "an unrelated phase still skips the bridge");
	await toolResult(false);
	await stop();
	assert.deepEqual(requests.slice(2).map(({ phase }) => phase), ["post", "stop"]);
	await rm(definition);
	await toolResult(false);
	await stop();
	assert.equal(requests.length, 4);
});
