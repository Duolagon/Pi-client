import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DesktopService } from "../src/backend.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

test("the current conversation changes mode or theme during work without replacing its run", { timeout: 45000 }, async () => {
	const fixture = await createCoreFixture();
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
		toolControlExtension: fileURLToPath(new URL("../src/tool-control-extension.ts", import.meta.url)),
		env: fixture.env,
		initialProject: fixture.project,
	};
	let service = new DesktopService(options);
	try {
		const initialized = await service.initialize();
		assert.equal(initialized.engineStatus, "ready", initialized.engineError);
		const first = initialized.active!.id;
		await service.command({ type: "prompt", message: "slow-stream" }, first);
		const run = (await service.snapshot()).turn;
		assert.equal(run?.active, true);
		const changed = await service.setConversationPermission(first, "read");
		assert.equal(changed.settings.permission, "ask");
		assert.equal(changed.active?.permissionMode, "read");
		assert.equal(changed.turn?.id, run?.id);
		assert.equal((await service.checkPermission({ conversationId: first, toolName: "bash", input: { command: "pwd" } })).action, "deny");
		const theme = await service.saveSettings({ permission: changed.settings.permission, theme: "dark" });
		assert.equal(theme.settings.theme, "dark");
		assert.equal(theme.turn?.id, run?.id);
		await service.command({ type: "abort" }, first);
		const deadline = Date.now() + 10000;
		while ((await service.snapshot()).turn?.active && Date.now() < deadline) await delay(25);
		assert.equal((await service.snapshot()).turn?.active, false);
		await service.setConversationPermission(first, "plan");
		assert.equal((await service.listTools(first)).find((tool) => tool.name === "ExitPlanMode")?.modelVisible, true);
		await service.setConversationPermission(first, "acceptEdits");
		assert.equal((await service.listTools(first)).find((tool) => tool.name === "ExitPlanMode")?.modelVisible, false);
		const second = (await service.newConversation()).active!.id;
		assert.notEqual(first, second);
		assert.equal((await service.permissionSettings(second)).effective.mode, "ask");
		assert.equal((await service.permissionSettings(first)).effective.mode, "acceptEdits");
		await service.close();
		service = new DesktopService(options);
		await service.initialize();
		assert.equal((await service.permissionSettings(first)).effective.mode, "acceptEdits");
		assert.equal((await service.permissionSettings(second)).effective.mode, "ask");
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
