import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildWorkspaceOutline } from "../src/language-service.ts";
import permissions, { ESCALATION_MESSAGE_TYPE, isVerificationBashCommand } from "../src/permission-extension.ts";
import { loadRuntimePermissionPolicy } from "../src/permission-policy.ts";
import toolControl from "../src/tool-control-extension.ts";
import { deferredSpecialistTools, desktopModelToolNames } from "../src/tool-control-types.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";

test("ToolSearch defers heavy specialist tool schemas by default, unlocks via query, and auto-unlocks from user intent", async (context) => {
	const host = new ToolHostServer({ handle: async () => ({ ok: true }) });
	context.after(() => host.close());
	await host.start();
	const reg = host.register("conv-1");
	const dir = await mkdtemp(join(tmpdir(), "pi-toolsearch-"));
	context.after(() => rm(dir, { recursive: true, force: true }));
	const toolsFile = join(dir, "tools.json");
	await writeFile(toolsFile, JSON.stringify({ overrides: {} }), "utf8");

	const definitions = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function>();
	let active = ["read", "bash", "edit", "write", "grep"];
	let lastUserMessage = "帮我重构一下登录表单校验逻辑";

	const prevEnv: Record<string, string | undefined> = {};
	const envPatch: Record<string, string> = {
		PI_DESKTOP_TOOLS_DIR: dir,
		PI_DESKTOP_TOOLS_TOKEN: "a".repeat(64),
		PI_DESKTOP_TOOLS_COMMAND: `desktop-tools-${"b".repeat(32)}`,
		PI_DESKTOP_TOOLS_FILE: toolsFile,
		PI_DESKTOP_HOST_URL: reg.url,
		PI_DESKTOP_HOST_TOKEN: reg.token,
	};
	for (const [k, v] of Object.entries(envPatch)) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	context.after(() => {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const all: ToolInfo[] = active.map((name) => ({
		name,
		description: `${name} builtin`,
		parameters: { type: "object", properties: {} },
		exposure: "direct",
		sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
	})) as ToolInfo[];

	toolControl({
		registerTool(def: ToolDefinition) {
			definitions.set(def.name, def);
			all.push({
				name: def.name,
				description: def.description,
				parameters: def.parameters,
				exposure: def.exposure ?? "direct",
				sourceInfo: { path: "/runtime/tool-control-extension.mjs", source: "extension", scope: "temporary", origin: "top-level" },
			} as ToolInfo);
			if (def.defaultActive !== false) active.push(def.name);
		},
		registerCommand() {},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		getAllTools: () => all,
		getActiveTools: () => active,
		setActiveTools(next: string[]) {
			active = [...next];
		},
		getSettings: () => ({}),
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI);

	assert.equal(definitions.size, desktopModelToolNames.length + 1);
	const searchDef = definitions.get("ToolSearch")!;
	assert.ok(searchDef, "ToolSearch must be registered");

	const ctx = {
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "user", content: lastUserMessage } }],
		},
	};
	await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, ctx);

	// All 12 specialist tools are hidden from outgoing declarations initially.
	const initialHidden = searchDef.prepareLoadout?.({} as never)?.hiddenDeclarations ?? [];
	assert.deepEqual([...initialHidden].sort(), [...deferredSpecialistTools].sort());

	// Calling ToolSearch("preview") loads PreviewCheck schema and removes it from hiddenDeclarations.
	const searchRes = await searchDef.execute("ts-1", { query: "preview" }, undefined, undefined, {} as never);
	const searchText = (searchRes.content[0] as { text: string }).text;
	assert.match(searchText, /### PreviewCheck/);
	assert.match(searchText, /Parameters JSON Schema:/);
	const afterSearchHidden = searchDef.prepareLoadout?.({} as never)?.hiddenDeclarations ?? [];
	assert.ok(!afterSearchHidden.includes("PreviewCheck"), "PreviewCheck should be unlocked after ToolSearch");
	assert.ok(afterSearchHidden.includes("CronCreate"), "Unrelated specialist tools remain deferred");

	// Mentioning worktree in user prompt auto-unlocks worktree tools before the first model call!
	lastUserMessage = "请在独立 worktree 分支隔离里实现实验特性";
	await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, ctx);
	const afterPromptHidden = searchDef.prepareLoadout?.({} as never)?.hiddenDeclarations ?? [];
	assert.ok(!afterPromptHidden.includes("WorktreeCreate"));
	assert.ok(!afterPromptHidden.includes("WorktreeMerge"));
});

