import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { HooksService, hookEventNames } from "../src/hooks-service.ts";
import { evaluatePermission, loadRuntimePermissionPolicy } from "../src/permission-policy.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/permission-extension.ts");
const toolControlPath = resolve(here, "../src/tool-control-extension.ts");
const navigationPath = resolve(here, "../src/session-navigation-extension.ts");
const historyPath = resolve(here, "../src/session-history-entry.ts");

/** Keep ~/.claude/settings.json of the real user out of these tests. */
async function isolatedHome(root: string): Promise<() => void> {
	const previous = process.env.HOME;
	process.env.HOME = root;
	return () => {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	};
}

/** A command hook that appends its stdin JSON as one line to `log`. */
async function recorder(root: string, log: string): Promise<string> {
	const script = join(root, "record.mjs");
	await writeFile(
		script,
		`import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, readFileSync(0, "utf8").trim() + "\\n");\n`,
	);
	return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

async function readLog(log: string): Promise<Record<string, unknown>[]> {
	const raw = await readFile(log, "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("SessionEnd and PostCompact are known events with reason/trigger matchers", async () => {
	assert.ok(hookEventNames.includes("SessionEnd"));
	assert.ok(hookEventNames.includes("PostCompact"));
	const root = await mkdtemp(join(tmpdir(), "pi-batch2-hooks-"));
	const restore = await isolatedHome(root);
	try {
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const log = join(root, "log.jsonl");
		const command = await recorder(root, log);
		// Claude-style nested groups, as imported from .claude/settings.json files.
		await writeFile(
			join(agentDir, "hooks.json"),
			JSON.stringify({
				version: 1,
				hooks: {
					SessionEnd: [{ matcher: "close", hooks: [{ type: "command", command }] }],
					PostCompact: [{ matcher: "auto", hooks: [{ type: "command", command }] }],
				},
			}),
		);
		let disabled = false;
		const hooks = new HooksService({ agentDir: () => agentDir, disabled: () => disabled });
		const listed = await hooks.list(undefined, false);
		assert.deepEqual(listed.map((entry) => entry.event).sort(), ["PostCompact", "SessionEnd"]);

		const base = { projectTrusted: false, conversationId: "c1", permissionMode: "ask" };
		assert.equal((await hooks.run("SessionEnd", { ...base, reason: "other" })).executedCount, 0);
		assert.equal((await hooks.run("SessionEnd", { ...base, reason: "close" })).executedCount, 1);
		assert.equal((await hooks.run("PostCompact", { ...base, trigger: "manual" })).executedCount, 0);
		assert.equal((await hooks.run("PostCompact", { ...base, trigger: "auto", compactSummary: "S" })).executedCount, 1);
		disabled = true;
		assert.equal((await hooks.run("SessionEnd", { ...base, reason: "close" })).executedCount, 0);

		const entries = await readLog(log);
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.hook_event_name, "SessionEnd");
		assert.equal(entries[0]!.reason, "close");
		assert.equal(entries[1]!.hook_event_name, "PostCompact");
		assert.equal(entries[1]!.trigger, "auto");
		assert.equal(entries[1]!.compact_summary, "S");
	} finally {
		restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("dontAsk policy denies what would otherwise prompt and keeps safe defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-batch2-policy-"));
	try {
		await writeFile(join(root, "seed.txt"), "x");
		// The env fallback maps the global mode to ask + dontAsk.
		const policy = await loadRuntimePermissionPolicy({ PI_DESKTOP_PERMISSION_MODE: "dontAsk" }, root);
		assert.equal(policy.mode, "ask");
		assert.equal(policy.dontAsk, true);
		assert.equal((await evaluatePermission(policy, { toolName: "read", input: { path: "seed.txt" } })).action, "allow");
		const bash = await evaluatePermission(policy, { toolName: "bash", input: { command: "touch made.txt" } });
		assert.equal(bash.action, "deny");
		assert.match(bash.reason, /dontAsk/);
		const write = await evaluatePermission(policy, { toolName: "write", input: { path: "a.txt", content: "a" } });
		assert.equal(write.action, "deny");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DesktopService maps dontAsk, fires PostCompact after compaction_end and SessionEnd on close", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const restore = await isolatedHome(fixture.root);
	const log = join(fixture.root, "hooks.jsonl");
	const command = await recorder(fixture.root, log);
	await writeFile(
		join(fixture.agentDir, "hooks.json"),
		JSON.stringify({
			version: 1,
			hooks: {
				SessionStart: [{ type: "command", command }],
				SessionEnd: [{ type: "command", command }],
				PostCompact: [{ type: "command", command }],
			},
		}),
	);
	let service: DesktopService | undefined = new DesktopService({
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
		let snap = await service.initialize();
		assert.equal(snap.engineStatus, "ready");
		const conversationId = snap.active!.id;
		const internals = service as unknown as {
			permissionPolicy(id: string): { mode: string; dontAsk?: boolean };
			runtimes: Map<string, unknown>;
			onEvent(runtime: unknown, event: unknown): void;
		};

		// Switching permission restarts the runtime: SessionEnd with reason "other".
		snap = await service.saveSettings({ permission: "dontAsk", theme: snap.settings.theme });
		assert.equal(snap.settings.permission, "dontAsk");
		const policy = internals.permissionPolicy(conversationId);
		assert.equal(policy.mode, "ask");
		assert.equal(policy.dontAsk, true);
		await waitFor(async () => (await readLog(log)).some((entry) => entry.hook_event_name === "SessionEnd"));
		const first = (await readLog(log)).find((entry) => entry.hook_event_name === "SessionEnd")!;
		assert.equal(first.reason, "other");
		assert.equal(first.session_id, conversationId);
		assert.equal(first.permission_mode, "ask");

		// Compaction results fire PostCompact; aborted or empty results do not.
		await waitFor(async () => internals.runtimes.has(conversationId));
		const runtime = internals.runtimes.get(conversationId);
		internals.onEvent(runtime, { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
		internals.onEvent(runtime, {
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "SUMMARY_TEXT", firstKeptEntryId: "x", tokensBefore: 10 },
			aborted: false,
			willRetry: false,
		});
		await waitFor(async () => (await readLog(log)).some((entry) => entry.hook_event_name === "PostCompact"));
		const compacts = (await readLog(log)).filter((entry) => entry.hook_event_name === "PostCompact");
		assert.equal(compacts.length, 1);
		assert.equal(compacts[0]!.trigger, "auto");
		assert.equal(compacts[0]!.compact_summary, "SUMMARY_TEXT");
		assert.equal(compacts[0]!.permission_mode, "dontAsk");

		await service.close();
		service = undefined;
		const ends = (await readLog(log)).filter((entry) => entry.hook_event_name === "SessionEnd");
		assert.equal(ends.length, 2);
		assert.equal(ends[1]!.reason, "close");
		assert.equal(ends[1]!.permission_mode, "dontAsk");
		// SessionStart of the restarted runtime agrees with its SessionEnd.
		const starts = (await readLog(log)).filter((entry) => entry.hook_event_name === "SessionStart");
		assert.ok(starts.length >= 2);
		assert.equal(starts.at(-1)!.permission_mode, "dontAsk");

		// The stored value survives a reload.
		const stored = JSON.parse(await readFile(join(fixture.dataDir, "state.json"), "utf8").catch(() => "{}")) as {
			settings?: { permission?: string };
		};
		if (stored.settings) assert.equal(stored.settings.permission, "dontAsk");
	} finally {
		await service?.close();
		restore();
		await fixture.cleanup();
	}
});
