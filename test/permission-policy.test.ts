import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	evaluatePermission,
	loadRuntimePermissionPolicy,
	validatePermissionRule,
	validateRuntimePolicy,
} from "../src/permission-policy.ts";
import type { PermissionRule, RuntimePermissionPolicy } from "../src/permission-types.ts";
import permissions from "../src/permission-extension.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-permissions-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	await mkdir(project);
	await mkdir(outside);
	await mkdir(join(project, "src"));
	await writeFile(join(project, "seed.txt"), "seed");
	await writeFile(join(outside, "secret.txt"), "fixture-data");
	const policy = (overrides: Partial<RuntimePermissionPolicy> = {}): RuntimePermissionPolicy => ({
		version: 1, mode: "ask", rules: [], disabledTools: [], project, ...overrides,
	});
	const rule = (overrides: Partial<PermissionRule> = {}): PermissionRule => ({
		id: "rule-1", scope: "global", action: "allow", tool: "write", ...overrides,
	});
	return { root, project, outside, policy, rule, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("default asks only for project-external reads, writes and custom tools", async () => {
	const f = await fixture();
	try {
		for (const toolName of ["read", "grep", "find", "ls"]) {
			assert.equal((await evaluatePermission(f.policy(), { toolName, input: { path: "seed.txt" } })).action, "allow");
			assert.equal((await evaluatePermission(f.policy(), { toolName, input: { path: "../outside/secret.txt" } })).action, "ask");
		}
		assert.equal((await evaluatePermission(f.policy(), { toolName: "write", input: { path: "new.txt" } })).action, "ask");
		assert.equal((await evaluatePermission(f.policy(), { toolName: "mcp__calendar__list", input: {} })).action, "ask");
		assert.equal((await evaluatePermission(f.policy(), { toolName: "read", input: {} })).action, "deny");
	} finally { await f.cleanup(); }
});

test("acceptEdits allows project edits but keeps command and external path prompts", async () => {
	const f = await fixture();
	try {
		const policy = f.policy({ mode: "acceptEdits" });
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path: "new.txt" } })).action, "allow");
		assert.equal((await evaluatePermission(policy, { toolName: "edit", input: { path: "src/seed.txt" } })).action, "allow");
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path: "../outside/new.txt" } })).action, "ask");
		assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command: "touch new.txt" } })).action, "ask");
		assert.equal((await evaluatePermission(policy, { toolName: "read", input: { path: "../outside/secret.txt" } })).action, "ask");
		const denied = await evaluatePermission(
			f.policy({ mode: "acceptEdits", rules: [f.rule({ action: "deny", tool: "edit", path: "src/**" })] }),
			{ toolName: "edit", input: { path: "src/seed.txt" } },
		);
		assert.equal(denied.action, "deny");
	} finally { await f.cleanup(); }
});

test("read mode and disabled tools take precedence over all allow rules", async () => {
	const f = await fixture();
	try {
		const rules = [f.rule({ tool: "*" })];
		for (const toolName of ["write", "edit", "bash", "Agent", "WorktreeCreate", "WorktreeMerge", "WorktreeRemove", "mcp__x__read"]) {
			assert.equal((await evaluatePermission(f.policy({ mode: "read", rules }), { toolName, input: { path: "new.txt" } })).action, "deny");
		}
		for (const toolName of ["TaskOutput", "TaskList", "TaskStop", "WorktreeList"]) {
			assert.equal((await evaluatePermission(f.policy({ mode: "read" }), { toolName, input: {} })).action, "allow");
		}
		assert.equal((await evaluatePermission(f.policy({ mode: "auto", rules, disabledTools: ["read"] }), {
			toolName: "read", input: { path: "seed.txt" },
		})).action, "deny");
	} finally { await f.cleanup(); }
});

test("deny outranks ask and allow regardless of rule order and auto mode", async () => {
	const f = await fixture();
	try {
		const rules = [
			f.rule({ id: "allow-all", tool: "*" }),
			f.rule({ id: "ask-source", action: "ask", path: "src/**" }),
			f.rule({ id: "deny-secret", action: "deny", path: "src/secret.txt" }),
		];
		const decision = await evaluatePermission(f.policy({ mode: "auto", rules }), { toolName: "write", input: { path: "src/secret.txt" } });
		assert.equal(decision.action, "deny");
		assert.equal(decision.ruleId, "deny-secret");
		assert.equal((await evaluatePermission(f.policy({ rules }), { toolName: "write", input: { path: "src/normal.txt" } })).action, "ask");
	} finally { await f.cleanup(); }
});

