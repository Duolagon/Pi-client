import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DesktopService } from "../src/backend.ts";
import { wrapDesktopWorkspaceContext } from "../src/file-references.ts";
import permissions from "../src/permission-extension.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import { isStatusOnlyRequest } from "../src/remote-operation.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const base: RuntimePermissionPolicy = { version: 1, mode: "auto", rules: [], disabledTools: [], project: tmpdir() };

test("foreground Kaggle writes follow the effective permission mode", async () => {
	for (const command of [
		"kaggle kernels status -k research/demo",
		"kaggle kernels list --mine",
		"kaggle competitions submissions -c contest",
		"curl https://www.kaggle.com/api/v1/kernels/status/research/demo",
		"curl -X POST https://www.kaggle.com/api/i/kernels.KernelsService/GetKernelSessionStatus -d '{}'",
		"printf '%s\\n' 'kaggle kernels delete -k research/demo'",
	]) {
		const result = await evaluatePermission(base, { toolName: "bash", input: { command } });
		assert.equal(result.action, "allow", command);
		assert.equal(result.remoteMutation, undefined, command);
	}

	for (const command of [
		"kaggle kernels delete -k research/demo",
		"kaggle kernels push -p notebook",
		"kaggle c submit -c contest -f result.csv -m result",
		"kaggle kernels status research/demo && .venv/bin/kaggle kernels cancel research/demo",
		"HOME=/tmp env -i nice -n 3 command kaggle datasets version -p output",
		"bash -lc 'kaggle kernels status research/demo; kaggle kernels push -p notebook'",
		"python3 -m kaggle datasets create -p output",
		"curl -sS -XPOST -d '{}' https://www.kaggle.com/api/i/kernels.KernelsService/DeleteKernel",
		"curl --request=DELETE https://www.kaggle.com/api/v1/kernels/research/demo",
	]) {
		const call = { toolName: "bash", input: { command } };
		const auto = await evaluatePermission(base, call);
		assert.equal(auto.action, "allow", command);
		assert.equal(auto.remoteMutation, true, command);

		const manual: RuntimePermissionPolicy = { ...base, mode: "ask", rules: [{ id: "allow-bash", scope: "global", action: "allow", tool: "bash" }] };
		const ask = await evaluatePermission(manual, call);
		assert.equal(ask.action, "ask", command);
		assert.equal(ask.remoteMutation, true, command);
		assert.equal((await evaluatePermission({ ...manual, dontAsk: true }, call)).action, "deny", command);
	}
});

test("Kaggle writes honor explicit ask and deny rules even in auto mode", async () => {
	const command = "kaggle kernels push -p notebook";
	const call = { toolName: "bash", input: { command } };
	for (const action of ["ask", "deny"] as const) {
		const ruleId = `${action}-bash`;
		const decision = await evaluatePermission({ ...base, rules: [{ id: ruleId, scope: "global", action, tool: "bash" }] }, call);
		assert.equal(decision.action, action);
		assert.equal(decision.ruleId, ruleId);
		if (action === "ask") assert.equal(decision.remoteMutation, true);
	}
});

test("protected writes cannot be dispatched as background commands or monitors", async () => {
	const command = "kaggle kernels push -p notebook";
	const calls = [
		{ toolName: "bash", input: { command, run_in_background: true } },
		{ toolName: "BashBackground", input: { command } },
		{ toolName: "Monitor", input: { command } },
	];
	for (const mode of ["auto", "ask"] as const) {
		for (const call of calls) {
			const decision = await evaluatePermission({ ...base, mode }, call);
			assert.equal(decision.action, "deny", call.toolName);
			assert.equal(decision.remoteMutation, true, call.toolName);
		}
	}
});

test("standalone progress questions stay read-only and explicit follow-up actions do not", () => {
	for (const message of [
		"为啥要排队，现在在跑什么",
		"我们现在什么情况",
		"现在什么情况？",
		"现在什么情况了",
		"现在怎么样了",
		"现在什么进展",
		"现在出分了吗",
		"请帮我查一下 Kaggle 作业进度",
		"现在怎么样了\n查看队列状态",
		"What is running now? Why is it queued?",
		"Any updates?",
	]) assert.equal(isStatusOnlyRequest(message), true, message);
	for (const message of [
		"查看状态，再删除这个测试作业",
		"现在怎么样了\n然后提交这一版",
		"看看进度后重跑",
		"跑完再提交",
	]) assert.equal(isStatusOnlyRequest(message), false, message);
});

