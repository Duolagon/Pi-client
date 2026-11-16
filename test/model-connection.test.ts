import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService, type ServiceOptions } from "../src/backend.ts";
import type { ConnectionProtocol, Provider } from "../src/shared.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { createModelEndpoint } from "./fixtures/model-endpoint.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

async function setup(overrides: Pick<ServiceOptions, "initialProject" | "providerBaseUrls"> = {}) {
	const fixture = await createCoreFixture();
	const key = randomBytes(32);
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
		// Substitute the Electron safeStorage boundary with real reversible encryption.
		encrypt: (value: string) => {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
		},
		decrypt: (value: string) => {
			const bytes = Buffer.from(value, "base64");
			const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			cipher.setAuthTag(bytes.subarray(12, 28));
			return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
		},
		...overrides,
	};
	const service = new DesktopService(options);
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
	} catch (error) {
		await service.close();
		await fixture.cleanup();
		throw error;
	}
	return { fixture, options, service };
}

test("provider presets are ready before opening a project and each provider needs only a key", async () => {
	const { fixture, service, options } = await setup({ initialProject: undefined });
	let current = service;
	try {
		const initial = await service.snapshot();
		assert.equal(initial.active, undefined);
		assert.deepEqual(initial.settings.configuredProviders, []);
		assert.deepEqual(initial.providerPresets.map((preset) => preset.provider).sort(), [
			"anthropic",
			"deepseek",
			"google",
			"openai",
			"openrouter",
		]);
		for (const preset of initial.providerPresets) {
			assert.ok(preset.models.length > 0, `${preset.provider} must include a model picker before authentication`);
			assert.ok(preset.models.some((model) => model.id === preset.defaultModelId));
			assert.ok(URL.canParse(preset.baseUrl));
			const saved = await service.saveSettings({
				permission: "ask",
				theme: "light",
				provider: preset.provider,
				apiKey: `test-only-key-for-${preset.provider}`,
			});
			assert.equal(saved.active, undefined);
			assert.equal(saved.settings.connections[preset.provider]?.mode, "preset");
			assert.equal(saved.settings.connections[preset.provider]?.modelId, preset.defaultModelId);
			assert.deepEqual(saved.settings.defaultModel, {
				provider: `desktop-${preset.provider}`,
				id: preset.defaultModelId,
			});
			assert.ok(saved.settings.configuredProviders.includes(preset.provider));
			assert.ok(!JSON.stringify(saved).includes(`test-only-key-for-${preset.provider}`));
		}
		await service.close();
		current = new DesktopService({ ...options, initialProject: undefined });
		const restored = await current.initialize();
		assert.equal(restored.active, undefined);
		assert.equal(restored.settings.configuredProviders.length, 5);
		assert.equal(restored.providerPresets.length, 5);
	} finally {
		await current.close();
		await fixture.cleanup();
	}
});

