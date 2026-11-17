import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/agent-definitions.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agents-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(project);
	await mkdir(agentDir);
	return {
		root,
		project,
		agentDir,
		registries: () => new AgentRegistry({ agentDir: () => agentDir }),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("lists built-ins, project/user files and Claude-compatible tools", async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.project, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(f.project, ".pi", "agents", "reviewer.md"),
			[
				"---",
				"name: reviewer",
				'description: "Reviews correctness and tests"',
				"tools: [Read, Grep, Glob]",
				"model: openrouter/moonshotai/kimi-k2.7-code",
				"thinkingLevel: high",
				"---",
				"",
				"You are a careful code reviewer. Do not edit files.",
				"",
			].join("\n"),
		);
		await mkdir(join(f.project, ".claude", "agents"), { recursive: true });
		await writeFile(
			join(f.project, ".claude", "agents", "claude-reviewer.md"),
			"---\nname: claude-reviewer\ndescription: From Claude\ntools: Read\n---\n\nReview only.\n",
		);
		const registry = f.registries();
		const agents = await registry.list(f.project);
		assert.deepEqual(
			agents.filter((agent) => agent.scope === "builtin").map((agent) => agent.name),
			["general-purpose", "Explore", "Plan"],
		);
		const reviewer = agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.readOnly, true);
		assert.deepEqual(reviewer.tools, ["read", "grep", "find"]);
		assert.deepEqual(reviewer.model, { provider: "openrouter", id: "moonshotai/kimi-k2.7-code" });
		assert.equal(reviewer.thinkingLevel, "high");
		assert.equal(reviewer.removable, true);
		const claude = agents.find((agent) => agent.name === "claude-reviewer");
		assert.ok(claude);
		assert.equal(claude.scope, "project");
		assert.equal(claude.removable, false);
		assert.equal((await registry.resolve(f.project, "reviewer"))?.name, "reviewer");
		assert.equal((await registry.resolve(f.project, "missing")), undefined);
		assert.equal((await registry.resolve(f.project, "Explore"))?.readOnly, true);
	} finally {
		await f.cleanup();
	}
});

test("saves and removes project/user agents without allowing built-in overrides", async () => {
	const f = await fixture();
	try {
		const registry = f.registries();
		const saved = await registry.save(f.project, {
			name: "test-writer",
			description: "Writes focused tests",
			prompt: "Add focused tests and run them.",
			tools: ["read", "edit", "write", "bash"],
			thinkingLevel: "medium",
			scope: "project",
		});
		const projectAgent = saved.find((agent) => agent.name === "test-writer");
		assert.ok(projectAgent);
		assert.equal(projectAgent.readOnly, false);
		assert.equal(projectAgent.removable, true);
		assert.match(await readFile(join(f.project, ".pi", "agents", "test-writer.md"), "utf8"), /tools: \[read, edit, write, bash\]/);

		const userSaved = await registry.save(f.project, {
			name: "user-reviewer",
			description: "User reviewer",
			prompt: "Review.",
			scope: "user",
		});
		assert.ok(userSaved.some((agent) => agent.name === "user-reviewer" && agent.scope === "user"));
		assert.match(await readFile(join(f.agentDir, "agents", "user-reviewer.md"), "utf8"), /name: user-reviewer/);

		const removed = await registry.remove(f.project, { name: "test-writer", scope: "project" });
		assert.equal(removed.some((agent) => agent.name === "test-writer"), false);
		await assert.rejects(() => registry.remove(f.project, { name: "Explore", scope: "project" }), /内置/);
		await assert.rejects(
			() =>
				registry.save(f.project, {
					name: "Explore",
					description: "Override",
					prompt: "No.",
					scope: "project",
				}),
			/内置/,
		);
		await assert.rejects(
			() =>
				registry.save(f.project, {
					name: "../escape",
					description: "Bad",
					prompt: "Bad.",
					scope: "project",
				}),
			/名称/,
		);
	} finally {
		await f.cleanup();
	}
});
