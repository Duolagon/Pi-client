import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DesktopService } from "../src/backend.ts";
import { MAX_SHELLS_PER_ROOT, MonitorService, SHELL_EVENT_TYPE } from "../src/monitor-service.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import toolControl, { unwrapSandboxedCommand } from "../src/tool-control-extension.ts";
import { validateDesktopToolInput, validateToolInvocation } from "../src/tool-control-types.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
	const started = Date.now();
	while (!(await check())) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await delay(25);
	}
}

function service() {
	const delivered: { conversationId: string; customType: string; content: string; details: Record<string, unknown> }[] = [];
	const monitors = new MonitorService({
		deliver: async (conversationId, params) => {
			delivered.push({ conversationId, customType: params.customType, content: params.content, details: params.details });
			return "sent";
		},
	});
	return { monitors, delivered };
}

test("background shell: start, incremental reads, filter, completion notice", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-bash-bg-"));
	const { monitors, delivered } = service();
	t.after(async () => { await monitors.close(); await rm(cwd, { recursive: true, force: true }); });
	const record = monitors.startShell({
		conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd,
		command: "printf 'alpha\\nbeta\\n'; printf 'oops\\n' >&2; sleep 0.4; printf 'gamma\\ndelta\\n'; pwd",
	});
	assert.equal(record.kind, "shell");
	assert.match(record.id, /^shell_[a-f0-9]{12}$/);
	await waitFor(() => (monitors.get(record.id)?.eventCount ?? 0) >= 3);
	const first = monitors.readShell(record.id);
	assert.equal(first.status, "running");
	assert.equal(first.exit_code, null);
	assert.equal(first.stdout, "alpha\nbeta");
	assert.equal(first.stderr, "oops");
	// Nothing new since the previous read.
	const empty = monitors.readShell(record.id);
	assert.equal(empty.stdout, "");
	assert.equal(empty.stderr, "");
	await waitFor(() => monitors.get(record.id)?.status !== "running");
	const filtered = monitors.readShell(record.id, "^(gamma|/)");
	assert.equal(filtered.status, "completed");
	assert.equal(filtered.exit_code, 0);
	assert.match(filtered.stdout, /^gamma\n\/.*pi-bash-bg-/);
	assert.equal(filtered.filtered_out, 1);
	// Filtered-out lines are consumed as well.
	assert.equal(monitors.readShell(record.id).stdout, "");
	await waitFor(() => delivered.length === 1);
	assert.equal(delivered[0].customType, SHELL_EVENT_TYPE);
	assert.equal(delivered[0].details.status, "completed");
	assert.match(delivered[0].content, /NOT USER INPUT/);
	assert.match(delivered[0].content, new RegExp(record.id));
	assert.throws(() => monitors.readShell(record.id, "("), /Invalid filter/);
});

