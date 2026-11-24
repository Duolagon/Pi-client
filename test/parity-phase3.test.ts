import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DesktopService } from "../src/backend.ts";
import { installControlHandlers } from "../src/control-ipc.ts";
import { installWorkspaceHandlers } from "../src/workspace-ipc.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import permissions from "../src/permission-extension.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import { HooksService } from "../src/hooks-service.ts";
import { SkillRegistry } from "../src/skill-registry.ts";
import { buildContextReport, deleteProjectMemoryRule, writeProjectMemoryFile } from "../src/context-inspector.ts";
import { formatClaudePermissionSpec, parseClaudePermissionSpec, readClaudeProjectPermissions, writeClaudeProjectPermissions } from "../src/claude-settings-sync.ts";
import { buildSeatbeltProfile } from "../src/sandbox.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";
import type { BtwResult, Command, ContextBreakdown, HookEntry, PlanFileState, SandboxStatus, SkillDefinitionEntry } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

function dummyCommand(value: unknown): Command {
	const rec = value as Record<string, unknown>;
	if (rec?.type === "abort") return { type: "abort" };
	throw new Error("Unsupported test command");
}

test("engine-level plan mode allows reads, plans, Explore/Plan subagents and blocks source writes and shells", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-plan-policy-"));
	try {
		const project = await realpath(root);
		await mkdir(join(project, "src"), { recursive: true });
		await writeFile(join(project, "src", "app.ts"), "export const x = 1;\n");
		const policy = (overrides: Partial<RuntimePermissionPolicy> = {}): RuntimePermissionPolicy => ({
			version: 1,
			mode: "plan",
			rules: [{ id: "broad-allow", scope: "global", action: "allow", tool: "*" }],
			disabledTools: [],
			project,
			...overrides,
		});

		assert.equal((await evaluatePermission(policy(), { toolName: "read", input: { path: "src/app.ts" } })).action, "allow");
		assert.equal((await evaluatePermission(policy(), { toolName: "write", input: { path: ".pi/plans/p1.md", content: "# Plan" } })).action, "allow");
		assert.equal((await evaluatePermission(policy(), { toolName: "edit", input: { path: ".claude/plans/p1.md", oldText: "a", newText: "b" } })).action, "allow");
		assert.equal((await evaluatePermission(policy(), { toolName: "write", input: { path: "src/app.ts", content: "hacked" } })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "edit", input: { path: "src/app.ts", oldText: "1", newText: "2" } })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "bash", input: { command: "ls" } })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "NotebookEdit", input: { notebook_path: "nb.ipynb", new_source: "1" } })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "Agent", input: { subagent_type: "Explore", prompt: "inspect", description: "read" } })).action, "allow");
		assert.equal((await evaluatePermission(policy(), { toolName: "Agent", input: { subagent_type: "general-purpose", prompt: "edit", description: "write" } })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "AskUserQuestion", input: { questions: [] } })).action, "allow");
		assert.equal((await evaluatePermission(policy(), { toolName: "ExitPlanMode", input: {} })).action, "allow");
		assert.equal((await evaluatePermission(policy({ mode: "auto" }), { toolName: "ExitPlanMode", input: {} })).action, "deny");
		assert.equal((await evaluatePermission(policy(), { toolName: "WebFetch", input: { url: "https://example.com" } })).action, "allow");

		// NotebookEdit permission modes outside plan mode
		assert.equal((await evaluatePermission(policy({ mode: "ask", rules: [] }), { toolName: "NotebookEdit", input: { notebook_path: "nb.ipynb", new_source: "1" } })).action, "ask");
		assert.equal((await evaluatePermission(policy({ mode: "acceptEdits", rules: [] }), { toolName: "NotebookEdit", input: { notebook_path: "nb.ipynb", new_source: "1" } })).action, "allow");
		assert.equal((await evaluatePermission(policy({ mode: "read", rules: [] }), { toolName: "NotebookEdit", input: { notebook_path: "nb.ipynb", new_source: "1" } })).action, "deny");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("AskUserQuestion, ExitPlanMode and NotebookEdit register and execute cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-phase3-tools-"));
	const prevHost = process.env.PI_DESKTOP_HOST_URL;
	const prevToken = process.env.PI_DESKTOP_HOST_TOKEN;
	const prevTest = process.env.PI_DESKTOP_CONNECTION_TEST;
	const prevChild = process.env.PI_DESKTOP_CHILD;
	let exitedPlan: { title?: string; plan?: string } | undefined;
	const host = new ToolHostServer({
		handle: async () => ({}),
		handleHook: async (req) => (req.toolName === "blocked_by_hook" ? { blocked: true, reason: "Hook blocked" } : { blocked: false }),
		handlePlanExit: async (req) => {
			exitedPlan = { title: req.title, plan: req.plan };
			return { saved: true, planFile: ".pi/plans/conv-1.md" };
		},
	});
	try {
		const nbPath = join(root, "demo.ipynb");
		await writeFile(nbPath, JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: {},
			cells: [{ id: "c1", cell_type: "code", metadata: {}, source: ["print(1)"], outputs: [], execution_count: null }],
		}, null, 1));
		const url = await host.start();
		const { token } = host.register("conv-1");
		process.env.PI_DESKTOP_HOST_URL = url;
		process.env.PI_DESKTOP_HOST_TOKEN = token;
		delete process.env.PI_DESKTOP_CONNECTION_TEST;
		delete process.env.PI_DESKTOP_CHILD;

		const tools = new Map<string, { execute: (id: string, input: unknown, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<{ content: { text: string }[]; details: unknown }> }>();
		permissions({
			registerTool(def: { name: string; execute: (id: string, input: unknown, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<{ content: { text: string }[]; details: unknown }> }) {
				tools.set(def.name, def);
			},
			registerProvider() {},
			on() {},
		} as unknown as ExtensionAPI);

		assert.ok(tools.has("AskUserQuestion"));
		assert.ok(tools.has("ExitPlanMode"));
		assert.ok(tools.has("NotebookEdit"));

		const askRes = await tools.get("AskUserQuestion")!.execute(
			"call-ask",
			{ questions: [{ header: "Target", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
			undefined,
			undefined,
			{ cwd: root, ui: { input: async (title: string) => { assert.equal(title, "__PI_ASK_QUESTIONS__"); return '{"answers":{"Target":"B"}}'; } } },
		);
		assert.match(askRes.content[0].text, /"Target":"B"/);

		const exitRes = await tools.get("ExitPlanMode")!.execute("call-plan", { title: "Demo", plan: "Step 1" });
		assert.deepEqual(exitedPlan, { title: "Demo", plan: "Step 1" });
		assert.match(exitRes.content[0].text, /conv-1\.md/);

		await tools.get("NotebookEdit")!.execute("call-nb1", { notebook_path: "demo.ipynb", cell_id: "c1", new_source: "print(2)\nprint(3)" }, undefined, undefined, { cwd: root });
		await tools.get("NotebookEdit")!.execute("call-nb2", { notebook_path: "demo.ipynb", edit_mode: "insert", cell_number: 1, cell_type: "markdown", new_source: "# Heading" }, undefined, undefined, { cwd: root });
		const nb = JSON.parse(await readFile(nbPath, "utf8")) as { cells: { cell_type: string; source: string[] }[] };
		assert.equal(nb.cells.length, 2);
		assert.deepEqual(nb.cells[0].source, ["print(2)\n", "print(3)"]);
		assert.equal(nb.cells[1].cell_type, "markdown");
	} finally {
		await host.close();
		if (prevHost === undefined) delete process.env.PI_DESKTOP_HOST_URL; else process.env.PI_DESKTOP_HOST_URL = prevHost;
		if (prevToken === undefined) delete process.env.PI_DESKTOP_HOST_TOKEN; else process.env.PI_DESKTOP_HOST_TOKEN = prevToken;
		if (prevTest === undefined) delete process.env.PI_DESKTOP_CONNECTION_TEST; else process.env.PI_DESKTOP_CONNECTION_TEST = prevTest;
		if (prevChild === undefined) delete process.env.PI_DESKTOP_CHILD; else process.env.PI_DESKTOP_CHILD = prevChild;
		await rm(root, { recursive: true, force: true });
	}
});

test("HooksService runs Claude-compatible PreToolUse, UserPromptSubmit and PostToolUse hooks and respects trust gating", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-hooks-test-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	try {
		await mkdir(join(project, ".claude"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "write",
						hooks: [{ type: "command", command: "node -e \"const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if((d.tool_input?.path||'').includes('.env')){process.stderr.write('No .env write'); process.exit(2);}\"" }],
					},
				],
				PostToolUse: [
					{
						matcher: "write",
						hooks: [{ type: "command", command: "node -e \"console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'Lint reminder'}}))\"" }],
					},
				],
			},
		}));

		const hooks = new HooksService({ agentDir: () => agentDir });
		// Untrusted project must never run project hooks
		const untrusted = await hooks.run("PreToolUse", {
			project,
			projectTrusted: false,
			toolName: "write",
			toolInput: { path: ".env" },
		});
		assert.equal(untrusted.blocked, false);
		assert.equal(untrusted.executedCount, 0);

		// Trusted project runs PreToolUse and blocks .env write
		const blocked = await hooks.run("PreToolUse", {
			project,
			projectTrusted: true,
			toolName: "write",
			toolInput: { path: ".env" },
		});
		assert.equal(blocked.blocked, true);
		assert.match(blocked.reason ?? "", /No \.env write/);

		// PostToolUse injects additionalContext
		const post = await hooks.run("PostToolUse", {
			project,
			projectTrusted: true,
			toolName: "write",
			toolInput: { path: "src/ok.ts" },
		});
		assert.equal(post.blocked, false);
		assert.equal(post.additionalContext, "Lint reminder");

		// User save & remove in .pi/hooks.json
		const afterSave = await hooks.save({ event: "UserPromptSubmit", command: "node -e \"console.log(JSON.stringify({decision:'block',reason:'Rejected keyword'}))\"", scope: "project", project });
		assert.ok(afterSave.some((h) => h.event === "UserPromptSubmit" && h.editable));
		const promptBlocked = await hooks.run("UserPromptSubmit", { project, projectTrusted: true, prompt: "hello" });
		assert.equal(promptBlocked.blocked, true);
		assert.match(promptBlocked.reason ?? "", /Rejected keyword/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ContextInspector, SkillRegistry, Claude permission sync and Seatbelt builder work cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-sync-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	try {
		await mkdir(join(project, "src"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(project, "src", "index.ts"), "export const v = 1;\n");
		await writeFile(join(project, "AGENTS.md"), "# Guide\nSee @src/index.ts and @missing.md\n");
		await writeProjectMemoryFile(project, ".claude/rules/ts.md", "---\npaths: src/**/*.ts\n---\nAlways typecheck.\n");

		const report = await buildContextReport({ project, agentDir, tools: [], messages: [] });
		const agentsEntry = report.sources.find((s) => s.relativePath === "AGENTS.md");
		assert.equal(agentsEntry?.exists, true);
		assert.deepEqual(agentsEntry?.imports, [{ target: "src/index.ts", exists: true }, { target: "missing.md", exists: false }]);
		const ruleEntry = report.sources.find((s) => s.relativePath === ".claude/rules/ts.md");
		assert.equal(ruleEntry?.pathsPattern, "src/**/*.ts");
		await deleteProjectMemoryRule(project, ".claude/rules/ts.md");
		await assert.rejects(access(join(project, ".claude", "rules", "ts.md")));

		const skills = new SkillRegistry({ agentDir: () => agentDir });
		const savedSkills = await skills.save({ name: "audit-api", description: "Audit REST endpoints", body: "Check validation.", scope: "project", project });
		assert.equal(savedSkills.find((s) => s.name === "audit-api")?.scope, "project");
		const afterRemove = await skills.remove({ name: "audit-api", scope: "project", project });
		assert.ok(!afterRemove.some((s) => s.name === "audit-api"));

		const parsedBash = parseClaudePermissionSpec("Bash(npm test:*)", "allow", project);
		assert.deepEqual(parsedBash?.command, { type: "prefix", argv: ["npm", "test"] });
		assert.equal(formatClaudePermissionSpec(parsedBash!), "Bash(npm test:*)");
		await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({ customKey: "keep-me" }));
		await writeClaudeProjectPermissions(project, [parsedBash!]);
		const rawClaude = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8")) as { customKey?: string };
		assert.equal(rawClaude.customKey, "keep-me");
		const imported = await readClaudeProjectPermissions(project);
		assert.equal(imported.length, 1);

		const sb = buildSeatbeltProfile(project);
		assert.match(sb, /\(deny file-write\*\)/);
		assert.ok(sb.includes(project));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DesktopService and IPC expose plan files, context report, hooks, skills, btw and claude rule sync", { timeout: 30000 }, async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	const reg = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, action); };
	installWorkspaceHandlers(reg, service, dummyCommand);
	installControlHandlers(reg, service);
	const invoke = <T = unknown>(ch: string, ...args: unknown[]) => handlers.get(ch)!(...args) as Promise<T>;
	try {
		const snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready", snap.engineError);

		// Plan mode writePlan works, while writeMemoryFile is blocked
		await service.saveSettings({ permission: "plan", theme: "light" });
		const savedPlan = await invoke<PlanFileState>("pi:plan:write", "# Implementation Plan\n1. Step A");
		assert.equal(savedPlan.exists, true);
		const readBack = await invoke<PlanFileState>("pi:plan:read");
		assert.equal(readBack.content, "# Implementation Plan\n1. Step A");
		await assert.rejects(invoke("pi:workspace:write-memory-file", "AGENTS.md", "blocked"), /Plan 模式/);

		await service.saveSettings({ permission: "ask", theme: "light" });
		await invoke("pi:workspace:write-memory-file", ".claude/rules/testing.md", "Run node --test.");
		const report = await invoke<ContextBreakdown>("pi:workspace:context-report");
		assert.ok(report.sources.some((s) => s.relativePath === ".claude/rules/testing.md" && s.exists));
		await invoke<ContextBreakdown>("pi:workspace:delete-memory-rule", ".claude/rules/testing.md");

		const hooks = await invoke<HookEntry[]>("pi:hooks:save", { event: "PreToolUse", matcher: "bash", command: "exit 0", scope: "project", project: snap.active!.project });
		assert.ok(hooks.some((h) => h.event === "PreToolUse"));
		const skills = await invoke<SkillDefinitionEntry[]>("pi:skills:save", { name: "quick-check", description: "Run checks", body: "npm run check", scope: "project", project: snap.active!.project });
		assert.ok(skills.some((s) => s.name === "quick-check"));

		const rule = { id: "proj-bash-test", scope: "project", project: snap.active!.project, action: "allow", tool: "bash", command: { type: "prefix", argv: ["node", "--test"] } };
		await service.upsertPermission(rule as never);
		const exported = await invoke<{ exported?: number }>("pi:permissions:export-claude");
		assert.equal(exported.exported, 1);

		const sb = await invoke<SandboxStatus>("pi:sandbox:status");
		assert.equal(sb.enabled, sb.supported);
		if (sb.supported) {
			await service.saveSettings({ permission: snap.settings.permission, theme: snap.settings.theme, sandbox: false });
			assert.equal((await invoke<SandboxStatus>("pi:sandbox:status")).enabled, false);
			await service.saveSettings({ permission: snap.settings.permission, theme: snap.settings.theme, sandbox: true });
			assert.equal((await invoke<SandboxStatus>("pi:sandbox:status")).enabled, true);
		}

		// /btw works without mutating main conversation transcript
		const beforeCount = (await service.snapshot()).messages.length;
		const btwRes = await invoke<BtwResult>("pi:btw", "What does seed.txt contain?");
		assert.ok(btwRes.answer.length > 0);
		assert.equal((await service.snapshot()).messages.length, beforeCount);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
