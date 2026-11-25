import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import type { CodeIntelligence } from "../src/language-service.ts";
import { ESCALATION_MESSAGE_TYPE, FALLBACK_MESSAGE_TYPE } from "../src/permission-extension.ts";
import type { DesktopEvent } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const primary = "desktop-test-1";
const review = "desktop-test-2";
const fallback = "desktop-test-3";
const model = (id: string) => ({ provider: "desktop-test", id });
const baseSettings = { permission: "auto", theme: "light", sandbox: false } as const;
const fixtureBranches = [
	"} else if (process.env.PI_FIXTURE_ESCALATION_SLOW === '1' && model.id === 'desktop-test-2') {",
	"    slow.setResponses([fauxAssistantMessage('Review diagnostics '.repeat(200))]);",
	"    return slow.provider.streamSimple(model, context, streamOptions);",
	"} else if (process.env.PI_FIXTURE_ESCALATION_OVERLOAD === '1' && model.id === 'desktop-test-2') {",
	"    response = fauxAssistantMessage('', { stopReason: 'error', errorMessage: '529 Overloaded' });",
	"} else if (text.includes('VERIFY_ESCALATION')) {",
	"    const steps = [",
	"        ['write', { path: 'generated.txt', content: 'changed\\n' }],",
	"        ['bash', { command: 'npm test' }],",
	"        ['bash', { command: 'npm test' }],",
	"    ];",
	"    const step = steps[results.length];",
	"    response = step ? fauxAssistantMessage(fauxToolCall(...step), { stopReason: 'toolUse' }) : fauxAssistantMessage('Done');",
	"} else if (text.includes('VERIFY_LSP_ESCALATION')) {",
	"    response = results.length < 2 ? fauxAssistantMessage(fauxToolCall('write', { path: 'changed-' + results.length + '.ts', content: 'export const invalid: string = 42;\\n' }), { stopReason: 'toolUse' }) : fauxAssistantMessage('Done');",
	"} else if (text.includes('VERIFY_BACKGROUND_ESCALATION')) {",
	"    const shellRead = (index) => ['BashOutput', { bash_id: results[index]?.details?.shell_id }];",
	"    const waitForExit = (index) => {",
	"        const id = results[index]?.details?.shell_id;",
	"        if (!/^shell_[a-f0-9]{12}$/.test(id)) return ['bash', { command: 'false' }];",
	"        return ['bash', { command: 'while ! test -f .' + id + '.exited; do /bin/sleep 0.02; done', timeout: 8 }];",
	"    };",
	"    const steps = [",
	"        ['write', { path: 'generated.txt', content: 'changed\\n' }],",
	"        ['bash', { command: 'npm test', run_in_background: true }],",
	"        waitForExit(1),",
	"        shellRead(1),",
	"        shellRead(1),",
	"        ['bash', { command: 'npm test', run_in_background: true }],",
	"        waitForExit(5),",
	"        shellRead(5),",
	"    ];",
	"    const step = steps[results.length];",
	"    response = step ? fauxAssistantMessage(fauxToolCall(...step), { stopReason: 'toolUse' }) : fauxAssistantMessage('Done');",
	"} else if (text.includes('VERIFY_BG_WAKE')) {",
	"    const step = results.length === 0",
	"        ? fauxToolCall('write', { path: 'generated.txt', content: 'changed\\n' })",
	"        : results.length < 3 ? fauxToolCall('bash', { command: 'npm test', run_in_background: true }) : undefined;",
	"    response = step ? fauxAssistantMessage(step, { stopReason: 'toolUse' }) : fauxAssistantMessage('Done');",
].join("\n\t\t\t");

async function createService({ overload = false, slowReview = false } = {}) {
	const fixture = await createCoreFixture();
	const provider = join(fixture.agentDir, "extensions", "faux-provider.js");
	const original = await readFile(provider, "utf8");
	const marker = "\t\t\t} else {\n\t\t\t\tresponse = fauxAssistantMessage(";
	assert.ok(original.includes(marker));
	await writeFile(provider, original.replace(marker, "\t\t\t" + fixtureBranches + "\n" + marker)
		.replace("\tmodels: [", "\tmodels: [\n\t\t{ id: 'desktop-test-3', name: 'Desktop Test Three', reasoning: true },"));
	await writeFile(join(fixture.project, "package.json"), JSON.stringify({ scripts: { test: "node --test checks.test.mjs" } }));
	await writeFile(join(fixture.project, "checks.test.mjs"), [
		"import test from 'node:test';",
		"import assert from 'node:assert/strict';",
		"test('example', () => assert.equal(1, 2));",
	].join("\n"));
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: join(repo, "src/permission-extension.ts"),
		toolControlExtension: join(repo, "src/tool-control-extension.ts"),
		navigationExtension: join(repo, "src/session-navigation-extension.ts"),
		historyEntry: join(repo, "src/session-history-entry.ts"),
		env: {
			...fixture.env, HOME: fixture.root, NODE_TEST_CONTEXT: undefined,
			PI_FIXTURE_ESCALATION_OVERLOAD: overload ? "1" : "0", PI_FIXTURE_ESCALATION_SLOW: slowReview ? "1" : "0",
		},
		initialProject: fixture.project,
	});
	return {
		service,
		project: fixture.project,
		async close() {
			await service.close();
			await fixture.cleanup();
		},
	};
}

async function run(service: DesktopService, id: string, message: string) {
	const events: DesktopEvent["event"][] = [];
	let release: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		release = service.subscribe(({ conversationId, event }) => {
			if (conversationId !== id) return;
			events.push(event);
			if (event.type === "agent_settled") resolve();
		});
	});
	try {
		await service.command({ type: "prompt", message }, id);
		await settled;
	} finally {
		release();
	}
	const snapshot = await service.snapshot();
	const modelCalls = events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "assistant" ? [event.message.model] : []);
	const notices = snapshot.messages.flatMap((message) => message.role === "custom" ? [message.customType] : []);
	return { modelCalls, notices, snapshot, events };
}

