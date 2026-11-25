import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluatePermission, redactSearchOutput } from "../src/permission-policy.ts";
import permissions from "../src/permission-extension.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import { isProtectedFileToolPath } from "../src/sandbox.ts";

test("native tool sandbox rules take precedence over auto and explicit allow rules", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-file-tool-sandbox-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const outside = join(root, "outside");
	await Promise.all([mkdir(project), mkdir(outside)]);
	await writeFile(join(project, ".env"), "PI_FIXTURE=value\n");
	const policy: RuntimePermissionPolicy = {
		version: 1,
		mode: "auto",
		sandbox: true,
		rules: [{ id: "allow-all", scope: "global", action: "allow", tool: "*" }],
		disabledTools: [],
		project,
	};
	for (const toolName of ["read", "grep", "find", "ls", "edit", "write"]) {
		for (const path of [".env", ".env.local"]) {
			const decision = await evaluatePermission(policy, { toolName, input: { path } });
			assert.equal(decision.action, "deny", `${toolName} ${path}`);
			assert.match(decision.reason, /敏感凭据/);
		}
	}
	const writeOutside = { toolName: "write", input: { path: join(outside, "draft.txt") } };
	assert.equal((await evaluatePermission(policy, writeOutside)).action, "deny");
	const notebookEdit = { toolName: "NotebookEdit", input: { path: "ordinary.txt", notebook_path: join(outside, "notes.ipynb") } };
	assert.equal((await evaluatePermission(policy, notebookEdit)).action, "deny");
	assert.equal((await evaluatePermission({ ...policy, additionalDirs: [outside] }, writeOutside)).action, "allow");
	assert.equal((await evaluatePermission({ ...policy, sandbox: false }, writeOutside)).action, "allow");
	for (const path of ["draft.txt", ".env.example"])
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path } })).action, "allow");

	if (process.platform !== "win32") {
		await symlink(join(project, ".env"), join(project, "settings.txt"));
		assert.equal((await evaluatePermission(policy, { toolName: "read", input: { path: "settings.txt" } })).action, "deny");
		await symlink(join(outside, "new.txt"), join(project, "dangling.txt"));
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path: "dangling.txt" } })).action, "deny");
	}
});

test("file protection recognizes host credential stores without treating unrelated names as protected", () => {
	const home = join(tmpdir(), "pi-fixture-home");
	assert.equal(isProtectedFileToolPath(join(home, ".ssh", "fixture"), home), true);
	assert.equal(isProtectedFileToolPath(join(home, "Library", "Keychains", "fixture"), home), true);
	assert.equal(isProtectedFileToolPath(join(home, ".netrc"), home), true);
	assert.equal(isProtectedFileToolPath(join(home, ".ssh-notes.txt"), home), false);
	assert.equal(isProtectedFileToolPath(join(home, "project", ".env.sample"), home), false);
});

test("recursive search results hide protected files while preserving ordinary matches", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-file-tool-results-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const policy: RuntimePermissionPolicy = { version: 1, mode: "auto", sandbox: true, rules: [], disabledTools: [], project };
	const output = "app.ts:1: fixture\n.env:1: PI_FIXTURE=value\nconfig/.env.local-2- adjacent\n.env.example:1: ordinary template";
	assert.deepEqual(await redactSearchOutput(policy, "grep", {}, output), {
		text: "app.ts:1: fixture\n.env.example:1: ordinary template", removed: 2,
	});
	assert.deepEqual(await redactSearchOutput(policy, "find", {}, ".env\n.env.example\napp.ts"), {
		text: ".env.example\napp.ts", removed: 1,
	});
	assert.equal((await redactSearchOutput({ ...policy, sandbox: false }, "grep", {}, output)).text, output);
});

test("recursive search honors explicit path rules for canonical directory names", { skip: process.platform === "win32" }, async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-file-tool-result-rules-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	await mkdir(join(project, "restricted"));
	await writeFile(join(project, "restricted", "example.txt"), "fixture");
	await symlink(join(project, "restricted"), join(project, "alias"), "dir");
	const policy: RuntimePermissionPolicy = {
		version: 1, mode: "auto", project, disabledTools: [],
		rules: [{ id: "restrict", scope: "global", action: "deny", tool: "grep", path: "restricted/**" }],
	};
	const output = "alias/example.txt:1: fixture\nregular.txt:1: fixture";
	assert.deepEqual(await redactSearchOutput(policy, "grep", {}, output), {
		text: "regular.txt:1: fixture", removed: 1,
	});
});

test("the result hook removes original truncation text and fails closed when the policy cannot load", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-file-tool-result-hook-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const policyFile = join(project, "policy.json");
	const original = process.env.PI_DESKTOP_POLICY_FILE;
	process.env.PI_DESKTOP_POLICY_FILE = policyFile;
	t.after(() => {
		if (original === undefined) delete process.env.PI_DESKTOP_POLICY_FILE;
		else process.env.PI_DESKTOP_POLICY_FILE = original;
	});
	const policy: RuntimePermissionPolicy = { version: 1, mode: "auto", sandbox: true, rules: [], disabledTools: [], project };
	await writeFile(policyFile, JSON.stringify(policy));
	let handle: (event: unknown, context?: unknown) => Promise<unknown>;
	permissions({ on(event: string, callback: typeof handle) { if (event === "tool_result") handle = callback; } } as unknown as ExtensionAPI);
	const output = "app.ts:1: fixture\n.env:1: PROTECTED_FIXTURE";
	const event = {
		toolName: "grep", toolCallId: "fixture", input: {},
		content: [{ type: "text", text: output }],
		details: { truncation: { content: output, totalLines: 2 } },
	};
	const filtered = await handle!(event);
	assert.doesNotMatch(JSON.stringify(filtered), /PROTECTED_FIXTURE/);
	assert.match(JSON.stringify(filtered), /app.ts:1: fixture/);
	await writeFile(policyFile, "{");
	assert.deepEqual(await handle!(event), {
		content: [{ type: "text", text: "无法确认搜索结果中的文件权限，已隐藏结果。" }],
		details: {},
		isError: true,
	});
});
