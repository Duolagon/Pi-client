import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissions, { FALLBACK_MESSAGE_TYPE, fallbackReason, parseFallbackModel } from "../src/permission-extension.ts";
import { parseFallbackModelUpdate, sanitizeFallbackModel } from "../src/model-routing.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

test("fallbackReason accepts overload, rate limit and server errors only", () => {
	assert.equal(fallbackReason("529 Overloaded"), "过载");
	assert.equal(fallbackReason('{"type":"overloaded_error","message":"Overloaded"}'), "过载");
	assert.equal(fallbackReason("429 Too Many Requests"), "限流");
	assert.equal(fallbackReason("429 Rate limit exceeded for API key"), "限流");
	assert.equal(fallbackReason("Rate limit reached for requests"), "限流");
	assert.equal(fallbackReason("503 Service Unavailable"), "服务端错误");
	assert.equal(fallbackReason("502 Bad Gateway"), "服务端错误");
	assert.equal(fallbackReason("Internal server error"), "服务端错误");

	for (const text of [
		"Request was aborted",
		"Operation cancelled by user",
		"401 Unauthorized",
		"403 Forbidden",
		"Invalid API key provided",
		"400 Bad Request: invalid_request_error",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"This model's maximum context length is 128000 tokens",
		"429 insufficient_quota: You exceeded your current quota",
		"billing hard limit reached",
		"fetch failed",
		"",
		"request id req_5030abc failed",
	])
		assert.equal(fallbackReason(text), undefined, text);
	assert.equal(fallbackReason(undefined), undefined);
	assert.equal(fallbackReason(42), undefined);
});

test("fallback model settings are validated at load, IPC and env boundaries", () => {
	assert.deepEqual(parseFallbackModel(JSON.stringify({ provider: "desktop-openai", id: "gpt-x" })), { provider: "desktop-openai", id: "gpt-x" });
	assert.equal(parseFallbackModel(undefined), undefined);
	assert.equal(parseFallbackModel("{not json"), undefined);
	assert.equal(parseFallbackModel(JSON.stringify({ provider: "", id: "x" })), undefined);
	assert.deepEqual(sanitizeFallbackModel({ provider: " p ", id: " m " }), { provider: "p", id: "m" });
	assert.equal(sanitizeFallbackModel("p/m"), undefined);
	assert.equal(parseFallbackModelUpdate(null), null);
	assert.deepEqual(parseFallbackModelUpdate({ provider: "p", id: "m" }), { provider: "p", id: "m" });
	assert.throws(() => parseFallbackModelUpdate({ provider: "p" }), /备用模型/);
	assert.throws(() => parseFallbackModelUpdate({ provider: "p".repeat(201), id: "m" }), /备用模型/);
});

const ENV_KEYS = ["PI_DESKTOP_FALLBACK_MODEL", "PI_DESKTOP_CONNECTION_TEST", "PI_DESKTOP_CHILD", "PI_DESKTOP_MAX_COST", "PI_DESKTOP_MIN_BALANCE", "PI_DESKTOP_MAX_TURNS", "PI_DESKTOP_HOST_URL", "PI_DESKTOP_CONNECTIONS", "PI_DESKTOP_POLICY_FILE"] as const;

async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void>) {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	const dir = await mkdtemp(join(tmpdir(), "pi-fallback-"));
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		Object.assign(process.env, values);
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		await rm(dir, { recursive: true, force: true });
	}
}

function load() {
	const handlers = new Map<string, Handler[]>();
	const selected: unknown[] = [];
	let setModelResult = true;
	permissions({
		registerTool() {},
		registerProvider() {},
		registerCommand() {},
		registerFlag() {},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		setModel: async (model: unknown) => {
			selected.push(model);
			return setModelResult;
		},
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const fallback = { provider: "desktop-openai", id: "backup-model", name: "Backup" };
	const ctx = {
		model: { provider: "desktop-anthropic", id: "main-model", name: "Main" } as { provider: string; id: string; name: string },
		modelRegistry: { find: (provider: string, id: string) => (provider === fallback.provider && id === fallback.id ? fallback : undefined) },
		ui: { notify: (message: string) => notices.push(message) },
		abort() {},
		sessionManager: { getEntries: () => [] },
		hasPendingMessages: () => false,
	};
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		let last: unknown;
		let entries: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) {
			const value = await handler({ type: name, entries, continue: false, context: { contextMessages: [] }, ...event }, ctx);
			if (value !== undefined) last = value;
			if (value && typeof value === "object" && "entries" in value) entries = (value as { entries: unknown[] }).entries;
		}
		return last;
	};
	const failTurn = async (errorMessage: string, contextMessages: unknown[] = []) => {
		await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage, content: [] } });
		return (await emit("agent_before_settle", { outcome: "error", context: { contextMessages, canContinue: true } })) as
			| { continue: boolean; entries: { type: string; customType: string; content: string; display: boolean }[] }
			| undefined;
	};
	return { ctx, notices, selected, fallback, emit, failTurn, setModelResult: (value: boolean) => (setModelResult = value) };
}

