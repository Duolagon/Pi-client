import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { localDay, UsageStatsCollector, usageRecordFromLine } from "../src/usage-stats.ts";
import { desktopProvider } from "../src/renderer/status-line-state.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/permission-extension.ts");
const toolControlPath = resolve(here, "../src/tool-control-extension.ts");
const navigationPath = resolve(here, "../src/session-navigation-extension.ts");
const historyPath = resolve(here, "../src/session-history-entry.ts");

const DAY = 24 * 60 * 60 * 1000;
/** Local noon keeps synthetic timestamps away from day boundaries in any time zone. */
function noon(daysAgo: number, now = Date.now()): number {
	const date = new Date(now - daysAgo * DAY);
	date.setHours(12, 0, 0, 0);
	return date.getTime();
}

function assistant(
	id: string,
	at: number,
	model: string,
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number },
	provider = "desktop-deepseek",
) {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			provider,
			model,
			timestamp: at,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				totalTokens: usage.input + usage.output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
			},
		},
	});
}

function session(id: string, lines: string[]): string {
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" });
	const user = JSON.stringify({
		type: "message",
		id: `${id}-u`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hi", timestamp: Date.now() },
	});
	return [header, user, ...lines].join("\n") + "\n";
}

test("usageRecordFromLine reads assistant usage and ignores other lines", () => {
	const at = noon(0);
	const record = usageRecordFromLine(assistant("a1", at, "deepseek-chat", { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 }));
	assert.ok(record);
	assert.equal(record.day, localDay(at));
	assert.equal(record.model, "desktop-deepseek/deepseek-chat");
	assert.deepEqual([record.input, record.output, record.cacheRead, record.cacheWrite, record.cost], [10, 5, 3, 2, 0.01]);
	assert.equal(usageRecordFromLine('{"type":"session","id":"x"}'), undefined);
	assert.equal(usageRecordFromLine("not json \"assistant\" \"usage\""), undefined);
	// Zero usage (an aborted reply) is not counted as a message.
	assert.equal(usageRecordFromLine(assistant("a2", at, "m", { input: 0, output: 0 })), undefined);
	// Negative or non-numeric values are treated as 0.
	const odd = usageRecordFromLine(assistant("a3", at, "m", { input: -5, output: 4 }));
	assert.equal(odd?.input, 0);
});

