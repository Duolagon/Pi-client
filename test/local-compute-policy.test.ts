import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/backend.ts";
import { evaluatePermission, validateRuntimePolicy } from "../src/permission-policy.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

test("project local compute is denied in foreground, background, and command monitors", async () => {
	const policy = validateRuntimePolicy({
		version: 1, mode: "auto", project: process.cwd(), rules: [], disabledTools: [], blockLocalCompute: true,
	});
	for (const [toolName, command] of [
		["bash", "cd '/tmp/demo' && (./bin/llama/llama-server -ngl 99 -np 3 > /tmp/demo.log 2>&1 & echo started)"],
		["BashBackground", "bash -lc 'env FOO=1 nohup bash eval/ab.sh'"],
		["Monitor", ".venv/bin/python -u eval/runner.py --concurrency 3"],
		["bash", "ollama serve"],
		["bash", "python3.13 -m vllm.entrypoints.openai.api_server"],
	]) {
		const decision = await evaluatePermission(policy, { toolName, input: { command } });
		assert.match(decision.reason, /禁止启动本机推理/);
		assert.equal(decision.action, "deny");
	}
	for (const command of ["llama-server --help", "grep -n llama-server AGENTS.md", "npm test", "kaggle kernels status demo/foo"]) {
		assert.equal((await evaluatePermission(policy, { toolName: "bash", input: { command } })).action, "allow", command);
	}
	assert.equal((await evaluatePermission({ ...policy, blockLocalCompute: undefined },
		{ toolName: "bash", input: { command: "./llama-server" } })).action, "allow");
});

test("project constraints persist across sessions and restart and can be cleared", { timeout: 20_000 }, async () => {
	const fixture = await createCoreFixture();
	const options = {
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry, initialProject: fixture.project,
		permissionExtension: resolve(import.meta.dirname, "../src/permission-extension.ts"), env: fixture.env,
	};
	let service = new DesktopService(options);
	try {
		const marker = join(fixture.project, "started");
		await writeFile(join(fixture.project, "llama-server"), "#!/bin/sh\ntouch started\n", { mode: 0o700 });
		const first = await service.initialize();
		assert.equal(first.engineStatus, "ready", first.engineError);
		await service.setProjectLocalCompute(first.active!.id, true);
		const second = await service.newConversation();
		assert.notEqual(second.active!.id, first.active!.id);
		const command = { type: "bash" as const, command: "./llama-server" };
		await assert.rejects(service.command(command), /禁止启动本机推理/);
		await assert.rejects(access(marker));
		await service.close();

		service = new DesktopService(options);
		const restarted = await service.initialize();
		assert.equal((await service.permissionSettings(restarted.active!.id)).effective.blockLocalCompute, true);
		await assert.rejects(service.command(command), /禁止启动本机推理/);
		await service.setProjectLocalCompute(restarted.active!.id, false);
		await service.command(command);
		await access(marker);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
