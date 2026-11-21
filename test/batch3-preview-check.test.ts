import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunchShellCommand, launchConfigUrl, readLaunchConfigurations, validateLocalPreviewUrl } from "../src/launch-config.ts";
import { formatPreviewInspectSummary } from "../src/preview-check-types.ts";
import { validateToolInvocation } from "../src/tool-control-types.ts";
import { evaluatePermission } from "../src/permission-policy.ts";

test("#27 PreviewCheck: .claude/launch.json parsing, security filters, and shell command building", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-test-"));
	try {
		const missing = await readLaunchConfigurations(root);
		assert.equal(missing.exists, false);
		assert.deepEqual(missing.configurations, []);

		await mkdir(join(root, ".claude"), { recursive: true });
		await mkdir(join(root, "web"), { recursive: true });
		await writeFile(
			join(root, ".claude", "launch.json"),
			JSON.stringify({
				version: "0.0.1",
				configurations: [
					{
						name: "dev",
						runtimeExecutable: "npm",
						runtimeArgs: ["run", "dev", "--", "--port", "5173"],
						port: 5173,
						cwd: "web",
						env: { NODE_ENV: "development", NODE_OPTIONS: "--evil", DYLD_INSERT_LIBRARIES: "/bad.dylib" },
					},
					{
						name: "escaped-cwd",
						command: "echo hi",
						cwd: "../../..",
					},
					{
						name: "external-url",
						command: "npm start",
						url: "https://example.com/",
						port: 3000,
					},
				],
			}),
			"utf8",
		);

		const result = await readLaunchConfigurations(root);
		assert.equal(result.exists, true);
		assert.equal(result.configurations.length, 2);
		const dev = result.configurations.find((c) => c.name === "dev")!;
		assert.equal(launchConfigUrl(dev), "http://127.0.0.1:5173/");
		assert.deepEqual(dev.env, { NODE_ENV: "development" });
		const cmd = buildLaunchShellCommand(dev);
		assert.match(cmd, /^NODE_ENV='development' 'npm' 'run' 'dev'/);

		// escaped-cwd was rejected
		assert.equal(result.configurations.some((c) => c.name === "escaped-cwd"), false);
		// external-url had its remote url stripped and warned, falling back to port
		const ext = result.configurations.find((c) => c.name === "external-url")!;
		assert.equal(ext.url, undefined);
		assert.equal(launchConfigUrl(ext), "http://127.0.0.1:3000/");
		assert.ok(result.warnings.length >= 2);

		assert.throws(() => validateLocalPreviewUrl("https://evil.example.com"), /本机开发地址/);
		assert.equal(validateLocalPreviewUrl("http://localhost:3000/app").hostname, "localhost");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("#27 PreviewCheck: tool input validation and permission policy", async () => {
	const validCheck = validateToolInvocation({
		tool: "PreviewCheck",
		toolCallId: "pc-1",
		input: {
			action: "check",
			url: "http://localhost:5173",
			mobile: true,
			screenshot: true,
			selector: "#app",
			actions: [
				{ type: "wait_for", selector: "button#submit", timeoutMs: 2000 },
				{ type: "fill", selector: "input[name='email']", value: "dev@example.com" },
				{ type: "click", selector: "button#submit" },
				{ type: "scroll", y: 300 },
				{ type: "wait", ms: 200 },
			],
		},
	});
	assert.equal(validCheck.tool, "PreviewCheck");

	assert.throws(() =>
		validateToolInvocation({
			tool: "PreviewCheck",
			toolCallId: "pc-2",
			input: { action: "invalid_action" },
		}),
	);
	assert.throws(() =>
		validateToolInvocation({
			tool: "PreviewCheck",
			toolCallId: "pc-3",
			input: { action: "check", actions: [{ type: "eval", code: "1+1" }] },
		}),
	);

	// Permission policy checks
	const base = { version: 1 as const, rules: [], disabledTools: [], project: "/tmp" };
	assert.equal((await evaluatePermission({ ...base, mode: "read" }, { toolName: "PreviewCheck", input: { action: "check", url: "http://localhost:3000" } })).action, "allow");
	assert.equal((await evaluatePermission({ ...base, mode: "read" }, { toolName: "PreviewCheck", input: { action: "list_configs" } })).action, "allow");
	assert.equal((await evaluatePermission({ ...base, mode: "read" }, { toolName: "PreviewCheck", input: { action: "start_server", name: "dev" } })).action, "deny");
	assert.equal((await evaluatePermission({ ...base, mode: "plan" }, { toolName: "PreviewCheck", input: { action: "start_server", name: "dev" } })).action, "deny");
	assert.equal((await evaluatePermission({ ...base, mode: "ask" }, { toolName: "PreviewCheck", input: { action: "start_server", name: "dev" } })).action, "ask");
	assert.equal((await evaluatePermission({ ...base, mode: "auto" }, { toolName: "PreviewCheck", input: { action: "start_server", name: "dev" } })).action, "allow");
	assert.equal(
		(await evaluatePermission({ ...base, mode: "auto", disabledTools: ["PreviewCheck"] }, { toolName: "PreviewCheck", input: { action: "check" } })).action,
		"deny",
	);
});

test("#27 PreviewCheck: summary formatting includes actions, errors, interactive elements, DOM, and screenshot", () => {
	const summary = formatPreviewInspectSummary({
		url: "http://127.0.0.1:5173/dashboard",
		title: "Dashboard",
		status: 200,
		elapsedMs: 412,
		errors: ["TypeError: Cannot read properties of undefined"],
		actionLog: ['click #refresh (<button> "Refresh")'],
		interactiveElements: [{ tag: "button", text: "Refresh", selector: "#refresh" }],
		domText: "Welcome to Dashboard",
		domHtml: '<main id="app">Welcome</main>',
		screenshotPath: "/tmp/preview-123.png",
	});
	assert.match(summary, /\[PreviewCheck\] http:\/\/127\.0\.0\.1:5173\/dashboard/);
	assert.match(summary, /HTTP 200/);
	assert.match(summary, /click #refresh/);
	assert.match(summary, /TypeError: Cannot read properties of undefined/);
	assert.match(summary, /截图已保存：\/tmp\/preview-123\.png/);
	assert.match(summary, /#refresh/);
	assert.match(summary, /Welcome to Dashboard/);
});
