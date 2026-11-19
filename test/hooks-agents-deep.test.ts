import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../src/agent-definitions.ts";
import { DesktopService } from "../src/backend.ts";
import { HooksService } from "../src/hooks-service.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import permissions from "../src/permission-extension.ts";
import { createForkedSessionSnapshot } from "../src/session-fork.ts";
import { SkillRegistry } from "../src/skill-registry.ts";
import { ToolHostServer, type HookBridgeRequest } from "../src/tool-host-server.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
const toolControlPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/tool-control-extension.ts");
const navigationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-navigation-extension.ts");
const historyPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-history-entry.ts");

test("HooksService supports HTTP hooks, allowedEnvVars whitelisting, new events and fails open on 5xx", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-hooks-http-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const received: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
	let mode: "allow_update" | "deny" | "error_500" = "allow_update";

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(Buffer.from(c));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		received.push({ headers: req.headers, body });
		if (mode === "error_500") {
			res.writeHead(500);
			res.end("Internal Error");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		if (mode === "deny") {
			res.end(JSON.stringify({
				hookSpecificOutput: {
					permissionDecision: "deny",
					permissionDecisionReason: "Blocked by HTTP hook",
				},
			}));
			return;
		}
		res.end(JSON.stringify({
			hookSpecificOutput: {
				permissionDecision: "allow",
				updatedInput: { path: "safe.txt", __proto__: { polluted: true } },
				additionalContext: "Verified via HTTP",
			},
		}));
	});

	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(project, { recursive: true });
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const url = `http://127.0.0.1:${port}/hook`;

		const hooks = new HooksService({ agentDir: () => agentDir });
		await assert.rejects(
			() => hooks.save({ event: "PreToolUse", handlerType: "http", url: `http://user:pass@127.0.0.1:${port}/`, scope: "project", project }),
			/凭据|URL/,
		);

		const saved = await hooks.save({
			event: "PreToolUse",
			handlerType: "http",
			matcher: "^Write$",
			url,
			headers: {
				"X-Auth": "Token $ALLOWED_SECRET",
				"X-Leak": "$PI_DESKTOP_KEY_ANTHROPIC",
			},
			allowedEnvVars: ["ALLOWED_SECRET", "PI_DESKTOP_KEY_ANTHROPIC"],
			timeout: 5000,
			scope: "project",
			project,
		});
		assert.equal(saved[0]?.handlerType, "http");

		// Untrusted project must never run HTTP hooks
		const untrusted = await hooks.run("PreToolUse", {
			project,
			projectTrusted: false,
			toolName: "write",
			toolInput: { path: "orig.txt" },
			env: { ALLOWED_SECRET: "ok-token", PI_DESKTOP_KEY_ANTHROPIC: "must-strip" },
		});
		assert.equal(untrusted.executedCount, 0);

		const allowed = await hooks.run("PreToolUse", {
			project,
			projectTrusted: true,
			toolName: "write",
			toolCallId: "tc-1",
			toolInput: { path: "orig.txt" },
			env: { ALLOWED_SECRET: "ok-token", PI_DESKTOP_KEY_ANTHROPIC: "must-strip" },
		});
		assert.equal(allowed.blocked, false);
		assert.equal(allowed.permissionDecision, "allow");
		assert.deepEqual(allowed.updatedInput, { path: "safe.txt" });
		assert.equal(Object.hasOwn(allowed.updatedInput ?? {}, "polluted"), false);
		assert.equal(allowed.additionalContext, "Verified via HTTP");
		assert.equal(received[0]?.headers["x-auth"], "Token ok-token");
		assert.equal(received[0]?.headers["x-leak"], "");
		assert.equal(received[0]?.body.tool_name, "write");
		assert.equal(received[0]?.body.tool_use_id, "tc-1");

		// Claude settings HTTP hook sends Claude tool_name ("Write")
		await mkdir(join(project, ".claude"), { recursive: true });
		await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({
			hooks: { PreToolUse: [{ matcher: "^Write$", hooks: [{ type: "http", url, timeout: 5 }] }] },
		}));
		const claudeCountBefore = received.length;
		await hooks.run("PreToolUse", { project, projectTrusted: true, toolName: "write", toolInput: { path: "orig.txt" } });
		assert.equal(received.length, claudeCountBefore + 2);
		const runNames = received.slice(claudeCountBefore).map((r) => r.body.tool_name);
		assert.ok(runNames.includes("Write"));
		assert.ok(runNames.includes("write"));

		mode = "deny";
		const denied = await hooks.run("PreToolUse", { project, projectTrusted: true, toolName: "write", toolInput: { path: "x" } });
		assert.equal(denied.blocked, true);
		assert.equal(denied.reason, "Blocked by HTTP hook");

		mode = "error_500";
		const errRes = await hooks.run("PreToolUse", { project, projectTrusted: true, toolName: "write", toolInput: { path: "x" } });
		assert.equal(errRes.blocked, false);
		assert.match(errRes.systemMessage ?? "", /HTTP 500/);
	} finally {
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("permission-extension enforces PreToolUse updatedInput recheck, PermissionRequest, PostToolUseFailure, PreCompact and Stop without looping", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-ext-hooks-")));
	const policyFile = join(root, "policy.json");
	const prevHost = process.env.PI_DESKTOP_HOST_URL;
	const prevToken = process.env.PI_DESKTOP_HOST_TOKEN;
	const prevPolicy = process.env.PI_DESKTOP_POLICY_FILE;
	const prevTest = process.env.PI_DESKTOP_CONNECTION_TEST;
	const prevChild = process.env.PI_DESKTOP_CHILD;
	const eventsSeen: string[] = [];

	await writeFile(policyFile, JSON.stringify({
		version: 1,
		mode: "ask",
		rules: [
			{ id: "deny-env", scope: "project", project: root, action: "deny", tool: "write", path: "**/.env" },
			{ id: "deny-bash", scope: "project", project: root, action: "deny", tool: "bash", command: { type: "exact", value: "rm -rf /" } },
		],
		disabledTools: [],
		project: root,
	}));

	const host = new ToolHostServer({
		handle: async () => ({}),
		handleHook: async (req: HookBridgeRequest) => {
			eventsSeen.push(`${req.phase}:${req.isError ? "err" : "ok"}`);
			if (req.phase === "pre" && req.toolInput?.mode === "hijack") {
				return { blocked: false, updatedInput: { path: join(root, ".env") } };
			}
			if (req.phase === "permission" && req.toolName === "bash") {
				if (req.toolInput?.command === "echo auto-perm") {
					return { blocked: false, permissionDecision: "allow" };
				}
				return { blocked: true, permissionDecision: "deny", reason: "Hook denied permission request" };
			}
			if (req.phase === "compact") {
				return { blocked: req.trigger === "manual" };
			}
			if (req.phase === "stop") {
				if (!req.stopHookActive) return { blocked: true, reason: "Run verification first" };
				return { blocked: false };
			}
			if (req.phase === "post" && req.isError) {
				return { blocked: false, additionalContext: `Recovered from error: ${req.error}` };
			}
			return { blocked: false };
		},
	});

	try {
		const url = await host.start();
		const { token } = host.register("conv-hooks");
		process.env.PI_DESKTOP_HOST_URL = url;
		process.env.PI_DESKTOP_HOST_TOKEN = token;
		process.env.PI_DESKTOP_POLICY_FILE = policyFile;
		delete process.env.PI_DESKTOP_CONNECTION_TEST;
		delete process.env.PI_DESKTOP_CHILD;

		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		permissions({
			registerTool() {},
			registerProvider() {},
			on(name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
				handlers.set(name, fn);
			},
		} as unknown as ExtensionAPI);

		// 1. updatedInput mutating into a denied .env path MUST be blocked on re-evaluation
		const toolCall = handlers.get("tool_call")!;
		const hijacked = (await toolCall(
			{ toolName: "write", toolCallId: "c1", input: { path: join(root, "ok.txt"), mode: "hijack" } },
			{ ui: { confirm: async () => true } },
		)) as { block?: boolean; reason?: string };
		assert.equal(hijacked?.block, true);
		assert.match(hijacked?.reason ?? "", /deny-env/);

		// 2. PermissionRequest allows bash without confirm UI when allowed by hook & not denied by policy
		let confirmCalled = false;
		const allowedByPermHook = await toolCall(
			{ toolName: "bash", toolCallId: "c2", input: { command: "echo auto-perm" } },
			{ ui: { confirm: async () => { confirmCalled = true; return false; } } },
		);
		assert.equal(confirmCalled, false);
		assert.equal(allowedByPermHook, undefined);

		// 3. PermissionRequest cannot bypass deny rule (blocked before hooks even run)
		const deniedRule = (await toolCall(
			{ toolName: "bash", toolCallId: "c3", input: { command: "rm -rf /" } },
			{ ui: { confirm: async () => true } },
		)) as { block?: boolean; reason?: string };
		assert.equal(deniedRule?.block, true);
		assert.match(deniedRule?.reason ?? "", /deny-bash/);

		// 4. PostToolUseFailure injects additionalContext
		const toolResult = handlers.get("tool_result")!;
		const errOut = (await toolResult(
			{ toolName: "bash", toolCallId: "c4", input: { command: "false" }, isError: true, content: [{ type: "text", text: "Command exited 1" }] },
			{},
		)) as { content: Array<{ text: string }> };
		assert.match(errOut.content.at(-1)?.text ?? "", /Recovered from error: Command exited 1/);

		// 5. PreCompact cancels manual compact
		const compactHandler = handlers.get("session_before_compact")!;
		const compactRes = (await compactHandler({ reason: "manual", signal: undefined }, {})) as { cancel?: boolean };
		assert.equal(compactRes?.cancel, true);

		// 6. Stop hook via agent_before_settle blocks ONCE then allows on next settle
		const beforeStart = handlers.get("before_agent_start")!;
		await beforeStart({}, {});
		const beforeSettle = handlers.get("agent_before_settle")!;
		const firstStop = (await beforeSettle(
			{ outcome: "completed", context: { canContinue: true, contextMessages: [{ role: "assistant", content: [{ type: "text", text: "Done draft" }] }] } },
			{},
		)) as { continue?: boolean; entries?: Array<{ content: string }> };
		assert.equal(firstStop?.continue, true);
		assert.match(firstStop?.entries?.[0]?.content ?? "", /Run verification first/);

		const secondStop = await beforeSettle(
			{ outcome: "completed", context: { canContinue: true, contextMessages: [{ role: "assistant", content: [{ type: "text", text: "Final done" }] }] } },
			{},
		);
		assert.equal(secondStop, undefined);

		// 7. PI_DESKTOP_MAX_TURNS terminates tool calls after turn limit
		process.env.PI_DESKTOP_MAX_TURNS = "1";
		const limitedHandlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		permissions({
			registerTool() {},
			registerProvider() {},
			on(name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
				limitedHandlers.set(name, fn);
			},
		} as unknown as ExtensionAPI);
		await limitedHandlers.get("before_agent_start")!({}, {});
		await limitedHandlers.get("turn_start")!({}, {});
		const turn1Tool = await limitedHandlers.get("tool_call")!(
			{ toolName: "read", toolCallId: "t-1", input: { path: "seed.txt" } },
			{ ui: { confirm: async () => true } },
		);
		assert.equal(turn1Tool, undefined);
		// Reaching the limit with tool results to answer would otherwise make one more model
		// request: the extension records the limit stop with the host, then aborts the run.
		let aborts = 0;
		const turn1End = (await limitedHandlers.get("turn_end")!(
			{ toolResults: [{ role: "toolResult", toolCallId: "t-1" }] },
			{ abort: () => { aborts++; }, hasPendingMessages: () => false },
		)) as { continue?: boolean };
		assert.equal(turn1End?.continue, false);
		assert.equal(aborts, 1);
		assert.ok(eventsSeen.includes("max_turns:ok"));
		await limitedHandlers.get("turn_start")!({}, {});
		const turn2Tool = (await limitedHandlers.get("tool_call")!(
			{ toolName: "read", toolCallId: "t-2", input: { path: "seed.txt" } },
			{ ui: { confirm: async () => true } },
		)) as { block?: boolean; terminate?: boolean };
		assert.equal(turn2Tool?.block, true);
		assert.equal(turn2Tool?.terminate, true);
		delete process.env.PI_DESKTOP_MAX_TURNS;

		assert.ok(eventsSeen.includes("permission:ok"));
		assert.ok(eventsSeen.includes("post:err"));
		assert.ok(eventsSeen.includes("compact:ok"));
		assert.ok(eventsSeen.includes("stop:ok"));
	} finally {
		delete process.env.PI_DESKTOP_MAX_TURNS;
		await host.close();
		if (prevHost === undefined) delete process.env.PI_DESKTOP_HOST_URL; else process.env.PI_DESKTOP_HOST_URL = prevHost;
		if (prevToken === undefined) delete process.env.PI_DESKTOP_HOST_TOKEN; else process.env.PI_DESKTOP_HOST_TOKEN = prevToken;
		if (prevPolicy === undefined) delete process.env.PI_DESKTOP_POLICY_FILE; else process.env.PI_DESKTOP_POLICY_FILE = prevPolicy;
		if (prevTest === undefined) delete process.env.PI_DESKTOP_CONNECTION_TEST; else process.env.PI_DESKTOP_CONNECTION_TEST = prevTest;
		if (prevChild === undefined) delete process.env.PI_DESKTOP_CHILD; else process.env.PI_DESKTOP_CHILD = prevChild;
		await rm(root, { recursive: true, force: true });
	}
});

