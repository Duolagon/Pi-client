import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { applyEvent, transcript } from "../src/renderer/messages.ts";
import {
	SUBAGENT_RETENTION_MS,
	buildSubagentPanelState,
	classifySubagentViewSlash,
	groupSidebarConversations,
} from "../src/renderer/subagent-panel-state.ts";
import type { Conversation, DesktopEvent, DesktopTask } from "../src/shared.ts";
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

test("SubagentPanel 30s retention, sidebar subagent folding, and subagent slash guards", () => {
	const base = 1_000_000;
	const makeTask = (overrides: Partial<DesktopTask>): DesktopTask => ({
		id: "t",
		conversationId: "c",
		project: "/repo",
		workingDirectory: "/repo",
		title: "work",
		prompt: "do it",
		status: "running",
		createdAt: base,
		updatedAt: base,
		revision: 1,
		turn: 1,
		parentConversationId: "parent-1",
		subagentType: "Explore",
		runInBackground: true,
		...overrides,
	});
	const tasks: DesktopTask[] = [
		makeTask({ id: "running-1", conversationId: "c1", status: "running", name: "scout", updatedAt: base }),
		makeTask({ id: "done-recent", conversationId: "c2", status: "completed", updatedAt: base + 10_000 }),
		makeTask({ id: "failed-recent", conversationId: "c3", status: "failed", updatedAt: base + 10_000 }),
		makeTask({ id: "stopped-old", conversationId: "c4", status: "cancelled", updatedAt: base }),
		makeTask({ id: "other-parent", conversationId: "c5", parentConversationId: "parent-2", status: "running" }),
	];

	const at20 = buildSubagentPanelState(tasks, [], {}, "parent-1", base + 20_000);
	assert.deepEqual(at20.rows.map((r) => r.id), ["running-1", "failed-recent", "stopped-old"]);
	assert.equal(at20.completedHintCount, 1);

	const at31 = buildSubagentPanelState(tasks, [], {}, "parent-1", base + 31_000);
	assert.deepEqual(at31.rows.map((r) => r.id), ["running-1", "failed-recent"]);
	assert.equal(at31.completedHintCount, 1);

	const at45 = buildSubagentPanelState(tasks, [], {}, "parent-1", base + 10_000 + SUBAGENT_RETENTION_MS + 1000);
	assert.deepEqual(at45.rows.map((r) => r.id), ["running-1"]);
	assert.equal(at45.completedHintCount, 0);

	const convs: Conversation[] = [
		{ id: "parent-1", title: "Main", project: "/repo", updatedAt: base + 5000 },
		{ id: "child-1", title: "Explore", project: "/repo", updatedAt: base + 4000, kind: "subagent", parentConversationId: "parent-1" },
		{ id: "child-2", title: "Plan", project: "/repo", updatedAt: base + 3000, kind: "subagent", parentConversationId: "parent-1" },
		{ id: "orphan-1", title: "Orphan", project: "/repo", updatedAt: base + 2000, kind: "subagent", parentConversationId: "deleted-parent" },
	];
	const sidebar = groupSidebarConversations(convs, base + 6000);
	assert.deepEqual(sidebar.groups.flatMap((g) => g.items.map((c) => c.id)), ["parent-1"]);
	assert.deepEqual(sidebar.childrenByParent.get("parent-1")?.map((c) => c.id), ["child-1", "child-2"]);
	assert.deepEqual(sidebar.orphanedSubagents.map((c) => c.id), ["orphan-1"]);

	assert.equal(classifySubagentViewSlash("/model opus").action, "blocked");
	assert.deepEqual(classifySubagentViewSlash("/compact focus"), { action: "confirm_main", command: "compact", args: "focus" });
	assert.deepEqual(classifySubagentViewSlash("/clear"), { action: "confirm_main", command: "clear" });
	assert.deepEqual(classifySubagentViewSlash("continue checking tests"), { action: "send" });
});

test("snapshot marks delegated children as subagent and sendToTask advances turn to 2", { timeout: 45000 }, async () => {
	const data = await setup();
	const updated: DesktopTask[] = [];
	const unsub = data.service.subscribeTasks((event) => {
		if (event.type === "task_updated") updated.push(event.task);
	});
	try {
		const child = await data.service.startTask(
			{ message: "first turn hello", isolation: "shared" },
			{
				parentConversationId: data.id,
				parentToolCallId: "call-1",
				subagentType: "general-purpose",
				delegationDepth: 1,
				readOnly: true,
				runInBackground: true,
			},
		);
		await until(() => updated.some((t) => t.id === child.id && t.status === "completed"), "child turn 1 completion");
		const snap = await data.service.snapshot();
		const childConv = snap.conversations.find((c) => c.id === child.conversationId);
		assert.equal(childConv?.kind, "subagent");
		assert.equal(childConv?.parentConversationId, data.id);
		const sidebar = groupSidebarConversations(snap.conversations);
		assert.equal(sidebar.groups.flatMap((g) => g.items).some((c) => c.id === child.conversationId), false, "subagent is folded out of top-level sidebar");
		assert.equal(sidebar.childrenByParent.get(data.id)?.some((c) => c.id === child.conversationId), true);

		const sent = await data.service.sendToTask({ taskId: child.id, message: "second turn follow-up" });
		assert.equal(sent.status, "resumed");
		assert.equal(sent.task.turn, 2);
		await until(() => updated.some((t) => t.id === child.id && t.turn === 2 && t.status === "completed"), "child turn 2 completion");
	} finally {
		unsub();
		await data.service.close();
		await data.fixture.cleanup();
	}
});