test("status-only requests block mutations in auto mode and configured hook approvals still apply", async () => {
	const project = await realpath(await mkdtemp(join(tmpdir(), "pi-remote-operation-")));
	const policyFile = join(project, "policy.json");
	const environment = ["PI_DESKTOP_HOST_URL", "PI_DESKTOP_HOST_TOKEN", "PI_DESKTOP_POLICY_FILE", "PI_DESKTOP_CONNECTION_TEST"] as const;
	const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
	const deleteCommand = "kaggle kernels delete -k research/demo";
	let hookNeedsApproval = false;
	const host = new ToolHostServer({
		handle: async () => ({}),
		handleHook: async (request) => ({
			blocked: false,
			permissionDecision: hookNeedsApproval && request.phase === "pre" ? "ask" : "allow",
			...(request.toolInput?.command === "echo rewritten" ? { updatedInput: { command: deleteCommand } } : {}),
		}),
	});
	try {
		await host.start();
		const { url, token } = host.register("remote-gate");
		process.env.PI_DESKTOP_HOST_URL = url;
		process.env.PI_DESKTOP_HOST_TOKEN = token;
		process.env.PI_DESKTOP_POLICY_FILE = policyFile;
		delete process.env.PI_DESKTOP_CONNECTION_TEST;
		await writeFile(policyFile, JSON.stringify({ ...base, project }));
		const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
		permissions({ registerTool() {}, registerProvider() {}, on: (name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) => handlers.set(name, handler) } as unknown as ExtensionAPI);
		const decide = handlers.get("tool_call")!;
		const titles: string[] = [];
		const approvalTitle = "允许执行 bash（远端写入，仅本次）？";
		const invoke = (command: string, content: UserMessage["content"]) => decide({ toolName: "bash", toolCallId: "remote-test", input: { command } }, {
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content } }] },
			ui: { confirm: async (title: string) => { titles.push(title); return true; } },
		});
		const blocked = { block: true, reason: "本轮仅查询状态，不能执行远端写操作。" };
		const submitCommand = ".venv/bin/kaggle competitions submit -c contest -f result.csv";
		for (const status of ["为啥要排队，现在在跑什么", "我们现在什么情况", "现在什么情况了", "现在怎么样了"]) {
			assert.equal(await invoke("kaggle kernels status research/demo", status), undefined);
			assert.deepEqual(await invoke(deleteCommand, status), blocked);
			assert.deepEqual(await invoke(submitCommand, status), blocked);
			assert.deepEqual(await invoke("echo rewritten", status), blocked);
		}
		assert.deepEqual(await invoke(submitCommand, [
			{ type: "text", text: "现在怎么样了" },
			{ type: "image", data: "", mimeType: "image/png" },
			{ type: "text", text: wrapDesktopWorkspaceContext("Local project information") },
		]), blocked);
		assert.equal(await invoke(submitCommand, [
			{ type: "text", text: "现在怎么样了" },
			{ type: "text", text: "再提交这一版" },
		]), undefined);
		assert.equal(await invoke(deleteCommand, "删除这个测试作业"), undefined);
		assert.deepEqual(titles, []);
		hookNeedsApproval = true;
		assert.equal(await invoke(deleteCommand, "删除这个测试作业"), undefined);
		assert.deepEqual(titles, [approvalTitle]);
		hookNeedsApproval = false;
		await writeFile(policyFile, JSON.stringify({ ...base, project, mode: "ask" }));
		assert.equal(await invoke(deleteCommand, "删除这个测试作业"), undefined);
		assert.deepEqual(titles, [approvalTitle, approvalTitle]);
	} finally {
		await host.close();
		for (const key of environment) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(project, { recursive: true, force: true });
	}
});

test("the direct terminal confirms recognized writes in manual mode and skips approval in auto", { timeout: 30000 }, async () => {
	const fixture = await createCoreFixture();
	let approve = false;
	const confirmations: string[] = [];
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts"),
		env: fixture.env,
		initialProject: fixture.project,
		confirmRemoteCommand: async ({ command }) => { confirmations.push(command); return approve; },
	});
	try {
		const marker = join(fixture.project, "z-remote-operation");
		await writeFile(join(fixture.project, "kaggle"), "#!/bin/sh\n[ \"$2\" = status ] || touch z-remote-operation\n", { mode: 0o700 });
		assert.equal((await service.initialize()).engineStatus, "ready");
		await service.saveSettings({ permission: "ask", theme: "light" });
		await service.command({ type: "bash", command: "./kaggle kernels status research/demo" });
		assert.deepEqual(confirmations, []);
		const command = "./kaggle kernels delete -k research/demo";
		await assert.rejects(service.command({ type: "bash", command }), /未确认远端写操作/);
		await assert.rejects(access(marker));
		approve = true;
		await service.command({ type: "bash", command });
		await access(marker);
		assert.deepEqual(confirmations, [command, command]);
		await rm(marker);
		approve = false;
		await service.saveSettings({ permission: "auto", theme: "light" });
		await service.command({ type: "bash", command });
		await access(marker);
		assert.deepEqual(confirmations, [command, command]);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