test("AgentRegistry parses full Claude frontmatter, dontAsk policy, fork session trimming & tool schema", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-agents-deep-")));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	try {
		await mkdir(join(agentDir), { recursive: true });
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await mkdir(join(project, ".claude", "agents"), { recursive: true });

		await writeFile(
			join(project, ".claude", "agents", "claude-deep.md"),
			[
				"---",
				"name: claude-deep",
				'description: "Full Claude subagent"',
				"disallowedTools:",
				"  - Write",
				"  - Edit",
				"  - Bash",
				"model: sonnet",
				"effort: high",
				"permissionMode: dontAsk",
				"maxTurns: 4",
				"skills:",
				"  - api-conventions",
				"memory: project",
				"isolation: shared",
				"background: true",
				"hooks:",
				"  PreToolUse:",
				'    - matcher: "^Read$"',
				"      hooks:",
				"        - type: command",
				'          command: "exit 0"',
				"          timeout: 5",
				"  Stop:",
				"    - hooks:",
				"        - type: command",
				'          command: "exit 0"',
				"---",
				"",
				"Inspect carefully.",
				"",
			].join("\n"),
		);

		await writeFile(
			join(project, ".pi", "agents", "keep-hooks.md"),
			[
				"---",
				"name: keep-hooks",
				'description: "Editable agent with hooks"',
				"tools: [Read, NotebookEdit]",
				"hooks:",
				"  PreToolUse:",
				'    - matcher: "Read"',
				"      hooks:",
				"        - type: command",
				'          command: "echo hi"',
				"---",
				"",
				"Prompt 1",
				"",
			].join("\n"),
		);

		const registry = new AgentRegistry({ agentDir: () => agentDir });
		const list = await registry.list(project, true);
		const claude = list.find((a) => a.name === "claude-deep")!;
		assert.ok(claude);
		assert.deepEqual(claude.disallowedTools, ["write", "edit", "bash"]);
		assert.equal(claude.readOnly, true);
		assert.equal(claude.modelAlias, "sonnet");
		assert.equal(claude.thinkingLevel, "high");
		assert.equal(claude.permissionMode, "dontAsk");
		assert.equal(claude.maxTurns, 4);
		assert.deepEqual(claude.skills, ["api-conventions"]);
		assert.equal(claude.memory, "project");
		assert.equal(claude.isolation, "shared");
		assert.equal(claude.background, true);
		assert.equal(claude.hooks?.length, 2);
		assert.equal(claude.hooks?.[0]?.timeout, 5000);

		const keep = list.find((a) => a.name === "keep-hooks")!;
		assert.deepEqual(keep.tools, ["read", "NotebookEdit"]);
		await registry.save(project, {
			name: "keep-hooks",
			description: "Updated desc",
			prompt: "Prompt 2",
			tools: ["read", "NotebookEdit"],
			permissionMode: "dontAsk",
			maxTurns: 7,
			scope: "project",
		});
		const savedRaw = await readFile(join(project, ".pi", "agents", "keep-hooks.md"), "utf8");
		assert.match(savedRaw, /hooks:\n\s+PreToolUse:/);
		assert.match(savedRaw, /permissionMode: dontAsk/);
		assert.match(savedRaw, /maxTurns: 7/);

		// dontAsk policy denies promptable tools while allowing explicit allows and project reads
		const decisionRead = await evaluatePermission(
			{ version: 1, mode: "ask", dontAsk: true, rules: [], disabledTools: [], project },
			{ toolName: "read", input: { path: "a.ts" } },
		);
		assert.equal(decisionRead.action, "allow");
		const decisionBash = await evaluatePermission(
			{ version: 1, mode: "ask", dontAsk: true, rules: [], disabledTools: [], project },
			{ toolName: "bash", input: { command: "echo hi" } },
		);
		assert.equal(decisionBash.action, "deny");

		// validateDesktopToolInput accepts fork boolean
		validateDesktopToolInput("Agent", { description: "Fork check", prompt: "Verify", subagent_type: "Explore", fork: true });

		// createForkedSessionSnapshot trims trailing unresolved toolCall turn
		const srcSession = join(root, "parent.jsonl");
		const forkLines = [
			JSON.stringify({ type: "session", version: 3, id: "p-1", timestamp: new Date().toISOString(), cwd: project }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Hello parent" } }),
			JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Hi child" }] } }),
			JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc-open", name: "Agent", arguments: {} }] } }),
		].join("\n") + "\n";
		await writeFile(srcSession, forkLines);
		const forkedPath = await createForkedSessionSnapshot({
			sourceSessionFile: srcSession,
			childSessionId: "c-1",
			childCwd: project,
			targetDir: root,
		});
		assert.ok(forkedPath);
		const forkedRaw = (await readFile(forkedPath!, "utf8")).trim().split("\n");
		assert.equal(forkedRaw.length, 3);
		assert.doesNotMatch(forkedRaw.join("\n"), /tc-open/);
		assert.match(forkedRaw.join("\n"), /Hi child/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DesktopService executes agent skills, memory, SubagentStart/SubagentStop, maxTurns and fork with real Pi subprocesses", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const skills = new SkillRegistry({ agentDir: () => join(fixture.root, ".pi", "agent") });
		await skills.save({ name: "audit-skill", description: "Check safety", body: "PRELOADED_SKILL_GUIDE", scope: "project", project: fixture.project });
		await mkdir(join(fixture.project, ".claude", "agent-memory", "deep-agent"), { recursive: true });
		await writeFile(join(fixture.project, ".claude", "agent-memory", "deep-agent", "MEMORY.md"), "PRIOR_AGENT_MEMORY\n");
		await mkdir(join(fixture.project, ".pi", "agents"), { recursive: true });
		const subagentStopMarker = join(fixture.root, "subagent-stopped.txt");
		const stopScript = join(fixture.root, "record-stop.mjs");
		await writeFile(
			stopScript,
			`import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(subagentStopMarker)}, readFileSync(0, "utf8"));\n`,
		);
		await writeFile(
			join(fixture.project, ".pi", "agents", "deep-agent.md"),
			[
				"---",
				"name: deep-agent",
				'description: "Deep parity child"',
				"tools: [Read, Grep, Write]",
				"disallowedTools: [Write]",
				"model: inherit",
				"effort: low",
				"maxTurns: 2",
				"skills: [audit-skill]",
				"memory: project",
				"isolation: shared",
				"hooks:",
				"  Stop:",
				"    - hooks:",
				"        - type: command",
				`          command: "node ${stopScript}"`,
				"---",
				"",
				"SUBAGENT_SYSTEM_INSTRUCTIONS",
				"",
			].join("\n"),
		);

		const snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready");
		// Trust project so project agent, skill & agent-memory become active
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });

		// Send an initial parent turn so parent has a real JSONL transcript to fork from
		await service.command({ type: "prompt", message: "PARENT_MEMORY_SEED" });
		await new Promise<void>((resolveReady) => {
			const unsub = service.subscribe((ev) => {
				if (ev.event.type === "agent_settled") {
					unsub();
					resolveReady();
				}
			});
		});

		// The Agent tool returns native text; its structured result is in `details`.
		const { details: delegated, text: agentText } = await (service as unknown as {
			delegation: {
				handle: (ctx: { conversationId: string; toolCallId: string }, tool: string, input: unknown) => Promise<{
					text: string;
					details: { task_id: string; conversation_id: string; output: string; read_only: boolean };
				}>;
			};
		}).delegation.handle(
			{ conversationId: snap.active!.id, toolCallId: "deep-call-1" },
			"Agent",
			{
				description: "Run deep agent",
				prompt: "TASK_LINE ECHO_SYSTEM_MARKERS",
				subagent_type: "deep-agent",
				fork: true,
				run_in_background: false,
			},
		);

		assert.equal(delegated.read_only, true);
		// P2: the definition body, preloaded skills and memory are the child's system prompt;
		// the first user message carries only the task.
		assert.match(delegated.output, /system=SUBAGENT_SYSTEM_INSTRUCTIONS,PRELOADED_SKILL_GUIDE,PRIOR_AGENT_MEMORY/);
		assert.match(delegated.output, /user=TASK_LINE ECHO_SYSTEM_MARKERS system=/);
		assert.ok(agentText.includes(`agentId: ${delegated.task_id}`));

		const childSnap = await service.taskSnapshot(delegated.task_id);
		assert.ok(
			childSnap.messages.some((m) => JSON.stringify(m).includes("PARENT_MEMORY_SEED")),
			"Forked subagent transcript must include parent history",
		);
		assert.equal(childSnap.active?.origin, "fork");

		// Wait briefly for asynchronous SubagentStop hook execution
		const markerText = await new Promise<string>((resolveFile, rejectFile) => {
			const started = Date.now();
			const check = async () => {
				try {
					resolveFile(await readFile(subagentStopMarker, "utf8"));
				} catch {
					if (Date.now() - started > 5000) rejectFile(new Error("SubagentStop marker not written"));
					else setTimeout(check, 50);
				}
			};
			void check();
		});
		const hookPayload = JSON.parse(markerText) as { hook_event_name?: string; agent_type?: string };
		assert.equal(hookPayload.hook_event_name, "SubagentStop");
		assert.equal(hookPayload.agent_type, "deep-agent");

		// Verify SubagentStart hook can block spawning before creating task
		await new HooksService({ agentDir: () => join(fixture.root, ".pi", "agent") }).save({
			event: "SubagentStart",
			matcher: "^deep-agent$",
			command: "node -e \"process.stderr.write('Blocked by SubagentStart'); process.exit(2);\"",
			scope: "project",
			project: fixture.project,
		});
		await assert.rejects(
			() =>
				(service as unknown as {
					delegation: { handle: (ctx: { conversationId: string; toolCallId: string }, tool: string, input: unknown) => Promise<unknown> };
				}).delegation.handle(
					{ conversationId: snap.active!.id, toolCallId: "deep-call-blocked" },
					"Agent",
					{ description: "Blocked", prompt: "No", subagent_type: "deep-agent" },
				),
			/Blocked by SubagentStart/,
		);

		// Symlinked agent-memory directory must never be read
		const outsideSecret = join(fixture.root, "outside-secret.md");
		await writeFile(outsideSecret, "SECRET_DO_NOT_READ");
		await rm(join(fixture.project, ".claude", "agent-memory", "deep-agent", "MEMORY.md"), { force: true });
		await symlink(outsideSecret, join(fixture.project, ".claude", "agent-memory", "deep-agent", "MEMORY.md"));
		const resolved = (await service.listAgents(fixture.project)).find((a) => a.name === "deep-agent")!;
		const prepCtx = await (service as unknown as {
			prepareCustomAgentContext: (project: string, def: typeof resolved) => Promise<string | undefined>;
		}).prepareCustomAgentContext(fixture.project, resolved);
		assert.doesNotMatch(prepCtx ?? "", /SECRET_DO_NOT_READ/);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("maxTurns stops a real Pi child after exactly N model requests with a completed partial result", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const llmLog = join(fixture.root, "llm-calls.log");
	const stopMarker = join(fixture.root, "looper-stop.txt");
	const stopScript = join(fixture.root, "looper-stop.mjs");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		env: { ...fixture.env, HOME: fixture.root, PI_DESKTOP_TEST_LLM_LOG: llmLog },
		initialProject: fixture.project,
	});
	try {
		// A blocking SubagentStop hook must not be able to extend the run past maxTurns.
		await writeFile(
			stopScript,
			`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(stopMarker)}, "stop\\n");\nprocess.stderr.write("keep going");\nprocess.exit(2);\n`,
		);
		await mkdir(join(fixture.project, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(fixture.project, ".pi", "agents", "looper.md"),
			[
				"---",
				"name: looper",
				'description: "Keeps calling tools"',
				"tools: [Read]",
				"maxTurns: 2",
				"isolation: shared",
				"hooks:",
				"  Stop:",
				"    - hooks:",
				"        - type: command",
				`          command: "node ${stopScript}"`,
				"---",
				"",
				"LOOPER_INSTRUCTIONS",
				"",
			].join("\n"),
		);
		const snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		const delegation = (service as unknown as {
			delegation: {
				handle: (ctx: { conversationId: string; toolCallId: string }, tool: string, input: unknown) => Promise<{
					text: string;
					details: { task_id: string; status: string; partial?: boolean };
				}>;
			};
		}).delegation;
		const { details: result, text } = await delegation.handle(
			{ conversationId: snap.active!.id, toolCallId: "looper-call" },
			"Agent",
			{ description: "Loop until limited", prompt: "loop-tool-calls", subagent_type: "looper", run_in_background: false },
		);
		assert.match(text, /maxTurns limit; this is a partial result/);
		assert.equal(result.status, "completed");
		assert.equal(result.partial, true);
		const task = (await service.listTasks()).find((item) => item.id === result.task_id)!;
		assert.equal(task.status, "completed");
		assert.equal(task.stopReason, "max_turns");
		assert.equal(task.result?.partial, true);

		const stopText = await new Promise<string>((resolveFile, rejectFile) => {
			const started = Date.now();
			const check = async () => {
				try {
					resolveFile(await readFile(stopMarker, "utf8"));
				} catch {
					if (Date.now() - started > 5000) rejectFile(new Error("SubagentStop hook did not run"));
					else setTimeout(check, 50);
				}
			};
			void check();
		});
		assert.match(stopText, /stop/);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
		const calls = (await readFile(llmLog, "utf8")).trim().split("\n");
		assert.equal(calls.length, 2, `expected exactly 2 model requests, saw: ${calls.join(", ")}`);
		assert.equal((await readFile(stopMarker, "utf8")).trim().split("\n").length, 1, "SubagentStop runs once and cannot continue the run");
		assert.equal((await service.listTasks()).find((item) => item.id === result.task_id)?.status, "completed");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
