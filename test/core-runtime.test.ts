import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { RpcHarness } from "./fixtures/rpc-harness.ts";
import type { RpcSessionState } from "../src/shared.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

test(
	"actual Pi runtime streams output, runs real tools with approvals, rejects writes, aborts, and restores a persisted session",
	{ timeout: 60000 },
	async () => {
		const fixture = await createCoreFixture();
		let harness: RpcHarness;
		const approvals: string[] = [];
		const launch = (sessionFile?: string) =>
			new RpcHarness({
				executable: process.execPath,
				entry: fixture.entry,
				cwd: fixture.project,
				args: ["--extension", extension, ...(sessionFile ? ["--session", sessionFile] : [])],
				env: { ...fixture.env, PI_DESKTOP_PERMISSION_MODE: "ask" },
				onEvent: (event) => {
					if (event.type === "extension_ui_request" && event.method === "confirm") {
						approvals.push(event.title);
						void harness.process.respond({
							type: "extension_ui_response",
							id: event.id,
							confirmed: !event.message.includes("denied.txt"),
						});
					}
				},
			});
		harness = launch();
		try {
			let state = await harness.request<RpcSessionState>({ type: "get_state" });
			assert.equal(state.model?.provider, "desktop-test");
			assert.equal(state.model?.id, "desktop-test-1");
			assert.ok(state.model?.baseUrl.includes("desktop-runtime-secret"));
			const models = await harness.request<{ models: { id: string }[] }>({ type: "get_available_models" });
			assert.deepEqual(models.models.map((model) => model.id).sort(), ["desktop-test-1", "desktop-test-2"]);
			let start = harness.events.length;
			const settled = harness.waitFor("agent_settled", start);
			await harness.request({ type: "prompt", message: "read-write-bash" });
			await settled;
			assert.equal(await readFile(join(fixture.project, "generated.txt"), "utf8"), "written by real Pi tool\n");
			assert.equal(await readFile(join(fixture.project, "command.txt"), "utf8"), "real-pi-command\n");
			const tools = harness.events.filter((event) => event.type === "tool_execution_end");
			assert.deepEqual(
				tools.map((event) => event.toolName),
				["read", "write", "bash"],
			);
			assert.ok(tools.every((event) => !event.isError));
			assert.equal(approvals.length, 2);
			assert.ok(
				harness.events.some(
					(event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
				),
			);

			start = harness.events.length;
			const denied = harness.waitFor("agent_settled", start);
			await harness.request({ type: "prompt", message: "deny-write" });
			await denied;
			await assert.rejects(access(join(fixture.project, "denied.txt")));
			assert.ok(harness.events.slice(start).some((event) => event.type === "tool_execution_end" && event.isError));

			await harness.request({ type: "set_model", provider: "desktop-test", modelId: "desktop-test-2" });
			state = await harness.request<RpcSessionState>({ type: "get_state" });
			assert.equal(state.model?.id, "desktop-test-2");
			assert.ok(state.sessionFile);
			const sessionFile = state.sessionFile;
			start = harness.events.length;
			const aborted = harness.waitFor("agent_settled", start);
			const streaming = harness.waitFor("message_update", start);
			await harness.request({ type: "prompt", message: "slow-stream" });
			await streaming;
			await harness.request({ type: "abort" });
			assert.equal((await aborted).aborted, true);
			await harness.stop();
			harness = launch(sessionFile);
			const restored = await harness.request<RpcSessionState>({ type: "get_state" });
			assert.equal(restored.sessionId, state.sessionId);
			assert.ok(restored.messageCount >= state.messageCount);
		} finally {
			await harness.stop();
			await fixture.cleanup();
		}
	},
);
