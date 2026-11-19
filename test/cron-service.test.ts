import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CRON_LIFETIME_MS,
	CronService,
	computeNextCronRun,
	parseCronExpression,
	parseLoopCommandArgs,
} from "../src/cron-service.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("Cron expression parser, /loop parser, and 7-day validation enforce bounds", () => {
	const parsed = parseCronExpression("*/15 9-17 * * 1-5");
	assert.deepEqual([...parsed.minute.values], [0, 15, 30, 45]);
	assert.equal(parsed.dow.values.has(0), false);
	assert.equal(parsed.dow.values.has(3), true);

	assert.throws(() => parseCronExpression("*/5 * * *"), /5 fields/);
	assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);

	const base = Date.UTC(2026, 10, 19, 10, 2, 0);
	const next = computeNextCronRun("*/5 * * * *", base, 0);
	assert.ok(next > base && next <= base + 5 * 60 * 1000);

	assert.deepEqual(parseLoopCommandArgs("5m check build status"), {
		interval_seconds: 300,
		prompt: "check build status",
	});
	assert.deepEqual(parseLoopCommandArgs("0 */2 * * * summarize logs"), {
		cron: "0 */2 * * *",
		prompt: "summarize logs",
	});
	assert.deepEqual(parseLoopCommandArgs("check logs every 30s"), {
		interval_seconds: 30,
		prompt: "check logs",
	});
	assert.deepEqual(parseLoopCommandArgs("just monitor health"), {
		interval_seconds: 600,
		prompt: "just monitor health",
	});

	assert.throws(() => validateDesktopToolInput("ScheduleWakeup", { delay_seconds: 0, reason: "x" }), /delay_seconds/);
	assert.throws(() => validateDesktopToolInput("ScheduleWakeup", { delay_seconds: 604801, reason: "x" }), /delay_seconds/);
	assert.throws(() => validateDesktopToolInput("CronCreate", { prompt: "x" }), /exactly one/);
});

test("CronService enforces idle-only delivery, one-shot wakeup retry on settle, and global enable toggle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cron-idle-"));
	try {
		let enabled = true;
		let idle = false;
		const delivered: Array<{ key?: string; content: string }> = [];
		const service = new CronService({
			dataDir: () => dir,
			isEnabled: () => enabled,
			isProjectTrusted: () => true,
			applyJitter: false,
			deliver: async (_cid, params) => {
				if (params.idleOnly && !idle) return "deferred";
				delivered.push({ key: params.key, content: params.content });
				return "sent";
			},
		});

		try {
			const job = await service.scheduleWakeup({
				conversationId: "parent-1",
				input: { delay_seconds: 1, reason: "recheck CI status" },
			});
			assert.equal(job.expiresAt - job.createdAt, CRON_LIFETIME_MS);

			// Force due while busy -> deferred, not consumed
			(service as unknown as { jobs: Map<string, { nextRunAt: number }> }).jobs.get(job.id)!.nextRunAt = Date.now() - 10;
			await service.processDue();
			assert.equal(delivered.length, 0);

			// Disable globally -> even when idle, will not fire while cronEnabled=false
			idle = true;
			enabled = false;
			service.onConversationSettled("parent-1");
			await service.processDue();
			assert.equal(delivered.length, 0);
			await assert.rejects(
				service.create({ conversationId: "parent-1", input: { interval_seconds: 30, prompt: "hi" } }),
				/cronEnabled/,
			);

			// Re-enable -> idle retry delivers once and deletes one-shot wakeup
			enabled = true;
			service.onConversationSettled("parent-1");
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(delivered.length, 1);
			assert.match(delivered[0]!.content, /recheck CI status/);
			assert.equal((await service.list("parent-1")).length, 0);
		} finally {
			await service.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("CronService stores durable tasks in private .pi/scheduled_tasks.json gated by project trust & schema validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cron-trust-"));
	const project = join(dir, "proj");
	const dataDir = join(dir, "data");
	await mkdir(project, { recursive: true });
	await mkdir(dataDir, { recursive: true });

	try {
		let trusted = false;
		const untrustedService = new CronService({
			dataDir: () => dataDir,
			isEnabled: () => true,
			isProjectTrusted: () => trusted,
			deliver: async () => "sent",
		});
		try {
			await assert.rejects(
				untrustedService.create({
					conversationId: "root-1",
					project,
					input: { interval_seconds: 60, prompt: "watch tests", durable: true },
				}),
				/尚未被信任/,
			);
		} finally {
			await untrustedService.close();
		}

		// Trusted project persists to .pi/scheduled_tasks.json with jitter and validates on reload
		trusted = true;
		const trustedService = new CronService({
			dataDir: () => dataDir,
			isEnabled: () => true,
			isProjectTrusted: () => trusted,
			applyJitter: true,
			deliver: async () => "sent",
		});
		let createdId: string;
		try {
			const job = await trustedService.create({
				conversationId: "root-1",
				project,
				input: { interval_seconds: 60, prompt: "watch tests", durable: true },
			});
			createdId = job.id;
			assert.ok(job.jitterMs >= 0 && job.jitterMs <= 6000);
			const savedRaw = JSON.parse(await readFile(join(project, ".pi", "scheduled_tasks.json"), "utf8")) as {
				version: number;
				jobs: Array<{ id: string }>;
			};
			assert.equal(savedRaw.version, 1);
			assert.equal(savedRaw.jobs[0]?.id, createdId);

			// Inject a poisoned entry (> 7d expiry) + unknown field directly on disk
			savedRaw.jobs.push({
				id: "poisoned",
				conversationId: "root-1",
				project,
				prompt: "evil",
				intervalMs: 10000,
				recurring: true,
				durable: true,
				jitterMs: 0,
				createdAt: Date.now(),
				expiresAt: Date.now() + CRON_LIFETIME_MS * 10,
				nextRunAt: Date.now() + 1000,
				runCount: 0,
				enabled: true,
				source: "tool",
				extraEvilField: true,
			} as never);
			await writeFile(join(project, ".pi", "scheduled_tasks.json"), JSON.stringify(savedRaw));
		} finally {
			await trustedService.close();
		}

		// Reloading ignores the tampered entry and refuses loading altogether when untrusted
		trusted = false;
		const blockedReload = new CronService({
			dataDir: () => dataDir,
			isEnabled: () => true,
			isProjectTrusted: () => trusted,
			deliver: async () => "sent",
		});
		try {
			assert.equal((await blockedReload.list("root-1", project)).length, 0);
		} finally {
			await blockedReload.close();
		}

		trusted = true;
		const cleanReload = new CronService({
			dataDir: () => dataDir,
			isEnabled: () => true,
			isProjectTrusted: () => trusted,
			deliver: async () => "sent",
		});
		try {
			const loaded = await cleanReload.list("root-1", project);
			assert.deepEqual(loaded.map((j) => j.id), [createdId!]);
		} finally {
			await cleanReload.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