const FALLBACK_ENV = { PI_DESKTOP_FALLBACK_MODEL: JSON.stringify({ provider: "desktop-openai", id: "backup-model" }) };

test("an overloaded primary switches to the fallback once per prompt and continues", async () => {
	await withEnv(FALLBACK_ENV, async () => {
		const pi = load();
		await pi.emit("before_agent_start");
		const result = await pi.failTurn("529 Overloaded");
		assert.ok(result);
		assert.equal(result.continue, true);
		assert.equal(pi.selected.length, 1);
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0].customType, FALLBACK_MESSAGE_TYPE);
		assert.equal(result.entries[0].display, true);
		assert.match(result.entries[0].content, /主模型 Main 暂不可用（过载），已切换到备用模型 Backup 继续/);
		assert.ok(pi.notices.some((notice) => notice.includes("备用模型 Backup")));

		// A second failure in the same prompt (even on another model) does not loop.
		pi.ctx.model = { provider: "desktop-anthropic", id: "main-model", name: "Main" };
		assert.equal(await pi.failTurn("503 Service Unavailable"), undefined);
		assert.equal(pi.selected.length, 1);

		// The next prompt gets a new chance.
		await pi.emit("before_agent_start");
		assert.equal((await pi.failTurn("429 Too Many Requests"))?.continue, true);
		assert.equal(pi.selected.length, 2);
	});
});

test("no fallback for ineligible errors, aborts, the fallback itself, guards or connection tests", async () => {
	await withEnv(FALLBACK_ENV, async () => {
		const pi = load();
		await pi.emit("before_agent_start");
		for (const text of ["401 Unauthorized", "400 Bad Request", "prompt is too long: 300000 tokens", "insufficient_quota"])
			assert.equal(await pi.failTurn(text), undefined, text);
		// A run that ended by abort (Esc, cost cap, balance floor) is not an "error" outcome.
		await pi.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
		assert.equal(await pi.emit("agent_before_settle", { outcome: "aborted", context: { contextMessages: [] } }), undefined);
		// A successful final response clears the previous error.
		await pi.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "529 Overloaded", content: [] } });
		await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
		assert.equal(await pi.emit("agent_before_settle", { outcome: "error", context: { contextMessages: [] } }), undefined);
		// A cost-cap or balance-floor notice blocks the switch.
		assert.equal(await pi.failTurn("529 Overloaded", [{ role: "custom", customType: "desktop_max_cost" }]), undefined);
		assert.equal(await pi.failTurn("529 Overloaded", [{ role: "custom", customType: "desktop_min_balance" }]), undefined);
		// Already on the fallback model.
		pi.ctx.model = { ...pi.fallback };
		assert.equal(await pi.failTurn("529 Overloaded"), undefined);
		assert.equal(pi.selected.length, 0);
	});
	await withEnv({ ...FALLBACK_ENV, PI_DESKTOP_CONNECTION_TEST: "1" }, async () => {
		const pi = load();
		await pi.emit("before_agent_start");
		assert.equal(await pi.failTurn("529 Overloaded"), undefined);
		assert.equal(pi.selected.length, 0);
	});
	await withEnv({}, async () => {
		const pi = load();
		await pi.emit("before_agent_start");
		assert.equal(await pi.failTurn("529 Overloaded"), undefined);
	});
});