test("buildWorkspaceOutline maps multi-language symbols, ignores build dirs, and enforces read permission filter", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pi-outline-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "node_modules/pkg"), { recursive: true });

	await writeFile(
		join(root, "src/service.ts"),
		[
			"export interface UserRecord { id: string }",
			"export class AuthService {",
			"  login() {}",
			"}",
			"export async function verifyToken(token: string) { return Boolean(token); }",
		].join("\n"),
	);
	await writeFile(join(root, "src/secret.py"), "class SecretVault:\n    pass\ndef load_secret():\n    return 1\n");
	await writeFile(join(root, "node_modules/pkg/index.js"), "export function ignoredPkg() {}\n");

	const outline = await buildWorkspaceOutline(root, ".", async (relPath) => !relPath.endsWith("secret.py"));
	assert.equal(outline.scannedFiles, 1);
	assert.equal(outline.files[0]?.path, "src/service.ts");
	assert.deepEqual(
		outline.files[0]?.symbols.map((s) => `${s.kind}:${s.name}@${s.line}`),
		["interface:UserRecord@1", "class:AuthService@2", "function:verifyToken@5"],
	);
	assert.doesNotMatch(outline.formatted, /secret\.py/);
	assert.doesNotMatch(outline.formatted, /ignoredPkg/);
});

test("loadRuntimePermissionPolicy caches unchanged stat and reloads immediately on atomic swap", async (context) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-policy-cache-"));
	context.after(() => rm(dir, { recursive: true, force: true }));
	const policyFile = join(dir, "policy.json");
	await writeFile(
		policyFile,
		JSON.stringify({ version: 1, mode: "ask", rules: [], disabledTools: [], project: dir }),
	);
	const env = { PI_DESKTOP_POLICY_FILE: policyFile };
	const first = await loadRuntimePermissionPolicy(env, dir);
	const second = await loadRuntimePermissionPolicy(env, dir);
	assert.equal(first, second, "Unchanged policy file should return cached validated instance");

	const nextTmp = `${policyFile}.tmp`;
	await writeFile(
		nextTmp,
		JSON.stringify({ version: 1, mode: "acceptEdits", rules: [], disabledTools: ["bash"], project: dir }),
	);
	const { rename } = await import("node:fs/promises");
	await rename(nextTmp, policyFile);
	const third = await loadRuntimePermissionPolicy(env, dir);
	assert.notEqual(third, first);
	assert.equal(third.mode, "acceptEdits");
	assert.deepEqual(third.disabledTools, ["bash"]);
});

