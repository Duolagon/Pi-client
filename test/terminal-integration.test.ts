import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPtyHelper } from "../scripts/build-pty.mjs";
import { DesktopService } from "../src/backend.ts";
import type { TerminalEvent } from "../src/terminal-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
let buildDirectory: string, helper: string;
before(async () => {
	buildDirectory = await mkdtemp(join(tmpdir(), "pi-terminal-integration-"));
	helper = await buildPtyHelper(join(buildDirectory, "pty-host"));
});
after(async () => {
	await rm(buildDirectory, { recursive: true, force: true });
});
async function git(project: string, ...args: string[]) {
	const result = await exec("git", args, { cwd: project, env: gitEnv });
	return result.stdout.trim();
}
async function setup() {
	const fixture = await createCoreFixture();
	await git(fixture.project, "-c", "init.defaultBranch=main", "init");
	await git(fixture.project, "add", "--", "seed.txt");
	await git(
		fixture.project,
		"-c",
		"user.name=Desktop Test",
		"-c",
		"user.email=desktop@example.invalid",
		"-c",
		"commit.gpgSign=false",
		"commit",
		"-m",
		"feat: Initialize PTY integration fixture",
	);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
		ptyHelperPath: helper,
	});
	const events: TerminalEvent[] = [];
	service.subscribeTerminals((event) => events.push(event));
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, service, events, conversationId: snapshot.active!.id };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}
async function output(service: DesktopService, id: string, pattern: RegExp) {
	const started = Date.now();
	while (Date.now() - started < 5000) {
		const text = service
			.terminalReplay(id)
			.chunks.map((chunk) => chunk.data)
			.join("");
		if (pattern.test(text)) return text;
		await delay(20);
	}
	assert.fail(`Missing ${pattern}: ${JSON.stringify(service.terminalReplay(id))}`);
}

