import assert from "node:assert/strict";
import { test } from "node:test";
import { installControlHandlers } from "../src/control-ipc.ts";
import type { DesktopService } from "../src/backend.ts";
import type { McpSaveInput } from "../src/mcp-types.ts";

test("MCP IPC normalizes empty optional fields from the dialog", async () => {
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	let captured: McpSaveInput | undefined;
	installControlHandlers(
		(channel, action) => handlers.set(channel, action),
		{
			saveMcpServer: async (input: McpSaveInput) => {
				captured = input;
				return [];
			},
		} as unknown as DesktopService,
	);
	const save = handlers.get("pi:mcp:save")!;
	await save({
		name: "docs",
		scope: "project",
		transport: "http",
		command: "",
		url: "https://example.com/mcp",
		description: "",
		enabled: true,
		project: "/tmp/project",
	});
	assert.equal(captured?.command, undefined);
	assert.equal(captured?.url, "https://example.com/mcp");
	assert.equal(captured?.description, undefined);

	await save({
		name: "filesystem",
		scope: "user",
		transport: "stdio",
		command: "npx",
		url: "",
		args: ["-y", "server"],
		project: "/tmp/project",
	});
	assert.equal(captured?.command, "npx");
	assert.equal(captured?.url, undefined);
	assert.deepEqual(captured?.args, ["-y", "server"]);

	await save({
		name: "filesystem",
		scope: "project",
		transport: "http",
		command: "",
		url: "",
		overrideOnly: true,
		enabled: false,
		project: "/tmp/project",
	});
	assert.equal(captured?.overrideOnly, true);
	assert.equal(captured?.command, undefined);
	assert.equal(captured?.url, undefined);
});
