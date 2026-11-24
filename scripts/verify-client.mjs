import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableArgument = process.argv.indexOf("--executable");
const builtExecutable = join(
	repo,
	"release/desktop",
	process.arch === "arm64" ? "mac-arm64" : "mac",
	"Pi Desktop.app/Contents/MacOS/Pi Desktop",
);
// To test the installed copy, pass --executable "/Applications/Pi Desktop.app/Contents/MacOS/Pi Desktop".
const executable = executableArgument >= 0 ? resolve(process.argv[executableArgument + 1]) : builtExecutable;
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
console.log(`Verifying ${executable}`);
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
		/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS|^LANGFUSE_)/.test(
			key,
		)
	)
		env[key] = undefined;
let application;
let page;
const checks = [];
let previewServer;
try {
	application = await electron.launch({ executablePath: executable, args: [], env, timeout: 30000 });
	page = await application.firstWindow();
	page.setDefaultTimeout(15000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const snapshot = () => page.evaluate(() => window.pi.snapshot());
	const permissionOf = (value) => value.active?.permissionMode ?? value.settings.permission;
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
	const openMore = async (name) => {
		await page.getByRole("button", { name: "更多工具", exact: true }).click();
		await page.getByRole("menuitem", { name, exact: true }).click();
	};
	const assertChatEdges = async (card) => {
		const boxes = await Promise.all([".cl-transcript", ".cl-composer-box", card].map((selector) => page.locator(selector).boundingBox()));
		assert.ok(boxes.every(Boolean), `Visible transcript, composer and ${card}`);
		const [transcript, ...rest] = boxes;
		for (const box of rest) {
			assert.ok(Math.abs(box.x - transcript.x) <= 2 && Math.abs(box.width - transcript.width) <= 2,
				`Chat edges should align for ${card}: ${JSON.stringify(boxes)}`);
		}
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
	await page.getByRole("region", { name: "允许执行 write？", exact: true }).waitFor();
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
	const personalFile = join(project, "personal-notes.txt");
	await writeFile(personalFile, "原有手工笔记\n");
	const appWindow = await application.browserWindow(page);
	const [originalWidth, originalHeight] = await appWindow.evaluate((win) => win.getSize());
	const resizeWindow = async (width) => {
		await appWindow.evaluate((win, [w, h]) => win.setSize(w, h), [width, originalHeight]);
		await page.waitForFunction((w) => window.innerWidth === w, width);
	};
	await submit("请实现问候函数，并运行测试确认中文问候语正确。");
	for (const name of ["write", "bash"]) {
		await page.getByRole("region", { name: `允许执行 ${name}？`, exact: true }).waitFor();
		await assertChatEdges(".cc-active-request");
		if (name === "write") {
			await resizeWindow(1100);
			await page.getByRole("button", { name: "代码修改", exact: true }).click();
			await page.locator(".live-app.has-compact-inspector").waitFor();
			await assertChatEdges(".cc-active-request");
			const timing = await page.getByRole("combobox", { name: "补充指令发送时机", exact: true }).boundingBox();
			for (const label of ["选择模型", "思考强度"]) {
				const control = await page.getByRole("combobox", { name: label, exact: true }).boundingBox();
				assert.ok(control?.width > 20 && timing?.width > 20 &&
					(control.x + control.width <= timing.x || control.y + control.height <= timing.y),
					`${label} and the delivery selector must remain visible without overlap`);
			}
			await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
			await resizeWindow(originalWidth);
		}
		await page.getByRole("button", { name: "允许执行", exact: true }).click();
	}
	await page.getByText("已完成问候函数，并通过项目测试。", { exact: true }).waitFor();
	await idle();
	assert.equal(await page.locator(".cl-msg-user").count(), 1);
	assert.equal(await page.locator(".cl-msg-ai").count(), 1);
	const stepGroup = page.locator(".cc-tool-group-head").filter({ hasText: "读取 1 个文件" });
	await stepGroup.click();
	assert.equal(await page.locator(".cl-tool.done").count(), 3);
	await stepGroup.click();
	assert.match(await readFile(join(project, "src/greeting.mjs"), "utf8"), /你好/);
	assert.ok((await input.boundingBox()).height < 100);
	const checksDetail = page.locator(".cc-turn-checks");
	await checksDetail.locator("summary").click();
	await checksDetail.getByText("node --test test/greeting.test.mjs", { exact: true }).waitFor();
	await checksDetail.getByText("通过 · 退出码 0", { exact: true }).waitFor();
	await checksDetail.getByRole("button", { name: "在终端重跑", exact: true }).click();
	await until(async () => await page.getByRole("textbox", { name: "终端命令", exact: true }).inputValue() === "node --test test/greeting.test.mjs", "recorded command in terminal input");
	await page.getByRole("button", { name: "关闭终端", exact: true }).click();
	await page.locator(".cl-title-button").click();
	await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("实现问候函数与测试");
	await page.getByRole("button", { name: "保存名称", exact: true }).click();
	await page.getByRole("button", { name: "审查本轮改动", exact: true }).click();
	const files = page.locator(".changed-file-list .cc-change-open");
	await files.filter({ hasText: "greeting.mjs" }).click();
	assert.equal(await files.filter({ hasText: "personal-notes.txt" }).count(), 0);
	await page.locator(".live-diff").filter({ hasText: "你好" }).waitFor();
	await page.getByRole("button", { name: "整个工作区", exact: true }).click();
	await files.filter({ hasText: "personal-notes.txt" }).waitFor();
	await page.getByRole("button", { name: "本轮改动", exact: true }).click();
	await rm(personalFile);
	checks.push("real read/write/bash tools, recorded check and rerun, exact turn review excludes pre-existing edits");

	await resizeWindow(1100);
	const expandSidebar = page.getByRole("button", { name: "展开侧栏", exact: true });
	await expandSidebar.waitFor();
	const chatHeader = await page.locator(".cl-top").boundingBox();
	const reviewHeader = await page.locator(".workspace-review > .inspector-header").boundingBox();
	const moreTools = await page.getByRole("button", { name: "更多工具", exact: true }).boundingBox();
	assert.ok(chatHeader && reviewHeader && moreTools);
	assert.equal(await page.getByRole("complementary", { name: "项目与会话" }).count(), 0);
	assert.ok((await expandSidebar.boundingBox()).x >= 90, "The sidebar button must clear the macOS window controls");
	assert.ok(Math.abs(chatHeader.height - reviewHeader.height) <= 1, "Chat and review headers must align");
	assert.ok(moreTools.x + moreTools.width <= reviewHeader.x, "The toolbar must fit within the chat column");
	await assertChatEdges(".cc-completion-card");
	await expandSidebar.click();
	await page.getByRole("complementary", { name: "项目与会话" }).waitFor();
	await page.getByRole("button", { name: "审查本轮改动", exact: true }).click();

	await resizeWindow(800);
	const backToChat = page.getByRole("button", { name: "返回聊天", exact: true });
	await backToChat.waitFor();
	await input.waitFor({ state: "hidden" });
	const fullReviewHeader = await page.locator(".workspace-review > .inspector-header").boundingBox();
	assert.ok(fullReviewHeader && Math.abs(fullReviewHeader.width - 800) <= 1);
	assert.ok((await backToChat.boundingBox()).x >= 90, "The full-width review toolbar must clear the macOS window controls");
	await backToChat.click();
	await input.waitFor();
	await resizeWindow(originalWidth);
	await appWindow.dispose();
	checks.push("macOS window control clearance, aligned chat surfaces and responsive review at 1100px and 800px");
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
		await page.getByRole("button", { name: "切换主题", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "grail");
		await page.locator(".grail-magic-backdrop").waitFor();
		await page.screenshot({ path: join(screenshots, "client-grail.png"), scale: "css" });
		await page.getByRole("button", { name: "切换主题", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	} else {
		await page.getByRole("button", { name: "切换主题", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
		await page.getByRole("button", { name: "切换主题", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "grail");
		await page.locator(".grail-magic-backdrop").waitFor();
		await page.getByRole("button", { name: "切换主题", exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	}
	checks.push("light, dark and Holy Grail anime theme switching");

	await page.getByRole("button", { name: "终端", exact: true }).click();
	await page.getByRole("textbox", { name: "终端命令", exact: true }).fill("printf 'UI_SHELL_OK\\n'");
	await page.getByRole("textbox", { name: "终端命令", exact: true }).press("Enter");
	await page.locator(".terminal-output").filter({ hasText: "UI_SHELL_OK" }).waitFor();
	await page.waitForFunction(() => document.querySelector(".terminal-output")?.textContent.includes("退出码 0"));
	await page.getByRole("button", { name: "关闭终端", exact: true }).click();
	checks.push("legacy shell command panel");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const providerSelection = page.getByRole("combobox", { name: "模型服务商", exact: true });
	await providerSelection.selectOption("deepseek");
	assert.ok((await page.getByRole("combobox", { name: "默认模型", exact: true }).locator("option").count()) >= 2);
	const providerKey = page.getByLabel("API Key", { exact: true });
	assert.equal(await providerKey.inputValue(), "");
	await providerKey.fill("demo-provider-draft");
	await providerSelection.selectOption("openai");
	assert.equal(await providerKey.inputValue(), "");
	await providerSelection.selectOption("deepseek");
	assert.equal(await providerKey.inputValue(), "demo-provider-draft");
	await providerKey.fill("");
	await page.getByText("Agent 与自动化", { exact: true }).click();
	assert.equal(await page.getByRole("checkbox", { name: "允许 fork 子 Agent", exact: true }).isChecked(), true);
	assert.equal(await page.getByRole("checkbox", { name: "隔离可写 worktree 子 Agent Bash", exact: true }).isChecked(), true);
	await page.getByRole("checkbox", { name: "允许 fork 子 Agent", exact: true }).uncheck();
	await page.getByRole("spinbutton", { name: "子 Agent 最大嵌套深度", exact: true }).fill("2");
	await page.getByRole("spinbutton", { name: "最大并发子 Agent 数", exact: true }).fill("6");
	await page.getByRole("button", { name: "保存设置", exact: true }).click();
	await until(
		async () => {
			const s = (await snapshot()).settings;
			return s.forkSubagent === false && s.maxSubagentDepth === 2 && s.maxConcurrentSubagents === 6;
		},
		"P6/P7 settings saved",
	);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByText("Agent 与自动化", { exact: true }).click();
	await page.getByRole("checkbox", { name: "允许 fork 子 Agent", exact: true }).check();
	await page.getByRole("spinbutton", { name: "子 Agent 最大嵌套深度", exact: true }).fill("1");
	await page.getByRole("spinbutton", { name: "最大并发子 Agent 数", exact: true }).fill("8");
	await page.getByRole("button", { name: "保存设置", exact: true }).click();
	await until(async () => (await page.getByRole("dialog", { name: /设置/ }).count()) === 0, "settings dialog closed");
	checks.push("P6/P7 settings dialog controls and persistence");
	await page.getByRole("button", { name: "搜索会话", exact: true }).click();
	await page.getByRole("combobox", { name: "搜索会话标题或项目", exact: true }).fill("实现问候函数");
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
	const ignoredWorktreeFile = "pi-ui-ignored-cache.txt";
	const gitExclude = join(project, ".git", "info", "exclude");
	await writeFile(gitExclude, (await readFile(gitExclude, "utf8")) + "\n" + ignoredWorktreeFile + "\n");
	await writeFile(join(task.workingDirectory, ignoredWorktreeFile), "ignored fixture\n");
	await page.getByRole("button", { name: "后台任务与 Worktree", exact: true }).click();
	const worktreeDrawer = page.getByRole("dialog", { name: "后台任务、子 Agent 与 Worktree (/tasks)", exact: true });
	await worktreeDrawer.getByRole("tab", { name: /Worktrees/ }).click();
	await worktreeDrawer.getByRole("button", { name: "清理", exact: true }).click();
	const cleanupWorktree = worktreeDrawer.getByRole("group", { name: "确认清理 Worktree", exact: true });
	await cleanupWorktree.getByRole("button", { name: "取消", exact: true }).click();
	assert.equal(await readFile(join(task.workingDirectory, ignoredWorktreeFile), "utf8"), "ignored fixture\n");
	await worktreeDrawer.getByRole("button", { name: "清理", exact: true }).click();
	await cleanupWorktree.getByRole("button", { name: "确认清理", exact: true }).click();
	const retainedWorktree = worktreeDrawer.getByRole("status").filter({ hasText: "忽略文件已保留在" }).locator("code");
	await retainedWorktree.waitFor();
	assert.equal(await readFile(join(await retainedWorktree.innerText(), ignoredWorktreeFile), "utf8"), "ignored fixture\n");
	await assert.rejects(access(task.workingDirectory), { code: "ENOENT" });
	await worktreeDrawer.getByRole("button", { name: "关闭对话框", exact: true }).click();
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
	assert.deepEqual(executors.map((item) => item.id), ["codex", "claude", "kimi", "antigravity"]);
	assert.equal(executors.find((item) => item.id === "kimi").capabilities.readOnly, false);
	assert.equal(executors.find((item) => item.id === "antigravity").capabilities.readOnly, false);
	assert.deepEqual(await page.evaluate(() => window.pi.externalAgents.list()), []);
	const configured = await page.evaluate(() => window.pi.externalAgents.configure({ id: "codex", enabled: false }));
	assert.equal(configured.find((item) => item.id === "codex").enabled, false);
	await page.evaluate(() => window.pi.externalAgents.configure({ id: "codex", enabled: true }));
	checks.push("local external executor discovery, configuration and task namespace through real preload");
	const fakeKimi = join(root, "kimi-fixture");
	await cp(join(repo, "test/fixtures/fake-kimi-acp.mjs"), fakeKimi);
	await chmod(fakeKimi, 0o700);
	await input.focus();
	const externalQuestionTask = await page.evaluate(async (executable) => {
		await window.pi.externalAgents.configure({ id: "kimi", executable, enabled: true });
		return window.pi.externalAgents.start({ executor: "kimi", description: "外部提问回归", prompt: "form" });
	}, fakeKimi);
	const externalQuestion = page.getByRole("region", { name: "外部 Agent 提问", exact: true });
	await externalQuestion.waitFor();
	assert.equal(await input.evaluate((node) => node === document.activeElement), true);
	const submitExternalAnswers = externalQuestion.getByRole("button", { name: "提交回答", exact: true });
	assert.equal(await submitExternalAnswers.isDisabled(), true);
	await externalQuestion.getByRole("combobox", { name: "q0", exact: true }).selectOption("blue");
	await externalQuestion.getByRole("checkbox", { name: "test", exact: true }).check();
	await submitExternalAnswers.click();
	await externalQuestion.waitFor({ state: "hidden" });
	await until(async () => (await page.evaluate((id) => window.pi.externalAgents.snapshot(id), externalQuestionTask.id)).status === "completed", "external question completes");
	const answeredExternalQuestion = await page.evaluate((id) => window.pi.externalAgents.snapshot(id), externalQuestionTask.id);
	assert.deepEqual(JSON.parse(answeredExternalQuestion.output), { action: "accept", content: { q0: "blue", q1: ["test"] } });
	checks.push("external structured questions stay inline, preserve the chat focus and return native structured answers");

	// Verify Claude Code UI modals, autocomplete, and interactive PTY tab
	await openMore("检查点与回滚");
	await page.getByRole("dialog", { name: "检查点与代码回滚 (/rewind)", exact: true }).waitFor();
	await page.locator(".cc-rewind-file-bar").filter({ hasText: "greeting.mjs" }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await openMore("工具与权限");
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

	await openMore("会话分支树");
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
	await page.getByRole("tab", { name: /^交互 PTY/ }).click();
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).fill("echo UI_PTY_PANEL_OK");
	await page.getByRole("textbox", { name: "PTY 输入", exact: true }).press("Enter");
	await page.locator(".terminal-output").filter({ hasText: "UI_PTY_PANEL_OK" }).waitFor();
	await page.getByRole("button", { name: "关闭终端", exact: true }).click();
	checks.push("Claude Code UI modals, autocomplete and PTY panel");

	await page.getByRole("button", { name: "代码修改", exact: true }).click();
	await page.getByRole("button", { name: "整个工作区", exact: true }).click();
	await page.getByRole("button", { name: "暂存 src/greeting.mjs", exact: true }).click();
	await page.locator(".cc-change-section").filter({ hasText: "已暂存 (1)" }).waitFor();
	await page.getByRole("button", { name: "取消暂存 src/greeting.mjs", exact: true }).click();
	await page.getByRole("button", { name: "暂存 src/greeting.mjs", exact: true }).waitFor();
	await page.locator(".changed-file-list button.cc-change-open").filter({ hasText: "greeting.mjs" }).click();
	await page.locator(".live-diff").filter({ hasText: "你好" }).waitFor();
	await page.locator('button[title="切换统一/分栏对比"]').click();
	await page.locator(".cc-diff-split").waitFor();
	await page.getByRole("button", { name: /^评审新行 / }).first().click();
	await page.getByRole("textbox", { name: "逐行评审反馈", exact: true }).fill("Check greeting punctuation.");
	await input.fill("这份会话草稿应当保留");
	await page.getByRole("button", { name: "保存评审意见", exact: true }).click();
	assert.equal(await input.inputValue(), "这份会话草稿应当保留");
	await page.getByRole("button", { name: "发送 1 条评审意见", exact: true }).click();
	await until(async () => (await snapshot()).messages.some((message) => message.role === "user" &&
		message.content.some((block) => block.type === "text" && /src\/greeting.mjs[\s\S]*Check greeting punctuation\./.test(block.text))), "sent review feedback");
	await idle();
	assert.equal(await input.inputValue(), "这份会话草稿应当保留");
	await input.fill("");
	await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
	checks.push("split diff and batched inline review feedback preserve the existing chat draft");

	await openMore("项目记忆与状态");
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

	previewServer = createServer(async (request, response) => {
		if (request.url === "/mcp") {
			try {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				const query = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (query.id === undefined) { response.writeHead(202).end(); return; }
				const result = query.method === "initialize" ? {
					protocolVersion: query.params.protocolVersion, serverInfo: { name: "local-fixture", version: "1" }, capabilities: { tools: {} },
				} : { tools: [] };
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: query.id, result }));
			} catch {
				response.writeHead(400).end();
			}
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<title>Pi Local Preview</title><h1>Preview fixture</h1><script>console.error('fixture console')</script>");
	});
	await new Promise((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
	const previewUrl = `http://127.0.0.1:${previewServer.address().port}/`;
	await mkdir(join(project, ".claude"), { recursive: true });
	const previewConfig = join(project, ".claude", "launch.json");
	await writeFile(previewConfig, JSON.stringify({ configurations: [{ name: "local-preview-fixture", runtimeExecutable: "node", port: previewServer.address().port }] }));
	await openMore("本地网页预览");
	await page.locator("aside[aria-label='本地应用预览']").waitFor();
	const previewAddress = page.getByRole("textbox", { name: "预览地址", exact: true });
	assert.equal(await previewAddress.inputValue(), previewUrl);
	await previewAddress.fill("https://example.com");
	await page.getByRole("button", { name: "访问", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: /localhost/ }).waitFor();
	await previewAddress.fill(previewUrl);
	await page.getByRole("button", { name: "访问", exact: true }).click();
	assert.equal(await page.locator("aside.cc-preview-panel iframe").getAttribute("src"), previewUrl);
	await page.frameLocator("aside.cc-preview-panel iframe").getByRole("heading", { name: "Preview fixture" }).waitFor();
	await page.getByRole("button", { name: "验证页面", exact: true }).click();
	await page.getByText("Pi Local Preview", { exact: true }).waitFor();
	await page.getByText("fixture console", { exact: true }).waitFor();
	assert.match(await page.locator(".cc-preview-result").innerText(), /HTTP 200/);
	checks.push("local preview opens the configured port, rejects remote addresses, and reports browser console errors");
	await page.getByRole("button", { name: "关闭预览面板", exact: true }).click();
	await rm(previewConfig);

	await openMore("命令面板");
	await page.getByRole("dialog", { name: "命令面板 (⌘P)", exact: true }).waitFor();
	await page.getByRole("combobox", { name: "搜索客户端命令", exact: true }).fill("AGENTS.md");
	await page.locator(".search-results button").filter({ hasText: "/memory" }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await page.getByRole("combobox", { name: "权限模式", exact: true }).selectOption("plan");
	await until(
		async () => (await page.getByRole("combobox", { name: "权限模式", exact: true }).inputValue()) === "plan",
		"Plan mode switch",
	);
	const planFile = (await page.evaluate(() => window.pi.readPlan())).relativePath;
	assert.ok((await input.inputValue()).includes(planFile));
	const planReply = page.getByText("已收到补充指令，客户端与 Pi 引擎连接正常。", { exact: true });
	const earlierPlanReplies = await planReply.count();
	await submit("请以只读方式分析实现计划。");
	await until(async () => (await planReply.count()) > earlierPlanReplies, "the new response in Plan mode");
	await idle();
	await page.getByRole("region", { name: "计划审批", exact: true }).waitFor();
	await page.getByText("等待 Pi 提交计划。也可以手动编写计划正文。", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "批准计划 · 接受编辑", exact: true }).count(), 0);
	await page.getByRole("button", { name: "编写计划正文", exact: true }).click();
	await page.getByRole("textbox", { name: "编辑计划内容", exact: true }).fill("# E2E Plan\n1. Check plan persistence\n");
	await page.getByRole("button", { name: "使用这份计划", exact: true }).click();
	const plan = await page.evaluate(() => window.pi.readPlan());
	await mkdir(dirname(plan.path), { recursive: true });
	await writeFile(plan.path, "# 另一份计划\n");
	await page.getByRole("button", { name: "批准计划 · 接受编辑", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "计划文件在编辑期间发生了变化" }).waitFor();
	assert.equal(permissionOf(await snapshot()), "plan");
	assert.equal(await readFile(plan.path, "utf8"), "# 另一份计划\n");
	await page.getByRole("button", { name: "重新读取计划", exact: true }).click();
	await page.getByRole("dialog", { name: "重新读取计划", exact: true }).getByRole("button", { name: "重新读取", exact: true }).click();
	const planEditor = page.getByRole("textbox", { name: "编辑计划内容", exact: true });
	await until(async () => (await planEditor.inputValue()) === "# 另一份计划\n", "latest plan file in editor");
	await submit("提交本地演示计划");
	await page.getByText("本地演示计划已提交。", { exact: true }).waitFor();
	await idle();
	const approve = page.getByRole("button", { name: "批准计划 · 逐项确认", exact: true });
	await approve.waitFor();
	const approvedBody = "# E2E Plan\n1. Review this exact version.\n";
	await planEditor.fill(approvedBody);
	await approve.click();
	await until(
		async () => {
			const value = await snapshot();
			return permissionOf(value) === "ask" && value.messages.some((message) => message.role === "user" &&
				message.content.some((part) => part.type === "text" && part.text.startsWith("计划已批准") && part.text.trimEnd().endsWith(approvedBody.trimEnd())));
		},
		"the approved revision reaches the model in the selected permission mode",
	);
	await idle();
	assert.equal(await readFile(plan.path, "utf8"), approvedBody);
	checks.push("plan requires explicit submission, rejects stale revisions and sends the approved saved body with the chosen permissions");
	await input.fill("");

	await openMore("工具与权限");
	await page.getByRole("dialog", { name: "工具、MCP 与权限规则", exact: true }).waitFor();
	await page.getByRole("tab", { name: /^Hooks/ }).click();
	await page.getByRole("textbox", { name: "Hook 命令", exact: true }).fill("echo HOOK_UI_OK");
	await page.getByRole("button", { name: "添加 Hook", exact: true }).click();
	await page.getByText("echo HOOK_UI_OK", { exact: true }).waitFor();
	await page.getByRole("combobox", { name: "Hook 类型", exact: true }).selectOption("http");
	await page.getByRole("textbox", { name: "Hook URL", exact: true }).fill(new URL("/hook-test", previewUrl).href);
	await page.getByRole("button", { name: "添加 Hook", exact: true }).click();
	await page.getByText(new URL("/hook-test", previewUrl).href, { exact: true }).waitFor();
	await page.getByRole("combobox", { name: "Hook 类型", exact: true }).selectOption("command");
	await page.getByRole("button", { name: "测试触发", exact: true }).click();
	await page.getByText(/执行 .* 个 Hook/).waitFor();
	await page.getByRole("tab", { name: /^Skills/ }).click();
	await page.getByRole("textbox", { name: "Skill 名称", exact: true }).fill("e2e-skill");
	await page.getByRole("textbox", { name: "Skill 描述", exact: true }).fill("E2E skill test");
	await page.getByRole("textbox", { name: "Skill 指令正文", exact: true }).fill("Run tests first.");
	await page.getByRole("button", { name: "保存 Skill", exact: true }).click();
	await page.getByText("/e2e-skill", { exact: true }).waitFor();
	assert.match(await readFile(join(project, ".pi", "skills", "e2e-skill", "SKILL.md"), "utf8"), /name: e2e-skill/);
	await page.getByRole("button", { name: "删除 Skill e2e-skill", exact: true }).click();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await openMore("项目记忆与状态");
	await page.getByRole("dialog", { name: "项目记忆与会话状态", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "新建规则文件名", exact: true }).fill("ui-rule");
	await page.getByRole("button", { name: "新建规则", exact: true }).click();
	await until(async () => {
		try {
			await access(join(project, ".claude", "rules", "ui-rule.md"));
			return true;
		} catch {
			return false;
		}
	}, "ui-rule.md created");
	await page.getByRole("tab", { name: /上下文分析/ }).click();
	await page.locator('[aria-label="上下文分段占用条"]').waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await openMore("命令面板");
	await page.getByRole("dialog", { name: "命令面板 (⌘P)", exact: true }).waitFor();
	await page.locator(".search-results button").filter({ hasText: "会话内关键词搜索" }).click();
	await page.getByRole("search", { name: "会话内查找", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "查找会话内容", exact: true }).fill("问候函数");
	await page.getByRole("button", { name: "关闭会话查找", exact: true }).click();
	checks.push("Hooks UI, Skills manager, rules hierarchy, /context breakdown and transcript search");

	await page.getByRole("combobox", { name: "权限模式", exact: true }).selectOption("acceptEdits");
	await until(
		async () => (await page.getByRole("combobox", { name: "权限模式", exact: true }).inputValue()) === "acceptEdits",
		"acceptEdits permission mode",
	);
	await page.getByRole("combobox", { name: "权限模式", exact: true }).selectOption("ask");
	await until(
		async () => (await page.getByRole("combobox", { name: "权限模式", exact: true }).inputValue()) === "ask",
		"restore ask mode",
	);

	await openMore("Agents 与子 Agent");
	await page.getByRole("dialog", { name: "Agents 与子 Agent", exact: true }).waitFor();
	await page.getByText("general-purpose", { exact: true }).waitFor();
	await page.getByRole("button", { name: "新建", exact: true }).click();
	await page.getByRole("textbox", { name: "Agent 名称", exact: true }).fill("e2e-reviewer");
	await page.getByRole("textbox", { name: "描述（模型据此决定何时委派）", exact: true }).fill("E2E reviewer");
	await page.getByRole("textbox", { name: "禁用工具 disallowedTools", exact: true }).fill("Write, Edit, Bash");
	await page.getByRole("textbox", { name: "系统提示词", exact: true }).fill("Review only. Do not edit files.");
	await page.getByRole("combobox", { name: "保存位置", exact: true }).selectOption("user");
	await page.getByText("Claude Code 高级兼容配置（Skills / Memory / 轮次 / 隔离）", { exact: true }).click();
	await page.getByRole("textbox", { name: "MCP 服务器名称 mcpServers（逗号分隔）", exact: true }).fill("github");
	await page.getByRole("textbox", { name: "主题色 color（名称或 #RRGGBB）", exact: true }).fill("#3b82f6");
	await page.getByRole("checkbox", { name: "不注入 CLAUDE.md / AGENTS.md 上下文（omitClaudeMd）", exact: true }).check();
	await page.getByRole("button", { name: "保存 Agent", exact: true }).click();
	await page.getByText("e2e-reviewer", { exact: true }).waitFor();
	const savedAgentText = await readFile(join(agentDir, "agents", "e2e-reviewer.md"), "utf8");
	assert.match(savedAgentText, /name: e2e-reviewer/);
	assert.match(savedAgentText, /disallowedTools: \[write, edit, bash\]/);
	assert.match(savedAgentText, /mcpServers: \[github\]/);
	assert.match(savedAgentText, /color: "#3b82f6"/);
	assert.match(savedAgentText, /omitClaudeMd: true/);
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	await openMore("MCP 服务器");
	await page.getByRole("dialog", { name: "MCP 服务器", exact: true }).waitFor();
	await page.getByRole("button", { name: "新建", exact: true }).click();
	await page.getByRole("textbox", { name: "名称", exact: true }).fill("e2e-mcp");
	await page.getByRole("combobox", { name: "作用域", exact: true }).selectOption("user");
	await page.getByRole("combobox", { name: "传输方式", exact: true }).selectOption("http");
	await page.getByRole("textbox", { name: "URL", exact: true }).fill(new URL("/mcp", previewUrl).href);
	await page.getByRole("button", { name: "保存并重载", exact: true }).click();
	await page.getByText("e2e-mcp", { exact: true }).waitFor();
	assert.match(await readFile(join(agentDir, "mcp.json"), "utf8"), /e2e-mcp/);
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	checks.push("acceptEdits, custom Agents and MCP save");
	checks.push("Git stage/unstage, split diff, memory/status, localhost preview, command palette and Plan mode");

	const originalSession = (await snapshot()).active;
	const secondProject = join(root, "parallel-project");
	await mkdir(secondProject);
	const secondSession = (await page.evaluate((dir) => window.pi.selectProject(dir), secondProject)).active;
	await openMore("刷新会话");
	await until(async () => (await page.locator(".cl-conv.selected").innerText()).includes("parallel-project"), "the other project");
	// Verify Claude Code topbar workspace picker can switch between opened projects
	await page.getByRole("button", { name: "切换工作目录", exact: true }).click();
	await page.getByRole("menu", { name: "工作目录列表", exact: true }).waitFor();
	await page.getByRole("menuitemradio").filter({ hasText: "pi-client-demo" }).click();
	await until(async () => (await snapshot()).active?.project?.endsWith("pi-client-demo"), "workspace picker switch back to pi-client-demo");
	await page.getByRole("button", { name: "切换工作目录", exact: true }).click();
	await page.getByRole("menuitemradio").filter({ hasText: "parallel-project" }).click();
	await until(async () => (await snapshot()).active?.project?.endsWith("parallel-project"), "workspace picker switch to parallel-project");
	// Verify composer sandbox pill & popover control
	await page.getByRole("button", { name: "命令沙箱设置", exact: true }).click();
	const sandboxPanel = page.getByRole("region", { name: "命令沙箱控制", exact: true });
	await sandboxPanel.getByText("文件工具可写", { exact: true }).waitFor();
	await sandboxPanel.getByText(/内置文件工具也会保护 \.env 文件/).waitFor();
	const sbStatus = await page.evaluate(() => window.pi.sandboxStatus());
	if (sbStatus.supported) {
		assert.equal(await page.getByRole("checkbox", { name: "快捷开启 macOS Seatbelt 命令沙箱", exact: true }).isChecked(), true);
		const offlineBox = page.getByRole("checkbox", { name: "快捷禁止 Bash 命令访问网络", exact: true });
		await offlineBox.check();
		await until(async () => (await snapshot()).settings.sandboxOffline === true && !(await offlineBox.isDisabled()), "sandbox offline enabled via popover");
		await offlineBox.uncheck();
		await until(async () => (await snapshot()).settings.sandboxOffline === false && !(await offlineBox.isDisabled()), "sandbox offline disabled via popover");
	}
	await page.getByRole("button", { name: "命令沙箱设置", exact: true }).click();
	checks.push("workspace directory switcher and inline Seatbelt sandbox popover");
	await page.locator(".cl-conv").filter({ hasText: originalSession.title }).first().click();
	await ready();
	await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
	await ready();
	const approvalSession = (await snapshot()).active;
	await submit("审批拒绝验证");
	await page.getByRole("button", { name: "稍后处理", exact: true }).click();
	await input.fill("只属于第一条会话的草稿");
	await page.locator(".cl-conv").filter({ hasText: "parallel-project" }).click();
	await ready();
	assert.notEqual(secondSession.id, approvalSession.id);
	assert.equal(await input.inputValue(), "");
	assert.equal((await snapshot()).activity[approvalSession.id], "approval");
	await submit("停止生成验证");
	await page.waitForFunction(() => document.querySelector(".cl-transcript")?.textContent.includes("流式恢复验证："));
	await input.fill("第二条会话草稿");
	const attention = page.getByRole("region", { name: "任务动态", exact: true });
	await attention.getByRole("heading", { name: /待我处理/ }).waitFor();
	await attention.getByRole("button", { name: /审批拒绝验证/ }).first().click();
	await page.getByRole("region", { name: "允许执行 write？", exact: true }).waitFor();
	assert.equal(await input.inputValue(), "只属于第一条会话的草稿");
	assert.equal((await snapshot()).active.id, approvalSession.id);
	assert.equal((await snapshot()).activity[secondSession.id], "running");
	await page.getByRole("button", { name: "拒绝", exact: true }).click();
	await idle();
	await page.locator(".cl-conv").filter({ hasText: "停止生成验证" }).filter({ has: page.locator(".cl-conv-status", { hasText: "运行中" }) }).click();
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await idle();
	assert.equal(await input.inputValue(), "第二条会话草稿");
	checks.push("parallel foreground sessions restore independent drafts, live output and approvals");

	await page.evaluate(async (dir) => {
		await window.pi.setProjectTrust({ project: dir, decision: "trusted" });
		await window.pi.writeMemoryFile("本机项目记忆", "PI_PRIVATE_MEMORY_FIXTURE");
		await window.pi.writeMemoryFile(".claude/rules/fixture.md", "PI_RULE_FIXTURE");
	}, (await snapshot()).active.project);
	await writeFile(join(secondProject, "ref.md"), "PI_REFERENCE_FIXTURE");
	await submit("模型上下文验证 @ref.md");
	await page.getByText("收到项目记忆、规则和文件引用。", { exact: true }).waitFor();
	await idle();
	assert.equal(await page.locator(".cl-msg-user").filter({ hasText: "PI_REFERENCE_FIXTURE" }).count(), 0);
	await writeFile(join(secondProject, "ref.md"), "UPDATED_CONTENT_NOT_NEEDED");
	await submit("文件引用续问验证");
	await page.getByText("仍能看到前一轮的文件引用。", { exact: true }).waitFor();
	await idle();
	checks.push("approved rules and private memory load once; referenced file snapshots survive follow-up without cluttering the user bubble");

	await page.getByRole("button", { name: "终端", exact: true }).click();
	await page.getByRole("button", { name: "Pi 扩展", exact: true }).click();
	await page.getByRole("button", { name: "列出用户扩展包", exact: true }).click();
	await page.getByLabel("交互终端画面", { exact: true }).waitFor();
	await until(async () => await page.evaluate(async (id) => {
		const installed = (await window.pi.terminals.list(id)).find((item) => item.label === "Pi 扩展");
		return installed?.status === "exited" && installed.exitCode === 0;
	}, secondSession.id), "the bundled Pi package CLI");
	checks.push("bundled Pi CLI and interactive terminal");

	// Verify live SubagentPanel, sidebar (+N) folding, SubagentTranscriptView and SubagentApprovals bubbling
	await page.locator(".cl-conv").filter({ hasText: originalSession.title }).first().click();
	await ready();
	await page.evaluate(
		(proj) => window.pi.permissions.upsert({ id: "e2e-allow-agent", scope: "project", project: proj, action: "allow", tool: "Agent" }),
		originalSession.project,
	);
	await submit("子Agent审批面板验证");
	await page.getByRole("region", { name: "子 Agent 面板", exact: true }).waitFor();
	await page.locator(".cc-subagent-row").filter({ hasText: "E2E 子审批" }).waitFor();
	await page.getByRole("button", { name: "展开 1 个子 Agent 会话", exact: true }).waitFor();
	const childApproval = page.getByRole("region", { name: /子 Agent ‹E2E 子审批›.*允许执行 write？/ });
	const reviewChild = page.getByRole("button", { name: "查看子 Agent 审批 (1)", exact: true });
	await input.focus();
	await reviewChild.waitFor();
	assert.equal(await page.getByRole("dialog", { name: /允许执行 write？/ }).count(), 0);
	assert.ok(await input.evaluate((element) => document.activeElement === element));
	await reviewChild.click();
	await childApproval.getByText("should be denied", { exact: true }).waitFor();
	await page.getByRole("button", { name: "稍后处理", exact: true }).click();
	await reviewChild.waitFor();
	await page.locator(".cc-subagent-row").filter({ hasText: "E2E 子审批" }).click();
	await page.getByRole("button", { name: "返回主会话", exact: true }).waitFor();
	await childApproval.getByText("should be denied", { exact: true }).waitFor();
	await page.getByRole("button", { name: "返回主会话", exact: true }).click();
	await reviewChild.click();
	await childApproval.getByRole("button", { name: "拒绝", exact: true }).click();
	await until(async () => {
		const list = await page.evaluate(() => window.pi.tasks.list());
		const sub = list.find((t) => t.title === "E2E 子审批");
		return sub && sub.status === "completed";
	}, "bubbled child approval completion");
	await idle();
	await page.evaluate(() => window.pi.permissions.remove("e2e-allow-agent"));
	checks.push("SubagentPanel, sidebar (+N) folding, SubagentTranscriptView and SubagentApprovals E2E UI");

	// P8 UI & Electron utilityProcess Workflow E2E check
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByText("Agent 与自动化", { exact: true }).click();
	assert.equal(await page.getByRole("checkbox", { name: "启用定时唤醒与 /loop 自动任务", exact: true }).isChecked(), true);
	await page.getByText(/会自动消耗额度/).waitFor();
	assert.equal(await page.getByRole("checkbox", { name: "实验性 Agent Teams 多成员协作", exact: true }).isChecked(), false);
	await page.getByRole("checkbox", { name: "实验性 Agent Teams 多成员协作", exact: true }).check();
	await page.getByRole("button", { name: "保存设置", exact: true }).click();
	await until(async () => (await snapshot()).settings.agentTeams === true, "agentTeams setting persisted");

	const skillsList = await page.evaluate((proj) => window.pi.skills.list(proj), originalSession.project);
	assert.ok(skillsList.some((s) => s.name === "batch" && s.scope === "bundled"));

	await page.getByRole("button", { name: /任务/ }).first().click();
	await page.getByRole("tab", { name: /任务清单/ }).waitFor();
	await page.getByRole("tab", { name: /定时唤醒/ }).waitFor();
	await page.getByRole("tab", { name: /工作流/ }).waitFor();
	await page.getByRole("tab", { name: /团队/ }).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	const activeConvId = (await snapshot()).active.id;
	await page.evaluate((cid) => window.pi.todos.create(cid, { subject: "E2E P8 Checklist", description: "Verify root todo strip" }), activeConvId);
	await page.locator(".cc-pinned-todos").waitFor();
	await page.locator(".cc-pinned-todos-head").click();
	await page.locator(".cc-pinned-todos").filter({ hasText: "E2E P8 Checklist" }).waitFor();

	const wf = await page.evaluate(
		(cid) => window.pi.workflow.start(cid, { title: "E2E Electron Workflow", script: `return await phase("calc", async () => { log("electron utilityProcess ok"); return 42; });` }),
		activeConvId,
	);
	await page.getByRole("region", { name: "工作流执行审批", exact: true }).waitFor();
	await page.getByRole("button", { name: "允许一次 (Once)", exact: true }).click();
	await until(async () => {
		const list = await page.evaluate((cid) => window.pi.workflow.list(cid), activeConvId);
		const item = list.find((w) => w.id === wf.id);
		return item && item.status === "completed" && item.result === 42;
	}, "Electron utilityProcess workflow completed via Once approval");
	checks.push("P8 settings notices, bundled /batch skill, TasksDrawer tabs, pinned Todo*, and Electron utilityProcess workflow approval E2E UI");


	const newChat = async () => {
		const previousId = (await snapshot()).active.id;
		await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
		await until(async () => (await snapshot()).active.id !== previousId, "new conversation");
		await ready();
	};
	const attachmentInput = page.getByLabel("选择附件", { exact: true });
	const picture = page.getByRole("button", { name: "移除附件 regression.png", exact: true });
	const attachPicture = async () => {
		await attachmentInput.setInputFiles({
			name: "regression.png",
			mimeType: "image/png",
			buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64"),
		});
		await picture.waitFor();
	};
	const queue = page.getByRole("region", { name: "排队的指令", exact: true });
	const startStream = async () => {
		await submit("停止生成验证");
		await page.locator(".cl-transcript").getByText(/^流式恢复验证：/).first().waitFor();
	};
	const queuedUserMessage = (messages, text) => messages.find(
		(message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text === text),
	);
	for (const withImage of [false, true]) {
		await newChat();
		await startStream();
		const text = withImage ? "带图的立即发送回归检查" : "纯文本立即发送回归检查";
		const timing = page.getByRole("combobox", { name: "补充指令发送时机", exact: true });
		assert.equal(await timing.inputValue(), "followUp");
		if (withImage) await timing.selectOption("steer");
		await input.fill(text);
		if (withImage) await attachPicture();
		await input.press("Enter");
		await queue.waitFor();
		await queue.getByText(withImage ? "下一工具步骤" : "本轮结束后", { exact: true }).waitFor();
		await queue.getByRole("button", { name: "停止并发送队列", exact: true }).click();
		await until(async () => Boolean(queuedUserMessage((await snapshot()).messages, text)), text);
		await idle();
		const userMessage = queuedUserMessage((await snapshot()).messages, text);
		assert.equal(userMessage.content.some((part) => part.type === "image"), withImage);
	}
	await newChat();
	await startStream();
	await input.fill("撤回时保留图片");
	await attachPicture();
	await input.press("Enter");
	await queue.waitFor();
	await input.fill("输入框里原有的草稿");
	await queue.getByRole("button", { name: "撤回到输入框", exact: true }).click();
	await picture.waitFor();
	assert.equal(await input.inputValue(), "撤回时保留图片\n\n输入框里原有的草稿");
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await idle();
	checks.push("send queued text and images immediately, and withdraw into an existing draft");

	await newChat();
	await submit("持久草稿会话");
	await idle();
	await input.fill("重启后保留的草稿");
	await attachPicture();
	await newChat();
	assert.equal(await input.inputValue(), "");
	assert.equal(await picture.count(), 0);
	await page.locator(".cl-conv").filter({ hasText: "持久草稿会话" }).click();
	await picture.waitFor();
	assert.equal(await input.inputValue(), "重启后保留的草稿");
	await page.reload();
	await ready();
	await picture.waitFor();
	assert.equal(await input.inputValue(), "重启后保留的草稿");
	await application.close();
	application = await electron.launch({
		executablePath: executable,
		env: { ...env, PI_DESKTOP_WORKSPACE: undefined },
		timeout: 30000,
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ready();
	await page.getByRole("button", { name: "移除附件 regression.png", exact: true }).waitFor();
	const recoveredInput = page.getByRole("textbox", { name: "输入任务", exact: true });
	assert.equal(await recoveredInput.inputValue(), "重启后保留的草稿");
	await page.getByRole("button", { name: "移除附件 regression.png", exact: true }).click();
	await recoveredInput.fill("");
	await recoveredInput.press("ArrowUp");
	assert.equal(await recoveredInput.inputValue(), "持久草稿会话");
	await recoveredInput.press("ArrowDown");
	assert.equal(await recoveredInput.inputValue(), "");
	checks.push("draft text and attachments are isolated per conversation and survive reload and restart");

	await page.evaluate(async (project) => {
		await window.pi.selectProject(project);
		await window.pi.newConversation();
	}, project);
	await page.reload();
	await ready();
	await page.getByRole("textbox", { name: "输入任务", exact: true }).press("ArrowUp");
	assert.equal(await page.getByRole("textbox", { name: "输入任务", exact: true }).inputValue(), "");
	checks.push("composer history comes from its own persisted conversation after restart");
	const oversized = join(project, "checkpoint-oversized.bin");
	await writeFile(oversized, "");
	await truncate(oversized, 65 * 1024 * 1024);
	const permissions = page.getByRole("combobox", { name: "权限模式", exact: true });
	for (const [mode, text] of [["read", "有大文件时的只读提问"], ["ask", "有大文件时的普通提问"]]) {
		await permissions.selectOption(mode);
		await until(async () => permissionOf(await snapshot()) === mode && !(await permissions.isDisabled()), mode);
		await submit(text);
		await until(async () => Boolean(queuedUserMessage((await snapshot()).messages, text)), text);
		await idle();
	}
	const checkpointList = await page.evaluate(() => window.pi.git.list());
	assert.equal(checkpointList.length, 1);
	assert.equal(checkpointList[0].excludedFiles, 1);
	await rm(oversized);
	checks.push("read-only prompts bypass snapshots and writable prompts skip oversized files");

	// A real shell invokes this fixture only. It cannot reach a Kaggle account or the network.
	await mkdir(join(project, ".venv/bin"), { recursive: true });
	const kaggleLog = join(project, "fake-kaggle.log");
	await writeFile(join(project, ".venv/bin/kaggle"), '#!/bin/sh\nprintf "%s\\n" "$2" >> fake-kaggle.log\nprintf "%s\\n" QUEUED\n', { mode: 0o755 });
	const setPermissionMode = async (mode) => {
		const requiresConfirmation = mode === "auto" && permissionOf(await snapshot()) !== "auto";
		await permissions.selectOption(mode);
		if (requiresConfirmation)
			await page.getByRole("dialog", { name: "为当前会话启用「全部放行」？" }).getByRole("button", { name: "启用全部放行" }).click();
		await until(async () => permissionOf(await snapshot()) === mode && !(await permissions.isDisabled()), mode);
	};
	await newChat();
	await setPermissionMode("auto");
	const autoConversationId = (await snapshot()).active.id;
	await submit("为啥要排队，现在在跑什么");
	await page.getByText("演示队列状态查询结束。", { exact: true }).waitFor();
	await idle();
	const queried = (await snapshot()).messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(queried.map((message) => message.isError), [false, true, true]);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\n");
	const remoteApproval = page.getByRole("region", { name: /远端写入/ });
	await submit("请删除演示云端作业");
	await page.getByText("演示远端操作结束。", { exact: true }).waitFor();
	await idle();
	assert.equal(await remoteApproval.count(), 0);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\ndelete\n");

	await newChat();
	assert.equal(permissionOf(await snapshot()), "ask");
	assert.equal((await snapshot()).conversations.find((item) => item.id === autoConversationId)?.permissionMode, "auto");
	await submit("请删除演示云端作业");
	await remoteApproval.waitFor();
	assert.equal(await remoteApproval.getByRole("button", { name: /始终允许/ }).count(), 0);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\ndelete\n");
	await remoteApproval.getByRole("button", { name: "仅本次执行", exact: true }).click();
	await page.getByText("演示远端操作结束。", { exact: true }).waitFor();
	await idle();
	assert.equal(await readFile(kaggleLog, "utf8"), "status\ndelete\ndelete\n");
	checks.push("status-only requests cannot mutate the remote queue; explicit writes follow auto and manual approval modes");

	await newChat();
	await setPermissionMode("auto");
	const listShells = () => page.evaluate(async () => window.pi.monitors.list((await window.pi.snapshot()).active.id));
	const olderPidPath = join(project, "previous-shell.pid");
	const latestPidPath = join(project, "current-shell.pid");
	await submit("登记旧的本机后台命令");
	await page.getByText("演示旧轮后台命令已登记。", { exact: true }).waitFor();
	await idle();
	const older = (await listShells()).find((shell) => shell.description === "演示旧轮后台命令");
	assert.ok(older?.ownerRunId);
	await submit("登记本轮本机后台命令");
	await page.getByText("演示本轮后台命令已登记。", { exact: true }).waitFor();
	await idle();
	const latest = (await listShells()).find((shell) => shell.description === "演示本轮后台命令");
	assert.ok(latest?.ownerRunId && latest.ownerRunId !== older.ownerRunId);
	await assert.rejects(page.evaluate(async (runId) => window.pi.tasks.stopCurrentTurn((await window.pi.snapshot()).active.id, runId), older.ownerRunId));
	await until(() => Promise.all([access(olderPidPath), access(latestPidPath)]).then(() => true, () => false), "both demo background processes started");
	const olderPid = Number(await readFile(olderPidPath, "utf8"));
	const latestPid = Number(await readFile(latestPidPath, "utf8"));
	assert.ok(olderPid > 1 && latestPid > 1 && olderPid !== latestPid);
	await page.reload();
	await ready();
	await page.getByRole("button", { name: "停止本轮后台命令", exact: true }).click();
	await until(async () => (await listShells()).find((shell) => shell.id === latest.id)?.status === "stopped", "current background job stops");
	await until(() => {
		try { process.kill(latestPid, 0); return false; }
		catch (error) { if (error.code === "ESRCH") return true; throw error; }
	}, "current process exits");
	assert.equal((await listShells()).find((shell) => shell.id === older.id)?.status, "running");
	process.kill(olderPid, 0);
	await page.getByRole("button", { name: "后台任务与 Worktree", exact: true }).click();
	const drawer = page.getByRole("dialog", { name: "后台任务、子 Agent 与 Worktree (/tasks)", exact: true });
	await drawer.getByRole("button", { name: "停止全部后台任务", exact: true }).waitFor();
	await drawer.getByRole("button", { name: "关闭对话框", exact: true }).click();
	await page.evaluate((id) => window.pi.monitors.stop(id), older.id);
	checks.push("stop remains available after the reply and reload, rejects another run ID, and exits only the current process");

	await newChat();
	await setPermissionMode("auto");
	await writeFile(join(project, "test/background-check.test.mjs"), [
		'import { access } from "node:fs/promises";',
		'import { test } from "node:test";',
		'import { setTimeout as wait } from "node:timers/promises";',
		'test("waits for the test driver", async () => {',
		'  while (!(await access("release-check.flag").then(() => true, () => false))) await wait(25);',
		'});',
	].join("\n"));
	await submit("验证后台检查的退出结果");
	await page.getByText("后台检查已登记，等待退出结果。", { exact: true }).waitFor();
	const evidence = page.locator(".cc-turn-checks").filter({ hasText: "node --test test/background-check.test.mjs" });
	await evidence.locator("summary").click();
	await evidence.getByText("等待后台退出结果", { exact: true }).waitFor();
	assert.equal(await evidence.getByText("通过 · 退出码 0", { exact: true }).count(), 0);
	await writeFile(join(project, "release-check.flag"), "go\n");
	await evidence.getByText("通过 · 退出码 0", { exact: true }).waitFor();
	await idle();
	checks.push("background verification stays pending until the same real shell exits successfully");

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
	previewServer?.closeAllConnections();
	await new Promise((resolve) => previewServer ? previewServer.close(resolve) : resolve());
	await rm(root, { recursive: true, force: true });
}
