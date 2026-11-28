import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { AgentProcess } from "../src/rpc.ts";
import type { GrailEvent, GrailVerdict } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

interface ReviewRun {
	id: string;
	controller: AbortController;
	startedAt: number;
}

interface GrailInternals {
	store: { settings: { grailTimeoutSec?: number } };
	runtimes: Map<string, { agent: AgentProcess }>;
	grailWish(): Promise<{ since: number; wish: number; checkpoint: { id: string } }>;
	runGrail(conversation: { id: string }, run: ReviewRun): Promise<GrailVerdict>;
	atomicJson(path: string, value: unknown, beforePublish?: () => void): Promise<void>;
	grailModelRun(cwd: string, model: { provider: string; id: string }, prompt: string, budget: { spent: number; max: number }, deadline: number, signal: AbortSignal, id: string): Promise<string>;
}

async function setup(t: TestContext) {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	t.after(async () => {
		await service.close();
		await fixture.cleanup();
	});
	const snapshot = await service.initialize();
	const id = snapshot.active!.id;
	const events: GrailEvent[] = [];
	service.subscribeGrail((event) => events.push(event));
	return { service, internals: service as unknown as GrailInternals, fixture, id, events };
}

function verdict(conversationId: string, run: ReviewRun): GrailVerdict {
	return {
		id: run.id, conversationId, wish: 0, startedAt: run.startedAt, finishedAt: Date.now(),
		grade: "unjudgeable", reasons: [], steps: {}, requirement: [], files: [], costUsd: 0,
	};
}

test("a new Grail start cancels the running one and cancel waits for cleanup", { timeout: 10000 }, async (t) => {
	const { service, internals, id, events } = await setup(t);
	const signals: AbortSignal[] = [];
	const cleanup = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	internals.runGrail = async (conversation, run) => {
		signals.push(run.controller.signal);
		if (signals.length === 1) {
			await cleanup.promise;
			run.controller.signal.throwIfAborted();
		} else second.resolve();
		return verdict(conversation.id, run);
	};
	try {
		const first = await service.startGrail(id);
		while (!signals.length) await new Promise((resolve) => setImmediate(resolve));
		// The replacement waits until the first run has finished cleaning up.
		const restart = service.startGrail(id);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(signals[0].aborted, true);
		assert.equal(signals.length, 1);
		cleanup.resolve();
		const next = await restart;
		assert.notEqual(next.id, first.id);
		await second.promise;
		while (!events.some((event) => event.type === "grail_verdict")) await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(events[0], { type: "grail_failed", conversationId: id, id: first.id, error: "鉴定已取消。", cancelled: true });
		assert.equal(await service.cancelGrail(id), false);
		assert.deepEqual((await service.grailState(id)).verdicts.map((item) => item.id), [next.id]);
	} finally {
		cleanup.resolve();
	}
});

test("Grail cancellation before the report rename emits one final event and stores nothing", { timeout: 10000 }, async (t) => {
	const { service, internals, fixture, id, events } = await setup(t);
	const entered = Promise.withResolvers<void>();
	const publish = Promise.withResolvers<void>();
	internals.runGrail = async (conversation, run) => verdict(conversation.id, run);
	const atomicJson = internals.atomicJson.bind(internals);
	internals.atomicJson = async (path, value, beforePublish) => {
		if (beforePublish) {
			entered.resolve();
			await publish.promise;
		}
		await atomicJson(path, value, beforePublish);
	};
	try {
		const run = await service.startGrail(id);
		await entered.promise;
		const cancellation = service.cancelGrail(id);
		publish.resolve();
		assert.equal(await cancellation, true);
		assert.deepEqual(events, [{ type: "grail_failed", conversationId: id, id: run.id, error: "鉴定已取消。", cancelled: true }]);
		await assert.rejects(readFile(join(fixture.dataDir, "grail", `${id}.json`)), { code: "ENOENT" });
	} finally {
		publish.resolve();
	}
});

test("Grail timeout also covers snapshot preparation and is distinct from user cancellation", { timeout: 10000 }, async (t) => {
	const { service, internals, id } = await setup(t);
	internals.store.settings.grailTimeoutSec = 0.01;
	internals.runGrail = async (_conversation, run) => {
		const { signal } = run.controller;
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		throw new Error("The audit fixture should never produce a verdict");
	};
	const terminal = Promise.withResolvers<GrailEvent>();
	service.subscribeGrail((event) => terminal.resolve(event));
	const run = await service.startGrail(id);
	assert.deepEqual(await terminal.promise, { type: "grail_failed", conversationId: id, id: run.id, error: "鉴定超时。", cancelled: false });
	assert.equal((await service.grailState(id)).running, undefined);
});

test("Grail does not launch a new model stage at an exhausted budget", { timeout: 10000 }, async (t) => {
	const { internals, fixture, id } = await setup(t);
	await assert.rejects(
		internals.grailModelRun(fixture.project, { provider: "desktop-test", id: "desktop-test-1" }, "local review",
			{ spent: 0.01, max: 0.01 }, Date.now() + 10000, new AbortController().signal, id),
		/鉴定费用额度已用完/,
	);
});

test("Grail cancels and times out during live history RPC without closing the agent", { timeout: 10000 }, async (t) => {
	const { service, internals, fixture, id, events } = await setup(t);
	const entry = join(fixture.root, "hung-history.mjs");
	await writeFile(entry, `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const { id, type } = JSON.parse(line);
	if (type === "get_entries") console.log(JSON.stringify({ type: "history_started" }));
	else console.log(JSON.stringify({ id, type: "response", command: type, success: true, data: "alive" }));
}`);
	let entered = Promise.withResolvers<void>();
	const transport = new AgentProcess({
		executable: process.execPath, entry, cwd: fixture.project, args: [], env: fixture.env,
		onEvent: () => entered.resolve(),
	});
	t.after(() => transport.stop());
	const interactive = internals.runtimes.get(id)!.agent;
	const request = interactive.request.bind(interactive);
	interactive.request = <T>(command: Parameters<AgentProcess["request"]>[0], signal?: AbortSignal) => command.type === "get_entries" && signal
		? transport.request<T>(command, signal)
		: request<T>(command, signal);
	internals.grailWish = async () => ({ wish: 0, since: 0, checkpoint: { id: "unused" } });

	const first = await service.startGrail(id);
	await entered.promise;
	assert.equal(await service.cancelGrail(id), true);
	assert.deepEqual(events.at(-1), { type: "grail_failed", conversationId: id, id: first.id, error: "鉴定已取消。", cancelled: true });
	assert.equal(await transport.request({ type: "get_state" }), "alive");

	entered = Promise.withResolvers<void>();
	internals.store.settings.grailTimeoutSec = 0.5;
	const terminal = Promise.withResolvers<GrailEvent>();
	const unsubscribe = service.subscribeGrail((event) => terminal.resolve(event));
	t.after(unsubscribe);
	const second = await service.startGrail(id);
	await entered.promise;
	assert.deepEqual(await terminal.promise, { type: "grail_failed", conversationId: id, id: second.id, error: "鉴定超时。", cancelled: false });
	assert.equal(await transport.request({ type: "get_state" }), "alive");
	assert.ok(await interactive.request({ type: "get_state" }));
});
