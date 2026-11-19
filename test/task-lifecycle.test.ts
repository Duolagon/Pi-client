import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent, Message } from "../src/shared.ts";
import type { TaskEvent } from "../src/task-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

async function setup(delaySelection = false) {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await exec("git", ["-c", "init.defaultBranch=main", "init"], { cwd: project, env: gitEnv });
	await exec("git", ["add", "--", "seed.txt"], { cwd: project, env: gitEnv });
	await exec(
		"git",
		[
			"-c",
			"user.name=Lifecycle Test",
			"-c",
			"user.email=lifecycle@example.invalid",
			"-c",
			"commit.gpgSign=false",
			"commit",
			"-m",
			"feat: Initialize task lifecycle fixture",
		],
		{ cwd: project, env: gitEnv },
	);
	const selectionMarker = join(fixture.root, "model-selection-started");
	if (delaySelection)
		await writeFile(
			join(fixture.agentDir, "extensions", "delay-model-selection.js"),
			`import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.on("model_select", async (event) => {
    if (event.model.id !== "desktop-test-2") return;
    await writeFile(${JSON.stringify(selectionMarker)}, "started");
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}
`,
		);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(app, "src", "permission-extension.ts"),
		archiveEntry: join(app, "src", "archive-entry.ts"),
		env: fixture.env,
		initialProject: project,
		maxConcurrentTasks: 4,
	});
	const events: DesktopEvent[] = [];
	const tasks: TaskEvent[] = [];
	service.subscribe((event) => events.push(event));
	service.subscribeTasks((event) => { if (event.type === "task_updated") tasks.push(event); });
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		await service.saveSettings({ permission: "auto", theme: "light" });
		return {
			fixture,
			project,
			selectionMarker,
			service,
			events,
			tasks,
			cleanup: async () => {
				await service.close();
				await fixture.cleanup();
			},
		};
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 15000) {
		if (await check()) return;
		await delay(20);
	}
	assert.fail(`Timed out waiting for ${description}`);
}
function text(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

test(
	"cancelling while a model-selection extension is still starting never runs the cancelled prompt",
	{ timeout: 30000 },
	async () => {
		const data = await setup(true);
		try {
			const task = await data.service.startTask({
				message: "read-write-bash cancelled during model selection",
				model: { provider: "desktop-test", id: "desktop-test-2" },
			});
			await waitFor(
				() =>
					access(data.selectionMarker).then(
						() => true,
						() => false,
					),
				"model selection to start",
			);
			assert.equal((await data.service.cancelTask(task.id)).status, "cancelled");
			await delay(650);
			assert.equal((await data.service.listTasks()).find((item) => item.id === task.id)?.status, "cancelled");
			assert.ok(
				!data.events.some(
					(packet) => packet.conversationId === task.conversationId && packet.event.type === "agent_start",
				),
			);
			await assert.rejects(access(join(task.workingDirectory, "generated.txt")), { code: "ENOENT" });
			await assert.rejects(access(join(task.workingDirectory, "command.txt")), { code: "ENOENT" });
		} finally {
			await data.cleanup();
		}
	},
);

test(
	"shared-directory tasks queue behind an active writer even when concurrency slots remain",
	{ timeout: 30000 },
	async () => {
		const data = await setup();
		try {
			const first = await data.service.startTask({ message: "slow-stream shared first", isolation: "shared" });
			await waitFor(
				() =>
					data.events.some(
						(packet) => packet.conversationId === first.conversationId && packet.event.type === "message_update",
					),
				"first shared stream",
			);
			const second = await data.service.startTask({
				message: "shared second finishes after cancellation",
				isolation: "shared",
			});
			await delay(100);
			assert.equal((await data.service.listTasks()).find((item) => item.id === second.id)?.status, "queued");
			assert.ok(
				!data.events.some(
					(packet) => packet.conversationId === second.conversationId && packet.event.type === "agent_start",
				),
			);
			await data.service.cancelTask(first.id);
			await waitFor(
				() => data.tasks.some((event) => event.task.id === second.id && event.task.status === "completed"),
				"second shared task completion",
			);
			const list = await data.service.listTasks();
			assert.equal(list.find((item) => item.id === first.id)?.status, "cancelled");
			assert.equal(list.find((item) => item.id === second.id)?.status, "completed");
			assert.equal(first.workingDirectory, second.workingDirectory);
			assert.ok(
				(await data.service.taskSnapshot(second.id)).messages.some(
					(message) => message.role === "assistant" && text(message).includes("shared second finishes"),
				),
			);
		} finally {
			await data.cleanup();
		}
	},
);

test(
	"removed Worktrees retain task transcripts and checkpoint differences without restarting an agent",
	{ timeout: 30000 },
	async () => {
		const data = await setup();
		try {
			const task = await data.service.startTask({ message: "read-write-bash archived task" });
			// "completed" is reported before the host finishes settling the run (checkpoint,
			// hooks); restoring needs an idle project, so also wait for the settlement event.
			await waitFor(
				() => data.tasks.some((event) => event.task.id === task.id && event.task.status === "completed") &&
					data.events.some((packet) => packet.conversationId === task.conversationId && packet.event.type === "agent_settled"),
				"task completion",
			);
			const [checkpoint] = await data.service.listCheckpoints(task.conversationId);
			assert.equal(checkpoint.status, "ready");
			assert.equal((await data.service.restoreCheckpoint(checkpoint.id, task.conversationId)).status, "restored");
			assert.ok(task.worktreeId);
			await data.service.removeWorktree(task.worktreeId);
			await assert.rejects(access(task.workingDirectory), { code: "ENOENT" });
			const previousStarts = data.events.filter(
				(packet) => packet.conversationId === task.conversationId && packet.event.type === "agent_start",
			).length;
			const snapshot = await data.service.taskSnapshot(task.id);
			assert.equal(snapshot.archived, true);
			assert.equal(snapshot.active?.id, task.conversationId);
			assert.ok(
				snapshot.messages.some((message) => message.role === "assistant" && text(message).includes("TOOLS_COMPLETE")),
			);
			assert.equal((await data.service.listCheckpoints(task.conversationId))[0].id, checkpoint.id);
			const difference = await data.service.checkpointDiff(checkpoint.id, task.conversationId, "generated.txt");
			assert.match(difference.files[0].diff, /\+written by real Pi tool/);
			await assert.rejects(data.service.restoreCheckpoint(checkpoint.id, task.conversationId), /ENOENT|不存在|存档/);
			await assert.rejects(
				data.service.command({ type: "prompt", message: "must not run" }, task.conversationId),
				/不存在|存档|重新打开/,
			);
			assert.equal(
				data.events.filter(
					(packet) => packet.conversationId === task.conversationId && packet.event.type === "agent_start",
				).length,
				previousStarts,
			);
			await assert.rejects(access(task.workingDirectory), { code: "ENOENT" });
		} finally {
			await data.cleanup();
		}
	},
);

test("read mode rejects isolated task creation before any Worktree is created", { timeout: 30000 }, async () => {
	const data = await setup();
	try {
		await data.service.saveSettings({ permission: "read", theme: "light" });
		await assert.rejects(data.service.startTask({ message: "should not create a Worktree" }), /只读/);
		assert.deepEqual(await data.service.listWorktrees(), []);
		assert.deepEqual(await data.service.listTasks(), []);
	} finally {
		await data.cleanup();
	}
});
