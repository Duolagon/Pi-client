import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { DesktopService } from "../src/backend.ts";
import { installSessionHandlers } from "../src/session-ipc.ts";
import type { CliSessionHistoryResult } from "../src/session-history-types.ts";
import type {
	SessionCopyResult,
	SessionEntriesResult,
	SessionHistoryImportResult,
	SessionNavigateResult,
	SessionTreeResult,
} from "../src/session-types.ts";
import type { DesktopEvent, Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function setup() {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"),
		navigationExtension: join(source, "session-navigation-extension.ts"),
		historyEntry: join(source, "session-history-entry.ts"),
		env: fixture.env,
		initialProject: fixture.project,
	});
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	installSessionHandlers((channel, action) => {
		assert.ok(!handlers.has(channel), `Duplicate session endpoint ${channel}`);
		handlers.set(channel, action);
	}, service);
	const events: DesktopEvent[] = [];
	service.subscribe((event) => events.push(event));
	const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
		const handler = handlers.get(channel);
		assert.ok(handler, `Missing session endpoint ${channel}`);
		return (await handler(...args)) as T;
	};
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		return { fixture, service, invoke, events, id: snapshot.active!.id };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
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

async function prompt(service: DesktopService, events: DesktopEvent[], id: string, message: string): Promise<void> {
	const mark = events.length;
	await service.command({ type: "prompt", message }, id);
	const start = Date.now();
	while (Date.now() - start < 15000) {
		if (events.slice(mark).some((packet) => packet.conversationId === id && packet.event.type === "agent_settled"))
			return;
		await delay(20);
	}
	assert.fail(`Timed out waiting for IPC fixture prompt ${message}`);
}

function nodes(tree: SessionTreeNode[]): SessionTreeNode[] {
	const pending = [...tree];
	const result: SessionTreeNode[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		result.push(node);
		pending.push(...node.children);
	}
	return result;
}

