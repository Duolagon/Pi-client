import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile, mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { DesktopTask } from "../src/shared.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = resolve(
	process.argv[2] ??
		join(appDir, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Desktop.app/Contents/Resources"),
);
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-packaged-backend-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
const dataDir = join(root, "desktop");
await Promise.all([mkdir(project), mkdir(dataDir), mkdir(join(agentDir, "extensions"), { recursive: true })]);
await cp(
	resolve(process.argv[3] ?? join(appDir, "test/fixtures/faux-provider.js")),
	join(agentDir, "extensions/faux-provider.js"),
);
await writeFile(join(project, "seed.txt"), "seed-content\n");
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({
		defaultProvider: "desktop-test",
		defaultModel: "desktop-test-1",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
for (const key of Object.keys(env))
	if (
		/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS)/.test(
			key,
		)
	)
		env[key] = undefined;
const fixture = { root, project, dataDir, env, cleanup: () => rm(root, { recursive: true, force: true }) };
const service = new DesktopService({
	dataDir: fixture.dataDir,
	runtimeDir: join(resources, "runtime"),
	ptyHelperPath: join(resources, "native/pty-host"),
	executable: process.execPath,
	env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
	initialProject: fixture.project,
});
const tasks = new Map<string, DesktopTask>();
const listeners = new Set<() => void>();
let maxRunning = 0;
service.subscribeTasks(({ task }) => {
	tasks.set(task.id, task);
	maxRunning = Math.max(
		maxRunning,
		[...tasks.values()].filter((item) => ["running", "waiting_for_input"].includes(item.status)).length,
	);
	for (const listener of listeners) listener();
});
service.subscribe(({ conversationId, event }) => {
	if (event.type === "extension_ui_request" && event.method === "confirm")
		void service.respond({ type: "extension_ui_response", id: event.id, confirmed: true }, conversationId);
});
const wait = (check: () => boolean, label: string) =>
	new Promise<void>((resolve, reject) => {
		const complete = () => {
			if (check()) {
				clearTimeout(timer);
				listeners.delete(complete);
				resolve();
			}
		};
		const timer = setTimeout(() => {
			listeners.delete(complete);
			reject(new Error(`Timed out: ${label}`));
		}, 20000);
		listeners.add(complete);
		complete();
	});

try {
	await exec("git", ["init", fixture.project]);
	await writeFile(join(fixture.project, ".gitignore"), "ignored\n");
	await exec("git", ["add", "seed.txt", ".gitignore"], { cwd: fixture.project });
	await exec(
		"git",
		[
			"-c",
			"user.name=Desktop Test",
			"-c",
			"user.email=desktop@example.invalid",
			"commit",
			"-m",
			"test: Prepare isolated runtime fixture",
		],
		{ cwd: fixture.project },
	);
	const initial = await service.initialize();
	assert.equal(initial.engineStatus, "ready", initial.engineError);
	const created = await Promise.all([
		service.startTask({ message: "read-write-bash", isolation: "worktree", title: "Packaged task one" }),
		service.startTask({ message: "read-write-bash", isolation: "worktree", title: "Packaged task two" }),
	]);
	for (const task of created) {
		await wait(() => ["completed", "failed"].includes(tasks.get(task.id)?.status ?? ""), task.id);
		assert.equal(tasks.get(task.id)?.status, "completed", tasks.get(task.id)?.error);
		const snapshot = await service.taskSnapshot(task.id);
		assert.ok(snapshot.messages.some((item) => item.role === "toolResult"));
		const points = await service.listCheckpoints(task.id);
		assert.ok(points[0].changes.some((item) => item.path === "generated.txt"));
		assert.equal((await service.restoreCheckpoint(points[0].id, task.id)).status, "restored");
		await service.removeWorktree(task.worktreeId!);
		const archived = await service.taskSnapshot(task.id);
		assert.equal(archived.archived, true);
		assert.ok(archived.messages.some((item) => item.role === "assistant"));
		assert.ok((await service.checkpointDiff(points[0].id, task.id)).files.length > 0);
	}
	assert.ok(maxRunning >= 2);
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: fixture.project })).stdout, "");

	let output = "";
	service.subscribeTerminals((event) => {
		if (event.type === "terminal_data") {
			output += event.data;
			for (const listener of listeners) listener();
		}
	});
	const terminal = await service.createTerminal({ cols: 100, rows: 30 });
	await service.writeTerminal(terminal.id, "test -t 0 && printf '\\nPACKAGED_TTY_OK\\n'\r");
	await wait(() => /[\r\n]PACKAGED_TTY_OK[\r\n]/.test(output), "packaged PTY");
	await service.resizeTerminal(terminal.id, 105, 35);
	assert.ok(service.terminalReplay(terminal.id).chunks.length > 0);
	await service.closeTerminal(terminal.id);
	console.log(
		"Packaged backend acceptance passed: two Pi runtimes, checkpoints, Worktrees, archived history, and native PTY.",
	);
} finally {
	await service.close();
	await fixture.cleanup();
}
