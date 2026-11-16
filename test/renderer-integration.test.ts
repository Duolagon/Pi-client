import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { applyEvent, transcript } from "../src/renderer/messages.ts";
import type { DesktopEvent } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function setup() {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(source, "permission-extension.ts"),
		env: fixture.env,
		initialProject: fixture.project,
	});
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		const snapshot = await service.saveSettings({ permission: "auto", theme: "light" });
		const id = snapshot.active!.id;
		let history = transcript(snapshot.messages);
		const events: DesktopEvent["event"][] = [];
		service.subscribe((packet) => {
			if (packet.conversationId !== id) return;
			events.push(packet.event);
			history = applyEvent(history, packet.event);
		});
		return { fixture, service, id, events, history: () => history };
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
}

async function until(check: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 15000) {
		if (check()) return;
		await delay(10);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

test("renderer reducer reconstructs real streamed text and tool results exactly once", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await data.service.command({ type: "prompt", message: "read-write-bash renderer transcript" }, data.id);
		await until(() => data.events.some((event) => event.type === "agent_settled"), "tool turn settlement");
		const snapshot = await data.service.snapshot();
		const history = data.history();
		assert.deepEqual(history.messages, snapshot.messages);
		assert.equal(history.streamingIndex, null);
		assert.equal(history.messages.filter((message) => message.role === "user").length, 1);
		assert.equal(history.messages.filter((message) => message.role === "toolResult").length, 3);
		assert.ok(data.events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"));
		const tools = Object.values(history.tools);
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "read", "write"]);
		assert.ok(tools.every((tool) => tool.status === "done"));
		assert.ok(tools.find((tool) => tool.name === "read")?.output.includes("seed-content"));
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("renderer reducer finalizes an aborted stream and continues without duplicated history", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await data.service.command({ type: "prompt", message: "slow-stream renderer abort" }, data.id);
		await until(() => data.events.some((event) => event.type === "message_update"), "partial response");
		assert.notEqual(data.history().streamingIndex, null);
		await data.service.command({ type: "abort" }, data.id);
		await until(() => data.events.some((event) => event.type === "agent_settled"), "aborted turn settlement");
		const stopped = await data.service.snapshot();
		assert.equal(stopped.state?.isStreaming, false);
		assert.equal(data.history().streamingIndex, null);
		assert.deepEqual(data.history().messages, stopped.messages);
		assert.ok(data.history().messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"));
		const mark = data.events.length;
		await data.service.command({ type: "prompt", message: "continue after renderer abort" }, data.id);
		await until(() => data.events.slice(mark).some((event) => event.type === "agent_settled"), "continued turn settlement");
		assert.equal(data.history().streamingIndex, null);
		assert.deepEqual(data.history().messages, (await data.service.snapshot()).messages);
		assert.equal(data.history().messages.filter((message) => message.role === "user").length, 2);
	} finally {
		await data.service.close();
		await data.fixture.cleanup();
	}
});

test("a renderer reloaded during streaming restores the exact prefix and replays only newer events", { timeout: 45000 }, async () => {
	const data = await setup();
	const packets: DesktopEvent[] = [];
	const unsubscribe = data.service.subscribe((packet) => {
		if (packet.conversationId === data.id) packets.push(packet);
	});
	try {
		await data.service.command({ type: "prompt", message: "slow-stream renderer reload" }, data.id);
		await until(() => packets.some((packet) => packet.event.type === "message_update" && packet.event.assistantMessageEvent.type === "text_delta"), "initial streamed prefix");
		const snapshot = await data.service.snapshot();
		assert.equal(snapshot.state?.isStreaming, true);
		assert.ok(snapshot.liveTranscript?.assistant);
		assert.ok(snapshot.eventSequence);
		assert.ok(!snapshot.messages.some((message) => message.role === "assistant"));
		const prefix = snapshot.liveTranscript.assistant.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		assert.ok(prefix.length > 0);
		// Delay applying the snapshot to exercise the IPC response/event crossing window.
		await until(() => packets.some((packet) => (packet.sequence ?? 0) > snapshot.eventSequence! && packet.event.type === "message_update" && packet.event.assistantMessageEvent.type === "text_delta"), "newer streamed delta");
		let restored = transcript(snapshot.messages, snapshot.liveTranscript);
		let sequence = snapshot.eventSequence;
		for (const packet of packets) {
			if (packet.sequence !== undefined && packet.sequence > sequence) {
				restored = applyEvent(restored, packet.event);
				sequence = packet.sequence;
			}
		}
		assert.notEqual(restored.streamingIndex, null);
		assert.deepEqual(restored.messages, data.history().messages);
		const partial = restored.messages[restored.streamingIndex!];
		assert.equal(partial.role, "assistant");
		if (partial.role === "assistant") {
			const text = partial.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			assert.ok(text.startsWith(prefix));
			assert.ok(text.length > prefix.length);
		}
		const resume = data.service.subscribe((packet) => {
			if (packet.conversationId === data.id && packet.sequence !== undefined && packet.sequence > sequence) {
				restored = applyEvent(restored, packet.event);
				sequence = packet.sequence;
			}
		});
		try {
			await data.service.command({ type: "abort" }, data.id);
			await until(() => packets.some((packet) => packet.event.type === "agent_settled"), "stopped reloaded stream");
			const final = await data.service.snapshot();
			assert.equal(restored.streamingIndex, null);
			assert.deepEqual(restored.messages, final.messages);
			assert.equal(restored.messages.filter((message) => message.role === "assistant").length, 1);
			assert.equal(final.liveTranscript?.assistant, undefined);
			assert.deepEqual(final.liveTranscript?.tools, {});
		} finally {
			resume();
		}
	} finally {
		unsubscribe();
		await data.service.close();
		await data.fixture.cleanup();
	}
});
