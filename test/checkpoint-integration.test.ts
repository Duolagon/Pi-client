import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPtyHelper } from "../scripts/build-pty.mjs";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
let helperDirectory: string;
let helper: string;
before(async () => {
	helperDirectory = await mkdtemp(join(tmpdir(), "pi-checkpoint-pty-"));
	helper = await buildPtyHelper(join(helperDirectory, "pty-host"));
});
after(async () => {
	await rm(helperDirectory, { recursive: true, force: true });
});

class Events {
	private packets: DesktopEvent[] = [];
	private waiters = new Set<{
		type: DesktopEvent["event"]["type"];
		resolve: (event: DesktopEvent) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}>();
	private unsubscribe: () => void;
	constructor(service: DesktopService) {
		this.unsubscribe = service.subscribe((packet) => {
			this.packets.push(packet);
			for (const waiter of this.waiters) {
				if (packet.event.type !== waiter.type) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(packet);
			}
		});
	}
	wait(type: DesktopEvent["event"]["type"], since = this.packets.length): Promise<DesktopEvent> {
		const existing = this.packets.slice(since).find((packet) => packet.event.type === type);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				type,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Missing ${type}`));
				}, 15000),
			};
			this.waiters.add(waiter);
		});
	}
	close() {
		this.unsubscribe();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Event log closed"));
		}
		this.waiters.clear();
	}
}

async function setup() {
	const fixture = await createCoreFixture();
	await exec("git", ["init", fixture.project]);
	await writeFile(join(fixture.project, "generated.txt"), "indexed generated\n");
	await writeFile(join(fixture.project, "command.txt"), "indexed command\n");
	await exec("git", ["add", "--", "seed.txt", "generated.txt", "command.txt"], { cwd: fixture.project });
	await writeFile(join(fixture.project, "seed.txt"), "user seed before task\n");
	await writeFile(join(fixture.project, "generated.txt"), "user generated before task\n");
	await writeFile(join(fixture.project, "command.txt"), "user command before task\n");
	await writeFile(join(fixture.project, "untracked.txt"), "user untracked before task\n");
	const terminalShell = join(fixture.root, "test-shell");
	await writeFile(terminalShell, "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o700 });
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
		ptyHelperPath: helper,
	});
	const events = new Events(service);
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		await service.saveSettings({ permission: "auto", theme: "light" });
	} catch (error) {
		await service.close();
		events.close();
		await fixture.cleanup();
		throw error;
	}
	return {
		fixture,
		terminalShell,
		service,
		events,
		cleanup: async () => {
			await service.close();
			events.close();
			await fixture.cleanup();
		},
	};
}

test(
	"real Pi read/write/bash task automatically captures a durable restore point without changing the Git index",
	{ timeout: 30000 },
	async () => {
		const { fixture, service, events, cleanup } = await setup();
		try {
			const index = await readFile(join(fixture.project, ".git", "index"));
			const settled = events.wait("agent_settled");
			await service.command({ type: "prompt", message: "read-write-bash" });
			await settled;
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "written by real Pi tool\n");
			assert.equal(await readFile(join(fixture.project, "command.txt"), "utf8"), "real-pi-command\n");
			const checkpoints = await service.listCheckpoints();
			assert.equal(checkpoints.length, 1);
			assert.equal(checkpoints[0].status, "ready");
			const entries = await service.sessionForkMessages();
			assert.equal(checkpoints[0].userEntryId, entries.messages[0].entryId);
			assert.deepEqual(
				checkpoints[0].changes.map((change) => change.path),
				["command.txt", "generated.txt"],
			);
			const diff = await service.checkpointDiff(checkpoints[0].id, undefined, "generated.txt");
			assert.match(diff.files[0].diff, /-user generated before task/);
			assert.match(diff.files[0].diff, /\+written by real Pi tool/);
			const restored = await service.restoreCheckpoint(checkpoints[0].id);
			assert.equal(restored.status, "restored", JSON.stringify(restored));
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "user generated before task\n");
			assert.equal(await readFile(join(fixture.project, "command.txt"), "utf8"), "user command before task\n");
			assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "user seed before task\n");
			assert.equal(await readFile(join(fixture.project, "untracked.txt"), "utf8"), "user untracked before task\n");
			assert.deepEqual(await readFile(join(fixture.project, ".git", "index")), index);
		} finally {
			await cleanup();
		}
	},
);

test("identical prompts get distinct native checkpoint identities and cannot be restored from another conversation", { timeout: 30000 }, async () => {
	const { service, events, cleanup } = await setup();
	try {
		for (let run = 0; run < 2; run++) {
			const settled = events.wait("agent_settled");
			await service.command({ type: "prompt", message: "read-write-bash" });
			await settled;
		}
		const checkpoints = await service.listCheckpoints();
		const entries = await service.sessionForkMessages();
		assert.equal(checkpoints.length, 2);
		assert.equal(checkpoints[0].label, checkpoints[1].label);
		assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.userEntryId), entries.messages.map((entry) => entry.entryId).reverse());
		const another = await service.newConversation();
		assert.equal(another.active?.project, checkpoints[0].project);
		await assert.rejects(service.checkpointDiff(checkpoints[0].id, another.active!.id), /不属于当前会话/);
		await assert.rejects(service.restoreCheckpoint(checkpoints[0].id, another.active!.id), /不属于当前会话/);
	} finally {
		await cleanup();
	}
});

test(
	"direct bash gets its own checkpoint and later external edits block an all-files restore",
	{ timeout: 30000 },
	async () => {
		const { fixture, service, cleanup } = await setup();
		try {
			const index = await readFile(join(fixture.project, ".git", "index"));
			await service.command({
				type: "bash",
				command: "printf 'task seed' > seed.txt; printf 'task generated' > generated.txt",
			});
			const [checkpoint] = await service.listCheckpoints();
			assert.equal(checkpoint.status, "ready");
			await writeFile(join(fixture.project, "seed.txt"), "external editor change");
			const conflict = await service.restoreCheckpoint(checkpoint.id);
			assert.equal(conflict.status, "conflict");
			assert.ok(conflict.conflicts.some((item) => item.path === "seed.txt"));
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "task generated");
			assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "external editor change");
			const selected = await service.restoreCheckpoint(checkpoint.id, undefined, ["generated.txt"]);
			assert.equal(selected.status, "restored");
			assert.equal(selected.checkpoint.status, "partially-restored");
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "user generated before task\n");
			assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "external editor change");
			assert.deepEqual(await readFile(join(fixture.project, ".git", "index")), index);
		} finally {
			await cleanup();
		}
	},
);

test(
	"manual checkpoint API supports selected-file restore and read mode blocks restoring files",
	{ timeout: 30000 },
	async () => {
		const { fixture, service, cleanup } = await setup();
		try {
			const before = await service.beginCheckpoint(undefined, "Manual file operation");
			await writeFile(join(fixture.project, "seed.txt"), "manual changed seed");
			await writeFile(join(fixture.project, "untracked.txt"), "manual changed untracked");
			const after = await service.finishCheckpoint(before.id);
			assert.equal(after.status, "ready");
			assert.equal((await service.checkpointDiff(before.id)).files.length, 2);
			await service.saveSettings({ permission: "read", theme: "light" });
			await assert.rejects(service.restoreCheckpoint(before.id), /只读/);
			assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "manual changed seed");
			await service.saveSettings({ permission: "auto", theme: "light" });
			assert.equal((await service.restoreCheckpoint(before.id, undefined, ["seed.txt"])).status, "restored");
			assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "user seed before task\n");
			assert.equal(await readFile(join(fixture.project, "untracked.txt"), "utf8"), "manual changed untracked");
		} finally {
			await cleanup();
		}
	},
);

test("active Pi work and open project PTYs prevent restoring the worktree", { timeout: 30000 }, async () => {
	const { fixture, terminalShell, service, events, cleanup } = await setup();
	try {
		const checkpoint = await service.beginCheckpoint(undefined, "Blocked while busy");
		await writeFile(join(fixture.project, "seed.txt"), "manual changed seed");
		await service.finishCheckpoint(checkpoint.id);
		const update = events.wait("message_update");
		const settled = events.wait("agent_settled");
		await service.command({ type: "prompt", message: "slow-stream" });
		await update;
		await assert.rejects(service.restoreCheckpoint(checkpoint.id), /运行|任务|停止|工作目录/);
		await service.command({ type: "abort" });
		await settled;
		const terminal = await service.createTerminal({ shell: terminalShell });
		assert.equal(terminal.status, "running");
		await assert.rejects(service.restoreCheckpoint(checkpoint.id), /终端/);
		await service.closeTerminal(terminal.id);
		assert.equal((await service.restoreCheckpoint(checkpoint.id)).status, "restored");
		assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "user seed before task\n");
	} finally {
		await cleanup();
	}
});
