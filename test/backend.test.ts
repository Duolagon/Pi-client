import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import type { DesktopEvent } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const exec = promisify(execFile);
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");
type Event = DesktopEvent["event"];
class EventLog {
	events: Event[] = [];
	private listeners = new Set<(event: Event) => void>();
	add(event: Event) {
		this.events.push(event);
		for (const listener of [...this.listeners]) listener(event);
	}
	waitFor<T extends Event["type"]>(type: T, since = this.events.length): Promise<Extract<Event, { type: T }>> {
		const previous = this.events.slice(since).find((event) => event.type === type);
		if (previous) return Promise.resolve(previous as Extract<Event, { type: T }>);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(
					new Error(
						`Missing ${type}: ${this.events
							.slice(since)
							.map((event) => event.type)
							.join(",")}`,
					),
				);
			}, 15000);
			const listener = (event: Event) => {
				if (event.type !== type) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(event as Extract<Event, { type: T }>);
			};
			this.listeners.add(listener);
		});
	}
}

async function setup() {
	const fixture = await createCoreFixture();
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
	};
	const service = new DesktopService(options);
	const events = new EventLog();
	service.subscribe((message) => events.add(message.event));
	const snapshot = await service.initialize();
	assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
	return { fixture, options, service, events };
}

test("a project opens before any model credentials are configured", { timeout: 30000 }, async () => {
	const fixture = await createCoreFixture();
	await rm(join(fixture.agentDir, "extensions"), { recursive: true });
	await writeFile(join(fixture.agentDir, "settings.json"), "{}");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
	});
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		assert.equal(snapshot.active?.project, await realpath(fixture.project));
		assert.deepEqual(snapshot.models, []);
		assert.deepEqual(snapshot.settings.configuredProviders, []);
		await service.command({ type: "get_state" });
		await service.saveSettings({ permission: "ask", theme: "light" });
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test(
	"desktop service owns real Pi conversation, approvals, models, and persisted restore",
	{ timeout: 60000 },
	async () => {
		const { fixture, options, service, events } = await setup();
		let current = service;
		try {
			service.subscribe(({ event }) => {
				if (event.type === "extension_ui_request" && event.method === "confirm")
					void service.respond({
						type: "extension_ui_response",
						id: event.id,
						confirmed: !event.message.includes("denied.txt"),
					});
			});
			let settled = events.waitFor("agent_settled");
			await service.command({ type: "prompt", message: "read-write-bash" });
			await settled;
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "written by real Pi tool\n");
			assert.equal(await readFile(join(fixture.project, "command.txt"), "utf8"), "real-pi-command\n");
			let snapshot = await service.snapshot();
			assert.ok(
				!JSON.stringify(snapshot).includes("desktop-runtime-secret"),
				"Snapshot must not expose runtime model headers",
			);
			for (const command of [{ type: "get_state" }, { type: "get_available_models" }] as const) {
				assert.ok(
					!JSON.stringify(await service.command(command)).includes("desktop-runtime-secret"),
					`${command.type} must not expose runtime model headers`,
				);
			}
			assert.ok(snapshot.messages.some((message) => message.role === "toolResult"));
			assert.ok(snapshot.stats && snapshot.stats.toolCalls >= 3);
			const originalId = snapshot.active!.id;
			await service.renameConversation(originalId, "Real desktop session");
			settled = events.waitFor("agent_settled");
			await service.command({ type: "prompt", message: "deny-write" });
			await settled;
			await assert.rejects(access(join(fixture.project, "denied.txt")));
			const selected = await service.command({
				type: "set_model",
				provider: "desktop-test",
				modelId: "desktop-test-2",
			});
			assert.ok(!JSON.stringify(selected).includes("desktop-runtime-secret"));
			assert.equal((await service.snapshot()).state?.model?.id, "desktop-test-2");
			const created = await service.newConversation();
			assert.notEqual(created.active?.id, originalId);
			assert.equal(created.messages.length, 0);
			await service.selectConversation(originalId);
			assert.equal((await service.snapshot()).active?.title, "Real desktop session");
			const exportPath = join(fixture.root, "conversation.html");
			await service.exportConversation(exportPath);
			const exported = await readFile(exportPath, "utf8");
			const encoded = exported.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			assert.ok(encoded, "Export contains embedded session data");
			assert.match(Buffer.from(encoded, "base64").toString("utf8"), /TOOLS_COMPLETE/);
			await service.close();
			current = new DesktopService({ ...options, initialProject: undefined });
			snapshot = await current.initialize();
			assert.equal(snapshot.active?.id, originalId);
			assert.equal(snapshot.active?.title, "Real desktop session");
			assert.ok(snapshot.messages.some((message) => message.role === "assistant"));
		} finally {
			await current.close();
			await fixture.cleanup();
		}
	},
);