test(
	"DeepSeek key-only presets share defaults across tests, model switching, and restored sessions",
	{ timeout: 60000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const { fixture, service, options } = await setup({ providerBaseUrls: { deepseek: endpoint.baseUrl } });
		let current = service;
		const secret = "test-only-deepseek-preset-key";
		try {
			const initial = await service.snapshot();
			const preset = initial.providerPresets.find((item) => item.provider === "deepseek");
			assert.ok(preset);
			assert.equal(preset.defaultModelId, "deepseek-flash");
			assert.deepEqual(preset.models.map((model) => model.id).sort(), ["deepseek-flash", "deepseek-v4-pro"]);
			const checked = await service.testConnection({ provider: "deepseek", apiKey: secret });
			assert.equal(checked.success, true, checked.message);
			assert.equal(checked.model, preset.defaultModelId);
			assert.equal(endpoint.requests.at(-1)?.body.model, preset.defaultModelId);
			assert.equal(endpoint.requests.at(-1)?.headers.authorization, `Bearer ${secret}`);
			const saved = await service.saveSettings({
				permission: "ask",
				theme: "light",
				provider: "deepseek",
				apiKey: secret,
			});
			assert.equal(saved.engineStatus, "ready", saved.engineError);
			assert.equal(saved.settings.connections.deepseek?.mode, "preset");
			assert.equal(saved.state?.model?.id, checked.model);
			const available = saved.models.filter((model) => model.provider === "desktop-deepseek");
			assert.deepEqual(available.map((model) => model.id).sort(), preset.models.map((model) => model.id).sort());
			for (const model of preset.models) {
				await service.command({ type: "set_model", provider: "desktop-deepseek", modelId: model.id });
				const requestsBefore = endpoint.requests.length;
				await prompt(service);
				assert.equal(endpoint.requests.length, requestsBefore + 1);
				const request = endpoint.requests.at(-1);
				assert.ok(request);
				assert.equal(request.path, "/chat/completions");
				assert.equal(request.body.model, model.id);
				assert.equal(request.headers.authorization, `Bearer ${secret}`);
			}
			const selected = (await service.snapshot()).state?.model?.id;
			await service.close();
			current = new DesktopService({ ...options, initialProject: undefined });
			const restored = await current.initialize();
			assert.equal(restored.engineStatus, "ready", restored.engineError);
			assert.equal(restored.state?.model?.id, selected);
			const requestsBeforeRestorePrompt = endpoint.requests.length;
			await prompt(current);
			assert.equal(endpoint.requests.length, requestsBeforeRestorePrompt + 1);
			assert.equal(endpoint.requests.at(-1)?.body.model, selected);
			const next = await current.newConversation();
			assert.equal(next.state?.model?.id, selected);
			const reused = await current.testConnection({ provider: "deepseek" });
			assert.equal(reused.success, true, reused.message);
			assert.equal(reused.model, selected);
		} finally {
			await current.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

async function prompt(service: DesktopService) {
	let complete: () => void = () => {};
	let fail: (error: Error) => void = () => {};
	const settled = new Promise<void>((resolve, reject) => {
		complete = resolve;
		fail = reject;
	});
	const unsubscribe = service.subscribe(({ event }) => {
		if (event.type === "agent_settled") complete();
		if (event.type === "desktop_error") fail(new Error(event.message));
	});
	const timer = setTimeout(() => fail(new Error("Model request did not settle")), 15000);
	try {
		await service.command({ type: "prompt", message: "Verify the configured model." });
		await settled;
		const snapshot = await service.snapshot();
		const reply = snapshot.messages.findLast((message) => message.role === "assistant");
		assert.ok(reply?.role === "assistant");
		assert.ok(
			reply.content.some((content) => content.type === "text" && content.text === "WIRE_OK"),
			JSON.stringify(snapshot.messages.filter((message) => message.role === "assistant")),
		);
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}

const protocols: { provider: Provider; api: ConnectionProtocol; path: string }[] = [
	{ provider: "openai", api: "openai-completions", path: "/v1/chat/completions" },
	{ provider: "anthropic", api: "anthropic-messages", path: "/v1/messages" },
	{ provider: "openai", api: "openai-responses", path: "/v1/responses" },
];

for (const { provider, api, path } of protocols) {
	test(
		`saved ${api} connection authenticates actual Pi requests and survives session restore`,
		{ timeout: 60000 },
		async () => {
			const endpoint = await createModelEndpoint();
			const { fixture, options, service } = await setup();
			let current = service;
			const secret = `test-only-${api}-secret`;
			const modelId = `desktop-wire-${provider}`;
			try {
				const saved = await service.saveSettings({
					permission: "ask",
					theme: "light",
					provider,
					apiKey: secret,
					modelId,
					api,
					baseUrl: api === "anthropic-messages" ? endpoint.baseUrl : `${endpoint.baseUrl}/v1`,
				});
				assert.equal(saved.engineStatus, "ready", saved.engineError);
				assert.equal(saved.state?.model?.provider, `desktop-${provider}`);
				assert.equal(saved.state?.model?.id, modelId);
				assert.equal(saved.state?.model?.api, api);
				assert.equal(saved.settings.connections[provider]?.api, api);
				assert.ok(saved.settings.configuredProviders.includes(provider));
				assert.ok(!JSON.stringify(saved).includes(secret));
				assert.ok(!JSON.stringify(await service.command({ type: "get_state" })).includes(secret));
				const disk = await readFile(join(fixture.dataDir, "desktop.json"), "utf8");
				assert.ok(!disk.includes(secret), "Desktop metadata must contain only encrypted credentials");
				const stored = JSON.parse(disk) as { keys: Partial<Record<Provider, string>> };
				assert.ok(stored.keys[provider]);
				assert.equal(options.decrypt(stored.keys[provider]!), secret);
				assert.equal((await stat(join(fixture.dataDir, "desktop.json"))).mode & 0o777, 0o600);
				await prompt(service);
				assert.equal(endpoint.requests.length, 1);
				assert.equal(endpoint.requests[0].path, path);
				assert.equal(endpoint.requests[0].body.model, modelId);
				assert.equal(endpoint.requests[0].body.stream, true);
				assert.equal(
					api === "anthropic-messages"
						? endpoint.requests[0].headers["x-api-key"]
						: endpoint.requests[0].headers.authorization,
					api === "anthropic-messages" ? secret : `Bearer ${secret}`,
				);
				await service.close();
				current = new DesktopService({ ...options, initialProject: undefined });
				const restored = await current.initialize();
				assert.equal(restored.engineStatus, "ready", restored.engineError);
				assert.equal(restored.state?.model?.id, modelId);
				assert.equal(restored.state?.model?.api, api);
				await prompt(current);
				assert.equal(endpoint.requests.length, 2);
				const next = await current.newConversation();
				assert.equal(next.state?.model?.provider, `desktop-${provider}`);
				assert.equal(next.state?.model?.id, modelId);
			} finally {
				await current.close();
				await endpoint.close();
				await fixture.cleanup();
			}
		},
	);
}

test(
	"desktop alias preserves native Pi model capabilities while owning its endpoint and credentials",
	{ timeout: 30000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const { fixture, service } = await setup();
		const originalKey = "test-only-native-provider-key";
		const originalHeader = "test-only-native-provider-header";
		const desktopKey = "test-only-alias-provider-key";
		try {
			await writeFile(
				join(fixture.agentDir, "models.json"),
				JSON.stringify({
					providers: {
						openai: {
							baseUrl: "http://127.0.0.1:1/native-upstream",
							apiKey: originalKey,
							headers: { "x-native-only": originalHeader },
						},
					},
				}),
			);
			await service.saveSettings({ permission: "read", theme: "light" });
			await service.command({ type: "set_model", provider: "openai", modelId: "o3-mini" });
			const native = (await service.snapshot()).state?.model;
			assert.ok(native);
			assert.equal(native.api, "openai-responses");
			assert.equal(native.reasoning, true);
			assert.deepEqual(native.input, ["text"]);
			assert.equal(native.contextWindow, 200000);
			assert.equal(native.maxTokens, 100000);
			assert.equal(endpoint.requests.length, 0);
			const saved = await service.saveSettings({
				permission: "read",
				theme: "light",
				provider: "openai",
				modelId: native.id,
				api: "openai-responses",
				apiKey: desktopKey,
				baseUrl: `${endpoint.baseUrl}/v1`,
			});
			assert.equal(saved.engineStatus, "ready", saved.engineError);
			const alias = saved.state?.model;
			assert.ok(alias);
			assert.equal(alias.provider, "desktop-openai");
			assert.equal(alias.id, native.id);
			assert.equal(alias.reasoning, native.reasoning);
			assert.deepEqual(alias.input, native.input);
			assert.equal(alias.contextWindow, native.contextWindow);
			assert.equal(alias.maxTokens, native.maxTokens);
			assert.ok(saved.thinkingLevels.some((level) => level !== "off"));
			assert.equal(alias.baseUrl, `${endpoint.baseUrl}/v1`);
			assert.notEqual(alias.baseUrl, native.baseUrl);
			await prompt(service);
			assert.equal(endpoint.requests.length, 1);
			assert.equal(endpoint.requests[0].path, "/v1/responses");
			assert.equal(endpoint.requests[0].body.model, native.id);
			assert.equal(endpoint.requests[0].headers.authorization, `Bearer ${desktopKey}`);
			assert.equal(endpoint.requests[0].headers["x-native-only"], undefined);
			assert.ok(!JSON.stringify(endpoint.requests).includes(originalKey));
			assert.ok(!JSON.stringify(endpoint.requests).includes(originalHeader));
		} finally {
			await service.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

test(
	"connection test uses draft and saved credentials without changing settings or conversation history",
	{ timeout: 60000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const { fixture, service } = await setup();
		const secret = "test-only-connection-check-secret";
		const input = {
			provider: "openai",
			api: "openai-completions",
			apiKey: secret,
			modelId: "draft-wire-model",
			baseUrl: `${endpoint.baseUrl}/v1`,
		} as const;
		try {
			const before = await service.snapshot();
			const disk = await readFile(join(fixture.dataDir, "desktop.json"), "utf8");
			const entries = await readdir(fixture.dataDir);
			const result = await service.testConnection(input);
			assert.equal(result.success, true, result.message);
			assert.equal(result.model, input.modelId);
			assert.ok(result.latencyMs !== undefined && result.latencyMs >= 0);
			assert.ok(!JSON.stringify(result).includes(secret));
			assert.equal(endpoint.requests.length, 1);
			assert.equal(endpoint.requests[0].headers.authorization, `Bearer ${secret}`);
			assert.ok(!endpoint.requests[0].body.tools, "Connection checks must not expose tools");
			const after = await service.snapshot();
			assert.deepEqual(after.messages, before.messages);
			assert.deepEqual(after.settings, before.settings);
			assert.deepEqual(after.conversations, before.conversations);
			assert.equal(after.active?.id, before.active?.id);
			assert.equal(after.state?.model?.id, before.state?.model?.id);
			assert.equal(await readFile(join(fixture.dataDir, "desktop.json"), "utf8"), disk);
			assert.deepEqual(await readdir(fixture.dataDir), entries);
			await service.saveSettings({ permission: "ask", theme: "light", ...input });
			const reused = await service.testConnection({ provider: "openai", apiKey: "  " });
			assert.equal(reused.success, true, reused.message);
			assert.equal(reused.model, input.modelId);
			assert.equal(endpoint.requests.at(-1)?.headers.authorization, `Bearer ${secret}`);
			endpoint.fail(`Rejected credential ${secret}`);
			const failed = await service.testConnection({ provider: "openai" });
			assert.equal(failed.success, false);
			assert.match(failed.message, /401|Rejected|认证|密钥/);
			assert.ok(!JSON.stringify(failed).includes(secret), "Provider errors must not echo the saved credential");
			assert.ok(!(await readdir(fixture.dataDir)).some((name) => name.startsWith("connection-check-")));
		} finally {
			await service.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

test(
	"connection test reports a missing key before requesting the network and resolves omitted model defaults",
	{ timeout: 30000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const { fixture, service } = await setup();
		try {
			const missingKey = await service.testConnection({
				provider: "openai",
				baseUrl: `${endpoint.baseUrl}/v1`,
				modelId: "test",
			});
			assert.equal(missingKey.success, false);
			assert.match(missingKey.message, /API Key|密钥/);
			assert.equal(endpoint.requests.length, 0);
			const defaultModel = (await service.snapshot()).providerPresets.find(
				(preset) => preset.provider === "openai",
			)?.defaultModelId;
			assert.ok(defaultModel);
			const missingModel = await service.testConnection({
				provider: "openai",
				baseUrl: `${endpoint.baseUrl}/v1`,
				apiKey: "test-only-key",
			});
			assert.equal(missingModel.success, true, missingModel.message);
			assert.equal(missingModel.model, defaultModel);
			assert.equal(endpoint.requests.length, 1);
			assert.equal(endpoint.requests[0].body.model, defaultModel);
		} finally {
			await service.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

test("connection test rejects an empty assistant reply", { timeout: 15000 }, async () => {
	const endpoint = await createModelEndpoint();
	const { fixture, service } = await setup();
	try {
		endpoint.replyWith("   ");
		const result = await service.testConnection({
			provider: "openai",
			api: "openai-completions",
			apiKey: "test-only-empty-reply-key",
			modelId: "test-model",
			baseUrl: `${endpoint.baseUrl}/v1`,
		});
		assert.equal(result.success, false);
		assert.match(result.message, /文本|回复/);
		assert.equal(endpoint.requests.length, 1);
	} finally {
		await service.close();
		await endpoint.close();
		await fixture.cleanup();
	}
});

test(
	"closing the service cancels an outstanding connection test and removes temporary files",
	{ timeout: 15000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const { fixture, service } = await setup();
		try {
			endpoint.stall();
			const checking = service.testConnection({
				provider: "openai",
				api: "openai-completions",
				apiKey: "test-only-cancelled-key",
				modelId: "test-model",
				baseUrl: `${endpoint.baseUrl}/v1`,
			});
			await endpoint.requested;
			await service.close();
			const result = await checking;
			assert.equal(result.success, false);
			assert.match(result.message, /取消|关闭/);
			assert.ok(!(await readdir(fixture.dataDir)).some((name) => name.startsWith("connection-check-")));
		} finally {
			await service.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

test("configuration paths expand home and allow an absent default directory", async () => {
	const fixture = await createCoreFixture();
	const defaultDir = join(fixture.root, "not-created-yet");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		env: { ...fixture.env, PI_CODING_AGENT_DIR: defaultDir },
	});
	try {
		assert.equal((await service.initialize()).settings.agentDir, defaultDir);
		assert.equal(
			(await service.saveSettings({ permission: "ask", theme: "light", agentDir: defaultDir })).settings.agentDir,
			defaultDir,
		);
		assert.equal(
			(await service.saveSettings({ permission: "ask", theme: "light", agentDir: "~" })).settings.agentDir,
			homedir(),
		);
		assert.equal(
			(await service.saveSettings({ permission: "ask", theme: "light", agentDir: "~/" })).settings.agentDir,
			homedir(),
		);
		assert.equal(
			(await service.saveSettings({ permission: "ask", theme: "dark", agentDir: " " })).settings.agentDir,
			defaultDir,
		);
		await assert.rejects(
			service.saveSettings({ permission: "ask", theme: "light", agentDir: join(fixture.root, "missing-custom") }),
		);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("clearing a saved connection model without replacing its key rejects atomically", { timeout: 30000 }, async () => {
	const endpoint = await createModelEndpoint();
	const { fixture, service } = await setup();
	try {
		const before = await service.saveSettings({
			permission: "ask",
			theme: "light",
			provider: "openai",
			api: "openai-completions",
			apiKey: "test-only-retained-key",
			modelId: "retained-wire-model",
			baseUrl: `${endpoint.baseUrl}/v1`,
		});
		const disk = await readFile(join(fixture.dataDir, "desktop.json"), "utf8");
		assert.deepEqual(before.settings.defaultModel, { provider: "desktop-openai", id: "retained-wire-model" });
		await assert.rejects(
			service.saveSettings({ permission: "auto", theme: "dark", provider: "openai", modelId: "" }),
			/模型 ID/,
		);
		const after = await service.snapshot();
		assert.deepEqual(after.settings, before.settings);
		assert.deepEqual(after.settings.defaultModel, before.settings.defaultModel);
		assert.equal(after.state?.model?.id, "retained-wire-model");
		assert.equal(after.engineStatus, "ready", after.engineError);
		assert.equal(await readFile(join(fixture.dataDir, "desktop.json"), "utf8"), disk);
	} finally {
		await service.close();
		await endpoint.close();
		await fixture.cleanup();
	}
});

test("saving a key requires system encryption and leaves settings unchanged on failure", async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({ dataDir: fixture.dataDir, executable: process.execPath, env: fixture.env });
	try {
		const before = await service.initialize();
		await assert.rejects(
			service.saveSettings({
				permission: "auto",
				theme: "dark",
				provider: "openai",
				apiKey: "test-only-must-not-save",
			}),
			/系统安全存储|API Key/,
		);
		const after = await service.snapshot();
		assert.deepEqual(after.settings, before.settings);
		assert.deepEqual(after.settings.configuredProviders, []);
		assert.ok(!JSON.stringify(after).includes("test-only-must-not-save"));
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