test("collector buckets by local day and model, dedupes forked copies and caches by size and mtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-usage-"));
	try {
		const now = Date.now();
		const parentLines = [
			assistant("p1", noon(0, now), "deepseek-chat", { input: 100, output: 50, cost: 0.02 }),
			assistant("p2", noon(1, now), "deepseek-chat", { input: 200, output: 100, cacheRead: 40, cost: 0.03 }),
			assistant("p3", noon(40, now), "deepseek-chat", { input: 999, output: 999, cost: 9 }),
		];
		const parent = join(root, "2026_parent.jsonl");
		await writeFile(parent, session("parent", parentLines));
		// A forked child copies p1 verbatim and adds its own reply on another model.
		const child = join(root, "fork-child.jsonl");
		await writeFile(
			child,
			session("child", [parentLines[0], assistant("c1", noon(1, now), "deepseek-reasoner", { input: 30, output: 20, cacheWrite: 10 })]),
		);
		const collector = new UsageStatsCollector();
		const report = await collector.collect([parent, child, join(root, "missing.jsonl")], { now });
		assert.equal(collector.lastReads, 2);
		assert.equal(report.files, 2);
		assert.equal(report.skipped, 1);
		assert.equal(report.rangeDays, 30);
		// p3 is 40 days old and outside the 30-day range; the duplicate p1 counts once.
		assert.equal(report.totals.messages, 3);
		assert.equal(report.totals.input, 330);
		assert.equal(report.totals.output, 170);
		assert.equal(report.totals.cacheRead, 40);
		assert.equal(report.totals.cacheWrite, 10);
		assert.equal(report.totals.tokens, 330 + 170 + 40 + 10);
		assert.ok(Math.abs(report.totals.cost - 0.05) < 1e-9);
		assert.deepEqual(
			report.days.map((day) => [day.key, day.messages]),
			[
				[localDay(noon(0, now)), 1],
				[localDay(noon(1, now)), 2],
			],
		);
		const models = Object.fromEntries(report.models.map((item) => [item.key, item]));
		assert.equal(models["desktop-deepseek/deepseek-chat"].messages, 2);
		assert.equal(models["desktop-deepseek/deepseek-reasoner"].cost, 0);
		assert.equal(report.models[0].key, "desktop-deepseek/deepseek-chat");

		// Unchanged files are served from cache.
		await collector.collect([parent, child], { now });
		assert.equal(collector.lastReads, 0);
		// A changed file is read again; the other stays cached.
		await writeFile(child, session("child", [assistant("c2", noon(0, now), "deepseek-reasoner", { input: 1, output: 1 })]));
		const later = new Date(now + 5000);
		await utimes(child, later, later);
		const updated = await collector.collect([parent, child], { now });
		assert.equal(collector.lastReads, 1);
		assert.equal(updated.totals.messages, 3);

		// A wider range includes the old reply.
		const wide = await collector.collect([parent], { now, days: 60 });
		assert.equal(wide.totals.messages, 3);
		assert.equal(wide.days.length, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("usageStats reads known conversations and child sessions inside the app session directory only", async () => {
	const fixture = await createCoreFixture();
	const sessions = join(fixture.dataDir, "sessions");
	await mkdir(sessions, { recursive: true });
	const now = Date.now();
	const parentFile = join(sessions, "2026-01-01_parent-1.jsonl");
	await writeFile(parentFile, session("parent-1", [assistant("p1", noon(0, now), "m1", { input: 10, output: 10, cost: 0.5 })]));
	// The child conversation has no stored sessionFile; it is found by its id suffix.
	await writeFile(
		join(sessions, "2026-01-01_child-1.jsonl"),
		session("child-1", [assistant("c1", noon(2, now), "m2", { input: 5, output: 5 })]),
	);
	// A session file of an unknown conversation is not read.
	await writeFile(join(sessions, "2026-01-01_stranger.jsonl"), session("stranger", [assistant("s1", noon(0, now), "m3", { input: 1000, output: 1 })]));
	// A path outside the session directory is refused even when a conversation names it.
	const outside = join(fixture.root, "outside.jsonl");
	await writeFile(outside, session("outside", [assistant("o1", noon(0, now), "m4", { input: 7777, output: 1 })]));
	await writeFile(
		join(fixture.dataDir, "desktop.json"),
		JSON.stringify({
			projects: [{ path: fixture.project, name: "project" }],
			conversations: [
				{ id: "parent-1", title: "父会话", project: fixture.project, sessionFile: parentFile, updatedAt: now },
				{ id: "child-1", title: "子会话", project: fixture.project, parentConversationId: "parent-1", updatedAt: now },
				{ id: "evil-1", title: "外部", project: fixture.project, sessionFile: outside, updatedAt: now },
			],
			activeId: "parent-1",
			settings: { permission: "ask", theme: "light", configuredProviders: [], connections: {} },
			keys: {},
			tasks: [],
		}),
	);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		await service.initialize();
		const report = await service.usageStats();
		assert.equal(report.totals.messages, 2);
		assert.equal(report.totals.input, 15);
		assert.deepEqual(report.models.map((item) => item.key).sort(), ["desktop-deepseek/m1", "desktop-deepseek/m2"]);
		assert.equal(report.days.length, 2);
		const short = await service.usageStats({ days: 1 });
		assert.equal(short.totals.messages, 1);

		// The status-line balance toggle persists only when turned off.
		const off = await service.saveSettings({ permission: "ask", theme: "light", statusBalance: false });
		assert.equal(off.settings.statusBalance, false);
		const on = await service.saveSettings({ permission: "ask", theme: "light", statusBalance: true });
		assert.equal(on.settings.statusBalance, undefined);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("desktopProvider maps runtime providers to desktop connections", () => {
	assert.equal(desktopProvider("desktop-deepseek"), "deepseek");
	assert.equal(desktopProvider("desktop-openrouter"), "openrouter");
	assert.equal(desktopProvider("desktop-unknown"), undefined);
	assert.equal(desktopProvider("deepseek"), undefined);
	assert.equal(desktopProvider(undefined), undefined);
});
