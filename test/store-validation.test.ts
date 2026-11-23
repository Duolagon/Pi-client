import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService, piToolArgs } from "../src/backend.ts";
import { MAX_AGENT_OUTPUT, MAX_PENDING_MESSAGE, MAX_TASK_ERROR, MAX_TURN_CALLS, TOOL_NAME_PATTERN } from "../src/delegation-limits.ts";
import type { DesktopTask } from "../src/task-types.ts";
import { sanitizeStoredTasks, validateTask } from "../src/task-validation.ts";

const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
/** Hooks, agents and settings come from a temporary directory, never the user's Pi configuration. */
function isolatedEnv(root: string): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" };
}
function service(dataDir: string, root: string): DesktopService {
	return new DesktopService({
		dataDir,
		executable: process.execPath,
		historyEntry: join(source, "session-history-entry.ts"),
		env: isolatedEnv(root),
	});
}

const policy = (project: string) => ({ version: 1, mode: "ask", rules: [], disabledTools: ["Agent", "AgentSend"], project });

function baseTask(id: string, project: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id, conversationId: id, project, workingDirectory: project, title: id, prompt: "do work",
		status: "completed", createdAt: 1, updatedAt: 2, revision: 3, ...extra,
	};
}
function child(id: string, project: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return baseTask(id, project, {
		parentConversationId: "parent", parentToolCallId: `call-${id}`, subagentType: "general-purpose",
		delegationDepth: 1, readOnly: false, runInBackground: true, ...extra,
	});
}

