import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { CRON_WAKEUP_TYPE, type CronService } from "../src/cron-service.ts";
import type { CronJobRecord } from "../src/cron-types.ts";
import { MONITOR_EVENT_TYPE, SHELL_EVENT_TYPE } from "../src/monitor-service.ts";
import type { DesktopEvent } from "../src/shared.ts";
import type { DesktopToolInvocation, ToolHostContext } from "../src/tool-control-types.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(25);
	}
	assert.fail("timed out waiting for background work");
}

async function fixture() {
	const data = await createCoreFixture();
	const service = new DesktopService({
		dataDir: data.dataDir,
		executable: process.execPath,
		entry: data.entry,
		permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
		toolControlExtension: fileURLToPath(new URL("../src/tool-control-extension.ts", import.meta.url)),
		initialProject: data.project,
		env: { ...data.env, HOME: data.root },
		childRuntimeReapIntervalMs: 0,
	});
	const internals = service as unknown as {
		runtimes: Map<string, unknown>;
		reapIdleRuntimes(idleMs: number): Promise<number>;
		cron: Pick<CronService, "processDue"> & { jobs: Map<string, CronJobRecord> };
		modelTool(call: DesktopToolInvocation, context: ToolHostContext): Promise<Record<string, unknown>>;
	};
	const events: DesktopEvent[] = [];
	service.subscribe((event) => events.push(event));
	async function close() { await service.close(); await data.cleanup(); }
	return { data, service, internals, events, close };
}

function hasNotification(events: DesktopEvent[], conversationId: string, customType: string, text: string): boolean {
	return events.some(({ conversationId: owner, event }) => owner === conversationId &&
		event.type === "message_end" && event.message.role === "custom" && event.message.customType === customType &&
		JSON.stringify(event.message).includes(text));
}

test("switching and idle reaping preserve managed shells and Monitor delivery on the original conversation", { timeout: 20000 }, async () => {
	const { service, data, internals, events, close } = await fixture();
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready");
		const owner = snapshot.active!.id;
		await service.saveSettings({ permission: "auto", theme: "light" });
		const call = (tool: "BashBackground" | "Monitor", input: Record<string, unknown>) =>
			internals.modelTool({ tool, toolCallId: tool, input }, { conversationId: owner, toolCallId: tool, signal: new AbortController().signal });
		const wait = "while [ ! -f ready.flag ]; do sleep 0.1; done;";
		const shell = await call("BashBackground", { command: `${wait} printf 'kept-shell\\n'`, description: "detached shell" });
		const monitor = await call("Monitor", {
			command: `${wait} printf 'kept-monitor\\n'; sleep 1`,
			description: "detached monitor",
			timeout_ms: 12000,
		});
		const next = (await service.newConversation()).active!.id;
		assert.notEqual(next, owner);
		assert.equal(await internals.reapIdleRuntimes(0), 0);
		const current = await service.listMonitors(owner);
		assert.equal(current.find((m) => m.id === shell.shell_id)?.status, "running");
		assert.equal(current.find((m) => m.id === monitor.monitor_id)?.status, "running");

		await writeFile(join(data.project, "ready.flag"), "");
		await waitFor(() => hasNotification(events, owner, SHELL_EVENT_TYPE, "detached shell"));
		await waitFor(() => hasNotification(events, owner, MONITOR_EVENT_TYPE, "kept-monitor"));
		assert.equal((await service.snapshot()).active?.id, next);
	} finally {
		await close();
	}
});

test("a due Cron job wakes its cold session without changing the current conversation", { timeout: 15000 }, async () => {
	const { service, data, internals, events, close } = await fixture();
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready");
		const owner = snapshot.active!.id;
		await service.setProjectTrust({ project: data.project, decision: "trusted" });
		const scheduled = await service.createCron(owner, { prompt: "cron fixture", interval_seconds: 30 });
		const next = (await service.newConversation()).active!.id;
		assert.notEqual(next, owner);
		assert.equal(internals.runtimes.has(owner), false);
		internals.cron.jobs.get(scheduled.id)!.nextRunAt = Date.now() - 1;

		await internals.cron.processDue();
		await waitFor(() => hasNotification(events, owner, CRON_WAKEUP_TYPE, "cron fixture"));
		assert.equal((await service.listCron(owner)).find((job) => job.id === scheduled.id)?.runCount, 1);
		assert.equal((await service.snapshot()).active?.id, next);
	} finally {
		await close();
	}
});