test("zero-hook fastpath skips loopback /hook calls until a hook config file appears on disk, and escalates model after 2 failed verifications", async (context) => {
	let hookHttpCalls = 0;
	const host = new ToolHostServer({
		handle: async () => ({ ok: true }),
		handleHook: async () => {
			hookHttpCalls++;
			return { blocked: false };
		},
	});
	context.after(() => host.close());
	await host.start();
	const reg = host.register("conv-esc");

	const root = await mkdtemp(join(tmpdir(), "pi-fastpath-esc-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const project = join(root, "project");
	await mkdir(home, { recursive: true });
	await mkdir(project, { recursive: true });
	const policyFile = join(root, "policy.json");
	await writeFile(
		policyFile,
		JSON.stringify({ version: 1, mode: "auto", rules: [], disabledTools: [], project }),
	);

	const prevEnv: Record<string, string | undefined> = {};
	const envPatch: Record<string, string> = {
		HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_DESKTOP_HOST_URL: reg.url,
		PI_DESKTOP_HOST_TOKEN: reg.token,
		PI_DESKTOP_POLICY_FILE: policyFile,
		PI_DESKTOP_HOOK_FASTPATH: "1",
		PI_DESKTOP_HAS_EXTRA_HOOKS: "0",
		PI_DESKTOP_TRUST_PROJECT: project,
		PI_DESKTOP_ESCALATION_MODEL: JSON.stringify({ provider: "desktop-anthropic", id: "claude-opus-4-6" }),
	};
	for (const [k, v] of Object.entries(envPatch)) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	context.after(() => {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	assert.equal(isVerificationBashCommand("npm test"), true);
	assert.equal(isVerificationBashCommand("npx tsc --noEmit"), true);
	assert.equal(isVerificationBashCommand("ls -la src"), false);

	const handlers = new Map<string, Function[]>();
	let currentModel = { provider: "desktop-deepseek", id: "deepseek-chat", name: "DeepSeek V3" };
	const models = new Map([
		["desktop-deepseek/deepseek-chat", currentModel],
		["desktop-anthropic/claude-opus-4-6", { provider: "desktop-anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
	]);
	const notifications: string[] = [];

	permissions({
		registerTool() {},
		registerProvider() {},
		on(event: string, fn: Function) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		async setModel(target: typeof currentModel) {
			currentModel = target;
			return true;
		},
	} as unknown as ExtensionAPI);

	const fire = async (event: string, payload: unknown, ctx?: unknown) => {
		const results = [];
		for (const fn of handlers.get(event) ?? []) {
			const res = await fn(payload, ctx);
			if (res !== undefined) results.push(res);
		}
		return results;
	};

	const ctx = {
		get model() {
			return currentModel;
		},
		modelRegistry: {
			find: (provider: string, id: string) => models.get(`${provider}/${id}`),
		},
		ui: {
			notify: (msg: string) => notifications.push(msg),
		},
		sessionManager: {
			getBranch: () => [],
		},
	};

	const guidelines: string[] = [];
	await fire("before_agent_start", { systemPrompt: "", systemPromptOptions: { sections: {}, promptGuidelines: guidelines } }, ctx);
	assert.equal(guidelines.length, 3, "Coding discipline guidelines injected cleanly");

	// 1. With zero hook files on disk, PreToolUse & PostToolUse make 0 HTTP calls to /hook!
	await fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "a.ts" } }, ctx);
	await fire("tool_result", { toolName: "edit", toolCallId: "e1", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: "ok" }] }, ctx);
	assert.equal(hookHttpCalls, 0, "Expected zero loopback /hook HTTP calls when no hooks exist");

	// 2. Two consecutive failing test runs trigger automatic escalation to Claude Opus 4.6 on turn_end!
	await fire("tool_result", {
		toolName: "bash",
		toolCallId: "b1",
		input: { command: "npm test" },
		isError: true,
		structuredContent: { exit_code: 1 },
		content: [{ type: "text", text: "AssertionError: expected 1 to equal 2" }],
	}, ctx);
	let turnRes = await fire("turn_end", { entries: [] }, ctx);
	assert.equal(currentModel.id, "deepseek-chat", "Single failure should let primary model retry once");
	assert.equal(turnRes.length, 0);

	await fire("tool_result", {
		toolName: "bash",
		toolCallId: "b2",
		input: { command: "npm test" },
		isError: true,
		structuredContent: { exit_code: 1 },
		content: [{ type: "text", text: "AssertionError: still failing" }],
	}, ctx);
	turnRes = await fire("turn_end", { entries: [] }, ctx);
	assert.equal(currentModel.id, "claude-opus-4-6", "Second consecutive failure must escalate to routed strong model");
	assert.equal(turnRes[0]?.entries?.[0]?.customType, ESCALATION_MESSAGE_TYPE);
	assert.ok(notifications.some((n) => n.includes("Claude Opus 4.6")));

	// 3. Settling the run automatically restores the primary cost-efficient model!
	await fire("agent_settled", {}, ctx);
	assert.equal(currentModel.id, "deepseek-chat", "Settling run must restore primary model");

	// 4. Writing .pi/hooks.json on disk mid-session is detected immediately on the next tool call!
	await mkdir(join(project, ".pi"), { recursive: true });
	await writeFile(
		join(project, ".pi", "hooks.json"),
		JSON.stringify({ version: 1, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo ok" }] }] } }),
	);
	await fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "a.ts" } }, ctx);
	assert.equal(hookHttpCalls, 1, "Creating .pi/hooks.json must immediately re-enable /hook dispatch");
});