test(
	"DesktopService binds PTYs to the requested conversation rather than the active project",
	{ timeout: 15000 },
	async () => {
		const { fixture, service, events, conversationId } = await setup();
		try {
			const other = join(fixture.root, "other-project");
			await mkdir(other);
			const selected = await service.selectProject(other);
			assert.notEqual(selected.active?.id, conversationId);
			const terminal = await service.createTerminal({ conversationId, shell: "/bin/bash", cols: 88, rows: 24 });
			assert.equal(terminal.conversationId, conversationId);
			assert.equal(terminal.project, await realpath(fixture.project));
			await service.writeTerminal(
				terminal.id,
				"printf 'terminal-cwd:%s\\n' \"$PWD\"; printf 'terminal-size:%s\\n' \"$(stty size)\"\n",
			);
			await output(service, terminal.id, /terminal-size:24 88/);
			assert.match(await output(service, terminal.id, /terminal-cwd:/), /terminal-cwd:.*\/project/);
			assert.ok(
				events.some(
					(event) =>
						event.type === "terminal_data" &&
						event.terminalId === terminal.id &&
						event.conversationId === conversationId,
				),
			);
			assert.equal(service.listTerminals(conversationId).length, 1);
			assert.equal(service.listTerminals(selected.active!.id).length, 0);
			const cursor = service.terminalReplay(terminal.id).nextSequence - 1;
			await service.resizeTerminal(terminal.id, 120, 40);
			await service.writeTerminal(terminal.id, "printf 'new-size:%s\\n' \"$(stty size)\"\n");
			await output(service, terminal.id, /new-size:40 120/);
			assert.ok(service.terminalReplay(terminal.id, cursor).chunks.every((chunk) => chunk.sequence > cursor));
			await service.closeTerminal(terminal.id);
			assert.ok(events.some((event) => event.type === "terminal_exit" && event.terminalId === terminal.id));
			await assert.rejects(service.createTerminal({ conversationId: "unknown-session" }), /会话不存在/);
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);

test("read mode closes existing PTYs and rejects further creation and input", { timeout: 15000 }, async () => {
	const { fixture, service, conversationId } = await setup();
	try {
		const terminal = await service.createTerminal({ conversationId, shell: "/bin/bash" });
		await service.writeTerminal(terminal.id, "printf '%s%s\\n' 'BEFORE_' 'READ'\n");
		await output(service, terminal.id, /BEFORE_READ/);
		await service.saveSettings({ permission: "read", theme: "light" });
		assert.equal(service.listTerminals(conversationId)[0].status, "exited");
		await assert.rejects(service.createTerminal({ conversationId }), /只读/);
		await assert.rejects(service.writeTerminal(terminal.id, "touch forbidden.txt\n"), /不可|只读/);
		await assert.rejects(access(join(fixture.project, "forbidden.txt")));
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("a live PTY blocks checkpoint restoration until it is closed", { timeout: 15000 }, async () => {
	const { fixture, service, conversationId } = await setup();
	try {
		const checkpoint = await service.beginCheckpoint(conversationId, "manual change");
		await writeFile(join(fixture.project, "seed.txt"), "changed\n");
		await service.finishCheckpoint(checkpoint.id, conversationId);
		const terminal = await service.createTerminal({ conversationId, shell: "/bin/bash" });
		await assert.rejects(service.restoreCheckpoint(checkpoint.id, conversationId), /关闭.*终端/);
		assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "changed\n");
		await service.closeTerminal(terminal.id);
		const restored = await service.restoreCheckpoint(checkpoint.id, conversationId);
		assert.equal(restored.status, "restored");
		assert.equal(await readFile(join(fixture.project, "seed.txt"), "utf8"), "seed-content\n");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test(
	"live PTYs block Worktree merge and deletion, including terminals in the source repository",
	{ timeout: 15000 },
	async () => {
		const { fixture, service, conversationId } = await setup();
		try {
			const worktree = await service.createWorktree({ project: fixture.project });
			const terminal = await service.createTerminal({ conversationId, shell: "/bin/bash" });
			await assert.rejects(service.removeWorktree(worktree.id), /活动任务|终端/);
			assert.equal((await service.mergeWorktree(worktree.id)).status, "blocked");
			await service.closeTerminal(terminal.id);
			assert.equal((await service.mergeWorktree(worktree.id)).status, "up-to-date");
			await service.removeWorktree(worktree.id);
			await assert.rejects(access(worktree.path));
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);

test("closing DesktopService terminates terminal jobs and rejects late writes", { timeout: 15000 }, async () => {
	const { fixture, service, conversationId } = await setup();
	try {
		const terminal = await service.createTerminal({ conversationId, shell: "/bin/bash" });
		await service.writeTerminal(
			terminal.id,
			"set +H; (sleep 2; touch late-child.txt) & printf '%s%s\\n' 'CLOSE_' 'READY'; sleep 30\n",
		);
		await output(service, terminal.id, /CLOSE_READY/);
		await service.close();
		assert.equal(service.listTerminals(conversationId)[0].status, "exited");
		await assert.rejects(service.writeTerminal(terminal.id, "echo late\n"), /不可|关闭/);
		await delay(2200);
		await assert.rejects(access(join(fixture.project, "late-child.txt")));
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test(
	"concurrent terminal creation cannot leave a live terminal after enabling read mode",
	{ timeout: 15000 },
	async () => {
		const { fixture, service, conversationId } = await setup();
		try {
			await Promise.allSettled([
				service.createTerminal({ conversationId, shell: "/bin/bash" }),
				service.saveSettings({ permission: "read", theme: "light" }),
			]);
			assert.equal((await service.snapshot()).settings.permission, "read");
			assert.ok(service.listTerminals().every((terminal) => terminal.status === "exited"));
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);

test("read mode rejects Worktree mutations through DesktopService", { timeout: 15000 }, async () => {
	const { fixture, service } = await setup();
	try {
		const worktree = await service.createWorktree({ project: fixture.project });
		await service.saveSettings({ permission: "read", theme: "light" });
		await assert.rejects(service.createWorktree({ project: fixture.project }), /只读/);
		await assert.rejects(service.mergeWorktree(worktree.id), /只读/);
		await assert.rejects(service.removeWorktree(worktree.id), /只读/);
		await access(worktree.path);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