async function seededStore() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-store-validation-")));
	const project = join(root, "project");
	const dataDir = join(root, "desktop");
	await mkdir(project);
	await mkdir(dataDir);
	const ids = ["parent", "good", "comma-tools", "huge-turns", "forged-parent", "mismatch", "cycle-a", "cycle-b", "big-result", "bad-status", "manual"];
	const conversations = ids.map((id) => ({ id, title: id, project, updatedAt: 1 }));
	const tasks = [
		child("good", project, { allowedTools: ["read", "grep"], disallowedTools: ["grep"], maxTurns: 5, injected: "--no-sandbox" }),
		child("comma-tools", project, { allowedTools: ["read,bash", "write"] }),
		child("huge-turns", project, { maxTurns: 1e9 }),
		child("forged-parent", project, { parentConversationId: "not-a-conversation" }),
		{ ...child("mismatch", project), conversationId: "parent" },
		child("cycle-a", project, { parentConversationId: "cycle-b" }),
		child("cycle-b", project, { parentConversationId: "cycle-a" }),
		child("big-result", project, { result: { text: "x".repeat(MAX_AGENT_OUTPUT + 1), truncated: false } }),
		child("bad-status", project, { status: "root" }),
		baseTask("manual", project),
	];
	const taskPolicies: Record<string, unknown> = Object.fromEntries(
		["good", "comma-tools", "huge-turns", "forged-parent", "cycle-a", "cycle-b", "big-result", "bad-status", "orphan", "manual"].map((id) => [id, policy(project)]),
	);
	await writeFile(join(dataDir, "desktop.json"), JSON.stringify({
		projects: [{ path: project, name: "project" }],
		conversations,
		settings: { permission: "ask", theme: "light", connections: {} },
		keys: {},
		tasks,
		taskPolicies,
	}));
	await mkdir(join(root, "agent"));
	return { root, project, dataDir, tasks, taskPolicies, conversations, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const quarantinedIds = ["comma-tools", "huge-turns", "forged-parent", "mismatch", "cycle-a", "bad-status"];

test("Plan sessions can submit a plan while task tool restrictions remain enforced", () => {
	const tools = (task: Parameters<typeof piToolArgs>[0], mode: "plan" | "read") => piToolArgs(task, mode)[1].split(",");
	assert.ok(tools(undefined, "plan").includes("ExitPlanMode"));
	assert.ok(!tools(undefined, "plan").includes("bash"));
	assert.ok(!tools(undefined, "read").includes("ExitPlanMode"));
	assert.ok(!tools({ allowedTools: ["read"] }, "plan").includes("ExitPlanMode"));
	assert.deepEqual(tools({ allowedTools: ["read", "ExitPlanMode"] }, "plan"), ["read", "ExitPlanMode"]);
	assert.ok(!tools({ disallowedTools: ["ExitPlanMode"] }, "plan").includes("ExitPlanMode"));
});

test("tampered delegated records are quarantined read-only instead of becoming root conversations", async () => {
	const seeded = await seededStore();
	try {
		const result = sanitizeStoredTasks(
			seeded.tasks,
			new Map(seeded.conversations.map((item) => [item.id, item.project])),
			seeded.taskPolicies,
		);
		assert.deepEqual(result.tasks.map((task) => task.id), [
			"good", "comma-tools", "huge-turns", "forged-parent", "mismatch", "cycle-a", "cycle-b", "big-result", "bad-status", "manual",
		]);
		const byId = new Map(result.tasks.map((task) => [task.id, task]));
		for (const id of quarantinedIds) {
			const task = byId.get(id)!;
			assert.equal(task.quarantined, true, id);
			assert.equal(task.readOnly, true, id);
			assert.equal(task.permissionMode, "read", id);
			assert.equal(task.conversationId, id, "a quarantined record only restricts its own conversation");
			assert.equal(task.allowedTools, undefined, "invalid tool lists are never carried over");
			assert.equal(task.maxTurns, undefined);
			assert.notEqual(task.status, "running");
		}
		assert.equal(byId.get("bad-status")!.status, "interrupted");
		assert.equal(byId.get("comma-tools")!.parentConversationId, "parent", "a valid parent link is kept");
		assert.equal(byId.get("forged-parent")!.parentConversationId, undefined, "a forged parent link is never kept");
		assert.equal(byId.get("cycle-a")!.parentConversationId, undefined, "a cycle is broken at the quarantined record");
		assert.equal(byId.get("cycle-b")!.parentConversationId, "cycle-a", "the other end now inherits the quarantined read-only ceiling");
		// Display-only fields are repaired instead of failing the record.
		const bigResult = byId.get("big-result")!;
		assert.equal(bigResult.quarantined, undefined);
		assert.equal(bigResult.result!.text.length, MAX_AGENT_OUTPUT);
		assert.equal(bigResult.result!.truncated, true);
		assert.deepEqual(Object.keys(result.taskPolicies).sort(), ["bad-status", "big-result", "comma-tools", "cycle-b", "good", "huge-turns"]);
		assert.equal(result.dropped.length, 6 + 4, result.dropped.join("\n"));
		const good = byId.get("good")!;
		assert.equal((good as unknown as Record<string, unknown>).injected, undefined, "unknown fields are not carried over");
		assert.deepEqual(good.allowedTools, ["read", "grep"]);
		assert.equal(good.maxTurns, 5);
		// Generated Pi arguments only ever contain validated tool names.
		const args = piToolArgs(good, "ask");
		assert.deepEqual(args, ["--tools", "read"]);
		for (const task of result.tasks) {
			const tools = piToolArgs(task, task.quarantined ? "read" : "ask");
			if (tools.length) for (const name of tools[1].split(",").filter(Boolean)) assert.match(name, TOOL_NAME_PATTERN);
		}
		// Without project paths a record whose own project is invalid cannot be rebuilt and is dropped.
		const noProject = sanitizeStoredTasks([child("x", "relative/path")], new Set(["parent", "x"]), {});
		assert.equal(noProject.tasks.length, 0);
		assert.throws(() => validateTask(seeded.tasks[1], new Set(["parent", "comma-tools"])), /allowedTools/);
		assert.throws(() => validateTask(seeded.tasks[2], new Set(["parent", "huge-turns"])), /maxTurns/);
		assert.throws(() => validateTask(seeded.tasks[3], new Set(["parent", "forged-parent"])), /parentConversationId/);
		assert.throws(() => validateTask({ ...child("x", seeded.project), delegationDepth: 4 }, new Set(["parent", "x"])), /delegationDepth/);
		assert.throws(() => validateTask({ ...child("x", seeded.project), stopReason: "admin" }, new Set(["parent", "x"])), /stopReason/);
		assert.throws(() => validateTask(baseTask("x", "relative/path"), new Set(["x"])), /project/);
		// A damaged manual task has no delegation marker and is simply dropped.
		const manual = sanitizeStoredTasks([baseTask("m", seeded.project, { status: "root" })], new Map([["m", seeded.project]]), {});
		assert.equal(manual.tasks.length, 0);
	} finally {
		await seeded.cleanup();
	}
});

test("over-long display fields written by the host load without dropping the child or its policy", () => {
	const project = "/project";
	const conversations = new Map([["parent", project], ["explore", project], ["model", project]]);
	const explorePolicy = { version: 1, mode: "read", rules: [], disabledTools: ["Agent", "AgentSend"], project };
	const result = sanitizeStoredTasks([
		child("explore", project, {
			readOnly: true, subagentType: "Explore", status: "failed", error: "e".repeat(70 * 1024), title: "t".repeat(2000),
		}),
		child("model", project, { model: { provider: "p", id: "m".repeat(400) } }),
		child("model", project, { model: { provider: "p", id: "m".repeat(600) } }),
	], conversations, { explore: explorePolicy });
	const explore = result.tasks.find((task) => task.id === "explore")!;
	assert.equal(explore.quarantined, undefined);
	assert.equal(explore.readOnly, true);
	assert.equal(explore.error!.length, MAX_TASK_ERROR);
	assert.equal(explore.title.length, 1000);
	assert.equal(result.taskPolicies.explore.mode, "read");
	assert.equal(result.tasks.find((task) => task.id === "model")!.model!.id.length, 400, "IPC accepts 500-character model ids");
	assert.equal(result.dropped.length, 1, "only the duplicate record is reported");
	const tooLong = sanitizeStoredTasks([child("model", project, { model: { provider: "p", id: "m".repeat(600) } })], conversations, {});
	assert.equal(tooLong.tasks[0].model, undefined, "a malformed model selection falls back to the default model");
	assert.equal(tooLong.tasks[0].quarantined, undefined);
});

test("DesktopService quarantines tampered children on load, keeps them read-only and persists the restriction", async () => {
	const seeded = await seededStore();
	let desktop = service(seeded.dataDir, seeded.root);
	try {
		const snapshot = await desktop.initialize();
		assert.match(snapshot.engineError ?? "", /已丢弃或隔离 \d+ 条格式无效的后台任务记录/);
		const tasks = await desktop.listTasks();
		assert.equal(tasks.length, 10);
		for (const id of quarantinedIds) {
			const effective = (await desktop.permissionSettings(id)).effective;
			assert.equal(effective.mode, "read", id);
			assert.ok(effective.disabledTools.includes("Agent") && effective.disabledTools.includes("AgentSend"), id);
		}
		await desktop.close();
		const stored = JSON.parse(await readFile(join(seeded.dataDir, "desktop.json"), "utf8")) as {
			tasks: Array<Record<string, unknown>>;
			taskPolicies: Record<string, unknown>;
		};
		assert.deepEqual(stored.tasks.filter((task) => task.quarantined).map((task) => task.id).sort(), [...quarantinedIds].sort());
		assert.deepEqual(Object.keys(stored.taskPolicies).sort(), ["bad-status", "big-result", "comma-tools", "cycle-b", "good", "huge-turns"]);
		const serialized = JSON.stringify(stored);
		assert.doesNotMatch(serialized, /read,bash|1000000000|not-a-conversation|--no-sandbox/);
		// The restriction survives a second load unchanged.
		desktop = service(seeded.dataDir, seeded.root);
		const reloaded = await desktop.initialize();
		assert.equal(reloaded.engineError, undefined);
		assert.equal((await desktop.permissionSettings("forged-parent")).effective.mode, "read");
	} finally {
		await desktop.close().catch(() => {});
		await seeded.cleanup();
	}
});

test("a long host-written task error is truncated so the child keeps its ceiling after a restart", async () => {
	const seeded = await seededStore();
	let desktop = service(seeded.dataDir, seeded.root);
	try {
		await desktop.initialize();
		const internal = desktop as unknown as {
			store: { tasks: DesktopTask[]; taskPolicies: Record<string, { mode: string }> };
			updateTask(task: DesktopTask, status: DesktopTask["status"], error?: string, stopReason?: string): void;
		};
		const good = internal.store.tasks.find((task) => task.id === "good")!;
		good.readOnly = true;
		internal.store.taskPolicies.good.mode = "read";
		// A blocking hook keeps up to 256 KiB of stderr as its reason.
		internal.updateTask(good, "failed", `${"x".repeat(MAX_TASK_ERROR - 1)}\u{1F600}${"y".repeat(200 * 1024)}`, "error");
		assert.equal(good.error!.length, MAX_TASK_ERROR - 1, "a surrogate pair is never split");
		await desktop.close();
		desktop = service(seeded.dataDir, seeded.root);
		await desktop.initialize();
		const reloaded = (await desktop.listTasks()).find((task) => task.id === "good")!;
		assert.equal(reloaded.parentConversationId, "parent");
		assert.equal(reloaded.quarantined, undefined);
		assert.equal(reloaded.status, "failed");
		const effective = (await desktop.permissionSettings("good")).effective;
		assert.equal(effective.mode, "read");
		assert.ok(effective.disabledTools.includes("Agent"));
	} finally {
		await desktop.close().catch(() => {});
		await seeded.cleanup();
	}
});

test("a child interrupted by a crash keeps its partial output from the saved transcript", async () => {
	const seeded = await seededStore();
	const raw = JSON.parse(await readFile(join(seeded.dataDir, "desktop.json"), "utf8"));
	const sessions = join(seeded.dataDir, "sessions");
	await mkdir(sessions);
	const timestamp = "2026-01-02T03:04:05.000Z";
	const lines = [
		{ type: "session", version: 3, id: "good", timestamp, cwd: seeded.project },
		{ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "investigate", timestamp: 1 } },
		{
			type: "message", id: "a1", parentId: "u1", timestamp,
			message: {
				role: "assistant", content: [{ type: "text", text: "partial findings so far" }], timestamp: 2,
				api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		},
	];
	// No sessionFile is recorded: the host locates the child transcript by its session id.
	await writeFile(join(sessions, "2026-01-02_good.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	raw.tasks[0].status = "running";
	await writeFile(join(seeded.dataDir, "desktop.json"), JSON.stringify(raw));
	const desktop = service(seeded.dataDir, seeded.root);
	try {
		await desktop.initialize();
		const result = await desktop.delegatedTaskResult("good");
		assert.equal(result.status, "interrupted");
		assert.equal(result.output, "partial findings so far");
		assert.equal(result.partial, true);
		const task = (await desktop.listTasks()).find((item) => item.id === "good")!;
		assert.equal(task.stopReason, "restart");
		await desktop.close();
		const stored = JSON.parse(await readFile(join(seeded.dataDir, "desktop.json"), "utf8")) as { tasks: DesktopTask[] };
		assert.equal(stored.tasks.find((item) => item.id === "good")!.result?.text, "partial findings so far");
	} finally {
		await desktop.close().catch(() => {});
		await seeded.cleanup();
	}
});

test("a requested fork fails loudly and leaves no conversation or worktree behind", async () => {
	const seeded = await seededStore();
	// Point the parent at a session file that no longer exists.
	const raw = JSON.parse(await readFile(join(seeded.dataDir, "desktop.json"), "utf8"));
	raw.conversations[0].sessionFile = join(seeded.dataDir, "sessions", "deleted-parent.jsonl");
	await writeFile(join(seeded.dataDir, "desktop.json"), JSON.stringify(raw));
	const desktop = service(seeded.dataDir, seeded.root);
	try {
		await desktop.initialize();
		const before = (await desktop.snapshot()).conversations.length;
		const tasksBefore = (await desktop.listTasks()).length;
		await assert.rejects(
			desktop.startTask({ project: seeded.project, message: "fork me", isolation: "shared", forkParentConversationId: "parent" }),
			/Fork failed/,
		);
		assert.equal((await desktop.snapshot()).conversations.length, before);
		assert.equal((await desktop.listTasks()).length, tasksBefore);
	} finally {
		await desktop.close();
		await seeded.cleanup();
	}
});

test("a failed fork into a new worktree removes the worktree after SubagentStart ran", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-fork-worktree-")));
	const project = join(root, "project");
	const dataDir = join(root, "desktop");
	const marker = join(root, "subagent-start.json");
	await mkdir(project);
	await mkdir(dataDir);
	await mkdir(join(root, "agent"));
	await exec("git", ["init", project]);
	await writeFile(join(project, "seed.txt"), "seed\n");
	await exec("git", ["add", "seed.txt"], { cwd: project });
	await exec("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "seed"], { cwd: project });
	await writeFile(join(dataDir, "desktop.json"), JSON.stringify({
		projects: [{ path: project, name: "project" }],
		conversations: [{ id: "parent", title: "parent", project, updatedAt: 1, sessionFile: join(dataDir, "sessions", "missing.jsonl") }],
		settings: { permission: "ask", theme: "light", connections: {} },
		keys: {},
		tasks: [],
	}));
	const desktop = service(dataDir, root);
	try {
		await desktop.initialize();
		await desktop.saveHook({
			event: "SubagentStart",
			scope: "user",
			command: `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'started')" "${marker}"`,
		});
		const conversations = (await desktop.snapshot()).conversations.length;
		const worktrees = (await desktop.listWorktrees()).length;
		await assert.rejects(
			desktop.startTask(
				{ project, message: "fork me", isolation: "worktree", forkParentConversationId: "parent" },
				{ parentConversationId: "parent", parentToolCallId: "call-fork", subagentType: "general-purpose", delegationDepth: 1, readOnly: false, runInBackground: true },
			),
			/Fork failed/,
		);
		assert.equal(await readFile(marker, "utf8"), "started", "SubagentStart ran before the fork failed");
		assert.equal((await desktop.listWorktrees()).length, worktrees, "the new worktree was removed");
		assert.equal((await desktop.snapshot()).conversations.length, conversations);
		assert.equal((await desktop.listTasks()).length, 0);
		const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: project });
		assert.equal(stdout.match(/^worktree /gm)?.length, 1, "git has no leftover worktree");
		const sessionFiles = await readdir(join(dataDir, "sessions")).catch(() => [] as string[]);
		assert.deepEqual(sessionFiles.filter((name) => name.startsWith("fork-")), [], "no fork session file was written");
	} finally {
		await desktop.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("outbox fields are validated and legacy finished records count as already delivered", () => {
	const conversations = new Set(["parent", "legacy-done", "legacy-running", "pending", "delivered", "bad-turn", "bad-notified", "bad-suppressed", "future-notified"]);
	const project = "/project";
	const { tasks, dropped } = sanitizeStoredTasks([
		child("legacy-done", project),
		child("legacy-running", project, { status: "running" }),
		child("pending", project, { turn: 2, notifiedTurn: 1 }),
		child("delivered", project, { turn: 1, notifiedTurn: 1, notifySuppressed: true }),
		child("bad-turn", project, { turn: 0 }),
		child("bad-notified", project, { turn: 1, notifiedTurn: "1" }),
		child("bad-suppressed", project, { turn: 1, notifySuppressed: "yes" }),
		child("future-notified", project, { turn: 1, notifiedTurn: 2 }),
	], conversations, {});
	const byId = new Map(tasks.map((task) => [task.id, task]));
	// An upgrade must not replay results that were delivered (or lost) before the outbox existed.
	assert.equal(byId.get("legacy-done")?.turn, 1);
	assert.equal(byId.get("legacy-done")?.notifiedTurn, 1);
	// A run that was still active is reported after its restart interruption.
	assert.equal(byId.get("legacy-running")?.turn, 1);
	assert.equal(byId.get("legacy-running")?.notifiedTurn, undefined);
	assert.equal(byId.get("pending")?.turn, 2);
	assert.equal(byId.get("pending")?.notifiedTurn, 1);
	assert.equal(byId.get("delivered")?.notifySuppressed, true);
	for (const id of ["bad-turn", "bad-notified", "bad-suppressed", "future-notified"]) {
		const task = byId.get(id);
		assert.ok(task?.quarantined, `${id} is quarantined`);
		assert.equal(task?.notifySuppressed, true, `${id} never notifies its parent`);
	}
	assert.equal(dropped.length, 4);
});

test("stored Agent names, usage and system prompt files are validated before they reach a child process", () => {
	const ids = new Set(["parent", "c1"]);
	const promptDir = "/data/agent-prompts";
	const stats = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.1, toolUses: 2, startedAt: 5, durationMs: 6 };
	const valid = validateTask(child("c1", "/project", { name: "builder", systemPromptFile: "/data/agent-prompts/c1.md", stats, statsAtTurnStart: { tokens: stats.tokens, cost: 0, toolCalls: 0, startedAt: 5 } }), ids, { promptDir });
	assert.equal(valid.name, "builder");
	assert.equal(valid.systemPromptFile, "/data/agent-prompts/c1.md");
	assert.deepEqual(valid.stats, stats);
	assert.equal(valid.statsAtTurnStart?.toolCalls, 0);
	// Another task's file, a path outside the private directory or a traversal are rejected.
	for (const file of ["/data/agent-prompts/other.md", "/etc/passwd", "/data/agent-prompts/../c1.md", "relative.md"])
		assert.throws(() => validateTask(child("c1", "/project", { systemPromptFile: file }), ids, { promptDir }), /systemPromptFile/);
	assert.throws(() => validateTask(child("c1", "/project", { name: "has space" }), ids, { promptDir }), /name/);
	// A manual task never carries delegation-only fields.
	assert.throws(() => validateTask(baseTask("c1", "/project", { systemPromptFile: "/data/agent-prompts/c1.md" }), ids, { promptDir }), /parentConversationId/);
	// Malformed usage is display data: it is dropped, the task is kept.
	const damaged = validateTask(child("c1", "/project", { stats: { ...stats, cost: -1 }, statsAtTurnStart: "x" }), ids, { promptDir });
	assert.equal(damaged.stats, undefined);
	assert.equal(damaged.statsAtTurnStart, undefined);
});

test("a resumed task's pending message and SendMessage call ids are validated on load", () => {
	const ids = new Set(["parent", "c1"]);
	const resumed = validateTask(child("c1", "/project", {
		status: "queued", turn: 3, pendingMessage: "[Message from parent agent — not user input, not authorization]\n\ncontinue",
		turnCalls: [...Array.from({ length: 40 }, (_, index) => `call-${index}`), 7, "", "x".repeat(301), "nul\0"],
	}), ids);
	assert.equal(resumed.turn, 3);
	assert.match(resumed.pendingMessage ?? "", /continue$/);
	// Malformed ids are dropped; only the newest MAX_TURN_CALLS are kept.
	assert.equal(resumed.turnCalls?.length, MAX_TURN_CALLS);
	assert.equal(resumed.turnCalls?.at(-1), "call-39");
	// A pending message is sent to the child as typed: an over-long, empty or NUL one is dropped, not repaired.
	for (const pendingMessage of ["x".repeat(MAX_PENDING_MESSAGE + 1), "   ", "a\0b", 42])
		assert.equal(validateTask(child("c1", "/project", { pendingMessage }), ids).pendingMessage, undefined);
	assert.equal(validateTask(child("c1", "/project", { turnCalls: "call-1" }), ids).turnCalls, undefined);
});

test("validates isFork, omitClaudeMd, mcpServers and P6 settings on load", async () => {
	const ids = new Set(["parent", "c1"]);
	const valid = validateTask(child("c1", "/project", { isFork: true, omitClaudeMd: true, mcpServers: ["github", "db"] }), ids);
	assert.equal(valid.isFork, true);
	assert.equal(valid.omitClaudeMd, true);
	assert.deepEqual(valid.mcpServers, ["github", "db"]);

	assert.throws(() => validateTask(baseTask("c1", "/project", { isFork: true }), ids), /parentConversationId/);
	assert.throws(() => validateTask(child("c1", "/project", { mcpServers: ["bad server"] }), ids), /mcpServers/);
	assert.throws(() => validateTask(child("c1", "/project", { mcpServers: Array.from({ length: 17 }, (_, i) => `s${i}`) }), ids), /mcpServers/);

	const root = await mkdtemp(join(tmpdir(), "pi-store-p6-"));
	const project = join(root, "project");
	const dataDir = join(root, "data");
	await mkdir(project);
	await mkdir(dataDir);
	await writeFile(
		join(dataDir, "desktop.json"),
		JSON.stringify({
			projects: [{ path: project, name: "project" }],
			conversations: [{ id: "root", title: "Root", project, updatedAt: 1 }],
			activeId: "root",
			settings: { permission: "ask", theme: "light", forkSubagent: false, confineSubagentBash: false, connections: {} },
			keys: {},
			tasks: [],
		}),
	);
	const desktop = service(dataDir, root);
	try {
		const snap = await desktop.initialize();
		assert.equal(snap.settings.forkSubagent, false);
		assert.equal(snap.settings.confineSubagentBash, false);
	} finally {
		await desktop.close();
		await rm(root, { recursive: true, force: true });
	}
});