test(
	"session IPC routes fork, tree, entries, navigation, clone, and CLI history through real Pi",
	{ timeout: 60000 },
	async () => {
		const data = await setup();
		try {
			await prompt(data.service, data.events, data.id, "IPC common context");
			await prompt(data.service, data.events, data.id, "IPC selected user");
			const parent = await data.service.snapshot();
			assert.ok(parent.active?.sessionFile);
			const sourceDir = join(data.fixture.agentDir, "sessions", "ipc-project");
			await mkdir(sourceDir, { recursive: true });
			await cp(parent.active.sessionFile, join(sourceDir, "ipc-cli-history.jsonl"));
			const entries = await data.invoke<SessionEntriesResult>("pi:session:entries", { conversationId: data.id });
			const selected = entries.entries.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && text(entry.message) === "IPC selected user",
			);
			assert.ok(selected);
			const fork = await data.invoke<SessionCopyResult>("pi:session:fork", {
				conversationId: data.id,
				entryId: selected.id,
				activate: false,
				title: "IPC fork",
			});
			assert.equal(fork.cancelled, false);
			assert.equal(fork.selectedText, "IPC selected user");
			assert.ok(fork.conversation);
			assert.deepEqual(users(fork.snapshot), ["IPC common context"]);
			assert.equal((await data.service.snapshot()).active?.id, data.id);
			const forkTree = await data.invoke<SessionTreeResult>("pi:session:tree", fork.conversation.id);
			const forkEntries = await data.invoke<SessionEntriesResult>("pi:session:entries", {
				conversationId: fork.conversation.id,
			});
			assert.deepEqual(
				nodes(forkTree.tree)
					.map((node) => node.entry.id)
					.sort(),
				forkEntries.entries.map((entry) => entry.id).sort(),
			);
			const messages = await data.invoke<{ messages: { entryId: string; text: string }[] }>(
				"pi:session:fork-messages",
				data.id,
			);
			assert.ok(
				messages.messages.some(
					(message) => message.entryId === selected.id && message.text === "IPC selected user",
				),
			);
			const navigated = await data.invoke<SessionNavigateResult>("pi:session:navigate", {
				conversationId: data.id,
				targetId: selected.id,
				label: "IPC selected branch",
			});
			assert.equal(navigated.cancelled, false);
			assert.equal(navigated.editorText, "IPC selected user");
			assert.deepEqual(users(navigated.snapshot), ["IPC common context"]);
			const labelled = await data.invoke<SessionTreeResult>("pi:session:tree", data.id);
			assert.ok(
				nodes(labelled.tree).some((node) => node.entry.id === selected.id && node.label === "IPC selected branch"),
			);
			const clone = await data.invoke<SessionCopyResult>("pi:session:clone", {
				conversationId: data.id,
				activate: true,
			});
			assert.equal(clone.cancelled, false);
			assert.ok(clone.conversation);
			assert.deepEqual(users(clone.snapshot), ["IPC common context"]);
			assert.equal((await data.service.snapshot()).active?.id, clone.conversation.id);
			const history = await data.invoke<CliSessionHistoryResult>("pi:session:history");
			const found = history.sessions.find((session) => session.sourceSessionId === parent.state?.sessionId);
			assert.ok(found);
			const imported = await data.invoke<SessionHistoryImportResult>("pi:session:import-history", {
				token: found.token,
				activate: true,
			});
			assert.equal(imported.alreadyImported, false);
			assert.deepEqual(users(imported.snapshot), ["IPC common context", "IPC selected user"]);
			assert.equal((await data.service.snapshot()).active?.id, imported.conversation.id);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);

test(
	"session IPC rejects malformed identifiers, paths, options, and entry data without mutation",
	{ timeout: 30000 },
	async () => {
		const data = await setup();
		try {
			const before = await readFile(join(data.fixture.dataDir, "desktop.json"));
			const entries = await data.invoke<SessionEntriesResult>("pi:session:entries");
			const cases: { label: string; channel: string; args: unknown[]; pattern: RegExp }[] = [
				{ label: "Missing fork object", channel: "pi:session:fork", args: [], pattern: /参数格式/ },
				{ label: "Array fork object", channel: "pi:session:fork", args: [[]], pattern: /参数格式/ },
				{ label: "Entry id type", channel: "pi:session:fork", args: [{ entryId: 7 }], pattern: /文本格式|标识符/ },
				{
					label: "Entry traversal",
					channel: "pi:session:fork",
					args: [{ entryId: "../outside" }],
					pattern: /标识符/,
				},
				{
					label: "Conversation id type",
					channel: "pi:session:fork",
					args: [{ conversationId: {}, entryId: "entry" }],
					pattern: /文本格式|标识符/,
				},
				{
					label: "Clone activate type",
					channel: "pi:session:clone",
					args: [{ activate: "true" }],
					pattern: /选项格式/,
				},
				{
					label: "Clone title length",
					channel: "pi:session:clone",
					args: [{ title: "a".repeat(161) }],
					pattern: /文本格式/,
				},
				{
					label: "Navigation target type",
					channel: "pi:session:navigate",
					args: [{ targetId: [] }],
					pattern: /文本格式|标识符/,
				},
				{
					label: "Navigation target path",
					channel: "pi:session:navigate",
					args: [{ targetId: "/outside" }],
					pattern: /标识符/,
				},
				{
					label: "Navigation label type",
					channel: "pi:session:navigate",
					args: [{ targetId: "entry", label: 7 }],
					pattern: /文本格式/,
				},
				{
					label: "Navigation label NUL",
					channel: "pi:session:navigate",
					args: [{ targetId: "entry", label: "bad\0label" }],
					pattern: /文本格式/,
				},
				{
					label: "Entries cursor traversal",
					channel: "pi:session:entries",
					args: [{ since: "../outside" }],
					pattern: /标识符/,
				},
				{
					label: "Entries conversation null",
					channel: "pi:session:entries",
					args: [{ conversationId: null }],
					pattern: /文本格式|标识符/,
				},
				{ label: "Tree path", channel: "pi:session:tree", args: ["/outside"], pattern: /标识符/ },
				{
					label: "Fork messages NUL",
					channel: "pi:session:fork-messages",
					args: ["bad\0id"],
					pattern: /文本格式|标识符/,
				},
				{
					label: "History project type",
					channel: "pi:session:history",
					args: [{ project: {} }],
					pattern: /文本格式/,
				},
				{
					label: "History path NUL",
					channel: "pi:session:history",
					args: [{ sessionDir: "bad\0path" }],
					pattern: /文本格式/,
				},
				{
					label: "Raw source path cannot import",
					channel: "pi:session:import-history",
					args: [{ sourcePath: "/outside.jsonl" }],
					pattern: /标识符/,
				},
				{
					label: "Import token traversal",
					channel: "pi:session:import-history",
					args: [{ token: "../outside" }],
					pattern: /标识符/,
				},
				{
					label: "Import activation type",
					channel: "pi:session:import-history",
					args: [{ token: "unknown-token", activate: 1 }],
					pattern: /选项格式/,
				},
				{
					label: "Unissued import token",
					channel: "pi:session:import-history",
					args: [{ token: "unknown-token" }],
					pattern: /过期|不存在/,
				},
			];
			for (const item of cases)
				await assert.rejects(data.invoke(item.channel, ...item.args), item.pattern, item.label);
			assert.deepEqual(await data.invoke<SessionEntriesResult>("pi:session:entries"), entries);
			assert.equal((await data.service.snapshot()).conversations.length, 1);
			assert.deepEqual(await readFile(join(data.fixture.dataDir, "desktop.json")), before);
		} finally {
			await data.service.close();
			await data.fixture.cleanup();
		}
	},
);