test("an unavailable fallback model only notifies and does not continue", async () => {
	await withEnv({ PI_DESKTOP_FALLBACK_MODEL: JSON.stringify({ provider: "desktop-openai", id: "missing" }) }, async () => {
		const pi = load();
		await pi.emit("before_agent_start");
		assert.equal(await pi.failTurn("529 Overloaded"), undefined);
		assert.ok(pi.notices.some((notice) => notice.includes("未自动切换")));
	});
	await withEnv(FALLBACK_ENV, async () => {
		const pi = load();
		pi.setModelResult(false);
		await pi.emit("before_agent_start");
		assert.equal(await pi.failTurn("529 Overloaded"), undefined);
		assert.ok(pi.notices.some((notice) => notice.includes("未自动切换")));
	});
});

test("children keep the cost cap when the fallback is enabled", async () => {
	await withEnv({ ...FALLBACK_ENV, PI_DESKTOP_CHILD: "1", PI_DESKTOP_MAX_COST: "1" }, async () => {
		const pi = load();
		let aborted = 0;
		pi.ctx.abort = () => {
			aborted++;
		};
		pi.ctx.sessionManager.getEntries = () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: 2 } } } }] as never;
		await pi.emit("before_agent_start");
		await pi.emit("before_provider_request");
		assert.equal(aborted, 1);
		const stopped = (await pi.emit("turn_end")) as { continue: boolean } | undefined;
		assert.equal(stopped, undefined); // already stopped by before_provider_request
		assert.deepEqual(await pi.emit("input", { text: "hi", source: "interactive" }), { action: "handled" });
	});
});

test("real Pi: an overloaded primary switches to the fallback model and continues", { timeout: 60000 }, async () => {
	const { readFile: read, writeFile: write } = await import("node:fs/promises");
	const { dirname, resolve } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { DesktopService } = await import("../src/backend.ts");
	const { createCoreFixture } = await import("./fixtures/core-fixture.ts");
	const here = dirname(fileURLToPath(import.meta.url));
	const fixture = await createCoreFixture();
	const file = join(fixture.agentDir, "extensions", "faux-provider.js");
	const original = await read(file, "utf8");
	const marker = "\t\t\t} else {\n\t\t\t\tresponse = fauxAssistantMessage(`STREAM_COMPLETE ${model.id}: ${text}`);";
	assert.ok(original.includes(marker));
	await write(
		file,
		original.replace(
			marker,
			`\t\t\t} else if (text.includes("FALLBACK_OVERLOAD") && model.id === "desktop-test-1") {
				response = fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 Overloaded" });
${marker}`,
		),
	);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		navigationExtension: resolve(here, "../src/session-navigation-extension.ts"),
		historyEntry: resolve(here, "../src/session-history-entry.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready");
		await assert.rejects(
			service.saveSettings({ permission: "ask", theme: "light", fallbackModel: { provider: "x" } as never }),
			/备用模型/,
		);
		const saved = await service.saveSettings({
			permission: "ask",
			theme: "light",
			fallbackModel: { provider: "desktop-test", id: "desktop-test-2" },
		});
		assert.deepEqual(saved.settings.fallbackModel, { provider: "desktop-test", id: "desktop-test-2" });
		const id = saved.active!.id;
		assert.equal(saved.state?.model?.id, "desktop-test-1");
		const settled = new Promise<void>((done) => {
			const unsub = service.subscribe((ev) => {
				if (ev.conversationId === id && ev.event.type === "agent_settled") {
					unsub();
					done();
				}
			});
		});
		await service.command({ type: "prompt", message: "FALLBACK_OVERLOAD please" });
		await settled;
		const snapshot = await service.snapshot();
		assert.equal(snapshot.state?.model?.id, "desktop-test-1");
		const notice = snapshot.messages.find((m) => m.role === "custom" && m.customType === FALLBACK_MESSAGE_TYPE);
		assert.ok(notice, "fallback notice is in the transcript");
		const last = snapshot.messages.findLast((m) => m.role === "assistant") as { content: { type: string; text?: string }[] };
		assert.match(last.content.map((b) => b.text ?? "").join(""), /STREAM_COMPLETE desktop-test-2/);

		const cleared = await service.saveSettings({ permission: "ask", theme: "light", fallbackModel: null });
		assert.equal(cleared.settings.fallbackModel, undefined);
	} finally {
		await service.close?.();
		await fixture.cleanup();
	}
});
