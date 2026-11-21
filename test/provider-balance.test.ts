import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DesktopService } from "../src/backend.ts";
import permissions from "../src/permission-extension.ts";
import { balanceFor, balanceTarget, fetchBalance, parseBalance, validBalanceTarget } from "../src/provider-balance.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

/** A local stand-in for the providers' balance APIs; the reply is swapped per test step. */
async function balanceServer() {
	const requests: IncomingMessage[] = [];
	let reply: { status: number; body: unknown } = { status: 200, body: {} };
	const server = createServer((request, response) => {
		requests.push(request);
		response.writeHead(reply.status, { "content-type": "application/json" });
		response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		requests,
		set(status: number, body: unknown) {
			reply = { status, body };
		},
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

const deepseekBody = (total: string, available = true) => ({
	is_available: available,
	balance_infos: [{ currency: "CNY", total_balance: total, granted_balance: "0.00", topped_up_balance: total }],
});

test("balance targets only use official hosts and validated loopback overrides", () => {
	assert.deepEqual(balanceTarget("deepseek", "preset", undefined), {
		kind: "deepseek",
		url: "https://api.deepseek.com/user/balance",
		currency: "CNY",
	});
	assert.equal(balanceTarget("openrouter", undefined, undefined)?.url, "https://openrouter.ai/api/v1/key");
	assert.equal(balanceTarget("anthropic", "preset", undefined), undefined);
	assert.equal(balanceTarget("openai", "custom", "https://api.moonshot.cn/v1")?.url, "https://api.moonshot.cn/v1/users/me/balance");
	assert.equal(balanceTarget("openai", "custom", "https://api.moonshot.cn/v1")?.currency, "CNY");
	assert.equal(balanceTarget("openai", "custom", "https://api.moonshot.ai/v1")?.currency, "USD");
	assert.equal(balanceTarget("openai", "custom", "https://api.siliconflow.cn/v1")?.url, "https://api.siliconflow.cn/v1/user/info");
	// Unknown, look-alike or plain-HTTP hosts never receive the key.
	assert.equal(balanceTarget("deepseek", "custom", "https://api.deepseek.com.evil.test/v1"), undefined);
	assert.equal(balanceTarget("deepseek", "custom", "http://api.deepseek.com"), undefined);
	assert.equal(balanceTarget("openai", "custom", "https://proxy.example.com/v1"), undefined);
	assert.equal(balanceTarget("deepseek", "preset", undefined, "https://attacker.example")?.url, "https://api.deepseek.com/user/balance");
	assert.equal(balanceTarget("deepseek", "preset", undefined, "http://127.0.0.1:9")?.url, "http://127.0.0.1:9/user/balance");

	assert.ok(validBalanceTarget({ kind: "deepseek", url: "https://api.deepseek.com/user/balance", currency: "CNY" }));
	assert.equal(validBalanceTarget({ kind: "deepseek", url: "https://evil.test/user/balance", currency: "CNY" }), undefined);
	assert.equal(validBalanceTarget({ kind: "deepseek", url: "https://api.deepseek.com/other", currency: "CNY" }), undefined);
	assert.equal(validBalanceTarget({ kind: "moonshot", url: "https://api.deepseek.com/user/balance", currency: "CNY" }), undefined);
	assert.equal(validBalanceTarget({ kind: "deepseek", url: "https://api.deepseek.com/user/balance", currency: "cny" }), undefined);
	assert.equal(validBalanceTarget("x"), undefined);
});

test("each provider's documented balance response is parsed and malformed ones are rejected", () => {
	const deepseek = balanceTarget("deepseek", "preset", undefined)!;
	const result = parseBalance(deepseek, deepseekBody("110.00"));
	assert.deepEqual(result, { kind: "deepseek", available: true, balances: [{ currency: "CNY", amount: 110 }] });
	assert.equal(parseBalance(deepseek, deepseekBody("0.00", false)).available, false);
	assert.throws(() => parseBalance(deepseek, { is_available: true }), /格式/);
	assert.throws(() => parseBalance(deepseek, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "x" }] }), /格式/);

	const openrouter = balanceTarget("openrouter", "preset", undefined)!;
	const capped = parseBalance(openrouter, { data: { limit: 20, limit_remaining: 7.5, usage: 12.5 } });
	assert.deepEqual(capped.balances, [{ currency: "USD", amount: 7.5 }]);
	assert.equal(capped.usage, 12.5);
	const uncapped = parseBalance(openrouter, { data: { limit: null, limit_remaining: null, usage: 3 } });
	assert.deepEqual(uncapped.balances, []);
	assert.match(uncapped.note ?? "", /没有设置额度上限/);

	const moonshot = balanceTarget("openai", "custom", "https://api.moonshot.ai/v1")!;
	const kimi = parseBalance(moonshot, { code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: -1 } });
	assert.equal(kimi.available, false);
	assert.deepEqual(kimi.balances, [{ currency: "USD", amount: 0 }]);

	const silicon = balanceTarget("openai", "custom", "https://api.siliconflow.cn/v1")!;
	const sf = parseBalance(silicon, { code: 20000, data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal" } });
	assert.deepEqual(sf.balances, [{ currency: "CNY", amount: 88.88 }]);
	assert.equal(balanceFor(sf, "CNY")?.amount, 88.88);
});

test("fetchBalance sends only the bearer key and never echoes it in errors", async () => {
	const server = await balanceServer();
	try {
		const target = balanceTarget("deepseek", "preset", undefined, server.origin)!;
		server.set(200, deepseekBody("42.10"));
		const result = await fetchBalance(target, " test-only-key ");
		assert.equal(result.balances[0].amount, 42.1);
		assert.equal(server.requests.at(-1)?.headers.authorization, "Bearer test-only-key");
		assert.equal(server.requests.at(-1)?.url, "/user/balance");

		server.set(401, { error: { message: "bad key test-only-key" } });
		await assert.rejects(fetchBalance(target, "test-only-key"), (error: Error) => !error.message.includes("test-only-key") && /拒绝/.test(error.message));
		server.set(500, "oops");
		await assert.rejects(fetchBalance(target, "test-only-key"), /HTTP 500/);
		server.set(200, "not json");
		await assert.rejects(fetchBalance(target, "test-only-key"), /格式/);
		await assert.rejects(fetchBalance(target, "line\nbreak"), /API Key/);
	} finally {
		await server.close();
	}
});

type Handler = (event: unknown, ctx: unknown) => unknown;

test("the minimum-balance guard blocks input and stops turns once the balance reaches the floor", async () => {
	const server = await balanceServer();
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	const saved = {
		connections: process.env.PI_DESKTOP_CONNECTIONS,
		floor: process.env.PI_DESKTOP_MIN_BALANCE,
		test: process.env.PI_DESKTOP_CONNECTION_TEST,
		child: process.env.PI_DESKTOP_CHILD,
	};
	try {
		delete process.env.PI_DESKTOP_CONNECTION_TEST;
		delete process.env.PI_DESKTOP_CHILD;
		process.env.PI_DESKTOP_MIN_BALANCE = "5";
		process.env.PI_DESKTOP_CONNECTIONS = JSON.stringify({
			deepseek: { mode: "preset", modelId: "deepseek-flash", balance: balanceTarget("deepseek", "preset", undefined, server.origin) },
		});
		const handlers = new Map<string, Handler[]>();
		permissions({
			registerTool() {},
			registerProvider() {},
			registerCommand() {},
			registerFlag() {},
			on(name: string, handler: Handler) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI);
		const notices: string[] = [];
		let aborted = 0;
		const ctx = {
			model: { provider: "desktop-deepseek", id: "deepseek-flash" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only-key" }) },
			ui: { notify: (message: string) => notices.push(message) },
			abort: () => {
				aborted++;
			},
			sessionManager: { getEntries: () => [] },
		};
		const run = async (name: string) => {
			let last: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler({ type: name, text: "hi", source: "interactive", payload: {} }, ctx);
				if (value !== undefined) last = value;
			}
			return last;
		};
		server.set(200, deepseekBody("20.00"));
		assert.deepEqual(await run("input"), { action: "continue" });
		assert.equal(server.requests.at(-1)?.headers.authorization, "Bearer test-only-key");

		// A fresh "not low" result is reused; the lookup runs again once the cache expires.
		server.set(200, deepseekBody("4.99"));
		const requests = server.requests.length;
		assert.equal(await run("turn_end"), undefined);
		assert.equal(server.requests.length, requests);
		now += 31000;
		const stopped = (await run("turn_end")) as { continue: boolean; entries: { customType: string; content: string }[] };
		assert.equal(stopped.continue, false);
		assert.equal(stopped.entries[0].customType, "desktop_min_balance");
		assert.match(stopped.entries[0].content, /¥4\.99/);
		assert.ok(aborted >= 1);

		// The cached low balance blocks further requests and new prompts without waiting on the network.
		const before = aborted;
		await run("before_provider_request");
		assert.equal(aborted, before + 1);
		assert.deepEqual(await run("input"), { action: "handled" });
		assert.ok(notices.some((notice) => notice.includes("底线")));

		// A provider that says the account cannot pay is stopped regardless of the amount.
		server.set(200, deepseekBody("100.00", false));
		await run("before_agent_start");
		now += 31000;
		const unpaid = (await run("turn_end")) as { entries: { content: string }[] };
		assert.match(unpaid.entries[0].content, /不足以调用/);

		// A failed lookup never blocks work.
		const fresh = new Map<string, Handler[]>();
		permissions({
			registerTool() {},
			registerProvider() {},
			registerCommand() {},
			registerFlag() {},
			on(name: string, handler: Handler) {
				fresh.set(name, [...(fresh.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI);
		server.set(503, "down");
		let result: unknown;
		for (const handler of fresh.get("input") ?? []) {
			const value = await handler({ type: "input", text: "hi", source: "interactive" }, ctx);
			if (value !== undefined) result = value;
		}
		assert.deepEqual(result, { action: "continue" });
		// The failure is cached, so the next message does not wait on the provider again.
		const afterFailure = server.requests.length;
		for (const handler of fresh.get("input") ?? []) await handler({ type: "input", text: "again", source: "interactive" }, ctx);
		assert.equal(server.requests.length, afterFailure);
	} finally {
		Date.now = realNow;
		for (const [key, name] of [
			["connections", "PI_DESKTOP_CONNECTIONS"],
			["floor", "PI_DESKTOP_MIN_BALANCE"],
			["test", "PI_DESKTOP_CONNECTION_TEST"],
			["child", "PI_DESKTOP_CHILD"],
		] as const) {
			if (saved[key] === undefined) delete process.env[name];
			else process.env[name] = saved[key];
		}
		await server.close();
	}
});

function cipher() {
	const key = randomBytes(32);
	return {
		encrypt: (value: string) => {
			const nonce = randomBytes(12);
			const c = createCipheriv("aes-256-gcm", key, nonce);
			const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
			return Buffer.concat([nonce, c.getAuthTag(), encrypted]).toString("base64");
		},
		decrypt: (value: string) => {
			const bytes = Buffer.from(value, "base64");
			const d = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			d.setAuthTag(bytes.subarray(12, 28));
			return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString("utf8");
		},
	};
}

test("the desktop service queries balances with saved keys or key commands and stores the floor", { timeout: 60000 }, async () => {
	const server = await balanceServer();
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
		balanceOrigin: server.origin,
		...cipher(),
	});
	try {
		await service.initialize();
		assert.deepEqual(await service.providerBalance({ provider: "anthropic" }), {
			supported: false,
			message: "这个连接的服务商没有可用的余额查询接口。",
		});
		const missing = await service.providerBalance({ provider: "deepseek" });
		assert.equal(missing.success, false);

		server.set(200, deepseekBody("12.34"));
		const typed = await service.providerBalance({ provider: "deepseek", apiKey: "test-only-typed-key" });
		assert.equal(typed.success, true, typed.message);
		assert.deepEqual(typed.balances, [{ currency: "CNY", amount: 12.34 }]);
		assert.equal(server.requests.at(-1)?.headers.authorization, "Bearer test-only-typed-key");

		const command = await service.providerBalance({ provider: "deepseek", keyCommand: "printf test-only-command-key" });
		assert.equal(command.success, true, command.message);
		assert.equal(server.requests.at(-1)?.headers.authorization, "Bearer test-only-command-key");

		server.set(401, { error: { message: "test-only-typed-key is invalid" } });
		const rejected = await service.providerBalance({ provider: "deepseek", apiKey: "test-only-typed-key" });
		assert.equal(rejected.success, false);
		assert.ok(!rejected.message?.includes("test-only-typed-key"));

		// A saved DeepSeek key is never sent to another provider's balance host.
		await service.saveSettings({ permission: "ask", theme: "light", provider: "deepseek", apiKey: "test-only-saved-key" });
		server.set(200, deepseekBody("8.00"));
		const savedKey = await service.providerBalance({ provider: "deepseek" });
		assert.equal(savedKey.success, true, savedKey.message);
		assert.equal(server.requests.at(-1)?.headers.authorization, "Bearer test-only-saved-key");
		const count = server.requests.length;
		const moved = await service.providerBalance({ provider: "deepseek", mode: "custom", baseUrl: "https://openrouter.ai/api/v1", modelId: "x" });
		assert.equal(moved.success, false);
		assert.match(moved.message ?? "", /不会发给新地址/);
		assert.equal(server.requests.length, count);

		const saved = await service.saveSettings({ permission: "ask", theme: "light", minBalance: 5.005 });
		assert.equal(saved.settings.minBalance, 5.01);
		await assert.rejects(service.saveSettings({ permission: "ask", theme: "light", minBalance: 0 }), /余额底线/);
		const cleared = await service.saveSettings({ permission: "ask", theme: "light", minBalance: null });
		assert.equal(cleared.settings.minBalance, undefined);
	} finally {
		await service.close();
		await fixture.cleanup();
		await server.close();
	}
});