test("path glob matches canonical paths and resolves new files through symlinks", async () => {
	const f = await fixture();
	try {
		await symlink(f.outside, join(f.project, "linked"), "dir");
		const read = await evaluatePermission(f.policy(), { toolName: "read", input: { path: "linked/secret.txt" } });
		assert.equal(read.action, "ask");
		assert.deepEqual(read.targets, [await realpath(join(f.outside, "secret.txt"))]);
		const policy = f.policy({ rules: [f.rule({ path: "**" })] });
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path: "linked/new/deep.txt" } })).action, "ask");
		assert.equal((await evaluatePermission(policy, { toolName: "write", input: { path: "src/new/deep.txt" } })).action, "allow");
		const denied = f.policy({ mode: "auto", rules: [f.rule({ action: "deny", path: join(f.outside, "**") })] });
		assert.equal((await evaluatePermission(denied, { toolName: "write", input: { path: "linked/new.txt" } })).action, "deny");
	} finally { await f.cleanup(); }
});

test("path globs distinguish single-segment wildcards from recursive patterns", async () => {
	const f = await fixture();
	try {
		const direct = f.policy({ rules: [f.rule({ path: "src/*.ts" })] });
		assert.equal((await evaluatePermission(direct, { toolName: "write", input: { path: "src/a.ts" } })).action, "allow");
		assert.equal((await evaluatePermission(direct, { toolName: "write", input: { path: "src/sub/a.ts" } })).action, "ask");
		const recursive = f.policy({ rules: [f.rule({ path: "src/**/*.ts" })] });
		assert.equal((await evaluatePermission(recursive, { toolName: "write", input: { path: "src/a.ts" } })).action, "allow");
		assert.equal((await evaluatePermission(recursive, { toolName: "write", input: { path: "src/sub/a.ts" } })).action, "allow");
	} finally { await f.cleanup(); }
});

test("Pi native @, file URL and filename fallback normalization cannot hide external targets", async () => {
	const f = await fixture();
	try {
		for (const path of ["@../outside/secret.txt", pathToFileURL(join(f.outside, "secret.txt")).href]) {
			assert.equal((await evaluatePermission(f.policy(), { toolName: "read", input: { path } })).action, "ask");
			const denied = f.policy({ mode: "auto", rules: [f.rule({ tool: "write", action: "deny", path: join(f.outside, "**") })] });
			assert.equal((await evaluatePermission(denied, { toolName: "write", input: { path } })).action, "deny");
		}
		await symlink(join(f.outside, "secret.txt"), join(f.project, "Capture d’écran.txt"));
		assert.equal((await evaluatePermission(f.policy(), { toolName: "read", input: { path: "Capture d'écran.txt" } })).action, "ask");
	} finally { await f.cleanup(); }
});

test("literal Bash rules use argv boundaries and compound calls cannot inherit allow", async () => {
	const f = await fixture();
	try {
		const policy = f.policy({ rules: [f.rule({ tool: "bash", command: { type: "prefix", argv: ["npm", "test"] } })] });
		assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command: "npm test -- --runInBand" } })).action, "allow");
		for (const command of ["npm test-malicious", "npm test && touch x", "npm test; touch x", "npm test > output", "npm test $(touch x)", "env npm test"]) {
			assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command } })).action, "ask", command);
		}
		const exact = f.policy({ rules: [f.rule({ tool: "bash", command: { type: "exact", value: "git status --short" } })] });
		assert.equal((await evaluatePermission(exact, { toolName: "bash", input: { command: "git 'status' --short" } })).action, "allow");
		assert.equal((await evaluatePermission(exact, { toolName: "bash", input: { command: "git status --short --ignored" } })).action, "ask");
	} finally { await f.cleanup(); }
});

