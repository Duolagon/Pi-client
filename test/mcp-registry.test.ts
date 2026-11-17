import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRegistry } from "../src/mcp-registry.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(project);
	await mkdir(agentDir);
	return {
		root,
		project,
		agentDir,
		registry: () => new McpRegistry({ agentDir: () => agentDir }),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("adds, lists and removes stdio and HTTP servers without dropping unrelated config", async () => {
	const f = await fixture();
	try {
		const registry = f.registry();
		let servers = await registry.save(f.project, {
			name: "filesystem",
			scope: "user",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
			description: "Local files",
			enabled: true,
		});
		assert.equal(servers.length, 1);
		assert.equal(servers[0].transport, "stdio");
		assert.equal(servers[0].scope, "user");
		assert.equal(servers[0].enabled, true);

		await registry.save(f.project, {
			name: "docs",
			scope: "project",
			transport: "http",
			url: "https://example.com/mcp",
			description: "Docs",
		});
		servers = await registry.list(f.project);
		assert.deepEqual(servers.map((server) => server.name), ["docs", "filesystem"]);
		assert.equal(servers.find((server) => server.name === "docs")?.scope, "project");

		const userFile = join(f.agentDir, "mcp.json");
		const parsed = JSON.parse(await readFile(userFile, "utf8")) as { mcpServers: Record<string, unknown>; extra?: string };
		parsed.extra = "preserved";
		await writeFile(userFile, JSON.stringify(parsed));
		await registry.save(f.project, {
			name: "filesystem",
			scope: "user",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "src"],
			enabled: false,
		});
		const after = JSON.parse(await readFile(userFile, "utf8")) as { extra?: string; mcpServers: { filesystem: { enabled: boolean; args: string[] } } };
		assert.equal(after.extra, "preserved");
		assert.equal(after.mcpServers.filesystem.enabled, false);
		assert.deepEqual(after.mcpServers.filesystem.args, ["-y", "@modelcontextprotocol/server-filesystem", "src"]);

		servers = await registry.remove(f.project, { name: "docs", scope: "project" });
		assert.deepEqual(servers.map((server) => server.name), ["filesystem"]);
	} finally {
		await f.cleanup();
	}
});

test("project override inherits the user transport and only changes enabled state", async () => {
	const f = await fixture();
	try {
		const registry = f.registry();
		await registry.save(f.project, {
			name: "figma",
			scope: "user",
			transport: "http",
			url: "https://mcp.figma.com/mcp",
			description: "Figma",
		});
		await mkdir(join(f.project, ".pi"), { recursive: true });
		await writeFile(join(f.project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { figma: { enabled: false } } }));
		const servers = await registry.list(f.project);
		const figma = servers.find((server) => server.name === "figma");
		assert.ok(figma);
		assert.equal(figma.scope, "project");
		assert.equal(figma.transport, "http");
		assert.equal(figma.url, "https://mcp.figma.com/mcp");
		assert.equal(figma.enabled, false);
		assert.equal(figma.overridden, true);

		const updated = await registry.save(f.project, {
			name: "figma",
			scope: "project",
			transport: "http",
			url: "https://ignored.example/mcp",
			enabled: true,
			overrideOnly: true,
		});
		const enabled = updated.find((server) => server.name === "figma");
		assert.equal(enabled?.enabled, true);
		assert.equal(enabled?.url, "https://mcp.figma.com/mcp");
		const projectConfig = JSON.parse(await readFile(join(f.project, ".pi", "mcp.json"), "utf8")) as {
			mcpServers: { figma: { enabled: boolean; url?: string } };
		};
		assert.equal(projectConfig.mcpServers.figma.enabled, true);
		assert.equal(projectConfig.mcpServers.figma.url, undefined);
	} finally {
		await f.cleanup();
	}
});

test("rejects invalid names, URLs and missing remove targets", async () => {
	const f = await fixture();
	try {
		const registry = f.registry();
		await assert.rejects(
			() => registry.save(f.project, { name: "../bad", scope: "project", transport: "stdio", command: "npx" }),
			/名称/,
		);
		await assert.rejects(
			() => registry.save(f.project, { name: "bad-url", scope: "project", transport: "http", url: "file:///tmp/x" }),
			/http/,
		);
		await assert.rejects(
			() => registry.remove(f.project, { name: "missing", scope: "user" }),
			/不存在/,
		);
	} finally {
		await f.cleanup();
	}
});

test("rejects symlinked project MCP directories instead of writing outside the project", async () => {
	const f = await fixture();
	try {
		const outside = join(f.root, "outside");
		await mkdir(outside);
		await symlink(outside, join(f.project, ".pi"), "dir");
		const registry = f.registry();
		await assert.rejects(
			() => registry.save(f.project, { name: "escape", scope: "project", transport: "stdio", command: "echo" }),
			/符号链接|项目目录/,
		);
		await assert.rejects(() => registry.list(f.project), /符号链接|项目目录/);
		await assert.rejects(
			() => registry.list(f.project),
			/符号链接|项目目录/,
		);
	} finally {
		await f.cleanup();
	}
});
