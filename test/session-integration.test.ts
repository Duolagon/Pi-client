import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { DesktopService, type ServiceOptions } from "../src/backend.ts";
import type { DesktopEvent, Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function setup() {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	const options: ServiceOptions = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"),
		navigationExtension: join(source, "session-navigation-extension.ts"),
		historyEntry: join(source, "session-history-entry.ts"),
		archiveEntry: join(source, "archive-entry.ts"),
		env: fixture.env,
		initialProject: project,
	};
	const service = new DesktopService(options);
	const events: DesktopEvent[] = [];
	service.subscribe((event) => events.push(event));
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, project, options, service, events, id: snapshot.active!.id };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 15000) {
		if (await check()) return;
		await delay(20);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

async function prompt(service: DesktopService, events: DesktopEvent[], id: string, message: string): Promise<void> {
	const mark = events.length;
	await service.command({ type: "prompt", message }, id);
	await until(
		() => events.slice(mark).some((packet) => packet.conversationId === id && packet.event.type === "agent_settled"),
		`settled prompt ${message}`,
	);
}

function text(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function users(snapshot: Snapshot): string[] {
	return snapshot.messages.filter((message) => message.role === "user").map(text);
}

function userEntry(entries: SessionEntry[], content: string) {
	const entry = entries.find(
		(item) => item.type === "message" && item.message.role === "user" && text(item.message) === content,
	);
	assert.ok(entry && entry.type === "message" && entry.message.role === "user", `Missing user entry ${content}`);
	return entry;
}

function treeIds(tree: SessionTreeNode[]): string[] {
	const pending = [...tree];
	const result: string[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		result.push(node.entry.id);
		pending.push(...node.children);
	}
	return result.sort();
}

test(
	"forking a user entry creates an independent session with earlier context and selected editor text",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		let current = data.service;
		try {
			await prompt(current, data.events, data.id, "context before fork");
			await prompt(current, data.events, data.id, "selected user for fork");
			const parent = structuredClone(await current.snapshot());
			assert.ok(parent.active?.sessionFile);
			const parentBytes = await readFile(parent.active.sessionFile);
			const entries = await current.sessionEntries({ conversationId: data.id });
			const selected = userEntry(entries.entries, "selected user for fork");
			const forked = await current.forkSession({
				conversationId: data.id,
				entryId: selected.id,
				title: "Forked path",
				activate: true,
			});
			assert.equal(forked.cancelled, false);
			assert.equal(forked.selectedText, "selected user for fork");
			assert.ok(forked.conversation);
			const child = forked.conversation;
			assert.notEqual(child.id, data.id);
			assert.notEqual(child.sessionFile, parent.active.sessionFile);
			assert.equal(forked.snapshot.active?.id, child.id);
			assert.deepEqual(users(forked.snapshot), ["context before fork"]);
			assert.notEqual(forked.snapshot.state?.sessionId, parent.state?.sessionId);
			assert.deepEqual(await readFile(parent.active.sessionFile), parentBytes);
			const mark = data.events.length;
			await prompt(current, data.events, child.id, "child continuation");
			assert.ok(
				data.events
					.slice(mark)
					.filter((packet) => packet.event.type === "message_update")
					.every((packet) => packet.conversationId === child.id),
			);
			const original = await current.selectConversation(data.id);
			assert.equal(original.state?.sessionId, parent.state?.sessionId);
			assert.ok(original.active?.sessionFile);
			assert.equal(await realpath(original.active.sessionFile), await realpath(parent.active.sessionFile));
			assert.deepEqual(users(original), ["context before fork", "selected user for fork"]);
			assert.deepEqual(await readFile(parent.active.sessionFile), parentBytes);
			await current.close();
			current = new DesktopService({ ...data.options, initialProject: undefined });
			await current.initialize();
			const restored = await current.selectConversation(child.id);
			assert.ok(restored.active?.sessionFile && child.sessionFile);
			assert.equal(await realpath(restored.active.sessionFile), await realpath(child.sessionFile));
			assert.deepEqual(users(restored), ["context before fork", "child continuation"]);
		} finally {
			await current.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"tree navigation retains all branches while clone copies only the selected branch",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		try {
			await prompt(data.service, data.events, data.id, "common branch root");
			await prompt(data.service, data.events, data.id, "original second branch");
			let entries = await data.service.sessionEntries({ conversationId: data.id });
			const second = userEntry(entries.entries, "original second branch");
			const navigation = await data.service.navigateSession({ conversationId: data.id, targetId: second.id });
			assert.equal(navigation.cancelled, false);
			assert.equal(navigation.editorText, "original second branch");
			assert.equal(navigation.leafId, second.parentId);
			assert.deepEqual(users(navigation.snapshot), ["common branch root"]);
			await prompt(data.service, data.events, data.id, "replacement second branch");
			entries = await data.service.sessionEntries({ conversationId: data.id });
			assert.ok(userEntry(entries.entries, "original second branch"));
			assert.ok(userEntry(entries.entries, "replacement second branch"));
			const tree = await data.service.sessionTree(data.id);
			assert.equal(tree.leafId, entries.leafId);
			assert.deepEqual(treeIds(tree.tree), entries.entries.map((entry) => entry.id).sort());
			const forkMessages = await data.service.sessionForkMessages(data.id);
			assert.ok(forkMessages.messages.some((message) => message.text === "original second branch"));
			assert.ok(forkMessages.messages.some((message) => message.text === "replacement second branch"));
			const since = await data.service.sessionEntries({ conversationId: data.id, since: second.id });
			assert.deepEqual(
				since.entries,
				entries.entries.slice(entries.entries.findIndex((entry) => entry.id === second.id) + 1),
			);
			await assert.rejects(
				data.service.sessionEntries({ conversationId: data.id, since: "missing-entry" }),
				/not found|不存在/,
			);
			const parent = structuredClone(await data.service.snapshot());
			assert.ok(parent.active?.sessionFile);
			const bytes = await readFile(parent.active.sessionFile);
			const clone = await data.service.cloneSession({
				conversationId: data.id,
				title: "Cloned selected path",
				activate: true,
			});
			assert.equal(clone.cancelled, false);
			assert.ok(clone.conversation);
			assert.notEqual(clone.conversation.id, data.id);
			assert.notEqual(clone.conversation.sessionFile, parent.active.sessionFile);
			assert.deepEqual(users(clone.snapshot), ["common branch root", "replacement second branch"]);
			const clonedEntries = await data.service.sessionEntries({ conversationId: clone.conversation.id });
			assert.ok(
				!clonedEntries.entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						text(entry.message) === "original second branch",
				),
			);
			await prompt(data.service, data.events, clone.conversation.id, "clone continuation");
			assert.deepEqual(users(await data.service.selectConversation(data.id)), [
				"common branch root",
				"replacement second branch",
			]);
			assert.deepEqual(await readFile(parent.active.sessionFile), bytes);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"navigation without another prompt restores the selected leaf and context after restart",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		let current = data.service;
		try {
			await prompt(current, data.events, data.id, "first navigation context");
			await prompt(current, data.events, data.id, "second navigation context");
			const before = await current.sessionEntries({ conversationId: data.id });
			const target = userEntry(before.entries, "second navigation context");
			const navigated = await current.navigateSession({ conversationId: data.id, targetId: target.id });
			assert.equal(navigated.leafId, target.parentId);
			assert.deepEqual(users(navigated.snapshot), ["first navigation context"]);
			await current.close();
			current = new DesktopService({ ...data.options, initialProject: undefined });
			const restarted = await current.initialize();
			assert.equal(restarted.active?.id, data.id);
			assert.deepEqual(users(restarted), ["first navigation context"]);
			const restored = await current.sessionEntries({ conversationId: data.id });
			assert.equal(restored.leafId, target.parentId);
			assert.deepEqual(restored.entries, before.entries);
			const oldLeaf = before.entries.find((entry) => entry.id === before.leafId);
			assert.ok(oldLeaf);
			if (oldLeaf.type === "message") assert.notEqual(oldLeaf.message.role, "user");
			assert.ok(before.leafId);
			const forward = await current.navigateSession({ conversationId: data.id, targetId: before.leafId });
			assert.equal(forward.leafId, before.leafId);
			assert.deepEqual(users(forward.snapshot), ["first navigation context", "second navigation context"]);
		} finally {
			await current.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"native fork cancellation leaves the parent session and desktop conversation list unchanged",
	{ timeout: 45000 },
	async () => {
		const data = await setup();
		try {
			await prompt(data.service, data.events, data.id, "cancelled fork source");
			await writeFile(
				join(data.fixture.agentDir, "extensions", "cancel-fork.js"),
				'export default function (pi) { pi.on("session_before_fork", async () => ({ cancel: true })); }\n',
			);
			await data.service.saveSettings({ permission: "auto", theme: "light" });
			const parent = structuredClone(await data.service.snapshot());
			assert.ok(parent.active?.sessionFile);
			const bytes = await readFile(parent.active.sessionFile);
			const selected = userEntry(
				(await data.service.sessionEntries({ conversationId: data.id })).entries,
				"cancelled fork source",
			);
			const forked = await data.service.forkSession({
				conversationId: data.id,
				entryId: selected.id,
				activate: true,
			});
			assert.equal(forked.cancelled, true);
			assert.equal(forked.conversation, undefined);
			assert.equal(forked.snapshot.active?.id, data.id);
			const cloned = await data.service.cloneSession({ conversationId: data.id, activate: true });
			assert.equal(cloned.cancelled, true);
			assert.equal(cloned.conversation, undefined);
			assert.equal((await data.service.snapshot()).conversations.length, 1);
			assert.deepEqual(users(await data.service.snapshot()), ["cancelled fork source"]);
			assert.deepEqual(await readFile(parent.active.sessionFile), bytes);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"streaming sessions reject fork, clone, and navigation while entries and trees remain readable",
	{ timeout: 45000 },
	async () => {
		const data = await setup();
		try {
			await prompt(data.service, data.events, data.id, "idle context before streaming");
			const selected = userEntry(
				(await data.service.sessionEntries({ conversationId: data.id })).entries,
				"idle context before streaming",
			);
			const mark = data.events.length;
			await data.service.command({ type: "prompt", message: "slow-stream session mutation guard" }, data.id);
			await until(
				() =>
					data.events
						.slice(mark)
						.some((packet) => packet.conversationId === data.id && packet.event.type === "message_update"),
				"streaming response",
			);
			for (const mutation of [
				() => data.service.forkSession({ conversationId: data.id, entryId: selected.id }),
				() => data.service.cloneSession({ conversationId: data.id }),
				() => data.service.navigateSession({ conversationId: data.id, targetId: selected.id }),
			])
				await assert.rejects(mutation(), /停止|完成|运行|当前任务|busy/);
			assert.ok((await data.service.sessionEntries({ conversationId: data.id })).entries.length > 0);
			assert.ok((await data.service.sessionTree(data.id)).tree.length > 0);
			assert.ok((await data.service.sessionForkMessages(data.id)).messages.length > 0);
			assert.equal((await data.service.snapshot()).conversations.length, 1);
			await data.service.command({ type: "abort" }, data.id);
			await until(
				() =>
					data.events
						.slice(mark)
						.some((packet) => packet.conversationId === data.id && packet.event.type === "agent_settled"),
				"aborted stream",
			);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"queued task sessions allow queries and reject mutations before their prompt starts",
	{ timeout: 45000 },
	async () => {
		const data = await setup();
		try {
			const running = await data.service.startTask({
				message: "slow-stream queue session guard",
				isolation: "shared",
			});
			await until(
				() =>
					data.events.some(
						(packet) =>
							packet.conversationId === running.conversationId && packet.event.type === "message_update",
					),
				"occupied shared task",
			);
			const queued = await data.service.startTask({
				message: "queued source must retain its prompt",
				isolation: "shared",
			});
			assert.equal((await data.service.listTasks()).find((task) => task.id === queued.id)?.status, "queued");
			assert.deepEqual((await data.service.sessionEntries({ conversationId: queued.conversationId })).entries, []);
			assert.deepEqual((await data.service.sessionTree(queued.conversationId)).tree, []);
			for (const mutation of [
				() => data.service.forkSession({ conversationId: queued.conversationId, entryId: "queued-entry" }),
				() => data.service.cloneSession({ conversationId: queued.conversationId }),
				() => data.service.navigateSession({ conversationId: queued.conversationId, targetId: "queued-entry" }),
			])
				await assert.rejects(mutation(), /停止|后台|任务|运行|busy/);
			assert.equal((await data.service.listTasks()).find((task) => task.id === queued.id)?.status, "queued");
			assert.ok(
				!data.events.some(
					(packet) => packet.conversationId === queued.conversationId && packet.event.type === "agent_start",
				),
			);
			await data.service.cancelTask(queued.id);
			await data.service.cancelTask(running.id);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test("pending tool approvals reject session mutations without consuming the approval", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await prompt(data.service, data.events, data.id, "context before permission request");
		const selected = userEntry(
			(await data.service.sessionEntries({ conversationId: data.id })).entries,
			"context before permission request",
		);
		const mark = data.events.length;
		await data.service.command({ type: "prompt", message: "deny-write session approval guard" }, data.id);
		await until(
			() =>
				data.events
					.slice(mark)
					.some(
						(packet) =>
							packet.conversationId === data.id &&
							packet.event.type === "extension_ui_request" &&
							packet.event.method === "confirm",
					),
			"tool approval",
		);
		const approval = (await data.service.snapshot()).pendingUI[0];
		assert.ok(approval && approval.method === "confirm");
		for (const mutation of [
			() => data.service.forkSession({ conversationId: data.id, entryId: selected.id }),
			() => data.service.cloneSession({ conversationId: data.id }),
			() => data.service.navigateSession({ conversationId: data.id, targetId: selected.id }),
		])
			await assert.rejects(mutation(), /停止|完成|运行|当前任务|busy/);
		assert.ok((await data.service.sessionTree(data.id)).tree.length > 0);
		assert.equal((await data.service.snapshot()).pendingUI[0]?.id, approval.id);
		await data.service.respond({ type: "extension_ui_response", id: approval.id, confirmed: false }, data.id);
		await until(
			() =>
				data.events
					.slice(mark)
					.some((packet) => packet.conversationId === data.id && packet.event.type === "agent_settled"),
			"denied tool settlement",
		);
		assert.equal((await data.service.snapshot()).conversations.length, 1);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test(
	"cloning a completed background task preserves its task binding and scopes child events",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		try {
			const task = await data.service.startTask({
				message: "completed background source session",
				isolation: "shared",
			});
			await until(
				async () =>
					(await data.service.listTasks()).some((item) => item.id === task.id && item.status === "completed"),
				"background source completion",
			);
			const tasksBefore = await data.service.listTasks();
			const sourceSnapshot = await data.service.taskSnapshot(task.id);
			const sourceSessionId = sourceSnapshot.state?.sessionId;
			const clone = await data.service.cloneSession({ conversationId: task.conversationId, activate: false });
			assert.equal(clone.cancelled, false);
			assert.ok(clone.conversation);
			assert.notEqual(clone.conversation.id, task.conversationId);
			assert.deepEqual(await data.service.listTasks(), tasksBefore);
			assert.equal((await data.service.snapshot()).active?.id, data.id);
			const mark = data.events.length;
			await prompt(data.service, data.events, clone.conversation.id, "independent child of task");
			assert.ok(
				data.events
					.slice(mark)
					.filter((packet) => packet.event.type === "message_update")
					.every((packet) => packet.conversationId === clone.conversation!.id),
			);
			const sourceAfter = await data.service.taskSnapshot(task.id);
			assert.equal(sourceAfter.state?.sessionId, sourceSessionId);
			assert.deepEqual(users(sourceAfter), ["completed background source session"]);
			assert.deepEqual(await data.service.listTasks(), tasksBefore);
			assert.deepEqual(users(await data.service.selectConversation(clone.conversation.id)), [
				"completed background source session",
				"independent child of task",
			]);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"unloaded and archived session queries preserve foreground selection and never execute an agent",
	{ timeout: 45000 },
	async () => {
		const data = await setup();
		try {
			await prompt(data.service, data.events, data.id, "archived session context");
			const entries = await data.service.sessionEntries({ conversationId: data.id });
			const active = (await data.service.newConversation()).active!.id;
			const mark = data.events.length;
			assert.deepEqual(await data.service.sessionEntries({ conversationId: data.id }), entries);
			assert.deepEqual(
				treeIds((await data.service.sessionTree(data.id)).tree),
				entries.entries.map((entry) => entry.id).sort(),
			);
			assert.equal((await data.service.snapshot()).active?.id, active);
			await rm(data.project, { recursive: true });
			assert.deepEqual(await data.service.sessionEntries({ conversationId: data.id }), entries);
			assert.deepEqual(
				treeIds((await data.service.sessionTree(data.id)).tree),
				entries.entries.map((entry) => entry.id).sort(),
			);
			assert.ok(
				(await data.service.sessionForkMessages(data.id)).messages.some(
					(message) => message.text === "archived session context",
				),
			);
			assert.ok(
				!data.events
					.slice(mark)
					.some((packet) => packet.conversationId === data.id && packet.event.type === "agent_start"),
			);
			await assert.rejects(data.service.cloneSession({ conversationId: data.id }), /不存在|存档|移除/);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"CLI history import retains the complete tree, is idempotent, and never changes the source file",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		let current = data.service;
		try {
			await prompt(current, data.events, data.id, "CLI common history");
			await prompt(current, data.events, data.id, "CLI abandoned branch");
			const branchPoint = userEntry(
				(await current.sessionEntries({ conversationId: data.id })).entries,
				"CLI abandoned branch",
			);
			await current.navigateSession({ conversationId: data.id, targetId: branchPoint.id });
			await prompt(current, data.events, data.id, "CLI current branch");
			const original = await current.snapshot();
			assert.ok(original.active?.sessionFile);
			const sourceDir = join(data.fixture.agentDir, "sessions", "cli-project");
			await mkdir(sourceDir, { recursive: true });
			const sourceFile = join(sourceDir, "cli-history.jsonl");
			await cp(original.active.sessionFile, sourceFile);
			const bytes = await readFile(sourceFile);
			const info = await stat(sourceFile);
			const discovery = await current.discoverSessionHistory({});
			const found = discovery.sessions.find((session) => session.sourceSessionId === original.state?.sessionId);
			assert.ok(found, "CLI source should be discovered from the configured Pi agent directory");
			const imported = await current.importSessionHistory({ token: found.token, activate: true });
			assert.equal(imported.alreadyImported, false);
			assert.notEqual(imported.conversation.id, data.id);
			assert.notEqual(imported.conversation.sessionFile, sourceFile);
			assert.equal(imported.snapshot.active?.id, imported.conversation.id);
			assert.deepEqual(users(imported.snapshot), ["CLI common history", "CLI current branch"]);
			const importedEntries = await current.sessionEntries({ conversationId: imported.conversation.id });
			assert.ok(userEntry(importedEntries.entries, "CLI abandoned branch"));
			assert.ok(userEntry(importedEntries.entries, "CLI current branch"));
			const repeat = await current.importSessionHistory({ token: found.token, activate: false });
			assert.equal(repeat.alreadyImported, true);
			assert.equal(repeat.conversation.id, imported.conversation.id);
			assert.equal((await current.snapshot()).conversations.length, 2);
			await prompt(current, data.events, imported.conversation.id, "continued imported desktop session");
			assert.deepEqual(await readFile(sourceFile), bytes);
			assert.equal((await stat(sourceFile)).mtimeMs, info.mtimeMs);
			await current.close();
			current = new DesktopService({ ...data.options, initialProject: undefined });
			const restored = await current.initialize();
			assert.equal(restored.active?.id, imported.conversation.id);
			assert.deepEqual(users(restored), [
				"CLI common history",
				"CLI current branch",
				"continued imported desktop session",
			]);
			const rediscovered = await current.discoverSessionHistory({});
			const sameSource = rediscovered.sessions.find(
				(session) => session.sourceSessionId === original.state?.sessionId,
			);
			assert.ok(sameSource);
			const afterRestart = await current.importSessionHistory({ token: sameSource.token, activate: false });
			assert.equal(afterRestart.alreadyImported, true);
			assert.equal(afterRestart.conversation.id, imported.conversation.id);
			assert.deepEqual(await readFile(sourceFile), bytes);
			assert.equal((await stat(sourceFile)).mtimeMs, info.mtimeMs);
		} finally {
			await current.close();
			await data.fixture.cleanup();
		}
	},
);