test(
	"desktop file and Git APIs return actual data and reject traversal, escaped symlinks, binary, and oversized files",
	{ timeout: 30000 },
	async () => {
		const { fixture, service } = await setup();
		try {
			assert.equal((await service.readFile("seed.txt")).content, "seed-content\n");
			assert.ok((await service.files("")).some((entry) => entry.name === "seed.txt" && !entry.directory));
			const outside = join(fixture.root, "outside.txt");
			await writeFile(outside, "private outside data");
			await symlink(outside, join(fixture.project, "escape.txt"));
			await assert.rejects(service.readFile("../outside.txt"), /超出|outside|目录/);
			await assert.rejects(service.readFile("escape.txt"), /超出|outside|目录/);
			await assert.rejects(service.files(".."), /超出|outside|目录/);
			await writeFile(join(fixture.project, "binary.bin"), Buffer.from([0, 1, 2]));
			await assert.rejects(service.readFile("binary.bin"), /二进制|binary/);
			await writeFile(join(fixture.project, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
			await assert.rejects(service.readFile("large.txt"), /1 MB|超过|large/);
			assert.equal((await service.workspace()).isGit, false);
			await exec("git", ["init", fixture.project]);
			const workspace = await service.workspace();
			assert.equal(workspace.isGit, true);
			assert.ok(workspace.changes.some((change) => change.path === "seed.txt" && change.status === "??"));
			assert.match(await service.diff("seed.txt"), /\+seed-content/);
			await assert.rejects(service.diff("../outside.txt"), /超出|outside|目录/);
			await assert.rejects(service.diff("escape.txt"), /超出|outside|目录/);
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);

test(
	"desktop modes constrain writes and global settings while switching preserves the running session",
	{ timeout: 30000 },
	async () => {
		const { fixture, service, events } = await setup();
		try {
			await service.saveSettings({ permission: "read", theme: "light" });
			await assert.rejects(service.command({ type: "bash", command: "touch forbidden.txt" }), /只读/);
			await assert.rejects(service.command({ type: "switch_session", sessionPath: "outside.jsonl" }), /桌面|命令/);
			const update = events.waitFor("message_update");
			const settled = events.waitFor("agent_settled");
			const runningId = (await service.snapshot()).active!.id;
			await service.command({ type: "prompt", message: "slow-stream" });
			await update;
			const selected = await service.newConversation();
			assert.notEqual(selected.active?.id, runningId);
			await assert.rejects(
				service.saveSettings({ permission: "auto", theme: "dark" }),
				/执行|运行|完成|进行|停止|busy/,
			);
			await service.command({ type: "abort" }, runningId);
			assert.equal((await settled).aborted, true);
			await service.newConversation();
			await service.saveSettings({ permission: "ask", theme: "light" });
			const bash = await service.command({ type: "bash", command: "printf 'manual-terminal-output'" });
			assert.match(JSON.stringify(bash), /manual-terminal-output/);
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);

test(
	"snapshot preserves pending permission dialogs across renderer refresh and rejects expired replies",
	{ timeout: 30000 },
	async () => {
		const { fixture, service, events } = await setup();
		try {
			const approval = events.waitFor("extension_ui_request");
			const settled = events.waitFor("agent_settled");
			await service.command({ type: "prompt", message: "deny-write" });
			const request = await approval;
			assert.equal(request.method, "confirm");
			const reloaded = await service.snapshot();
			assert.equal(reloaded.pendingUI.length, 1);
			assert.equal(reloaded.pendingUI[0].id, request.id);
			assert.equal(reloaded.state?.isStreaming, true);
			await service.respond({ type: "extension_ui_response", id: request.id, confirmed: false });
			await settled;
			await assert.rejects(access(join(fixture.project, "denied.txt")));
			assert.equal((await service.snapshot()).pendingUI.length, 0);
			// A duplicate reply is ignored rather than applied: the renderer may answer from
			// both the parent conversation and the sub-agent view.
			await service.respond({ type: "extension_ui_response", id: request.id, confirmed: true });
			await assert.rejects(access(join(fixture.project, "denied.txt")));
		} finally {
			await service.close();
			await fixture.cleanup();
		}
	},
);
