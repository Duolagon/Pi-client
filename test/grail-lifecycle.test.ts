import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import type { GrailEvent, GrailVerdict } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

interface ReviewRun {
	id: string;
	controller: AbortController;
	startedAt: number;
}

interface GrailInternals {
	store: { settings: { grailTimeoutSec?: number } };
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

test("concurrent Grail starts share one operation and cancel waits for cleanup", { timeout: 10000 }, async (t) => {
	const { service, internals, id, events } = await setup(t);
	const entered = Promise.withResolvers<AbortSignal>();
	const cleanup = Promise.withResolvers<void>();
	let launched = 0;
	internals.runGrail = async (conversation, run) => {
		launched++;
		entered.resolve(run.controller.signal);
		await cleanup.promise;
		return verdict(conversation.id, run);
	};
	try {
		const [first, second] = await Promise.all([service.startGrail(id), service.startGrail(id)]);
		assert.deepEqual(first, second);
		const signal = await entered.promise;
		assert.equal(launched, 1);
		const cancelled = service.cancelGrail(id);
		assert.equal(signal.aborted, true);
		assert.equal(events.length, 0);
		await assert.rejects(service.startGrail(id), /仍在清理/);
		cleanup.resolve();
		assert.equal(await cancelled, true);
		assert.deepEqual(events, [{ type: "grail_failed", conversationId: id, id: first.id, error: "鉴定已取消。", cancelled: true }]);
		assert.deepEqual((await service.grailState(id)).verdicts, []);
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
