import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopService, type ServiceOptions } from "../src/backend.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = resolve(
	process.argv[2] ??
		join(appDir, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Desktop.app/Contents/Resources"),
);
const root = await mkdtemp(join(tmpdir(), "pi-packaged-sessions-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
await mkdir(project);
await mkdir(join(agentDir, "extensions"), { recursive: true });
await cp(resolve(process.argv[3] ?? join(appDir, "test/fixtures/faux-provider.js")), join(agentDir, "extensions/faux-provider.js"));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "desktop-test", defaultModel: "desktop-test-1", compaction: { enabled: false }, retry: { enabled: false } }));
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ELECTRON_RUN_AS_NODE: "1" };
for (const key of Object.keys(env))
	if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS)/.test(key)) env[key] = undefined;
const options: ServiceOptions = { dataDir: join(root, "desktop"), runtimeDir: join(resources, "runtime"), executable: process.execPath, env };
let service = new DesktopService({ ...options, initialProject: project });

async function prompt(id: string, message: string): Promise<void> {
	let complete: () => void = () => {};
	const settled = new Promise<void>((resolve) => { complete = resolve; });
	const unsubscribe = service.subscribe((packet) => {
		if (packet.conversationId === id && packet.event.type === "agent_settled") complete();
	});
	const timer = setTimeout(() => complete(), 20000);
	try {
		await service.command({ type: "prompt", message }, id);
		await settled;
		assert.equal((await service.snapshot()).state?.isStreaming, false);
	} finally { clearTimeout(timer); unsubscribe(); }
}

try {
	const initial = await service.initialize();
	assert.equal(initial.engineStatus, "ready", initial.engineError);
	const sourceId = initial.active!.id;
	await prompt(sourceId, "packaged context");
	await prompt(sourceId, "packaged second turn");
	const entries = await service.sessionEntries({ conversationId: sourceId });
	const target = entries.entries.findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	const originalFile = (await service.snapshot()).active!.sessionFile!;
	const originalBytes = await readFile(originalFile);
	const forked = await service.forkSession({ entryId: target.id });
	assert.equal(forked.selectedText, "packaged second turn");
	assert.deepEqual(await readFile(originalFile), originalBytes);
	assert.equal(forked.snapshot.messages.filter((message) => message.role === "user").length, 1);
	const cloned = await service.cloneSession();
	assert.notEqual(cloned.conversation!.id, forked.conversation!.id);
	assert.equal(cloned.snapshot.messages.filter((message) => message.role === "user").length, 1);
	assert.ok((await service.sessionTree(sourceId)).tree.length);
	await service.selectConversation(sourceId);
	const navigation = await service.navigateSession({ targetId: target.id });
	assert.equal(navigation.editorText, "packaged second turn");
	assert.equal(navigation.leafId, target.parentId);
	await service.close();
	service = new DesktopService(options);
	const restarted = await service.initialize();
	assert.equal(restarted.engineStatus, "ready", restarted.engineError);
	assert.equal((await service.sessionTree()).leafId, target.parentId);
	assert.equal(restarted.messages.filter((message) => message.role === "user").length, 1);
	const cliRoot = join(agentDir, "sessions", "test-project");
	await mkdir(cliRoot, { recursive: true });
	await cp(originalFile, join(cliRoot, "history.jsonl"));
	const history = await service.discoverSessionHistory();
	assert.equal(history.sessions.length, 1);
	const imported = await service.importSessionHistory({ token: history.sessions[0].token });
	assert.equal(imported.snapshot.messages.filter((message) => message.role === "user").length, 2);
	assert.equal((await service.importSessionHistory({ token: history.sessions[0].token })).alreadyImported, true);
	assert.deepEqual(await readFile(join(cliRoot, "history.jsonl")), originalBytes);
	console.log("Packaged sessions passed: fork, clone, tree, native navigation, cursor restart and CLI import.");
} finally {
	await service.close();
	await rm(root, { recursive: true, force: true });
}