test("background shell: failure status, kill, caps and truncation", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-bash-bg-"));
	const { monitors, delivered } = service();
	t.after(async () => { await monitors.close(); await rm(cwd, { recursive: true, force: true }); });
	const failing = monitors.startShell({ conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd, command: "printf 'bad\\n'; exit 3" });
	await waitFor(() => monitors.get(failing.id)?.status !== "running");
	const failed = monitors.readShell(failing.id);
	assert.equal(failed.status, "failed");
	assert.equal(failed.exit_code, 3);
	await waitFor(() => delivered.some((item) => item.details.shell_id === failing.id));
	assert.match(delivered.find((item) => item.details.shell_id === failing.id)!.content, /exitCode=3/);

	const long = monitors.startShell({ conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd, command: "sleep 30" });
	const stopped = await monitors.stop(long.id, undefined, "model_stop");
	assert.equal(stopped.status, "stopped");
	assert.equal(monitors.readShell(long.id).status, "killed");
	// A model stop does not send a completion notice.
	await delay(100);
	assert.ok(!delivered.some((item) => item.details.shell_id === long.id));

	const sleepers = Array.from({ length: MAX_SHELLS_PER_ROOT }, () =>
		monitors.startShell({ conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd, command: "sleep 30" }));
	assert.throws(() => monitors.startShell({ conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd, command: "sleep 30" }), /limit 8/);
	// Another root conversation has its own limit; monitors do not count against it.
	const other = monitors.startShell({ conversationId: "other", rootConversationId: "other", workingDirectory: cwd, command: "sleep 30" });
	assert.equal(await monitors.stopShellsForConversation("conv"), MAX_SHELLS_PER_ROOT);
	for (const item of sleepers) assert.equal(monitors.get(item.id)?.status, "stopped");
	assert.equal(monitors.get(other.id)?.status, "running");

	// About 1.5 MB of output: the oldest part is dropped and the read reports it.
	const big = monitors.startShell({
		conversationId: "conv", rootConversationId: "conv", workingDirectory: cwd,
		command: "i=0; while [ $i -lt 1500 ]; do printf '%01023d\\n' $i; i=$((i+1)); done",
	});
	await waitFor(() => monitors.get(big.id)?.status !== "running");
	let read = monitors.readShell(big.id);
	assert.equal(read.truncated, true);
	let total = read.stdout.length;
	while (read.has_more) { read = monitors.readShell(big.id); total += read.stdout.length + 1; }
	assert.ok(total <= 1024 * 1024 + 2048, String(total));
	assert.ok(total > 900 * 1024, String(total));
	assert.match(read.stdout, /1499$/);
});

test("background Bash permission equals foreground bash; BashOutput and KillShell are harmless", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-bash-bg-perm-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const policy: RuntimePermissionPolicy = { project, mode: "ask", rules: [], disabledTools: [] };
	const same = async (p: RuntimePermissionPolicy, command: string) => {
		const fg = await evaluatePermission(p, { toolName: "bash", input: { command } });
		const bg = await evaluatePermission(p, { toolName: "BashBackground", input: { command } });
		assert.equal(bg.action, fg.action, `${p.mode} ${command}`);
		return bg.action;
	};
	assert.equal(await same(policy, "npm run dev"), "ask");
	assert.equal(await same(policy, "sleep 1 && rm -rf /"), "ask");
	assert.equal(await same({ ...policy, mode: "auto" }, "npm run dev"), "allow");
	assert.equal(await same({ ...policy, mode: "read" }, "npm run dev"), "deny");
	assert.equal(await same({ ...policy, mode: "plan" }, "npm run dev"), "deny");
	assert.equal(await same({ ...policy, dontAsk: true }, "npm run dev"), "deny");
	assert.equal(await same({ ...policy, mode: "auto", disabledTools: ["bash"] }, "npm run dev"), "deny");
	const denyRule = { ...policy, mode: "auto" as const, rules: [{ id: "no-npm", scope: "global" as const, action: "deny" as const, tool: "bash", command: { type: "prefix" as const, argv: ["npm"] } }] };
	assert.equal(await same(denyRule, "npm run dev"), "deny");
	const allowRule = { ...policy, rules: [{ id: "dev", scope: "global" as const, action: "allow" as const, tool: "bash", command: { type: "exact" as const, value: "npm run dev" } }] };
	assert.equal(await same(allowRule, "npm run dev"), "allow");
	for (const mode of ["ask", "read", "plan"] as const) {
		assert.equal((await evaluatePermission({ ...policy, mode }, { toolName: "BashOutput", input: { bash_id: "shell_x" } })).action, "allow");
		assert.equal((await evaluatePermission({ ...policy, mode }, { toolName: "KillShell", input: { shell_id: "shell_x" } })).action, "allow");
	}
	// Host-boundary validation.
	assert.throws(() => validateDesktopToolInput("BashOutput", {}), /bash_id/);
	assert.throws(() => validateDesktopToolInput("BashOutput", { bash_id: "x", extra: 1 }), /Unknown/);
	assert.throws(() => validateDesktopToolInput("KillShell", { shell_id: "" }), /shell_id/);
	assert.throws(() => validateDesktopToolInput("BashBackground", { command: "x\0" }), /command/);
	assert.equal(validateToolInvocation({ tool: "BashBackground", toolCallId: "c", input: { command: "ls" } }).tool, "BashBackground");
	assert.throws(() => validateToolInvocation({ tool: "BashBackground", toolCallId: "c", input: { command: "ls" }, batch: { writers: 0 } }), /batch/);
});

