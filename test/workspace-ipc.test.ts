import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPtyHelper } from "../scripts/build-pty.mjs";
import { DesktopService } from "../src/backend.ts";
import { installWorkspaceHandlers } from "../src/workspace-ipc.ts";
import type {
	Command,
	DesktopEvent,
	DesktopTask,
	GitCheckpoint,
	GitCheckpointDiff,
	GitCommitDraft,
	GitCommitResult,
	GitDiscardInput,
	GitDiscardResult,
	GitRestoreResult,
	MemoryFileEntry,
	Snapshot,
	TerminalEvent,
	TerminalInfo,
	TerminalReplay,
	WorktreeInfo,
	WorktreeMergeResult,
	WorktreeRemoveResult,
	Workspace,
} from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
let helperDirectory: string;
let helperPath: string;

before(async () => {
	helperDirectory = await mkdtemp(join(tmpdir(), "pi-workspace-ipc-"));
	helperPath = await buildPtyHelper(join(helperDirectory, "pty-host"));
});
after(async () => { await rm(helperDirectory, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, env: gitEnv });
	return stdout.trim();
}

function command(value: unknown): Command {
	// The main window has its own full validator; this boundary covers only commands used in these endpoint tests.
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("测试命令格式错误。");
	const input = value as Record<string, unknown>;
	if (input.type === "abort") return { type: "abort" };
	if (input.type === "prompt" && typeof input.message === "string") return { type: "prompt", message: input.message };
	if (input.type === "set_thinking_level" && input.level === "high") return { type: "set_thinking_level", level: "high" };
	throw new Error("测试命令不在白名单或参数无效。");
}