test("real Pi applies a route saved in an existing session and restores the original model through nested fallback", { timeout: 30_000 }, async (context) => {
	const fixture = await createService({ overload: true });
	context.after(() => fixture.close());
	const { service } = fixture;
	const initial = await service.initialize();
	const id = initial.active!.id;
	await service.saveSettings({ ...baseSettings, fallbackModel: model(fallback) });
	assert.equal((await service.snapshot()).state?.model?.id, primary);
	// Plan already matches the primary. Review is the next eligible model.
	await service.saveSettings({ ...baseSettings, modelRouting: { plan: model(primary), review: model(review) } });
	await service.command({ type: "set_thinking_level", level: "high" }, id);
	const { modelCalls, notices, snapshot, events } = await run(service, id, "VERIFY_ESCALATION");
	assert.deepEqual(modelCalls, [primary, primary, primary, review, fallback]);
	assert.deepEqual(notices, [ESCALATION_MESSAGE_TYPE, FALLBACK_MESSAGE_TYPE]);
	assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "custom_message" &&
		event.entry.customType === ESCALATION_MESSAGE_TYPE));
	assert.equal(snapshot.state?.model?.id, primary);
	assert.equal(snapshot.state?.thinkingLevel, "high");
});

test("real Pi counts diagnostics after the write result and restores the primary model", { timeout: 30_000 }, async (context) => {
	const fixture = await createService();
	context.after(() => fixture.close());
	const { service } = fixture;
	const initial = await service.initialize();
	await service.saveSettings({ ...baseSettings, modelRouting: { plan: model(review) } });
	await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
	let inspections = 0;
	const inspect = async (): Promise<CodeIntelligence> => {
		inspections++;
		return {
			server: "test-langserver",
			diagnostics: [{ severity: 1, line: 1, column: 14, message: "Fixture type mismatch" }],
			diagnosticsComplete: true,
			symbols: [],
			definitions: [],
		};
	};
	// Replace only the external language server. All tools, loopback calls and Pi
	// extension events still follow the real desktop pipeline.
	(service as unknown as { languages: { inspect: typeof inspect } }).languages.inspect = inspect;
	const { modelCalls, notices, snapshot } = await run(service, initial.active!.id, "VERIFY_LSP_ESCALATION");
	assert.equal(inspections, 2);
	assert.deepEqual(modelCalls, [primary, primary, review]);
	assert.deepEqual(notices, [ESCALATION_MESSAGE_TYPE]);
	assert.equal(snapshot.state?.model?.id, primary);
});

test("real Pi waits for managed shell exits and counts each verification shell only once", { timeout: 30_000 }, async (context) => {
	const fixture = await createService();
	context.after(() => fixture.close());
	const { service } = fixture;
	const initial = await service.initialize();
	await service.saveSettings({ ...baseSettings, modelRouting: { plan: model(review) } });
	const unsubscribe = service.subscribeMonitors((event) => {
		if (event.type === "monitor_updated" && event.monitor.kind === "shell" && event.monitor.status === "exited") {
			void writeFile(join(fixture.project, "." + event.monitor.id + ".exited"), "");
		}
	});
	context.after(unsubscribe);
	const { modelCalls, notices, snapshot } = await run(service, initial.active!.id, "VERIFY_BACKGROUND_ESCALATION");
	assert.deepEqual(modelCalls, [...Array<string>(8).fill(primary), review]);
	assert.deepEqual(notices.filter((type) => type === ESCALATION_MESSAGE_TYPE), [ESCALATION_MESSAGE_TYPE]);
	assert.equal(snapshot.state?.model?.id, primary);
});

test("terminal notifications show the review model during the existing wakeup and restore the primary on cancellation", { timeout: 30_000 }, async (context) => {
	const fixture = await createService({ slowReview: true });
	context.after(() => fixture.close());
	const { service } = fixture;
	const id = (await service.initialize()).active!.id;
	await service.saveSettings({ ...baseSettings, modelRouting: { plan: model(review) } });
	const active = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const events: string[] = [];
	let reviewing = false;
	context.after(service.subscribe(({ conversationId, event }) => {
		if (conversationId !== id) return;
		if (event.type === "desktop_error") events.push(event.message);
		if (event.type !== "message_update") events.push(event.type + (event.type === "message_end" ? ":" + event.message.role +
			(event.message.role === "custom" ? ":" + event.message.customType : "") : ""));
		if (event.type === "message_start" && event.message.role === "assistant" && event.message.model === review) {
			reviewing = true;
			active.resolve();
		}
		if (reviewing && event.type === "agent_settled") stopped.resolve();
	}));
	await service.command({ type: "prompt", message: "VERIFY_BG_WAKE" }, id);
	const deadline = setTimeout(() => active.reject(new Error(JSON.stringify(events))), 5000);
	try { await active.promise; } finally { clearTimeout(deadline); }
	const live = await service.snapshot();
	assert.equal(live.state?.model?.id, review);
	assert.equal(live.state?.isStreaming, true);
	assert.equal(live.messages.filter((message) => message.role === "custom" && message.customType === "desktop_shell_event").length, 2);
	assert.equal(live.messages.filter((message) => message.role === "custom" && message.customType === ESCALATION_MESSAGE_TYPE).length, 1);
	await service.command({ type: "abort" }, id);
	await stopped.promise;
	assert.equal((await service.snapshot()).state?.model?.id, primary);
});