test("bash wrapper keeps foreground runs native and sends run_in_background to the host", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
	const requests: { tool: string; input: Record<string, unknown>; owner: string }[] = [];
	const host = new ToolHostServer({
		handle: async (request, context) => {
			requests.push({ tool: request.tool, input: request.input, owner: context.conversationId });
			return { shell_id: "shell_0123456789ab", status: "running" };
		},
	});
	t.after(async () => { await host.close(); await rm(cwd, { recursive: true, force: true }); });
	await host.start();
	const registration = host.register("parent");
	const toolsFile = join(cwd, "tools.json");
	await writeFile(toolsFile, JSON.stringify({ overrides: {} }));
	const env: Record<string, string> = {
		PI_DESKTOP_TOOLS_DIR: cwd, PI_DESKTOP_TOOLS_TOKEN: randomBytes(32).toString("hex"),
		PI_DESKTOP_TOOLS_COMMAND: `desktop-tools-${randomBytes(16).toString("hex")}`, PI_DESKTOP_TOOLS_FILE: toolsFile,
		PI_DESKTOP_HOST_URL: registration.url, PI_DESKTOP_HOST_TOKEN: registration.token,
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	const definitions = new Map<string, ToolDefinition>();
	Object.assign(process.env, env);
	try {
		toolControl({
			registerTool(definition: ToolDefinition) { definitions.set(definition.name, definition); },
			registerCommand() {}, on() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
			getSettings: () => ({}),
		} as unknown as ExtensionAPI);
	} finally {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
	const bash = definitions.get("bash")!;
	assert.ok(bash, "bash is wrapped");
	assert.ok(definitions.has("BashOutput") && definitions.has("KillShell"));
	const properties = (bash.parameters as { properties: Record<string, unknown> }).properties;
	assert.ok("command" in properties && "timeout" in properties && "run_in_background" in properties);
	assert.match(bash.description, /run_in_background/);
	const ctx = { cwd, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } } as never;
	const fg = await bash.execute("call-1", { command: "printf 'fg-output'" }, undefined, undefined, ctx);
	assert.match(JSON.stringify(fg.content), /fg-output/);
	assert.equal(requests.length, 0);
	const profile = "/tmp/profile 'x'.sb";
	const previousProfile = process.env.PI_DESKTOP_SANDBOX_PROFILE;
	process.env.PI_DESKTOP_SANDBOX_PROFILE = profile;
	try {
		// The permission extension already wrapped the approved command in sandbox-exec.
		const wrapped = `/usr/bin/sandbox-exec -f '/tmp/profile '\\''x'\\''.sb' /bin/sh -c 'npm run dev -- --name '\\''a b'\\'''`;
		const bg = await bash.execute("call-2", { command: wrapped, run_in_background: true, description: "dev server" }, undefined, undefined, ctx);
		assert.match(JSON.stringify(bg.content), /shell_0123456789ab/);
		assert.deepEqual(requests, [{ tool: "BashBackground", input: { command: "npm run dev -- --name 'a b'", description: "dev server" }, owner: "parent" }]);
	} finally {
		if (previousProfile === undefined) delete process.env.PI_DESKTOP_SANDBOX_PROFILE; else process.env.PI_DESKTOP_SANDBOX_PROFILE = previousProfile;
	}
	assert.equal(unwrapSandboxedCommand("echo hi", profile), "echo hi");
	assert.equal(unwrapSandboxedCommand("/usr/bin/sandbox-exec -f '/other.sb' /bin/sh -c 'echo hi'", profile), "/usr/bin/sandbox-exec -f '/other.sb' /bin/sh -c 'echo hi'");
	// A command that only looks wrapped is passed on unchanged (it stays confined by the host).
	const tricky = `/usr/bin/sandbox-exec -f '/tmp/profile '\\''x'\\''.sb' /bin/sh -c 'a' ; 'b'`;
	assert.equal(unwrapSandboxedCommand(tricky, profile), tricky);
});

