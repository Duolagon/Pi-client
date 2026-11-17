import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableArgument = process.argv.indexOf("--executable");
const executable =
	executableArgument >= 0
		? resolve(process.argv[executableArgument + 1])
		: join(
				repo,
				"release/desktop",
				process.arch === "arm64" ? "mac-arm64" : "mac",
				"Pi Desktop.app/Contents/MacOS/Pi Desktop",
			);
const capture = process.argv.includes("--screenshots");
async function until(check, label) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
await access(executable).catch(() => {
	throw new Error("Build the application first with npm run package, or pass --executable /path/to/application.");
});
const root = await mkdtemp(join(tmpdir(), "pi-client-ui-"));
const project = join(root, "pi-client-demo");
const agentDir = join(root, "agent");
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
await mkdir(join(project, "src"), { recursive: true });
await mkdir(join(project, "test"));
await mkdir(join(agentDir, "extensions"), { recursive: true });
await cp(join(repo, "test/fixtures/ui-provider.js"), join(agentDir, "extensions/ui-provider.js"));
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({
		defaultProvider: "desktop-demo",
		defaultModel: "desktop-demo-1",
		thinkingLevel: "off",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
await writeFile(join(project, "src/greeting.mjs"), 'export function greet(name) {\n  return "";\n}\n');
await writeFile(
	join(project, "test/greeting.test.mjs"),
	'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { greet } from "../src/greeting.mjs";\ntest("返回中文问候语", () => assert.equal(greet("Pi"), "你好，Pi！"));\n',
);
await exec("git", ["init", "--initial-branch=main", project], { env: gitEnv });
await exec("git", ["add", "--", "src/greeting.mjs", "test/greeting.test.mjs"], { cwd: project, env: gitEnv });
await exec(
	"git",
	[
		"-c",
		"user.name=Desktop Test",
		"-c",
		"user.email=desktop@example.invalid",
		"-c",
		"commit.gpgSign=false",
		"commit",
		"-m",
		"test: Prepare desktop UI fixture",
	],
	{ cwd: project, env: gitEnv },
);
const env = {
	...process.env,
	ELECTRON_RUN_AS_NODE: undefined,
	PI_CODING_AGENT_DIR: agentDir,
	PI_DESKTOP_DATA_DIR: join(root, "desktop"),
	PI_DESKTOP_WORKSPACE: project,
	PI_OFFLINE: "1",
};
for (const key of Object.keys(env))
	if (
		/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS)/.test(
			key,
		)
	)
		env[key] = undefined;
let application;
let page;
const checks = [];
try {
	application = await electron.launch({ executablePath: executable, args: [], env, timeout: 30000 });
	page = await application.firstWindow();
	page.setDefaultTimeout(15000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const snapshot = () => page.evaluate(() => window.pi.snapshot());
	const ready = () =>
		until(async () => {
			const value = await snapshot();
			return value.engineStatus === "ready" && value.state?.model?.provider === "desktop-demo";
		}, "Pi startup");
	const idle = () =>
		until(async () => {
			const value = await snapshot();
			return (
				!value.state?.isStreaming &&
				!value.state?.isCompacting &&
				(await page.getByRole("button", { name: "停止任务", exact: true }).count()) === 0
			);
		}, "the current response to settle");
	const submit = async (text) => {
		await page.getByRole("textbox", { name: "输入任务", exact: true }).fill(text);
		await page.getByRole("button", { name: "发送任务", exact: true }).click();
	};
	const closeError = async () => {
		await page.getByRole("button", { name: "关闭错误提示", exact: true }).click();
	};
	await ready();
	assert.ok((await snapshot()).models.length >= 2);
	await page.getByRole("combobox", { name: "选择模型", exact: true }).selectOption({ label: "本地演示模型 · 备用" });
	await until(
		async () =>
			(await snapshot()).state?.model?.id === "desktop-demo-2" &&
			(await page.getByRole("combobox", { name: "选择模型", exact: true }).inputValue()).endsWith("desktop-demo-2"),
		"the selected alternate model",
	);
	await page.getByRole("combobox", { name: "选择模型", exact: true }).selectOption({ label: "本地演示模型" });
	await until(
		async () =>
			(await snapshot()).state?.model?.id === "desktop-demo-1" &&
			(await page.getByRole("combobox", { name: "选择模型", exact: true }).inputValue()).endsWith("desktop-demo-1"),
		"the selected demo model",
	);
	await page.getByRole("combobox", { name: "思考强度", exact: true }).selectOption("low");
	await until(async () => (await snapshot()).state?.thinkingLevel === "low", "the selected thinking level");
	checks.push("model and thinking controls");

	const input = page.getByRole("textbox", { name: "输入任务", exact: true });
	await input.fill("需要检查的草稿\n".repeat(30));
	await page.waitForFunction(
		() => document.querySelector('textarea[aria-label="输入任务"]').getBoundingClientRect().height >= 190,
	);
	await page
		.getByLabel("选择附件", { exact: true })
		.setInputFiles({
			name: "private-draft.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("MUST_NOT_CROSS_SESSION"),
		});
	await page.getByRole("button", { name: "移除附件 private-draft.txt", exact: true }).waitFor();
	const firstId = (await snapshot()).active.id;
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await until(async () => (await snapshot()).active?.id !== firstId, "the new conversation");
	await page.waitForFunction(() => {
		const input = document.querySelector('textarea[aria-label="输入任务"]');
		return input.value === "" && input.getBoundingClientRect().height < 100;
	});
	assert.equal(await page.getByRole("button", { name: "移除附件 private-draft.txt", exact: true }).count(), 0);
	await input.fill("保留这份草稿");
	await page
		.getByLabel("选择附件", { exact: true })
		.setInputFiles({ name: "oversize.png", mimeType: "image/png", buffer: Buffer.alloc(8 * 1024 * 1024) });
	await page
		.getByRole("alert")
		.filter({ hasText: /图片|编码|超过/ })
		.waitFor();
	assert.equal(await input.inputValue(), "保留这份草稿");
	await closeError();
	await page
		.getByLabel("选择附件", { exact: true })
		.setInputFiles(
			Array.from({ length: 11 }, (_, index) => ({
				name: `image-${index}.png`,
				mimeType: "image/png",
				buffer: Buffer.from("tiny synthetic image"),
			})),
		);
	await page
		.getByRole("alert")
		.filter({ hasText: /10|图片/ })
		.waitFor();
	assert.equal(await input.inputValue(), "保留这份草稿");
	assert.equal(await page.locator(".cl-attachments button").count(), 0);
	await closeError();
	await page
		.getByLabel("选择附件", { exact: true })
		.setInputFiles(
			["one.txt", "two.txt"].map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024, "a") })),
		);
	await page
		.getByRole("alert")
		.filter({ hasText: /合计超过 2 MB/ })
		.waitFor();
	assert.equal(await input.inputValue(), "保留这份草稿");
	assert.equal(await page.locator(".cl-attachments button").count(), 0);
	await closeError();
	await submit("/demo-note");
	await page.waitForFunction(
		() => document.querySelector('textarea[aria-label="输入任务"]').value === "请继续完善测试。",
	);
	assert.ok((await input.boundingBox()).height < 100);
	checks.push("conversation attachment isolation, input resize and upload limits");

	await submit("审批拒绝验证");
	await page.getByRole("dialog", { name: "允许执行 write？", exact: true }).waitFor();
	await page.getByRole("button", { name: "拒绝", exact: true }).click();
	await page.getByText("写入已按你的选择取消。", { exact: true }).waitFor();
	await idle();
	await assert.rejects(access(join(project, "denied.txt")));
	checks.push("real tool approval refusal");
	await submit("停止生成验证");
	await page.waitForFunction(() =>
		document.querySelector(".cl-transcript")?.textContent.includes("流式恢复验证：正在检查"),
	);
	await page.reload();
	await ready();
	await page.waitForFunction(() => document.querySelector('button[aria-label="停止任务"]'));
	await page.waitForFunction(() => document.querySelector(".cl-transcript")?.textContent.includes("流式恢复验证："));
	const partialLength = await page
		.locator(".cl-transcript")
		.innerText()
		.then((text) => text.length);
	await page.waitForFunction(
		(size) => document.querySelector(".cl-transcript").textContent.length > size + 5,
		partialLength,
	);
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await idle();
	await page.getByText("本次回复已停止。", { exact: true }).waitFor();
	checks.push("stream restoration after reload and abort");

	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await ready();
	await submit("请实现问候函数，并运行测试确认中文问候语正确。");
	for (const name of ["write", "bash"]) {
		await page.getByRole("dialog", { name: `允许执行 ${name}？`, exact: true }).waitFor();
		await page.getByRole("button", { name: "允许执行", exact: true }).click();
	}
	await page.getByText("已完成问候函数，并通过项目测试。", { exact: true }).waitFor();
	await idle();
	assert.equal(await page.locator(".cl-msg-user").count(), 1);
	assert.equal(await page.locator(".cl-msg-ai").count(), 1);
	assert.equal(await page.locator(".cl-tool.done").count(), 3);
	assert.match(await readFile(join(project, "src/greeting.mjs"), "utf8"), /你好/);
	assert.ok((await input.boundingBox()).height < 100);
	await page.locator(".cl-title-button").click();
	await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("实现问候函数与测试");
	await page.getByRole("button", { name: "保存名称", exact: true }).click();
	await page.getByRole("button", { name: "代码修改", exact: true }).click();
	await page.locator(".changed-file-list button").filter({ hasText: "greeting.mjs" }).click();
	await page.locator(".live-diff").filter({ hasText: "你好" }).waitFor();
	await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
	checks.push("real read/write/bash tools, grouped transcript and Git diff");
	if (capture) {
		const screenshots = join(repo, "docs/screenshots");
		await mkdir(screenshots, { recursive: true });
		await page.screenshot({ path: join(screenshots, "client-light.png"), scale: "css" });
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByText("权限与外观", { exact: true }).click();
		await page.getByRole("combobox", { name: /^外观/ }).selectOption("dark");
		await page.getByRole("button", { name: "保存设置", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
		await page.getByRole("button", { name: "代码修改", exact: true }).click();
		await page.locator(".changed-file-list button").filter({ hasText: "greeting.mjs" }).click();
		await page.locator(".live-diff").filter({ hasText: "你好" }).waitFor();
		await page.screenshot({ path: join(screenshots, "client-dark.png"), scale: "css" });
		await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
	}

	await page.getByRole("button", { name: "终端", exact: true }).click();
	await page.getByRole("textbox", { name: "终端命令", exact: true }).fill("printf 'UI_SHELL_OK\\n'");
	await page.getByRole("textbox", { name: "终端命令", exact: true }).press("Enter");
	await page.locator(".terminal-output").filter({ hasText: "UI_SHELL_OK" }).waitFor();
	await page.waitForFunction(() => document.querySelector(".terminal-output")?.textContent.includes("退出码 0"));
	await page.getByRole("button", { name: "关闭终端", exact: true }).click();
	checks.push("legacy shell command panel");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("combobox", { name: "模型服务商", exact: true }).selectOption("deepseek");
	assert.ok((await page.getByRole("combobox", { name: "默认模型", exact: true }).locator("option").count()) >= 2);
	assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await page.getByRole("button", { name: "搜索会话", exact: true }).click();
	await page.getByRole("textbox", { name: "搜索会话标题或项目", exact: true }).fill("实现问候函数");
	await page.locator(".search-results button").filter({ hasText: "实现问候函数与测试" }).click();
	await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	checks.push("provider presets, conversation search and sidebar controls");

	const state = await snapshot();
	const points = await page.evaluate((id) => window.pi.git.list(id), state.active.id);
	const point = points.find((item) => item.changes.some((change) => change.path === "src/greeting.mjs"));
	assert.ok(point, "The visible agent turn must create a real Git checkpoint");
	const checkpointDiff = await page.evaluate(
		({ checkpointId, conversationId }) => window.pi.git.diff({ checkpointId, conversationId }),
		{ checkpointId: point.id, conversationId: state.active.id },
	);
	assert.ok(checkpointDiff.files.some((file) => file.path === "src/greeting.mjs"));
	const tree = await page.evaluate((id) => window.pi.sessions.tree(id), state.active.id);
	assert.ok(tree.tree.length);
	const terminal = await page.evaluate(() => window.pi.terminals.create({ shell: "/bin/bash" }));
	try {
		await page.evaluate(
			(id) => window.pi.terminals.write(id, "test -t 0 && test -t 1 && printf '\\nUI_PTY_OK\\n'\r"),
			terminal.id,
		);
		await until(
			async () =>
				(await page.evaluate((id) => window.pi.terminals.replay(id), terminal.id)).chunks
					.map((chunk) => chunk.data)
					.join("")
					.includes("\r\nUI_PTY_OK\r\n"),
			"real PTY output",
		);
	} finally {
		await page.evaluate((id) => window.pi.terminals.close(id), terminal.id);
	}
	const task = await page.evaluate(() =>
		window.pi.tasks.start({ message: "后台接口验证", title: "后台接口验证", isolation: "worktree" }),
	);
	await until(
		async () =>
			(await page.evaluate(() => window.pi.tasks.list())).some(
				(item) => item.id === task.id && ["completed", "failed"].includes(item.status),
			),
		"the background task",
	);
	assert.equal(
		(await page.evaluate(() => window.pi.tasks.list())).find((item) => item.id === task.id).status,
		"completed",
	);
	assert.equal((await snapshot()).active.id, state.active.id);
	await page.evaluate((id) => window.pi.worktrees.remove(id), task.worktreeId);
	checks.push("checkpoint, session tree, PTY, background task and worktree preload interfaces");
	const tools = await page.evaluate(() => window.pi.tools.list());
	assert.ok(tools.some((tool) => tool.name === "Agent" && tool.modelVisible && tool.source === "desktop"));
	const enabled = await page.evaluate(() => window.pi.tools.setEnabled({ name: "grep", enabled: true }));
	assert.ok(enabled.some((tool) => tool.name === "grep" && tool.enabled));
	await page.evaluate(() => window.pi.permissions.upsert({
		id: "verify-deny-write", scope: "global", action: "deny", tool: "write", path: "forbidden.txt",
	}));
	const decision = await page.evaluate(() => window.pi.permissions.check({ toolName: "write", input: { path: "forbidden.txt", content: "blocked" } }));
	assert.equal(decision.action, "deny");
	await page.evaluate(() => window.pi.permissions.remove("verify-deny-write"));
	await page.evaluate(() => window.pi.tools.setEnabled({ name: "grep", enabled: null }));
	checks.push("real tool inventory, scoped enablement and permission rule preload interfaces");
	const executors = await page.evaluate(() => window.pi.externalAgents.executors());
	assert.deepEqual(executors.map((item) => item.id), ["codex", "claude", "kimi"]);
	assert.equal(executors.find((item) => item.id === "kimi").capabilities.readOnly, false);
	assert.deepEqual(await page.evaluate(() => window.pi.externalAgents.list()), []);
	const configured = await page.evaluate(() => window.pi.externalAgents.configure({ id: "codex", enabled: false }));
	assert.equal(configured.find((item) => item.id === "codex").enabled, false);
	await page.evaluate(() => window.pi.externalAgents.configure({ id: "codex", enabled: true }));
	checks.push("local external executor discovery, configuration and task namespace through real preload");

	// Verify Claude Code UI modals, autocomplete, and interactive PTY tab
	await page.getByRole("button", { name: "检查点与回滚", exact: true }).click();
	await page.getByRole("dialog", { name: "检查点与代码回滚 (/rewind)", exact: true }).waitFor();
	await page.locator(".cc-rewind-file-bar").filter({ hasText: "greeting.mjs" }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.getByRole("button", { name: "工具与权限", exact: true }).click();
	await page.getByRole("dialog", { name: "工具、MCP 与权限规则", exact: true }).waitFor();
	await page.locator(".cc-tool-ctrl-name strong").getByText("Agent", { exact: true }).waitFor();
	await page.getByRole("tab", { name: /权限规则/ }).click();
	await page.getByRole("tab", { name: /外部执行器/ }).click();
	await page.locator(".cc-tool-ctrl-name strong").getByText("codex", { exact: true }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.getByRole("button", { name: "后台任务与 Worktree", exact: true }).click();
	await page.getByRole("dialog", { name: "后台任务、子 Agent 与 Worktree (/tasks)", exact: true }).waitFor();
	await page.getByRole("tab", { name: /Worktrees/ }).click();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.getByRole("button", { name: "会话分支树", exact: true }).click();
	await page.getByRole("dialog", { name: "会话分支树与 CLI 历史导入 (/sessions)", exact: true }).waitFor();
	await page.getByRole("tab", { name: /Pi CLI 历史/ }).click();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await input.fill("/");
	await page.getByRole("listbox", { name: "斜杠命令", exact: true }).waitFor();
	await input.fill("@greeting");
	await page.getByRole("listbox", { name: "引用项目文件", exact: true }).filter({ hasText: "src/greeting.mjs" }).waitFor();
	await input.fill("");

	await page.locator(".cc-skills-trigger").click();
	await page.locator(".cl-skills-list").waitFor();
	const skillsBox = await page.locator(".cl-skills-list").boundingBox();
	assert.ok(skillsBox && skillsBox.width <= 460 && skillsBox.x >= 0, `Skills popover must stay bounded (${JSON.stringify(skillsBox)})`);
	await page.getByRole("textbox", { name: "搜索技能或命令", exact: true }).fill("demo-note");
	await page.locator(".cc-skills-items button").filter({ hasText: "/demo-note" }).click();
	assert.equal(await input.inputValue(), "/demo-note ");
	assert.equal(await page.locator(".cl-skills-list").count(), 0);
	await input.fill("");

	await page.getByRole("button", { name: "终端", exact: true }).click();
	await page.getByRole("button", { name: /^交互 PTY/ }).click();
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).fill("echo UI_PTY_PANEL_OK");
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).press("Enter");
	await page.locator(".terminal-output").filter({ hasText: "UI_PTY_PANEL_OK" }).waitFor();
	await page.getByRole("button", { name: "关闭终端", exact: true }).click();
	checks.push("Claude Code UI modals, autocomplete and PTY panel");

	await page.getByRole("button", { name: "代码修改", exact: true }).click();
	await page.getByRole("button", { name: "暂存 src/greeting.mjs", exact: true }).click();
	await page.locator(".cc-change-section").filter({ hasText: "已暂存 (1)" }).waitFor();
	await page.getByRole("button", { name: "取消暂存 src/greeting.mjs", exact: true }).click();
	await page.getByRole("button", { name: "暂存 src/greeting.mjs", exact: true }).waitFor();
	await page.locator(".changed-file-list button.cc-change-open").filter({ hasText: "greeting.mjs" }).click();
	await page.locator(".live-diff").filter({ hasText: "你好" }).waitFor();
	await page.locator('button[title="切换统一/分栏对比"]').click();
	await page.locator(".cc-diff-split").waitFor();
	await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();

	await page.getByRole("button", { name: "项目记忆与状态", exact: true }).click();
	await page.getByRole("dialog", { name: "项目记忆与会话状态", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "编辑 AGENTS.md", exact: true }).fill("# Verify Project Rules\n");
	await page.getByRole("button", { name: "保存 AGENTS.md", exact: true }).click();
	await until(async () => {
		try {
			return (await readFile(join(project, "AGENTS.md"), "utf8")) === "# Verify Project Rules\n";
		} catch {
			return false;
		}
	}, "AGENTS.md write");
	await page.getByRole("tab", { name: /运行状态/ }).click();
	await page.getByText("工具与 MCP 挂载", { exact: true }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.getByRole("button", { name: "本地网页预览", exact: true }).click();
	await page.locator("aside[aria-label='本地应用预览']").waitFor();
	await page.getByRole("textbox", { name: "预览地址", exact: true }).fill("https://example.com");
	await page.getByRole("button", { name: "访问", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: /localhost/ }).waitFor();
	await page.getByRole("textbox", { name: "预览地址", exact: true }).fill("http://127.0.0.1:4173");
	await page.getByRole("button", { name: "访问", exact: true }).click();
	assert.equal(await page.locator("aside.cc-preview-panel iframe").getAttribute("src"), "http://127.0.0.1:4173/");
	await page.getByRole("button", { name: "关闭预览面板", exact: true }).click();

	await page.getByRole("button", { name: "命令面板", exact: true }).click();
	await page.getByRole("dialog", { name: "命令面板 (⌘P)", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "搜索客户端命令", exact: true }).fill("AGENTS.md");
	await page.locator(".search-results button").filter({ hasText: "/memory" }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.locator("button.cc-plan-pill").click();
	await until(
		async () => (await page.getByRole("combobox", { name: "权限模式", exact: true }).inputValue()) === "read",
		"Plan mode read-only switch",
	);
	await submit("请以只读方式分析实现计划。");
	await page.getByText("已收到补充指令，客户端与 Pi 引擎连接正常。", { exact: true }).waitFor();
	await idle();
	await page.getByRole("region", { name: "计划审批", exact: true }).waitFor();
	await page.getByRole("button", { name: "退出 Plan", exact: true }).click();
	await until(
		async () => (await page.getByRole("combobox", { name: "权限模式", exact: true }).inputValue()) === "ask",
		"Plan mode restore ask",
	);
	await input.fill("");
	checks.push("Git stage/unstage, split diff, memory/status, localhost preview, command palette and Plan mode");

	assert.deepEqual(pageErrors, []);
	if (capture)
		for (const name of ["client-light.png", "client-dark.png"])
			assert.ok((await stat(join(repo, "docs/screenshots", name))).size < 1024 * 1024);
	console.log(JSON.stringify({ passed: checks, screenshots: capture ? "docs/screenshots" : undefined }, null, 2));
} catch (error) {
	const artifacts = join(repo, "artifacts");
	await mkdir(artifacts, { recursive: true });
	await page?.screenshot({ path: join(artifacts, "client-verification-failure.png"), scale: "css" }).catch(() => {});
	console.error(`Desktop verification failed after: ${checks.join(", ") || "startup"}`);
	throw error;
} finally {
	await application?.close();
	await rm(root, { recursive: true, force: true });
}
