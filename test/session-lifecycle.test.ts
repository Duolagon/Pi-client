import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopService, type ServiceOptions } from "../src/backend.ts";
import type { DesktopEvent, Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function setup() {
	const fixture = await createCoreFixture();
	const options: ServiceOptions = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"),
		navigationExtension: join(source, "session-navigation-extension.ts"),
		historyEntry: join(source, "session-history-entry.ts"),
		env: fixture.env,
		initialProject: fixture.project,
	};
	const service = new DesktopService(options);
	const events: DesktopEvent[] = [];
	service.subscribe((event) => events.push(event));
	const initial = await service.initialize();
	assert.equal(initial.engineStatus, "ready", initial.engineError);
	assert.ok(initial.active);
	return { fixture, options, service, events, id: initial.active.id };
}

async function until(check: () => boolean, label: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 15000) {
		if (check()) return;
		await delay(10);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

async function prompt(service: DesktopService, events: DesktopEvent[], id: string, message: string): Promise<void> {
	const mark = events.length;
	await service.command({ type: "prompt", message }, id);
	await until(
		() => events.slice(mark).some((packet) => packet.conversationId === id && packet.event.type === "agent_settled"),
		"prompt settlement",
	);
}

function text(message: Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
}

function users(snapshot: Snapshot): string[] {
	return snapshot.messages.filter((message) => message.role === "user").map(text);
}

test("closing a streaming continuation preserves its selected branch after restart", { timeout: 45000 }, async () => {
	const data = await setup();
	let current = data.service;
	try {
		await prompt(current, data.events, data.id, "retained branch prefix");
		await prompt(current, data.events, data.id, "abandoned branch tail");
		const before = await current.sessionEntries({ conversationId: data.id });
		const target = before.entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				text(entry.message) === "abandoned branch tail",
		);
		assert.ok(target);
		const navigated = await current.navigateSession({ conversationId: data.id, targetId: target.id });
		const mark = data.events.length;
		await current.command({ type: "prompt", message: "slow-stream interrupted continuation" }, data.id);
		await until(
			() =>
				data.events
					.slice(mark)
					.some((packet) => packet.conversationId === data.id && packet.event.type === "message_update"),
			"partial response",
		);
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const restarted = await current.initialize();
		assert.equal(restarted.engineStatus, "ready", restarted.engineError);
		assert.deepEqual(users(restarted), ["retained branch prefix", "slow-stream interrupted continuation"]);
		const restored = await current.sessionEntries({ conversationId: data.id });
		assert.notEqual(restored.leafId, navigated.leafId);
		assert.ok(restored.entries.some((entry) => entry.id === target.id));
	} finally {
		await current.close();
		await data.fixture.cleanup();
	}
});

for (const cancelled of [false, true]) {
	test(
		`before-fork parent rename remains on the parent when replacement is ${cancelled ? "cancelled" : "successful"}`,
		{ timeout: 45000 },
		async () => {
			const data = await setup();
			try {
				await prompt(data.service, data.events, data.id, "parent hook fixture context");
				const parent = structuredClone((await data.service.snapshot()).active!);
				assert.ok(parent.sessionFile);
				await writeFile(
					join(data.fixture.agentDir, "extensions", "parent-name.js"),
					`export default function(pi) { pi.on("session_before_fork", () => { pi.setSessionName("parent renamed by hook"); return { cancel: ${cancelled} }; }); }`,
				);
				await data.service.saveSettings({ permission: "auto", theme: "light" });
				const result = await data.service.cloneSession({ conversationId: data.id, title: "explicit child title" });
				assert.equal(result.cancelled, cancelled);
				assert.equal(
					result.snapshot.conversations.find((conversation) => conversation.id === data.id)?.title,
					"parent renamed by hook",
				);
				const records = (await readFile(parent.sessionFile, "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { type: string; name?: string });
				assert.equal(
					records.filter((entry) => entry.type === "session_info").at(-1)?.name,
					"parent renamed by hook",
				);
				if (cancelled) {
					assert.equal(result.conversation, undefined);
					assert.equal(result.snapshot.active?.id, data.id);
					assert.equal(result.snapshot.conversations.length, 1);
				} else {
					assert.ok(result.conversation);
					assert.notEqual(result.conversation.id, data.id);
					assert.equal(result.conversation.title, "explicit child title");
					assert.equal(result.snapshot.state?.sessionId, result.conversation.id);
					const original = await data.service.selectConversation(data.id);
					assert.equal(original.engineStatus, "ready", original.engineError);
					assert.equal(original.active?.title, "parent renamed by hook");
					assert.equal(original.state?.sessionId, data.id);
				}
			} finally {
				await data.service.close();
				await data.fixture.cleanup();
			}
		},
	);
}

test(
	"renaming and configuring an empty conversation survives restart before its first message",
	{ timeout: 45000 },
	async () => {
		const data = await setup();
		let current = data.service;
		try {
			await current.renameConversation(data.id, "renamed empty conversation");
			await current.command({ type: "set_model", provider: "desktop-test", modelId: "desktop-test-2" }, data.id);
			await current.close();
			current = new DesktopService({ ...data.options, initialProject: undefined });
			const restarted = await current.initialize();
			assert.equal(restarted.engineStatus, "ready", restarted.engineError);
			assert.equal(restarted.active?.id, data.id);
			assert.equal(restarted.active.title, "renamed empty conversation");
			assert.equal(restarted.state?.model?.id, "desktop-test-2");
			assert.deepEqual(restarted.messages, []);
			const events: DesktopEvent[] = [];
			current.subscribe((event) => events.push(event));
			await prompt(current, events, data.id, "first message after empty restart");
			assert.deepEqual(users(await current.snapshot()), ["first message after empty restart"]);
		} finally {
			await current.close();
			await data.fixture.cleanup();
		}
	},
);

test("removing conversations keeps one active and survives restart", { timeout: 45000 }, async () => {
	const data = await setup();
	let current = data.service;
	try {
		const second = await current.newConversation();
		const secondId = second.active!.id;
		assert.notEqual(secondId, data.id);
		const afterInactive = await current.removeConversation(data.id);
		assert.equal(afterInactive.active?.id, secondId);
		assert.deepEqual(afterInactive.conversations.map((item) => item.id), [secondId]);
		const afterActive = await current.removeConversation(secondId);
		assert.equal(afterActive.conversations.length, 1);
		assert.ok(afterActive.active);
		assert.notEqual(afterActive.active.id, secondId);
		await assert.rejects(current.removeConversation(secondId), /会话不存在/);
		const keptId = afterActive.active.id;
		await current.close();
		current = new DesktopService({ ...data.options, initialProject: undefined });
		const restarted = await current.initialize();
		assert.deepEqual(restarted.conversations.map((item) => item.id), [keptId]);
	} finally {
		await current.close();
		await data.fixture.cleanup();
	}
});