test("host runs background shells in the project, checks ownership and stops them with the runtime", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const desktop = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const snap = await desktop.initialize();
		assert.equal(snap.engineStatus, "ready", snap.engineError);
		const conversationId = snap.active!.id;
		const internals = desktop as unknown as {
			modelTool(request: { tool: string; toolCallId: string; input: Record<string, unknown> }, context: { conversationId: string; toolCallId: string; signal: AbortSignal }): Promise<Record<string, unknown>>;
			runtimes: Map<string, unknown>;
			stopRuntime(runtime: unknown): Promise<void>;
		};
		const call = (tool: string, input: Record<string, unknown>, owner = conversationId) =>
			internals.modelTool({ tool, toolCallId: `call-${tool}`, input }, { conversationId: owner, toolCallId: `call-${tool}`, signal: new AbortController().signal });
		const started = await call("BashBackground", { command: "pwd; cat seed.txt; sleep 30" });
		const id = started.shell_id as string;
		assert.match(id, /^shell_/);
		await waitFor(async () => ((await call("BashOutput", { bash_id: id })).stdout as string) === "" ? false : true);
		const listed = await desktop.listMonitors(conversationId);
		assert.equal(listed.find((item) => item.id === id)?.kind, "shell");
		// Another root conversation cannot read or stop the shell.
		await assert.rejects(call("BashOutput", { bash_id: id }, "someone-else"), /not found/);
		await assert.rejects(call("KillShell", { shell_id: id }, "someone-else"), /not found/);
		await assert.rejects(call("BashOutput", { bash_id: "mon_000000000000" }), /not found/);

		const second = (await call("BashBackground", { command: "sleep 30" })).shell_id as string;
		const killed = await call("KillShell", { shell_id: second });
		assert.equal(killed.status, "killed");
		assert.equal((await call("BashOutput", { bash_id: second })).status, "killed");

		// Stopping the conversation's runtime stops its remaining shells.
		const runtime = internals.runtimes.get(conversationId);
		assert.ok(runtime);
		await internals.stopRuntime(runtime);
		const after = (await desktop.listMonitors(conversationId)).find((item) => item.id === id);
		assert.equal(after?.status, "stopped");
		assert.equal(after?.stopReason, "runtime_stop");
	} finally {
		await desktop.close();
		await fixture.cleanup();
	}
});

test("pwd of background shell is the project directory", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const desktop = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const snap = await desktop.initialize();
		const conversationId = snap.active!.id;
		const internals = desktop as unknown as {
			modelTool(request: { tool: string; toolCallId: string; input: Record<string, unknown> }, context: { conversationId: string; toolCallId: string; signal: AbortSignal }): Promise<Record<string, unknown>>;
		};
		const context = { conversationId, toolCallId: "c", signal: new AbortController().signal };
		const id = (await internals.modelTool({ tool: "BashBackground", toolCallId: "c", input: { command: "pwd -P; cat seed.txt" } }, context)).shell_id as string;
		let out = "";
		await waitFor(async () => {
			const read = await internals.modelTool({ tool: "BashOutput", toolCallId: "c", input: { bash_id: id } }, context);
			out += read.stdout as string;
			return read.status === "completed";
		});
		const lines = out.split("\n");
		const { realpath } = await import("node:fs/promises");
		assert.equal(lines[0], await realpath(fixture.project));
		assert.equal(lines[1], "seed-content");
	} finally {
		await desktop.close();
		await fixture.cleanup();
	}
});
