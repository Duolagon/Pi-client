import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopService } from "../src/backend.ts";
import type { Message, Snapshot } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
	const started = Date.now();
	let value: T;
	do {
		value = await read();
		if (predicate(value)) return value;
		await delay(25);
	} while (Date.now() - started < 20000);
	throw new Error(`Timed out: ${label}; latest ${JSON.stringify(value).slice(-2000)}`);
}
function content(message: Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function completed(snapshot: Snapshot): boolean {
	return !snapshot.state?.isStreaming && snapshot.messages.some((message) => message.role === "assistant" && content(message).includes("POLICY_PARENT_COMPLETE"));
}
async function setup() {
	const fixture = await createCoreFixture();
	const project = await realpath(fixture.project);
	await cp(join(here, "fixtures/delegation-policy-provider.js"), join(fixture.agentDir, "extensions/delegation-policy-provider.js"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "policy-delegation-test", defaultModel: "policy-delegation-1", thinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
	const gitEnv = { ...fixture.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	await exec("git", ["-c", "init.defaultBranch=main", "init"], { cwd: project, env: gitEnv });
	await exec("git", ["add", "--", "seed.txt"], { cwd: project, env: gitEnv });
	await exec("git", ["-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize policy fixture"], { cwd: project, env: gitEnv });
	const gate = join(fixture.root, "permission-gate");
	const service = new DesktopService({
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry, initialProject: project,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		env: { ...fixture.env, PI_POLICY_TEST_GATE: gate },
	});
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		await service.saveSettings({ permission: "auto", theme: "light" });
		return { fixture, service, project, gate, parentId: initial.active!.id };
	} catch (error) { await service.close(); await fixture.cleanup(); throw error; }
}

test("real writable child deduplicates inherited global rules and obeys parent path denies and disabled tools", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await data.service.upsertPermission({ id: "global-read-rule", scope: "global", action: "allow", tool: "read", path: "seed.txt" });
		await data.service.upsertPermission({ id: "project-deny-file", scope: "project", project: data.project, action: "deny", tool: "write", path: "denied.txt" });
		await data.service.setToolEnabled({ name: "bash", enabled: false, scope: "conversation", conversationId: data.parentId });
		await data.service.command({ type: "prompt", message: "POLICY_PARENT INITIAL" });
		const snapshot = await until(() => data.service.snapshot(), completed, "inherited policy child result");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "completed");
		assert.equal(child.parentConversationId, data.parentId);
		assert.notEqual(child.workingDirectory, data.project);
		assert.equal(await readFile(join(child.workingDirectory, "allowed.txt"), "utf8"), "child policy still permits this write\n");
		await assert.rejects(access(join(child.workingDirectory, "denied.txt")));
		await assert.rejects(access(join(child.workingDirectory, "forbidden-shell.txt")));
		assert.ok(snapshot.messages.some((message) => message.role === "assistant" && content(message).includes("read:ok,write:ok,write:error,bash:error")));
		const policy = (await data.service.permissionSettings(child.conversationId)).effective;
		assert.equal(new Set(policy.rules.map((rule) => rule.id)).size, policy.rules.length);
		assert.ok(policy.disabledTools.includes("bash"));
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});

test("new parent conversation denies and tool revocations reach an already-running child before its next call", { timeout: 45000 }, async () => {
	const data = await setup();
	try {
		await data.service.command({ type: "prompt", message: "POLICY_PARENT LIVE" });
		await until(() => access(`${data.gate}.entered`).then(() => true, () => false), Boolean, "child synchronization gate");
		const [child] = await data.service.listTasks();
		assert.equal(child.status, "running");
		await data.service.upsertPermission({ id: "live-deny-file", scope: "conversation", conversationId: data.parentId, action: "deny", tool: "write", path: "denied.txt" });
		await data.service.setToolEnabled({ name: "bash", enabled: false, scope: "conversation", conversationId: data.parentId });
		await writeFile(data.gate, "release");
		const snapshot = await until(() => data.service.snapshot(), completed, "live-revoked child result");
		assert.equal((await data.service.listTasks())[0].status, "completed");
		assert.equal(await readFile(join(child.workingDirectory, "allowed.txt"), "utf8"), "child policy still permits this write\n");
		await assert.rejects(access(join(child.workingDirectory, "denied.txt")));
		await assert.rejects(access(join(child.workingDirectory, "forbidden-shell.txt")));
		assert.ok(snapshot.messages.some((message) => message.role === "assistant" && content(message).includes("policy_pause:ok,read:ok,write:ok,write:error,bash:error")));
		assert.equal((await data.service.checkPermission({ conversationId: child.conversationId, toolName: "write", input: { path: "denied.txt" } })).action, "deny");
		// A delegatedOnly allow rule on the parent never overrides the parent's deny ceiling or disabled tools.
		await data.service.upsertPermission({
			id: "tree-allow-all-writes",
			scope: "conversation",
			conversationId: data.parentId,
			delegatedOnly: true,
			action: "allow",
			tool: "write",
		});
		await data.service.upsertPermission({
			id: "tree-allow-bash",
			scope: "conversation",
			conversationId: data.parentId,
			delegatedOnly: true,
			action: "allow",
			tool: "bash",
		});
		assert.equal(
			(await data.service.checkPermission({ conversationId: child.conversationId, toolName: "write", input: { path: "denied.txt" } })).action,
			"deny",
			"parent deny rule still overrides delegatedOnly allow rule",
		);
		assert.equal(
			(await data.service.checkPermission({ conversationId: child.conversationId, toolName: "bash", input: { command: "echo hi" } })).action,
			"deny",
			"parent disabled tool ceiling still overrides delegatedOnly allow rule",
		);
	} finally { await data.service.close(); await data.fixture.cleanup(); }
});
