import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolSettingsStore } from "../src/tool-settings.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import type { PermissionRule } from "../src/permission-types.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-tool-settings-"));
	const project = join(directory, "project");
	await mkdir(project);
	const store = new ToolSettingsStore(directory);
	await store.initialize();
	return { directory, project, store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("tool enablement resolves conversation over project over global and null restores inheritance", async () => {
	const f = await fixture();
	try {
		await f.store.toggle({ name: "bash", enabled: false, scope: "global" });
		await f.store.toggle({ name: "bash", enabled: true, scope: "project", project: f.project });
		await f.store.toggle({ name: "bash", enabled: false, scope: "conversation", conversationId: "conversation-a" });
		assert.equal(f.store.effective(f.project, "conversation-a").overrides.bash, false);
		assert.equal(f.store.effective(f.project, "conversation-b").overrides.bash, true);
		assert.equal(f.store.effective(join(f.directory, "other"), "conversation-b").overrides.bash, false);
		await f.store.toggle({ name: "bash", enabled: null, scope: "conversation", conversationId: "conversation-a" });
		assert.equal(f.store.effective(f.project, "conversation-a").overrides.bash, true);
		await f.store.toggle({ name: "bash", enabled: null, scope: "project", project: f.project });
		assert.equal(f.store.effective(f.project, "conversation-a").overrides.bash, false);
		await f.store.toggle({ name: "bash", enabled: null, scope: "global" });
		assert.equal(f.store.effective(f.project, "conversation-a").overrides.bash, undefined);
	} finally { await f.cleanup(); }
});

test("permission scopes select applicable rules while global deny remains an upper bound", async () => {
	const f = await fixture();
	try {
		const rule = (overrides: Partial<PermissionRule>): PermissionRule => ({ id: "deny-global", scope: "global", tool: "write", action: "deny", ...overrides });
		await f.store.upsert(rule({}));
		await f.store.upsert(rule({ id: "allow-project", scope: "project", project: f.project, action: "allow" }));
		await f.store.upsert(rule({ id: "ask-conversation", scope: "conversation", conversationId: "conversation-a", action: "ask" }));
		await f.store.upsert(rule({ id: "unrelated-project", scope: "project", project: join(f.directory, "other"), tool: "read" }));
		const effective = f.store.effective(f.project, "conversation-a");
		assert.deepEqual(effective.rules.map((item) => item.id).sort(), ["allow-project", "ask-conversation", "deny-global"]);
		assert.equal((await evaluatePermission({ version: 1, mode: "auto", rules: effective.rules, disabledTools: [], project: f.project }, {
			toolName: "write", input: { path: "output.txt" },
		})).action, "deny");
		assert.deepEqual(f.store.effective(f.project, "conversation-b").rules.map((item) => item.id).sort(), ["allow-project", "deny-global"]);
	} finally { await f.cleanup(); }
});

test("tool settings persist isolated scopes and returning values cannot mutate stored policy", async () => {
	const f = await fixture();
	try {
		await f.store.toggle({ name: "mcp__docs__search", enabled: false, scope: "conversation", conversationId: "conversation-a" });
		await f.store.upsert({ id: "ask-read", scope: "global", tool: "read", action: "ask" });
		const copy = f.store.rules();
		copy[0].action = "allow";
		assert.equal(f.store.rules()[0].action, "ask");
		const reloaded = new ToolSettingsStore(f.directory);
		await reloaded.initialize();
		assert.deepEqual(reloaded.rules(), f.store.rules());
		assert.equal(reloaded.effective(f.project, "conversation-a").overrides.mcp__docs__search, false);
		assert.equal(reloaded.effective(f.project, "conversation-b").overrides.mcp__docs__search, undefined);
		await reloaded.remove("ask-read");
		assert.deepEqual(reloaded.rules(), []);
		const stored = JSON.parse(await readFile(join(f.directory, "tool-settings.json"), "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), ["rules", "tools", "version"]);
	} finally { await f.cleanup(); }
});

test("invalid scopes, selector types and malformed saved settings are rejected", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.store.toggle({ name: "bash", enabled: false, scope: "project", project: "relative" }));
		await assert.rejects(f.store.toggle({ name: "bash", enabled: false, scope: "conversation" }));
		await assert.rejects(f.store.toggle({ name: "*", enabled: false, scope: "global" }));
		await assert.rejects(f.store.upsert({ id: "bad", scope: "global", tool: "bash", action: "unexpected" } as never));
		await writeFile(join(f.directory, "tool-settings.json"), JSON.stringify({ version: 2, rules: [], tools: [] }));
		await assert.rejects(new ToolSettingsStore(f.directory).initialize());
		await writeFile(join(f.directory, "tool-settings.json"), "invalid JSON");
		await assert.rejects(new ToolSettingsStore(f.directory).initialize());
	} finally { await f.cleanup(); }
});

test("failed atomic persistence does not update the in-memory policy", async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.directory, "tool-settings.json.tmp"));
		await assert.rejects(f.store.toggle({ name: "bash", enabled: false, scope: "global" }));
		assert.equal(f.store.effective(f.project, "conversation-a").overrides.bash, undefined);
	} finally { await f.cleanup(); }
});