test("Bash deny checks each compound segment and fails closed on opaque wrappers", async () => {
	const f = await fixture();
	try {
		const policy = f.policy({ mode: "auto", rules: [f.rule({ tool: "bash", action: "deny", command: { type: "exact", value: "rm secret.txt" } })] });
		for (const command of ["rm secret.txt", "echo hello && rm secret.txt", "echo hello | rm secret.txt", "rm 'secret.txt'; echo done", "sh -c 'rm secret.txt'", "r$(echo m) secret.txt"]) {
			const result = await evaluatePermission(policy, { toolName: "bash", input: { command } });
			assert.equal(result.action, "deny", command);
			assert.equal(result.ruleId, "rule-1");
		}
		assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command: "echo hello && git status" } })).action, "allow");
		assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command: "git status" } })).action, "allow");
	} finally { await f.cleanup(); }
});

test("MCP tool-name patterns are explicit and do not auto-allow other servers", async () => {
	const f = await fixture();
	try {
		const rules = [f.rule({ tool: "mcp__docs__*" })];
		assert.equal((await evaluatePermission(f.policy({ rules }), { toolName: "mcp__docs__search", input: {} })).action, "allow");
		assert.equal((await evaluatePermission(f.policy({ rules }), { toolName: "mcp__mail__send", input: {} })).action, "ask");
	} finally { await f.cleanup(); }
});

test("configured policy is loaded afresh and malformed or missing files fail closed", async () => {
	const f = await fixture();
	try {
		const file = join(f.root, "policy.json");
		const env = { PI_DESKTOP_POLICY_FILE: file, PI_DESKTOP_PERMISSION_MODE: "auto" };
		await assert.rejects(loadRuntimePermissionPolicy(env, f.project));
		await writeFile(file, JSON.stringify(f.policy({ mode: "auto" })));
		assert.equal((await loadRuntimePermissionPolicy(env, f.project)).mode, "auto");
		await writeFile(file, JSON.stringify(f.policy({ disabledTools: ["write"] })));
		assert.deepEqual((await loadRuntimePermissionPolicy(env, f.project)).disabledTools, ["write"]);
		await writeFile(file, "{}");
		await assert.rejects(loadRuntimePermissionPolicy(env, f.project));
		await writeFile(file, "invalid JSON");
		await assert.rejects(loadRuntimePermissionPolicy(env, f.project));
		assert.equal((await loadRuntimePermissionPolicy({ PI_DESKTOP_PERMISSION_MODE: "read" }, f.project)).mode, "read");
	} finally { await f.cleanup(); }
});

test("validators reject unknown fields, malformed scopes and unsafe command selectors", async () => {
	const f = await fixture();
	try {
		assert.throws(() => validatePermissionRule(f.rule({ scope: "project" })));
		assert.throws(() => validatePermissionRule(f.rule({ scope: "conversation" })));
		assert.throws(() => validatePermissionRule({ ...f.rule(), unexpected: true }));
		assert.throws(() => validatePermissionRule(f.rule({ command: { type: "prefix", argv: ["npm"] } })));
		assert.throws(() => validatePermissionRule(f.rule({ command: { type: "exact", value: "npm test && touch x" } })));
		assert.throws(() => validatePermissionRule(f.rule({ command: { type: "exact", value: "sh -c 'touch x'" } })));
		assert.throws(() => validateRuntimePolicy(f.policy({ rules: [f.rule(), f.rule()] })));
		assert.throws(() => validateRuntimePolicy({ ...f.policy(), disabledTools: ["*"] }));
		assert.deepEqual(validatePermissionRule(f.rule({ scope: "project", project: f.project })), f.rule({ scope: "project", project: f.project }));
	} finally { await f.cleanup(); }
});

test("tool hook rechecks revocation after an approval and blocks invalid configured policy", async () => {
	const f = await fixture();
	const previous = process.env.PI_DESKTOP_POLICY_FILE;
	try {
		const policyFile = join(f.root, "policy.json");
		process.env.PI_DESKTOP_POLICY_FILE = policyFile;
		await writeFile(policyFile, JSON.stringify(f.policy()));
		let hook: (event: { toolName: string; input: unknown }, ctx: unknown) => Promise<unknown>;
		permissions({ on(event: string, handler: typeof hook) { if (event === "tool_call") hook = handler; } } as unknown as ExtensionAPI);
		const event = { toolName: "write", input: { path: "new.txt" } };
		const decision = await hook!(event, { ui: { confirm: async () => {
			await writeFile(policyFile, JSON.stringify(f.policy({ disabledTools: ["write"] })));
			return true;
		} } });
		assert.deepEqual(decision, { block: true, reason: "该工具已停用。" });
		await writeFile(policyFile, "invalid JSON");
		const invalid = await hook!(event, { ui: { confirm: () => { throw new Error("must not prompt"); } } });
		assert.equal((invalid as { block: boolean }).block, true);
	} finally {
		if (previous === undefined) delete process.env.PI_DESKTOP_POLICY_FILE;
		else process.env.PI_DESKTOP_POLICY_FILE = previous;
		await f.cleanup();
	}
});

