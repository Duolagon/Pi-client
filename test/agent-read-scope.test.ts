import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateAgentScopePaths, verifyAgentScopePaths } from "../src/agent-read-scope.ts";
import { DesktopService } from "../src/backend.ts";
import { evaluatePermission, redactSearchOutput, validateRuntimePolicy } from "../src/permission-policy.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

test("scoped agent grants are literal existing project paths", async () => {
	assert.deepEqual(validateAgentScopePaths(["./src/", "src", "docs/guide.md"]), ["src", "docs/guide.md"]);
	for (const paths of [[], ["."], ["../sibling"], ["docs/../src"], ["/absolute"], ["C:drive-relative"], ["src\\nested"], ["docs/*.md"]])
		assert.throws(() => validateAgentScopePaths(paths), /scope_paths/);
	const project = await mkdtemp(join(tmpdir(), "pi-agent-scope-paths-"));
	try {
		await mkdir(join(project, "src"));
		await symlink(join(project, "src"), join(project, "linked-src"));
		await verifyAgentScopePaths(project, ["src"]);
		await assert.rejects(verifyAgentScopePaths(project, ["linked-src"]), /symbolic link/);
		await assert.rejects(verifyAgentScopePaths(project, ["missing"]), /Could not find scoped path/);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("scoped workers cannot read sibling paths, search through redirects, or use an unscoped tool", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-agent-scope-policy-"));
	try {
		await Promise.all([mkdir(join(project, "src")), mkdir(join(project, "src-extra"))]);
		await Promise.all([
			writeFile(join(project, "src", "allowed.txt"), "allowed"),
			writeFile(join(project, "src", "denied.txt"), "denied"),
			writeFile(join(project, "src-extra", "outside.txt"), "outside"),
		]);
		await symlink(join(project, "src-extra", "outside.txt"), join(project, "src", "[outside]"));
		const policy = validateRuntimePolicy({
			version: 1, project, mode: "read", readScope: ["src"], disabledTools: [],
			rules: [{ id: "deny-content", scope: "global", action: "deny", tool: "read", path: "src/denied.txt" }],
		});
		for (const [toolName, input] of [
			["read", { path: "src/allowed.txt" }],
			["ls", { path: "src" }],
			["find", { path: "src", pattern: "*" }],
			["grep", { path: "src", pattern: "allowed" }],
			["LSP", { operation: "workspaceOutline", filePath: "src" }],
		] as const) assert.equal((await evaluatePermission(policy, { toolName, input })).action, "allow", toolName);
		for (const [toolName, input] of [
			["read", { path: "src-extra/outside.txt" }],
			["read", { path: "src/denied.txt" }],
			["read", { path: "@src/[outside]" }],
			["ls", {}],
			["find", { path: "." }],
			["LSP", { operation: "workspaceOutline", filePath: "src-extra" }],
			["LSP", { operation: "goToDefinition", filePath: "src/allowed.txt" }],
			["Agent", { subagent_type: "Explore", scope_paths: ["src-extra"] }],
			["WebSearch", { query: "project content" }],
		] as const) assert.equal((await evaluatePermission(policy, { toolName, input })).action, "deny", toolName);
		for (const tool of ["ls", "find"]) {
			assert.deepEqual(await redactSearchOutput(policy, tool, { path: "src" }, "allowed.txt\n[outside]\ndenied.txt"), {
				text: "allowed.txt", removed: 2,
			});
		}
		assert.deepEqual(await redactSearchOutput(policy, "grep", { path: "src" }, "allowed.txt:1: allowed\n[outside]:1: outside\ndenied.txt:1: denied"), {
			text: "allowed.txt:1: allowed", removed: 2,
		});
		assert.deepEqual(await redactSearchOutput(policy, "grep", { path: "src/denied.txt" }, "denied.txt:1: denied"), {
			text: "", removed: 1,
		});
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("real local Pi hands the scope from the model to a read-only worker", { timeout: 30000 }, async () => {
	const fixture = await createCoreFixture();
	const here = dirname(fileURLToPath(import.meta.url));
	await mkdir(join(fixture.project, "assigned"));
	await writeFile(join(fixture.project, "assigned", "inside.txt"), "INSIDE_SCOPE\n");
	await writeFile(join(fixture.project, "sibling.txt"), "OUTSIDE_SCOPE_SECRET\n");
	await cp(join(here, "fixtures", "scoped-delegation-provider.js"), join(fixture.agentDir, "extensions", "faux-provider.js"));
	const service = new DesktopService({
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry, env: fixture.env, initialProject: fixture.project,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
	});
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready");
		await service.saveSettings({ permission: "read", theme: "light", maxSubagentDepth: 2 });
		const parent = initial.active!.id;
		await service.command({ type: "prompt", message: "SCOPED_PARENT" }, parent);
		for (let attempt = 0; attempt < 100; attempt++) {
			const task = (await service.listTasks()).find((candidate) => candidate.parentConversationId === parent);
			if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
				assert.equal(task.status, "completed", task.error);
				assert.equal(task.workingDirectory, await realpath(fixture.project));
				assert.deepEqual(task.scopePaths, ["assigned"]);
				assert.match(task.result?.text ?? "", /INSIDE_SCOPE/);
				assert.match(task.result?.text ?? "", /OUTSIDE_BLOCKED true/);
				assert.doesNotMatch(task.result?.text ?? "", /OUTSIDE_SCOPE_SECRET/);
				assert.deepEqual(task.result?.readPaths, ["assigned/inside.txt"]);
				assert.equal((await service.permissionSettings(task.id)).effective.readScope?.[0], "assigned");
				assert.ok(!(await service.listTools(task.id)).some((tool) => tool.name === "Agent" && tool.modelVisible));
				return;
			}
			await delay(100);
		}
		assert.fail("scoped worker never finished");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
