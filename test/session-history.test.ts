import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionHistoryService } from "../src/session-history.ts";

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-history-entry.ts");
const timestamp = "2026-01-02T03:04:05.000Z";
function session(project: string, id = "cli-source", name = "历史分支"): string {
	const entry = (type: string, id: string, parentId: string | null, fields: Record<string, unknown>) =>
		({ type, id, parentId, timestamp, ...fields });
	const user = (text: string) => ({ role: "user", content: text, timestamp: Date.parse(timestamp) });
	const assistant = (text: string) => ({
		role: "assistant", content: [{ type: "text", text }], timestamp: Date.parse(timestamp),
		api: "openai-completions", provider: "deepseek", model: "deepseek-chat", stopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	return [
		{ type: "session", version: 3, id, timestamp, cwd: project, parentSession: "/original/parent.jsonl", customHeader: "keep" },
		entry("model_change", "model", null, { provider: "deepseek", modelId: "deepseek-chat" }),
		entry("message", "u1", "model", { message: user("first question") }),
		entry("message", "a1", "u1", { message: assistant("first answer") }),
		entry("message", "u2", "a1", { message: user("old branch question") }),
		entry("message", "a2", "u2", { message: assistant("old branch answer") }),
		entry("compaction", "compact", "a2", { firstKeptEntryId: "u2", tokensBefore: 1000, summary: "compacted branch" }),
		entry("label", "label", "compact", { targetId: "a1", label: "keep this bookmark" }),
		entry("message", "alternative", "a1", { message: user("alternate branch question") }),
		entry("custom", "custom", "alternative", { customType: "test", data: { preserved: true } }),
		entry("session_info", "info", "custom", { name }),
	].map((value) => JSON.stringify(value)).join("\n");
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-session-history-")));
	const project = join(root, "project with spaces");
	const otherProject = join(root, "other-project");
	const agentDir = join(root, "isolated-agent");
	const dataDir = join(root, "desktop-data");
	const sourceDir = join(agentDir, "sessions", "--project--");
	await Promise.all([mkdir(project), mkdir(otherProject), mkdir(dataDir), mkdir(sourceDir, { recursive: true })]);
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: undefined, PI_OFFLINE: "1" };
	const options = { dataDir, executable: process.execPath, entry, env };
	const service = new SessionHistoryService(options);
	const source = join(sourceDir, "cli.jsonl");
	await writeFile(source, session(project));
	return { root, project, otherProject, agentDir, dataDir, sourceDir, source, options, service,
		cleanup: () => rm(root, { force: true, recursive: true }) };
}

test("CLI discovery exposes native tree metadata, filters projects and never repairs the source", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const before = await readFile(data.source);
		const beforeStat = await stat(data.source);
		await writeFile(join(data.sourceDir, "another.jsonl"), session(data.otherProject, "other-cli", "另一项目"));
		await writeFile(join(data.sourceDir, "broken.jsonl"), `${session(data.project)}\n{broken`);
		const all = await data.service.discover({ agentDir: data.agentDir });
		assert.equal(all.sessions.length, 2);
		assert.equal(all.skipped.length, 1);
		const listed = await data.service.discover({ agentDir: data.agentDir, project: data.project });
		assert.equal(listed.sessions.length, 1);
		const item = listed.sessions[0];
		assert.equal(item.title, "历史分支");
		assert.equal(item.sourceSessionId, "cli-source");
		assert.equal(item.project, data.project);
		assert.equal(item.messageCount, 5);
		assert.equal(item.entryCount, 10);
		assert.equal(item.branchCount, 2);
		assert.equal(item.leafId, "info");
		assert.deepEqual(item.model, { provider: "deepseek", modelId: "deepseek-chat" });
		assert.deepEqual(await readFile(data.source), before);
		assert.equal((await stat(data.source)).mtimeMs, beforeStat.mtimeMs);
	} finally { await data.cleanup(); }
});