test("TodoWrite and WebFetch follow policy modes and SSRF host guards", async () => {
	const f = await fixture();
	const previousHost = process.env.PI_DESKTOP_HOST_URL;
	const previousTest = process.env.PI_DESKTOP_CONNECTION_TEST;
	const previousChild = process.env.PI_DESKTOP_CHILD;
	try {
		assert.equal((await evaluatePermission(f.policy({ mode: "read" }), { toolName: "TodoWrite", input: { todos: [] } })).action, "allow");
		assert.equal((await evaluatePermission(f.policy({ mode: "ask" }), { toolName: "TodoWrite", input: { todos: [] } })).action, "allow");
		assert.equal((await evaluatePermission(f.policy({ mode: "auto", disabledTools: ["TodoWrite"] }), { toolName: "TodoWrite", input: { todos: [] } })).action, "deny");

		assert.equal((await evaluatePermission(f.policy({ mode: "read" }), { toolName: "WebFetch", input: { url: "https://example.com" } })).action, "deny");
		assert.equal((await evaluatePermission(f.policy({ mode: "ask" }), { toolName: "WebFetch", input: { url: "https://example.com" } })).action, "ask");
		assert.equal((await evaluatePermission(f.policy({ mode: "auto" }), { toolName: "WebFetch", input: { url: "https://example.com" } })).action, "allow");

		process.env.PI_DESKTOP_HOST_URL = "http://127.0.0.1:45555";
		delete process.env.PI_DESKTOP_CONNECTION_TEST;
		delete process.env.PI_DESKTOP_CHILD;
		const registered = new Map<string, { execute: (id: string, input: unknown) => Promise<unknown> }>();
		permissions({
			registerTool(def: { name: string; execute: (id: string, input: unknown) => Promise<unknown> }) {
				registered.set(def.name, def);
			},
			registerProvider() {},
			on() {},
		} as unknown as ExtensionAPI);
		assert.ok(registered.has("TodoWrite"));
		assert.ok(registered.has("WebFetch"));
		const todoResult = await registered.get("TodoWrite")!.execute("tc-1", {
			todos: [{ id: "1", content: "Write tests", status: "in_progress" }],
		}) as { details: { todos: unknown[] } };
		assert.equal(todoResult.details.todos.length, 1);
		await assert.rejects(registered.get("WebFetch")!.execute("tc-2", { url: "http://127.0.0.1:8080" }), /private or loopback/);
		await assert.rejects(registered.get("WebFetch")!.execute("tc-3", { url: "http://localhost/admin" }), /private or loopback/);
		await assert.rejects(
			registered.get("WebFetch")!.execute("tc-5", { url: "http://[::ffff:127.0.0.1]:8080/" }),
			/private or loopback/,
		);
		await assert.rejects(
			registered.get("WebFetch")!.execute("tc-6", { url: "http://[fc00::1]/" }),
			/private or loopback/,
		);
		await assert.rejects(registered.get("WebFetch")!.execute("tc-4", { url: "file:///etc/passwd" }), /http and https/);
	} finally {
		if (previousHost === undefined) delete process.env.PI_DESKTOP_HOST_URL;
		else process.env.PI_DESKTOP_HOST_URL = previousHost;
		if (previousTest === undefined) delete process.env.PI_DESKTOP_CONNECTION_TEST;
		else process.env.PI_DESKTOP_CONNECTION_TEST = previousTest;
		if (previousChild === undefined) delete process.env.PI_DESKTOP_CHILD;
		else process.env.PI_DESKTOP_CHILD = previousChild;
		await f.cleanup();
	}
});