async function setup({ observeCommitDraft = false } = {}) {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	const commitProbe = join(fixture.root, "commit-model-input.json");
	if (observeCommitDraft) {
		await writeFile(join(fixture.agentDir, "extensions", "faux-provider.js"), `
import { writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
const options = {
	provider: "desktop-test", api: "desktop-test-api",
	models: [{ id: "desktop-test-1", name: "Desktop Test One" }],
	tokensPerSecond: 30, tokenSize: { min: 1, max: 1 },
};
const faux = fauxProvider(options);
export default function (pi) {
	pi.registerProvider(options.provider, {
		api: options.api,
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			writeFileSync(process.env.PI_COMMIT_FIXTURE_PROBE, JSON.stringify(context.messages));
			faux.setResponses([fauxAssistantMessage("fix: 准确说明暂存变更")]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
`);
	}
	await git(project, "-c", "init.defaultBranch=main", "init");
	await git(project, "add", "--", "seed.txt");
	await git(project, "-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "feat: Initialize workspace IPC fixture");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: { ...fixture.env, HOME: fixture.root, SHELL: "/bin/bash", PI_COMMIT_FIXTURE_PROBE: commitProbe },
		initialProject: project,
		ptyHelperPath: helperPath,
	});
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	installWorkspaceHandlers((channel, action) => {
		assert.ok(!handlers.has(channel), `Duplicate endpoint ${channel}`);
		handlers.set(channel, action);
	}, service, command);
	const packets: DesktopEvent[] = [];
	const terminalEvents: TerminalEvent[] = [];
	service.subscribe((packet) => packets.push(packet));
	service.subscribeTerminals((event) => terminalEvents.push(event));
	const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
		const action = handlers.get(channel);
		assert.ok(action, `Missing endpoint ${channel}`);
		return await action(...args) as T;
	};
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, project, service, handlers, invoke, packets, terminalEvents, commitProbe, conversationId: snapshot.active!.id };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < 15000) {
		const value = await read();
		if (predicate(value)) return value;
		await delay(20);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

test("commit drafting and committing share the visible staged scope", { timeout: 30000 }, async () => {
	const data = await setup({ observeCommitDraft: true });
	try {
		const child = join(data.project, "child");
		await mkdir(child);
		await writeFile(join(child, "change.txt"), "STAGED_CHILD_CONTENT\n");
		await writeFile(join(data.project, "seed.txt"), "STAGED_SIBLING_CONTENT\n");
		const childSnapshot = await data.service.selectProject(child);
		const childId = childSnapshot.active!.id;
		await data.service.selectConversation(data.conversationId);
		const scoped = await data.invoke<Workspace>("pi:workspace:stage", undefined, childId);
		assert.deepEqual(scoped.changes.map((change) => change.path), ["change.txt"]);
		assert.equal(await git(data.project, "diff", "--cached", "--name-only"), "child/change.txt");
		await git(data.project, "add", "--", "seed.txt");
		const head = await git(data.project, "rev-parse", "HEAD");
		await assert.rejects(data.invoke("pi:workspace:draft-commit-message", childId), /仓库其他目录/);
		await assert.rejects(data.invoke("pi:workspace:commit", "fix: Only child", childId), /仓库其他目录/);
		await assert.rejects(access(data.commitProbe), { code: "ENOENT" });
		assert.equal(await git(data.project, "rev-parse", "HEAD"), head);
		assert.match(await git(data.project, "diff", "--cached"), /STAGED_SIBLING_CONTENT/);

		await git(data.project, "reset", "-q", "HEAD", "--", "seed.txt");
		await data.service.selectConversation(childId);
		await writeFile(join(child, "change.txt"), "UNSTAGED_CHILD_CONTENT\n");
		const draft = await data.invoke<GitCommitDraft>("pi:workspace:draft-commit-message", childId);
		assert.equal(draft.source, "model");
		assert.equal(draft.message, "fix: 准确说明暂存变更");
		const modelInput = await readFile(data.commitProbe, "utf8");
		assert.match(modelInput, /STAGED_CHILD_CONTENT/);
		assert.doesNotMatch(modelInput, /UNSTAGED_CHILD_CONTENT|STAGED_SIBLING_CONTENT/);
		await git(data.project, "config", "user.name", "Desktop Test");
		await git(data.project, "config", "user.email", "desktop@example.invalid");
		await git(data.project, "config", "commit.gpgSign", "false");
		const result = await data.invoke<GitCommitResult>("pi:workspace:commit", draft.message, childId, draft.stagedVersion);
		assert.ok(result.hash);
		assert.equal(await git(data.project, "show", "HEAD:child/change.txt"), "STAGED_CHILD_CONTENT");
		assert.equal(await readFile(join(child, "change.txt"), "utf8"), "UNSTAGED_CHILD_CONTENT\n");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "STAGED_SIBLING_CONTENT\n");
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("commit drafts reject changed staged contents and fall back for large patches", { timeout: 30000 }, async () => {
	const data = await setup({ observeCommitDraft: true });
	try {
		const path = join(data.project, "seed.txt");
		await writeFile(path, "first staged version\n");
		await git(data.project, "add", "--", "seed.txt");
		const draft = await data.invoke<GitCommitDraft>("pi:workspace:draft-commit-message", data.conversationId);
		assert.equal(draft.source, "model");
		await writeFile(path, "updated during draft\n");
		await git(data.project, "add", "--", "seed.txt");
		await assert.rejects(data.invoke("pi:workspace:commit", draft.message, data.conversationId, draft.stagedVersion), /暂存内容已变化/);
		await assert.rejects(data.invoke("pi:workspace:commit", draft.message, data.conversationId, "not-a-version"), /暂存版本无效/);

		await rm(data.commitProbe);
		const pending = data.invoke<GitCommitDraft>("pi:workspace:draft-commit-message", data.conversationId);
		const rejected = assert.rejects(pending, /暂存内容已变化/);
		await until(() => access(data.commitProbe).then(() => true, () => false), Boolean, "the draft model request");
		await writeFile(path, "updated while the model response was pending\n");
		await git(data.project, "add", "--", "seed.txt");
		await rejected;

		await rm(data.commitProbe);
		await writeFile(path, "large patch text line\n".repeat(120000));
		await git(data.project, "add", "--", "seed.txt");
		const fallback = await data.invoke<GitCommitDraft>("pi:workspace:draft-commit-message", data.conversationId);
		assert.equal(fallback.source, "fallback");
		assert.equal(fallback.fallbackReason, "large_diff");
		assert.match(fallback.message, /seed\.txt/);
		await assert.rejects(access(data.commitProbe), { code: "ENOENT" });
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("workspace endpoints expose real Git checkpoints and owned worktree lifecycle", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const index = await readFile(join(data.project, ".git", "index"));
		const checkpoint = await data.invoke<GitCheckpoint>("pi:git:begin", { conversationId: data.conversationId, label: "IPC manual checkpoint" });
		assert.equal(checkpoint.status, "pending");
		assert.equal(checkpoint.conversationId, data.conversationId);
		await writeFile(join(data.project, "seed.txt"), "changed through IPC fixture\n");
		const finished = await data.invoke<GitCheckpoint>("pi:git:finish", { checkpointId: checkpoint.id, conversationId: data.conversationId });
		assert.equal(finished.status, "ready");
		assert.equal(finished.changes[0].path, "seed.txt");
		const diff = await data.invoke<GitCheckpointDiff>("pi:git:diff", { checkpointId: checkpoint.id, conversationId: data.conversationId, path: "seed.txt" });
		assert.match(diff.files[0].diff, /\+changed through IPC fixture/);
		assert.equal((await data.invoke<GitCheckpoint[]>("pi:git:list", data.conversationId))[0].id, checkpoint.id);
		const restored = await data.invoke<GitRestoreResult>("pi:git:restore", { checkpointId: checkpoint.id, conversationId: data.conversationId, paths: ["seed.txt"] });
		assert.equal(restored.status, "restored");
		assert.deepEqual(restored.restored, ["seed.txt"]);
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "seed-content\n");
		assert.deepEqual(await readFile(join(data.project, ".git", "index")), index);
		const tree = await data.invoke<WorktreeInfo>("pi:worktree:create", { project: data.project, baseRef: "HEAD" });
		assert.equal(tree.repository, data.project);
		assert.equal(tree.status, "ready");
		assert.equal((await data.invoke<WorktreeInfo[]>("pi:worktree:list", data.project))[0].id, tree.id);
		const merged = await data.invoke<WorktreeMergeResult>("pi:worktree:merge", tree.id);
		assert.equal(merged.status, "up-to-date");
		const removed = await data.invoke<WorktreeRemoveResult>("pi:worktree:remove", tree.id);
		assert.equal(removed.worktreeId, tree.id);
		assert.equal(removed.branchRetained, false);
		await assert.rejects(access(tree.path));
		assert.deepEqual(await data.invoke<WorktreeInfo[]>("pi:worktree:list"), []);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("task IPC routes approvals, commands, file access, diffs, and automatic checkpoints to the selected task", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const task = await data.invoke<DesktopTask>("pi:task:start", { message: "deny-write IPC routing", isolation: "worktree", thinkingLevel: "high", model: { provider: "desktop-test", id: "desktop-test-2" } });
		assert.notEqual(task.workingDirectory, data.project);
		assert.ok(task.worktreeId);
		const snapshot = await until(() => data.invoke<Snapshot>("pi:task:snapshot", task.id), (value) => value.pendingUI.some((request) => request.method === "confirm"), "task tool approval");
		const request = snapshot.pendingUI.find((item) => item.method === "confirm")!;
		assert.equal(snapshot.active?.id, task.conversationId);
		assert.equal(snapshot.state?.model?.id, "desktop-test-2");
		await assert.rejects(data.invoke("pi:task:respond", data.conversationId, { type: "extension_ui_response", id: request.id, confirmed: true }), /失效/);
		await data.invoke("pi:task:respond", task.id, { type: "extension_ui_response", id: request.id, confirmed: true });
		await until(() => data.invoke<DesktopTask[]>("pi:task:list"), (tasks) => tasks.some((item) => item.id === task.id && item.status === "completed"), "completed IPC task");
		const content = await data.invoke<{ path: string; content: string }>("pi:task:read-file", task.id, "denied.txt");
		assert.equal(content.content, "must not exist\n");
		const files = await data.invoke<{ path: string }[]>("pi:task:files", task.id, "");
		assert.ok(files.some((item) => item.path === "denied.txt"));
		const workspace = await data.invoke<Workspace>("pi:task:workspace", task.id);
		assert.ok(workspace.changes.some((item) => item.path === "denied.txt"));
		assert.match(await data.invoke<string>("pi:task:diff", task.id, "denied.txt"), /\+must not exist/);
		assert.equal(await data.invoke("pi:task:command", task.id, { type: "set_thinking_level", level: "high" }), undefined);
		assert.equal((await data.invoke<Snapshot>("pi:task:snapshot", task.id)).state?.thinkingLevel, "high");
		const checkpoints = await data.invoke<GitCheckpoint[]>("pi:git:list", task.conversationId);
		assert.equal(checkpoints.length, 1);
		assert.ok(checkpoints[0].changes.some((change) => change.path === "denied.txt"));
		const undone = await data.invoke<GitRestoreResult>("pi:git:restore", { checkpointId: checkpoints[0].id, conversationId: task.conversationId });
		assert.equal(undone.status, "restored");
		await assert.rejects(access(join(task.workingDirectory, "denied.txt")));
		await assert.rejects(access(join(data.project, "denied.txt")));
		assert.equal((await data.invoke<DesktopTask>("pi:task:cancel", task.id)).status, "completed");
		assert.ok(data.packets.some((packet) => packet.conversationId === task.conversationId && packet.event.type === "tool_execution_end"));
		// Stop-all and "立即交付" act only on a named, existing conversation's own children.
		await assert.rejects(data.invoke("pi:task:stopAll", "../escape"), /标识符/);
		await assert.rejects(data.invoke("pi:task:stopAll", "missing-conversation"), /会话不存在/);
		await assert.rejects(data.invoke("pi:task:deliverNow", { id: data.conversationId }), /标识符|格式/);
		assert.deepEqual(await data.invoke("pi:task:stopAll", data.conversationId), { stopped: 0 });
		assert.equal((await data.invoke<DesktopTask[]>("pi:task:list")).find((item) => item.id === task.id)?.status, "completed", "a manual task is not a child");
		assert.deepEqual(await data.invoke("pi:task:deliverNow", data.conversationId), { pending: 0 });
		// "继续对话" and the viewing report validate their input at the IPC boundary.
		await assert.rejects(data.invoke("pi:task:send", { taskId: "../escape", message: "x" }), /标识符/);
		await assert.rejects(data.invoke("pi:task:send", { taskId: task.id, message: "x", forged: true }), /格式/);
		await assert.rejects(data.invoke("pi:task:send", { taskId: task.id, message: "x", notifyParent: "yes" }), /通知选项/);
		await assert.rejects(data.invoke("pi:task:send", { taskId: task.id, message: "   " }), /请输入/);
		await assert.rejects(data.invoke("pi:task:send", { taskId: "missing-task", message: "x" }), /后台任务不存在/);
		await assert.rejects(data.invoke("pi:conversation:viewing", task.conversationId, "yes"), /查看状态/);
		await assert.rejects(data.invoke("pi:conversation:viewing", "missing-conversation", true), /会话不存在/);
		assert.equal(await data.invoke("pi:conversation:viewing", task.conversationId, true), undefined);
		assert.equal(await data.invoke("pi:conversation:viewing", task.conversationId, false), undefined);
		await assert.rejects(data.invoke("pi:task:background", "../escape"), /标识符/);
		await assert.rejects(data.invoke("pi:task:background", "missing-task"), /后台任务不存在/);
		assert.equal((await data.invoke<DesktopTask>("pi:task:background", task.id)).id, task.id);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("terminal IPC creates a real PTY, accepts input and resize, replays output, and returns void mutations", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const terminal = await data.invoke<TerminalInfo>("pi:terminal:create", { conversationId: data.conversationId, cols: 80, rows: 24, shell: "/bin/bash", project: "/forged-working-directory" });
		assert.equal(terminal.project, data.project, "Only the host conversation chooses the terminal working directory");
		assert.equal(terminal.conversationId, data.conversationId);
		assert.equal(terminal.status, "running");
		assert.equal(await data.invoke("pi:terminal:write", terminal.id, "if test -t 0 && test -t 1; then printf '%s%s\\n' 'IPC_' 'IS_TTY'; fi\n"), undefined);
		await until(() => data.invoke<TerminalReplay>("pi:terminal:replay", terminal.id), (value) => value.chunks.map((chunk) => chunk.data).join("").includes("IPC_IS_TTY"), "real PTY output");
		assert.equal(await data.invoke("pi:terminal:resize", terminal.id, 120, 41), undefined);
		await data.invoke("pi:terminal:write", terminal.id, "printf 'size:%s\\n' \"$(stty size)\"; read -r answer; printf 'answer:%s\\n' \"$answer\"\n");
		await until(() => data.invoke<TerminalReplay>("pi:terminal:replay", terminal.id), (value) => value.chunks.map((chunk) => chunk.data).join("").includes("size:41 120"), "resized terminal");
		await data.invoke("pi:terminal:write", terminal.id, "桌面IPC输入\n");
		const replay = await until(() => data.invoke<TerminalReplay>("pi:terminal:replay", terminal.id), (value) => value.chunks.map((chunk) => chunk.data).join("").includes("answer:桌面IPC输入"), "interactive terminal input");
		assert.equal(replay.terminal.cols, 120);
		assert.equal(replay.terminal.rows, 41);
		const cursor = replay.chunks.at(-1)!.sequence;
		const next = await data.invoke<TerminalReplay>("pi:terminal:replay", terminal.id, cursor);
		assert.ok(next.chunks.every((chunk) => chunk.sequence > cursor));
		assert.equal((await data.invoke<TerminalInfo[]>("pi:terminal:list", data.conversationId))[0].id, terminal.id);
		assert.ok(data.terminalEvents.some((event) => event.type === "terminal_data" && event.terminalId === terminal.id && event.conversationId === data.conversationId));
		assert.equal(await data.invoke("pi:terminal:close", terminal.id), undefined);
		assert.equal((await data.invoke<TerminalReplay>("pi:terminal:replay", terminal.id)).terminal.status, "exited");
		await assert.rejects(data.invoke("pi:terminal:write", terminal.id, "late input"), /已关闭/);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("task IPC cancellation reaches a running real Pi process", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const task = await data.invoke<DesktopTask>("pi:task:start", { message: "slow-stream IPC cancellation" });
		await until(() => data.invoke<Snapshot>("pi:task:snapshot", task.id), (snapshot) => snapshot.state?.isStreaming === true && snapshot.messages.length > 0, "streaming IPC task");
		const cancelled = await data.invoke<DesktopTask>("pi:task:cancel", task.id);
		assert.equal(cancelled.status, "cancelled");
		await until(() => data.invoke<Snapshot>("pi:task:snapshot", task.id), (snapshot) => snapshot.state?.isStreaming === false, "cancelled Pi process");
		assert.equal((await data.invoke<DesktopTask[]>("pi:task:list"))[0].status, "cancelled");
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("task IPC reuses a managed worktree and rejects missing, mismatched, or redefined sources", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		await writeFile(join(data.project, "seed.txt"), "user staged before reuse\n");
		await git(data.project, "add", "--", "seed.txt");
		await writeFile(join(data.project, "seed.txt"), "user unstaged before reuse\n");
		const originalStatus = await git(data.project, "status", "--porcelain=v1");
		const originalIndex = await readFile(join(data.project, ".git", "index"));
		const tree = await data.invoke<WorktreeInfo>("pi:worktree:create", { project: data.project });
		await assert.rejects(data.invoke("pi:task:start", { worktreeId: "missing-worktree", message: "must not start" }), /Worktree 不可用/);
		await assert.rejects(data.invoke("pi:task:start", { worktreeId: tree.id, baseRef: "HEAD", message: "must not redefine base" }), /不能重新指定/);
		const otherRepository = join(data.fixture.root, "other-repository");
		await mkdir(otherRepository);
		await git(otherRepository, "init");
		await assert.rejects(data.invoke("pi:task:start", { project: otherRepository, worktreeId: tree.id, message: "must not cross repositories" }), /不属于.*源仓库/);
		assert.deepEqual(await data.invoke<DesktopTask[]>("pi:task:list"), []);
		assert.equal((await data.invoke<WorktreeInfo[]>("pi:worktree:list"))[0].conversationId, undefined);
		const task = await data.invoke<DesktopTask>("pi:task:start", { worktreeId: tree.id, message: "reuse existing worktree over IPC" });
		await until(() => data.invoke<DesktopTask[]>("pi:task:list"), (tasks) => tasks.some((item) => item.id === task.id && item.status === "completed"), "reused worktree task");
		assert.equal(task.worktreeId, tree.id);
		assert.equal(task.project, data.project);
		assert.equal(task.workingDirectory, tree.path);
		const list = await data.invoke<WorktreeInfo[]>("pi:worktree:list");
		assert.equal(list.length, 1, "Reusing a worktree must not silently allocate another one");
		assert.equal(list[0].conversationId, task.conversationId);
		const snapshot = await data.invoke<Snapshot>("pi:task:snapshot", task.id);
		assert.equal(snapshot.active?.project, tree.path);
		assert.ok(snapshot.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes("reuse existing worktree over IPC"))));
		assert.equal((await data.invoke<{ content: string }>("pi:task:read-file", task.id, "seed.txt")).content, "seed-content\n");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "user unstaged before reuse\n");
		assert.equal(await git(data.project, "status", "--porcelain=v1"), originalStatus);
		assert.deepEqual(await readFile(join(data.project, ".git", "index")), originalIndex);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("isolated tasks from a source subdirectory run real Pi tools in its matching worktree subdirectory", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const project = join(data.project, "packages", "demo");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "seed.txt"), "subdirectory seed content\n");
		await git(data.project, "add", "--", "packages/demo/seed.txt");
		await git(data.project, "-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "feat: Add subdirectory task fixture");
		await data.service.saveSettings({ permission: "auto", theme: "light" });
		const originalIndex = await readFile(join(data.project, ".git", "index"));
		const task = await data.invoke<DesktopTask>("pi:task:start", { project, message: "read-write-bash from source subdirectory", isolation: "worktree" });
		await until(() => data.invoke<DesktopTask[]>("pi:task:list"), (tasks) => tasks.some((item) => item.id === task.id && item.status === "completed"), "subdirectory task tools");
		const tree = (await data.invoke<WorktreeInfo[]>("pi:worktree:list")).find((item) => item.id === task.worktreeId)!;
		const expected = join(tree.path, "packages", "demo");
		assert.equal(task.project, project);
		assert.equal(task.workingDirectory, expected);
		assert.equal((await data.invoke<Snapshot>("pi:task:snapshot", task.id)).active?.project, expected);
		assert.equal(tree.conversationId, task.conversationId);
		assert.equal((await data.invoke<{ content: string }>("pi:task:read-file", task.id, "seed.txt")).content, "subdirectory seed content\n");
		assert.equal(await readFile(join(expected, "generated.txt"), "utf8"), "written by real Pi tool\n");
		assert.equal(await readFile(join(expected, "command.txt"), "utf8"), "real-pi-command\n");
		await writeFile(join(tree.path, "outside.txt"), "change outside the task folder\n");
		await git(tree.path, "add", "--", "outside.txt");
		await writeFile(join(expected, "seed.txt"), "task subdirectory modification\n");
		const scoped = await data.invoke<Workspace>("pi:task:workspace", task.id);
		assert.deepEqual(scoped.changes.map((change) => change.path).sort(), ["command.txt", "generated.txt", "seed.txt"]);
		assert.match(await data.invoke<string>("pi:task:diff", task.id, "seed.txt"), /\+task subdirectory modification/);
		await data.service.gitStage(undefined, task.conversationId);
		await data.service.gitUnstage(undefined, task.conversationId);
		assert.equal(await git(tree.path, "diff", "--cached", "--name-only"), "outside.txt");
		const input = { conversationId: task.conversationId, kind: "tracked" as const, path: "seed.txt" };
		const { version } = await data.invoke<{ version: string }>("pi:workspace:discard:preview", input);
		const result = await data.invoke<GitDiscardResult>("pi:workspace:discard", { ...input, expectedVersion: version });
		assert.deepEqual(result.undoCheckpoint?.changes.map((change) => change.path), ["seed.txt"]);
		assert.equal(await readFile(join(expected, "seed.txt"), "utf8"), "subdirectory seed content\n");
		assert.equal(await readFile(join(tree.path, "outside.txt"), "utf8"), "change outside the task folder\n");
		await assert.rejects(access(join(project, "generated.txt")));
		await assert.rejects(access(join(tree.path, "generated.txt")));
		assert.equal(await git(data.project, "status", "--porcelain=v1"), "");
		assert.deepEqual(await readFile(join(data.project, ".git", "index")), originalIndex);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("workspace IPC rejects malformed wire input and forged approvals without mutation", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const checkpoint = await data.invoke<GitCheckpoint>("pi:git:begin");
		await data.invoke("pi:git:finish", { checkpointId: checkpoint.id });
		const before = await readFile(join(data.project, "seed.txt"), "utf8");
		const cases: { label: string; channel: string; args: unknown[]; pattern: RegExp }[] = [
			{ label: "Task object", channel: "pi:task:start", args: [[]], pattern: /参数格式/ },
			{ label: "Isolation enum", channel: "pi:task:start", args: [{ message: "x", isolation: "unsafe" }], pattern: /隔离方式/ },
			{ label: "Model id type", channel: "pi:task:start", args: [{ message: "x", model: { provider: "desktop-test", id: 1 } }], pattern: /模型格式/ },
			{ label: "Thinking enum", channel: "pi:task:start", args: [{ message: "x", thinkingLevel: "unbounded" }], pattern: /白名单|参数无效/ },
			{ label: "Task message type", channel: "pi:task:start", args: [{ message: { text: "x" } }], pattern: /任务内容格式/ },
			{ label: "Task id traversal", channel: "pi:task:snapshot", args: ["../outside"], pattern: /标识符格式/ },
			{ label: "Unknown task", channel: "pi:task:cancel", args: ["missing-task"], pattern: /不存在/ },
			{ label: "Command enum", channel: "pi:task:command", args: [data.conversationId, { type: "switch_session", sessionPath: "/outside" }], pattern: /白名单/ },
			{ label: "Forged approval", channel: "pi:task:respond", args: [data.conversationId, { type: "extension_ui_response", id: "forged-request", confirmed: true }], pattern: /失效/ },
			{ label: "String confirmation", channel: "pi:task:respond", args: [data.conversationId, { type: "extension_ui_response", id: "forged-request", confirmed: "true" }], pattern: /响应格式/ },
			{ label: "Malformed confirmation value", channel: "pi:task:respond", args: [data.conversationId, { type: "extension_ui_response", id: "forged-request", confirmed: true, value: 7 }], pattern: /确认内容格式/ },
			{ label: "Approval id traversal", channel: "pi:task:respond", args: [data.conversationId, { type: "extension_ui_response", id: "../outside", confirmed: true }], pattern: /标识符格式/ },
			{ label: "Terminal invalid size", channel: "pi:terminal:create", args: [{ cols: 0 }], pattern: /列数无效/ },
			{ label: "Terminal fractional size", channel: "pi:terminal:create", args: [{ rows: 1.5 }], pattern: /行数无效/ },
			{ label: "Terminal string size", channel: "pi:terminal:create", args: [{ cols: "80" }], pattern: /列数无效/ },
			{ label: "Terminal null shell", channel: "pi:terminal:create", args: [{ shell: null }], pattern: /Shell 路径格式/ },
			{ label: "Terminal conversation id", channel: "pi:terminal:create", args: [{ conversationId: "../outside" }], pattern: /标识符格式/ },
			{ label: "Terminal resize bound", channel: "pi:terminal:resize", args: ["missing-terminal", 1001, 24], pattern: /列数无效/ },
			{ label: "Terminal write type", channel: "pi:terminal:write", args: ["missing-terminal", {}], pattern: /终端输入格式/ },
			{ label: "Terminal replay sequence", channel: "pi:terminal:replay", args: ["missing-terminal", -1], pattern: /输出序号无效/ },
			{ label: "Terminal id NUL", channel: "pi:terminal:close", args: ["bad\0id"], pattern: /标识符格式/ },
			{ label: "Checkpoint id traversal", channel: "pi:git:finish", args: [{ checkpointId: "../../outside" }], pattern: /标识符格式/ },
			{ label: "Checkpoint paths shape", channel: "pi:git:restore", args: [{ checkpointId: checkpoint.id, paths: {} }], pattern: /文件列表无效/ },
			{ label: "Checkpoint paths value", channel: "pi:git:restore", args: [{ checkpointId: checkpoint.id, paths: [1] }], pattern: /文件路径格式/ },
			{ label: "Checkpoint paths count", channel: "pi:git:restore", args: [{ checkpointId: checkpoint.id, paths: Array.from({ length: 5001 }, () => "seed.txt") }], pattern: /文件列表无效/ },
			{ label: "Checkpoint traversal", channel: "pi:git:restore", args: [{ checkpointId: checkpoint.id, paths: ["../outside"] }], pattern: /路径无效|超出/ },
			{ label: "Checkpoint Git metadata", channel: "pi:git:restore", args: [{ checkpointId: checkpoint.id, paths: [".git/config"] }], pattern: /路径无效|超出/ },
			{ label: "Checkpoint diff traversal", channel: "pi:git:diff", args: [{ checkpointId: checkpoint.id, path: "/outside" }], pattern: /路径无效|超出/ },
			{ label: "Worktree project type", channel: "pi:worktree:create", args: [{ project: 1 }], pattern: /项目目录格式/ },
			{ label: "Worktree unsafe base ref", channel: "pi:worktree:create", args: [{ project: data.project, baseRef: "--bad-option" }], pattern: /引用无效/ },
			{ label: "Worktree removal traversal", channel: "pi:worktree:remove", args: ["../outside"], pattern: /标识符格式/ },
			{ label: "Workspace stage paths type", channel: "pi:workspace:stage", args: ["bad"], pattern: /文件路径列表无效/ },
			{ label: "Workspace stage traversal", channel: "pi:workspace:stage", args: [["../outside"]], pattern: /超出/ },
			{ label: "Workspace stage .git metadata", channel: "pi:workspace:stage", args: [[".git/config"]], pattern: /\.git/ },
			{ label: "Workspace discard empty", channel: "pi:workspace:discard", args: [{ kind: "tracked", path: "" }], pattern: /指定/ },
			{ label: "Workspace discard invalid kind", channel: "pi:workspace:discard", args: [{ kind: "anything", path: "seed.txt" }], pattern: /操作类型/ },
			{ label: "Workspace commit empty", channel: "pi:workspace:commit", args: ["   "], pattern: /提交说明/ },
			{ label: "Workspace memory name allowlist", channel: "pi:workspace:write-memory", args: ["README.md", "hi"], pattern: /记忆文件名无效/ },
		];
		for (const item of cases) await assert.rejects(data.invoke(item.channel, ...item.args), item.pattern, item.label);
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), before);
		assert.deepEqual(await data.invoke<DesktopTask[]>("pi:task:list"), []);
		assert.deepEqual(await data.invoke<WorktreeInfo[]>("pi:worktree:list"), []);
		assert.deepEqual(await data.invoke<TerminalInfo[]>("pi:terminal:list"), []);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("workspace IPC handles Git stage/unstage/discard/commit and project memory with read-only guards", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		const originalSeed = await readFile(join(data.project, "seed.txt"), "utf8");
		const previewDiscard = (input: GitDiscardInput) => data.invoke<{ version: string }>("pi:workspace:discard:preview", input);
		const confirmDiscard = async (input: GitDiscardInput) => {
			const { version } = await previewDiscard(input);
			return data.invoke<GitDiscardResult>("pi:workspace:discard", { ...input, expectedVersion: version });
		};
		await git(data.project, "config", "user.name", "Desktop Test");
		await git(data.project, "config", "user.email", "desktop@example.invalid");
		await git(data.project, "config", "commit.gpgSign", "false");

		await writeFile(join(data.project, "seed.txt"), `${originalSeed}modified\n`);
		await writeFile(join(data.project, "notes.txt"), "scratch note\n");

		const afterStageOne = await data.invoke<Workspace>("pi:workspace:stage", ["notes.txt"]);
		const stagedNote = afterStageOne.changes.find((c) => c.path === "notes.txt");
		const unstagedSeed = afterStageOne.changes.find((c) => c.path === "seed.txt");
		assert.equal(stagedNote?.staged, true);
		assert.equal(stagedNote?.unstaged, false);
		assert.equal(unstagedSeed?.staged, false);
		assert.equal(unstagedSeed?.unstaged, true);

		const afterUnstage = await data.invoke<Workspace>("pi:workspace:unstage", ["notes.txt"]);
		assert.equal(afterUnstage.changes.find((c) => c.path === "notes.txt")?.staged, false);

		await assert.rejects(previewDiscard({ kind: "tracked", path: "notes.txt" }), /Git 状态已改变/);
		assert.equal(await readFile(join(data.project, "notes.txt"), "utf8"), "scratch note\n");
		const notes = { kind: "untracked" as const, path: "notes.txt" };
		const { version } = await previewDiscard(notes);
		await writeFile(join(data.project, "notes.txt"), "another note\n");
		await assert.rejects(data.invoke("pi:workspace:discard", { ...notes, expectedVersion: version }), /确认后发生变化/);
		assert.equal(await readFile(join(data.project, "notes.txt"), "utf8"), "another note\n");
		await writeFile(join(data.project, "notes.txt"), "scratch note\n");
		const trashed = await confirmDiscard(notes);
		assert.equal(trashed.disposition, "trashed");
		await assert.rejects(access(join(data.project, "notes.txt")));
		const trashDir = join(data.fixture.dataDir, "trash");
		const trashedNotes = (await readdir(trashDir)).find((file) => file.endsWith("-notes.txt"))!;
		assert.equal(await readFile(join(trashDir, trashedNotes), "utf8"), "scratch note\n");

		await symlink("seed.txt", join(data.project, "notes-link"));
		await confirmDiscard({ kind: "untracked", path: "notes-link" });
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), `${originalSeed}modified\n`);
		const discarded = await confirmDiscard({ kind: "tracked", path: "seed.txt" });
		assert.equal(discarded.disposition, "restored");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), originalSeed);
		assert.equal(discarded.undoCheckpoint?.kind, "discard-undo");
		assert.deepEqual(discarded.undoCheckpoint?.changes.map((change) => change.path), ["seed.txt"]);
		await data.invoke("pi:git:restore", { checkpointId: discarded.undoCheckpoint!.id });
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), `${originalSeed}modified\n`);

		await writeFile(join(data.project, "seed.txt"), `${originalSeed}committed\n`);
		await data.invoke<Workspace>("pi:workspace:stage");
		const committed = await data.invoke<GitCommitResult>("pi:workspace:commit", "feat: commit staged seed change");
		assert.ok(committed.hash.length >= 4);
		assert.equal(committed.workspace.changes.length, 0);
		assert.equal(await git(data.project, "log", "-1", "--pretty=%s"), "feat: commit staged seed change");

		const initialMemory = await data.invoke<MemoryFileEntry[]>("pi:workspace:read-memory");
		assert.deepEqual(initialMemory.map((m) => [m.file, m.exists]), [["AGENTS.md", false], ["CLAUDE.md", false]]);

		const written = await data.invoke<MemoryFileEntry>("pi:workspace:write-memory", "AGENTS.md", "# Project Rules\nUse node:test.\n");
		assert.equal(written.exists, true);
		const reloadedMemory = await data.invoke<MemoryFileEntry[]>("pi:workspace:read-memory");
		assert.equal(reloadedMemory.find((m) => m.file === "AGENTS.md")?.exists, true);
		assert.equal(reloadedMemory.find((m) => m.file === "AGENTS.md")?.content, "# Project Rules\nUse node:test.\n");

		const current = await data.service.snapshot();
		data.service.saveSettings({ ...current.settings, permission: "read" });
		await writeFile(join(data.project, "seed.txt"), `${originalSeed}blocked-in-readonly\n`);
		await assert.rejects(data.invoke("pi:workspace:stage", ["seed.txt"]), /只读模式/);
		await assert.rejects(data.invoke("pi:workspace:unstage", ["seed.txt"]), /只读模式/);
		await assert.rejects(previewDiscard({ kind: "tracked", path: "seed.txt" }), /只读模式/);
		await assert.rejects(data.invoke("pi:workspace:commit", "should fail"), /只读模式/);
		await assert.rejects(data.invoke("pi:workspace:write-memory", "CLAUDE.md", "nope"), /只读模式/);
		const readableInReadMode = await data.invoke<MemoryFileEntry[]>("pi:workspace:read-memory");
		assert.equal(readableInReadMode.find((m) => m.file === "AGENTS.md")?.exists, true);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});