test("import keeps every branch, compaction, label and header cwd and deduplicates across restarts", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const before = await readFile(data.source, "utf8");
		const beforeStat = await stat(data.source);
		const history = await data.service.discover({ agentDir: data.agentDir });
		const imports = await Promise.all([data.service.importSession({ token: history.sessions[0].token }),
			data.service.importSession({ token: history.sessions[0].token })]);
		assert.equal(imports[0].conversationId, imports[1].conversationId);
		assert.equal(imports.filter((item) => item.alreadyImported).length, 1);
		const imported = imports[0];
		assert.notEqual(imported.conversationId, "cli-source");
		const copy = await readFile(imported.sessionFile, "utf8");
		const sourceEntries = before.split("\n").map((line) => JSON.parse(line));
		const copiedEntries = copy.trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(copiedEntries.slice(1), sourceEntries.slice(1));
		assert.equal(copiedEntries[0].cwd, data.project);
		assert.equal(copiedEntries[0].customHeader, "keep");
		assert.equal(copiedEntries[0].parentSession, "/original/parent.jsonl");
		assert.equal(copiedEntries[0].id, imported.conversationId);
		if (process.platform !== "win32") assert.equal((await lstat(imported.sessionFile)).mode & 0o777, 0o600);
		const restored = new SessionHistoryService(data.options);
		const again = await restored.discover({ agentDir: data.agentDir });
		assert.equal(again.sessions[0].importedConversationId, imported.conversationId);
		assert.equal((await restored.importSession({ token: again.sessions[0].token })).alreadyImported, true);
		assert.equal(await readFile(imported.sessionFile, "utf8"), copy);
		assert.equal(await readFile(data.source, "utf8"), before);
		assert.equal((await stat(data.source)).mtimeMs, beforeStat.mtimeMs);
	} finally { await data.cleanup(); }
});

test("read-only inspect handles physical leaf, explicit empty root and alternate leaves without loading extensions", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		await mkdir(join(data.agentDir, "extensions"));
		await writeFile(join(data.agentDir, "extensions", "must-not-load.ts"), 'throw new Error("History readers must not execute CLI extensions");\n');
		const listed = await data.service.discover({ agentDir: data.agentDir });
		const imported = await data.service.importSession({ token: listed.sessions[0].token });
		const before = await readFile(imported.sessionFile);
		const beforeStat = await stat(imported.sessionFile);
		const selected = await data.service.inspect({ sessionFile: imported.sessionFile });
		assert.equal(selected.leafId, "info");
		assert.equal(selected.entries.length, 10);
		assert.equal(selected.tree[0].children[0].children[0].label, "keep this bookmark");
		assert.deepEqual(selected.forkMessages.map((message) => message.entryId), ["u1", "u2", "alternative"]);
		assert.match(JSON.stringify(selected.messages), /alternate branch question/);
		assert.doesNotMatch(JSON.stringify(selected.messages), /old branch question/);
		assert.equal((await data.service.inspect({ sessionFile: imported.sessionFile, leafId: "compact" })).leafId, "compact");
		assert.match(JSON.stringify((await data.service.inspect({ sessionFile: imported.sessionFile, leafId: "compact" })).messages), /compacted branch/);
		const empty = await data.service.inspect({ sessionFile: imported.sessionFile, leafId: null });
		assert.equal(empty.leafId, null);
		assert.deepEqual(empty.messages, []);
		await assert.rejects(data.service.inspect({ sessionFile: imported.sessionFile, leafId: "missing-entry" }), /not found/);
		assert.deepEqual(await readFile(imported.sessionFile), before);
		assert.equal((await stat(imported.sessionFile)).mtimeMs, beforeStat.mtimeMs);
		await assert.rejects(data.service.inspect({ sessionFile: data.source }), /超出允许目录/);
	} finally { await data.cleanup(); }
});

test("a changed CLI source expires its old token and becomes a new independent import", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const initial = await data.service.discover({ agentDir: data.agentDir });
		const imported = await data.service.importSession({ token: initial.sessions[0].token });
		const beforeCopy = await readFile(imported.sessionFile, "utf8");
		await writeFile(data.source, session(data.project, "cli-source", "changed"));
		await assert.rejects(data.service.importSession({ token: initial.sessions[0].token }), /历史已变化/);
		const changed = await data.service.discover({ agentDir: data.agentDir });
		const second = await data.service.importSession({ token: changed.sessions[0].token });
		assert.notEqual(second.conversationId, imported.conversationId);
		assert.equal(second.alreadyImported, false);
		assert.equal(await readFile(imported.sessionFile, "utf8"), beforeCopy);
		await assert.rejects(data.service.importSession({ token: data.source }), /已过期/);
	} finally { await data.cleanup(); }
});

test("discovery refuses symlink roots, files and project directories and detects replacement before import", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const outside = join(data.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.jsonl"), session(data.project, "outside-secret"));
		await symlink(outside, join(data.agentDir, "sessions", "linked-project"));
		await symlink(join(outside, "secret.jsonl"), join(data.sourceDir, "linked.jsonl"));
		await writeFile(join(data.sourceDir, "invalid-utf8.jsonl"), Buffer.from([0xc3, 0x28]));
		const listed = await data.service.discover({ agentDir: data.agentDir });
		assert.equal(listed.sessions.length, 1);
		assert.equal(listed.skipped.length, 3);
		const linkedRoot = join(data.root, "linked-root");
		await symlink(outside, linkedRoot);
		const explicit = await data.service.discover({ agentDir: data.agentDir, sessionDir: linkedRoot });
		assert.equal(explicit.sessions.length, 1);
		assert.ok(explicit.skipped.some((item) => item.path === linkedRoot));
		await rm(data.source);
		await symlink(join(outside, "secret.jsonl"), data.source);
		await assert.rejects(data.service.importSession({ token: listed.sessions[0].token }));
	} finally { await data.cleanup(); }
});

