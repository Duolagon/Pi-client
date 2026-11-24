import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { createModelEndpoint } from "./fixtures/model-endpoint.ts";

test("saving a secondary provider preserves both the current chat model and the default model", { timeout: 30000 }, async () => {
	const fixture = await createCoreFixture();
	const endpoint = await createModelEndpoint();
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
		providerBaseUrls: { deepseek: endpoint.baseUrl, anthropic: endpoint.baseUrl, openai: endpoint.baseUrl },
		encrypt: (value: string) => Buffer.from(value).toString("base64"),
		decrypt: (value: string) => Buffer.from(value, "base64").toString(),
	};
	let service = new DesktopService(options);
	const settings = { permission: "ask", theme: "light" } as const;
	try {
		const initial = await service.initialize();
		assert.equal(initial.engineStatus, "ready", initial.engineError);
		const currentId = initial.active!.id;
		const firstModel = await service.saveSettings({ ...settings, provider: "deepseek", apiKey: "test-current-chat" });
		assert.equal(firstModel.state?.model?.provider, "desktop-deepseek");
		const expectedCurrent = { provider: "desktop-deepseek", id: firstModel.state.model.id };
		let complete: () => void = () => {};
		const settled = new Promise<void>((resolve) => { complete = resolve; });
		const unsubscribe = service.subscribe(({ event }) => {
			if (event.type === "agent_settled") complete();
		});
		const timer = setTimeout(complete, 10000);
		try {
			await service.command({ type: "prompt", message: "Persist the chat's independent model." }, currentId);
			await settled;
			assert.equal(endpoint.requests[0]?.body.model, expectedCurrent.id);
			assert.equal((await service.snapshot()).turn?.active, false);
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}

		await service.newConversation();
		const changedDefault = await service.saveSettings({ ...settings, provider: "anthropic", apiKey: "test-default" });
		const expectedDefault = changedDefault.settings.defaultModel;
		assert.equal(expectedDefault?.provider, "desktop-anthropic");
		const current = await service.selectConversation(currentId);
		assert.equal(current.state?.model?.id, expectedCurrent.id);
		assert.deepEqual(current.settings.defaultModel, expectedDefault);

		const saved = await service.saveSettings({
			...settings,
			provider: "openai",
			apiKey: "test-secondary",
			useAsDefault: false,
		});
		assert.equal(saved.engineStatus, "ready", saved.engineError);
		assert.equal(saved.active?.id, currentId);
		assert.deepEqual(saved.settings.defaultModel, expectedDefault);
		assert.equal(saved.state?.model?.id, expectedCurrent.id);
		assert.equal(saved.state?.model?.provider, expectedCurrent.provider);
		assert.ok(saved.settings.configuredProviders.includes("openai"));
		assert.ok(saved.models.some((model) => model.provider === "desktop-openai"));

		await service.close();
		service = new DesktopService({ ...options, initialProject: undefined });
		const restored = await service.initialize();
		assert.equal(restored.active?.id, currentId);
		assert.equal(restored.state?.model?.id, expectedCurrent.id);
		assert.deepEqual(restored.settings.defaultModel, expectedDefault);
		assert.ok(restored.settings.configuredProviders.includes("openai"));
		assert.equal(endpoint.requests.length, 1);
	} finally {
		await service.close();
		await endpoint.close();
		await fixture.cleanup();
	}
});