test("sessionDir follows host, environment, project and global precedence while retaining default history", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const dirs = Object.fromEntries(["global", "local", "environment", "explicit"].map((name) => [name, join(data.root, name)]));
		await Promise.all(Object.values(dirs).map((path) => mkdir(path)));
		for (const [name, path] of Object.entries(dirs)) await writeFile(join(path, `${name}.jsonl`), session(data.project, name, name));
		await writeFile(join(data.agentDir, "settings.json"), JSON.stringify({ sessionDir: dirs.global }));
		await mkdir(join(data.project, ".pi"));
		await writeFile(join(data.project, ".pi", "settings.json"), JSON.stringify({ sessionDir: dirs.local }));
		const global = await data.service.discover({ agentDir: data.agentDir });
		assert.deepEqual(new Set(global.sessions.map((item) => item.sourceSessionId)), new Set(["cli-source", "global"]));
		const local = await data.service.discover({ agentDir: data.agentDir, project: data.project });
		assert.deepEqual(new Set(local.sessions.map((item) => item.sourceSessionId)), new Set(["cli-source", "local"]));
		const service = new SessionHistoryService({ ...data.options, env: { ...data.options.env, PI_CODING_AGENT_SESSION_DIR: dirs.environment } });
		const environment = await service.discover({ agentDir: data.agentDir, project: data.project });
		assert.deepEqual(new Set(environment.sessions.map((item) => item.sourceSessionId)), new Set(["cli-source", "environment"]));
		const explicit = await service.discover({ agentDir: data.agentDir, project: data.project, sessionDir: dirs.explicit });
		assert.deepEqual(new Set(explicit.sessions.map((item) => item.sourceSessionId)), new Set(["cli-source", "explicit"]));
	} finally { await data.cleanup(); }
});

test("legacy migration is confined to the imported copy and invalid trees are skipped intact", { timeout: 30000 }, async () => {
	const data = await fixture();
	try {
		const legacy = [
			{ type: "session", version: 1, id: "legacy", timestamp, cwd: data.project },
			{ type: "message", timestamp, message: { role: "user", content: "legacy question", timestamp: Date.parse(timestamp) } },
			{ type: "message", timestamp, message: { role: "hookMessage", content: "legacy custom", customType: "legacy", timestamp: Date.parse(timestamp) } },
		].map((value) => JSON.stringify(value)).join("\n");
		await writeFile(data.source, legacy);
		const bad = session(data.project).replace('"parentId":"model"', '"parentId":"u1"');
		await writeFile(join(data.sourceDir, "cycle.jsonl"), bad);
		const listed = await data.service.discover({ agentDir: data.agentDir });
		assert.equal(listed.sessions.length, 1);
		assert.equal(listed.skipped.length, 1);
		const refreshed = await data.service.discover({ agentDir: data.agentDir });
		assert.equal(refreshed.sessions[0].token, listed.sessions[0].token);
		assert.equal(refreshed.sessions[0].leafId, listed.sessions[0].leafId);
		const imported = await data.service.importSession({ token: listed.sessions[0].token });
		const copy = (await readFile(imported.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.equal(copy[0].version, 3);
		assert.equal(copy[0].cwd, data.project);
		assert.equal(copy[2].message.role, "custom");
		assert.equal(copy[2].parentId, copy[1].id);
		assert.equal(copy[2].id, listed.sessions[0].leafId);
		assert.equal(await readFile(data.source, "utf8"), legacy);
		assert.equal(await readFile(join(data.sourceDir, "cycle.jsonl"), "utf8"), bad);
	} finally { await data.cleanup(); }
});

test("configured root ancestors may use system-style aliases while inspected app paths are canonical", { timeout: 30000 }, async () => {
	const data = await fixture();
	const alias = `${data.root}-alias`;
	try {
		await symlink(data.root, alias);
		const service = new SessionHistoryService({ ...data.options, dataDir: join(alias, "desktop-data") });
		const history = await service.discover({ agentDir: join(alias, "isolated-agent") });
		assert.equal(history.sessions.length, 1);
		assert.equal(history.sessions[0].sourcePath, data.source);
		const imported = await service.importSession({ token: history.sessions[0].token });
		const canonical = await realpath(imported.sessionFile);
		assert.equal((await service.inspect({ sessionFile: canonical })).leafId, "info");
		assert.equal((await service.inspect({ sessionFile: imported.sessionFile })).leafId, "info");
	} finally { await rm(alias, { force: true }); await data.cleanup(); }
});
