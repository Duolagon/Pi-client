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
import { verifyCommitDraft } from "./verify-commit-draft.mjs";
import { verifyWerewolf } from "./verify-werewolf.mjs";
import { verifyWorkspaceNavigation } from "./verify-workspace-navigation.mjs";

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
const workspaceScreenshots = process.argv.includes("--workspace-screenshots") ? join(repo, "artifacts/workspace-regressions") : undefined;
const contestScreenshots = process.argv.includes("--contest-screenshots") ? join(repo, "artifacts/contest-handoff") : undefined;
const testArgs = process.platform === "darwin" ? ["--use-mock-keychain"] : [];
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
const cliFixtures = join(root, "bin");
const shellFixture = join(cliFixtures, "fixture-shell");
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
await mkdir(join(project, "src"), { recursive: true });
await mkdir(join(project, "test"));
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cliFixtures);
// Preserve the fixture PATH when the packaged app captures the macOS login environment.
await writeFile(shellFixture, `#!/bin/sh
if [ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ]; then
	exec /bin/sh -c "$4"
fi
exec "$PI_DESKTOP_FIXTURE_SHELL" "$@"
`, { mode: 0o755 });
const prFixture = JSON.stringify({
	number: 123, title: "本地演示 PR", url: "https://example.invalid/pull/123", state: "OPEN",
	isDraft: false, headRefName: "fixture", baseRefName: "main", autoMergeRequest: null, statusCheckRollup: [],
});
await writeFile(join(cliFixtures, "gh"), `#!/bin/sh
case "$1 $2" in
	"pr view") printf '%s\\n' '${prFixture}' ;;
	"pr merge") printf '%s\\n' "$*" >> "\${0%/*}/gh-commands" ;;
	*) exit 1 ;;
esac
`, { mode: 0o755 });
await cp(join(repo, "test/fixtures/ui-provider.js"), join(agentDir, "extensions/ui-provider.js"));
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({
		defaultProvider: "desktop-demo",
		defaultModel: "desktop-demo-1",
		thinkingLevel: "off",
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
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
	PATH: `${cliFixtures}:${process.env.PATH}`,
	SHELL: process.platform === "darwin" ? shellFixture : process.env.SHELL,
	PI_DESKTOP_FIXTURE_SHELL: process.env.SHELL || "/bin/sh",
	ELECTRON_RUN_AS_NODE: undefined,
	PI_CODING_AGENT_DIR: agentDir,
	PI_DESKTOP_DATA_DIR: join(root, "desktop"),
	PI_DESKTOP_WORKSPACE: project,
	PI_OFFLINE: "1",
	ACP_TEST_CONFIG: "1",
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
	application = await electron.launch({ executablePath: executable, args: testArgs, env, timeout: 30000 });
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
	const selectListbox = async (control) => {
		await control.click();
		const id = await control.getAttribute("aria-controls");
		assert.ok(id, "Combobox exposes its active listbox");
		return page.getByRole("listbox").and(page.locator(`[id=${JSON.stringify(id)}]`));
	};
	const selectValue = async (control, value) => {
		const list = await selectListbox(control);
		await list.getByRole("option").and(page.locator(`[value=${JSON.stringify(value)}]`)).click();
		await list.waitFor({ state: "hidden" });
	};
	const selectControl = (name) => page.getByRole("combobox", { name, exact: true });
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
	// Stub only the separate Kaggle browser profile. The app and its conversation
	// still use the same Chromium and host IPC as the packaged build.
	const fixtureNotebook = "https://www.kaggle.com/code/fixture/local-notebook/edit";
	const notebookWithQuery = `${fixtureNotebook}?private-preview=fixture`;
	await application.evaluate(({ BrowserWindow, Menu, dialog, session }, { notebookWithQuery }) => {
		const isolated = session.fromPartition("persist:pi-kaggle-browser");
		const content = `<!doctype html>
			<title>Fixture Kaggle Notebook</title>
			<h1>Fixture Kaggle Notebook</h1>
			<div role="toolbar" aria-label="Notebook actions">
				<button id="run-all" type="button">Run All</button>
			</div>
			<div role="status" id="status">Ready</div>
			<pre id="output" data-testid="cell-output">GPU fixture complete\nrows: 12</pre>
			<pre hidden data-testid="cell-output">FIXTURE_HIDDEN_OUTPUT</pre>
			<input type="password" value="FIXTURE_PASSWORD" />
			<script>
				document.getElementById("run-all").addEventListener("click", () => {
					const status = document.getElementById("status");
					const runCount = Number(status.dataset.runs ?? 0) + 1;
					status.dataset.runs = runCount;
					status.textContent = "Complete";
					document.getElementById("output").textContent = "FIXTURE_EXECUTED count=" + runCount;
				});
			</script>`;
		isolated.protocol.handle("https", (request) => new Response(
			request.url === notebookWithQuery ? content : "Unexpected URL",
			{ status: request.url === notebookWithQuery ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } },
		));
		globalThis.__piFixtureNativeMenuPopup = Menu.prototype.popup;
		Menu.prototype.popup = function (options) {
			const action = this.items.find((item) => item.label === "预览所选文本并附加到 Pi 草稿");
			if (action?.enabled) action.click(undefined, options.window);
		};
		globalThis.__piFixtureNotebookConfirmations = [];
		const responses = [0, 1, 1];
		globalThis.__piFixtureShowMessageBox = dialog.showMessageBox;
		dialog.showMessageBox = async function (...args) {
			const options = args.at(-1);
			if (options?.message !== "允许 Pi 在 Kaggle 点击 Run All？") {
				return globalThis.__piFixtureShowMessageBox.apply(this, args);
			}
			const response = responses.shift();
			if (response === undefined) throw new Error("Unexpected Kaggle Run All approval");
			globalThis.__piFixtureNotebookConfirmations.push({
				response,
				buttons: options.buttons,
				defaultId: options.defaultId,
				cancelId: options.cancelId,
			});
			if (responses.length === 0) {
				const notebook = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL() === notebookWithQuery);
				if (!notebook) throw new Error("Missing Notebook fixture for reload-before-confirmation");
				const reloaded = new Promise((resolve) => notebook.webContents.once("did-finish-load", resolve));
				notebook.webContents.reload();
				await reloaded;
			}
			return { response, checkboxChecked: false };
		};
	}, { notebookWithQuery });
	const kaggleInput = page.getByRole("textbox", { name: "输入任务", exact: true });
	await kaggleInput.fill("这段草稿保留");
	const messageCountBeforeHandoff = (await snapshot()).messages.length;
	await openMore("打开 Kaggle Notebook");
	const openKaggle = page.getByRole("dialog", { name: "打开 Kaggle Notebook", exact: true });
	await openKaggle.waitFor();
	const notebookLink = openKaggle.getByLabel("Notebook 链接", { exact: true });
	const openNotebook = openKaggle.getByRole("button", { name: "打开 Notebook", exact: true });
	await notebookLink.fill("https://www.kaggle.com.example.invalid/code/fixture/local-notebook");
	await openNotebook.click();
	await openKaggle.getByRole("alert").filter({ hasText: "请输入 HTTPS Kaggle Notebook 链接" }).waitFor();
	assert.equal(application.windows().length, 1);
	await notebookLink.fill(notebookWithQuery);
	const browserOpened = application.waitForEvent("window");
	await openNotebook.click();
	const kagglePage = await browserOpened;
	const output = kagglePage.locator("#output");
	await output.waitFor();
	assert.equal(await kagglePage.evaluate(() => typeof window.pi), "undefined");
	assert.equal(await kagglePage.evaluate(() => typeof window.require), "undefined");
	await openKaggle.waitFor({ state: "detached" });
	await output.selectText();
	await output.click({ button: "right", position: { x: 20, y: 7 } });
	const previewHandoff = page.getByRole("dialog", { name: "预览 Kaggle Notebook 输出", exact: true });
	await previewHandoff.waitFor();
	assert.equal(await previewHandoff.locator("pre").textContent(), "GPU fixture complete\nrows: 12");
	assert.equal(await previewHandoff.locator(".kaggle-browser-source").textContent(), fixtureNotebook);
	assert.equal(await kaggleInput.inputValue(), "这段草稿保留");
	if (contestScreenshots) {
		await mkdir(contestScreenshots, { recursive: true });
		await page.screenshot({ path: join(contestScreenshots, "notebook-output-handoff.png"), scale: "css", animations: "disabled" });
	}
	await previewHandoff.getByRole("button", { name: "附加到草稿", exact: true }).click();
	await previewHandoff.waitFor({ state: "detached" });
	assert.equal(await kaggleInput.inputValue(), `这段草稿保留\n\n从 Kaggle Notebook 选择的外部文本\n${fixtureNotebook}\n\n> GPU fixture complete\n> rows: 12`);
	assert.equal((await snapshot()).messages.length, messageCountBeforeHandoff);
	await kaggleInput.fill("");
	checks.push("isolated Kaggle browser captures an explicit selection into its originating draft without a model call");

	const notebookConversationId = (await snapshot()).active.id;
	const confirmations = () => application.evaluate(() => globalThis.__piFixtureNotebookConfirmations);
	const notebookPrompts = {
		inspect: "Kaggle Computer Use 验证读取状态和输出",
		run_all: "Kaggle Computer Use 验证运行全部单元格",
		status_only: "查看 Kaggle 当前队列状态",
	};
	const requestNotebookAction = async (action) => {
		const before = (await snapshot()).messages.length;
		await submit(notebookPrompts[action]);
		await until(async () =>
			(await snapshot()).messages.slice(before).some((message) => message.role === "assistant" &&
				message.content?.some((part) => part.type === "text" && part.text.startsWith("Kaggle Computer Use 演示"))),
		`Kaggle Computer Use ${action} tool result`);
		await idle();
		const results = (await snapshot()).messages.slice(before).filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0].toolName, "KaggleComputerUse");
		return results[0];
	};
	const readNotebook = await requestNotebookAction("inspect");
	assert.equal(readNotebook.isError, false);
	assert.match(JSON.stringify(readNotebook.content), /GPU fixture complete/);
	assert.match(JSON.stringify(readNotebook.content), /Ready/);
	assert.doesNotMatch(JSON.stringify(readNotebook.content), /FIXTURE_HIDDEN_OUTPUT|FIXTURE_PASSWORD|private-preview/);
	const statusOnly = await requestNotebookAction("status_only");
	assert.equal(statusOnly.isError, true);
	assert.match(JSON.stringify(statusOnly.content), /仅查询状态/);
	assert.equal(await kagglePage.locator("#status").getAttribute("data-runs"), null);
	assert.deepEqual(await confirmations(), []);
	await requestNotebookAction("run_all");
	assert.equal(await kagglePage.locator("#status").getAttribute("data-runs"), null);
	assert.deepEqual(await confirmations(), [
		{ response: 0, buttons: ["取消", "运行全部单元格"], defaultId: 0, cancelId: 0 },
	]);
	const launchNotebook = await requestNotebookAction("run_all");
	assert.equal(launchNotebook.isError, false);
	assert.equal(await output.textContent(), "FIXTURE_EXECUTED count=1");
	assert.deepEqual((await confirmations()).map(({ response }) => response), [0, 1]);
	const readRun = await requestNotebookAction("inspect");
	assert.equal(readRun.isError, false);
	assert.match(JSON.stringify(readRun.content), /FIXTURE_EXECUTED count=1/);
	if (contestScreenshots)
		await kagglePage.screenshot({ path: join(contestScreenshots, "notebook-computer-use.png"), scale: "css", animations: "disabled" });

	const staleApproval = await requestNotebookAction("run_all");
	assert.equal(staleApproval.isError, true);
	assert.match(JSON.stringify(staleApproval.content), /页面已切换|控件已变化/);
	assert.equal(await kagglePage.locator("#status").getAttribute("data-runs"), null);
	assert.equal(await output.textContent(), "GPU fixture complete\nrows: 12");
	assert.deepEqual((await confirmations()).map(({ response }) => response), [0, 1, 1]);

	await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
	await until(async () => (await snapshot()).active.id !== notebookConversationId, "isolated notebook permission check conversation");
	await ready();
	const unrelatedConversationId = (await snapshot()).active.id;
	const unrelatedRead = await requestNotebookAction("inspect");
	assert.equal(unrelatedRead.isError, true);
	assert.doesNotMatch(JSON.stringify(unrelatedRead.content), /GPU fixture complete|FIXTURE_EXECUTED/);
	assert.deepEqual((await confirmations()).map(({ response }) => response), [0, 1, 1]);
	await page.evaluate(async ({ notebookConversationId, unrelatedConversationId }) => {
		await window.pi.selectConversation(notebookConversationId);
		await window.pi.removeConversation(unrelatedConversationId);
	}, { notebookConversationId, unrelatedConversationId });
	await page.reload();
	await ready();
	checks.push("Kaggle Computer Use reads bounded Notebook output, enforces native Run All approval, and rejects stale or cross-conversation access");

	const kaggleWindow = await application.browserWindow(kagglePage);
	await kaggleWindow.evaluate((browser) => browser.destroy());
	await kaggleWindow.dispose();
	await application.evaluate(({ Menu, dialog, session }) => {
		Menu.prototype.popup = globalThis.__piFixtureNativeMenuPopup;
		delete globalThis.__piFixtureNativeMenuPopup;
		dialog.showMessageBox = globalThis.__piFixtureShowMessageBox;
		delete globalThis.__piFixtureShowMessageBox;
		delete globalThis.__piFixtureNotebookConfirmations;
		session.fromPartition("persist:pi-kaggle-browser").protocol.unhandle("https");
	});
	const modelControl = selectControl("选择模型");
	assert.equal(await modelControl.count(), 1);
	await modelControl.focus();
	await modelControl.press("Enter");
	const modelOptions = page.getByRole("listbox", { name: "选择模型 选项", exact: true });
	await modelOptions.waitFor();
	await modelControl.press("ArrowDown");
	const alternateModel = modelOptions.getByRole("option", { name: "本地演示模型 · 备用", exact: true });
	assert.equal(await modelControl.getAttribute("aria-activedescendant"), await alternateModel.getAttribute("id"));
	await modelControl.press("Escape");
	await modelOptions.waitFor({ state: "hidden" });
	assert.equal((await snapshot()).state?.model?.id, "desktop-demo-1");
	assert.equal(await modelControl.evaluate((node) => node === document.activeElement), true);
	await modelControl.press("Enter");
	await modelOptions.waitFor();
	await modelControl.press("Tab");
	await modelOptions.waitFor({ state: "hidden" });
	assert.equal(await selectControl("思考强度").evaluate((node) => node === document.activeElement), true);
	await modelControl.press("Enter");
	await modelControl.press("ArrowDown");
	await modelControl.press("Enter");
	await until(
		async () =>
			(await snapshot()).state?.model?.id === "desktop-demo-2" &&
			(await modelControl.textContent()).trim() === "本地演示模型 · 备用",
		"the selected alternate model",
	);
	await (await selectListbox(modelControl)).getByRole("option", { name: "本地演示模型", exact: true }).click();
	await until(
		async () =>
			(await snapshot()).state?.model?.id === "desktop-demo-1" &&
			(await modelControl.textContent()).trim() === "本地演示模型",
		"the selected demo model",
	);
	await selectValue(selectControl("思考强度"), "low");
	await until(async () => (await snapshot()).state?.thinkingLevel === "low", "the selected thinking level");
	checks.push("keyboard and pointer combobox selection, Escape cancellation, and Tab focus");

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
			await page.getByRole("region", { name: "允许执行 write？", exact: true })
				.locator(".cc-code-lines .tok-keyword").getByText("export", { exact: true }).waitFor();
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
		await selectValue(selectControl("外观"), "dark");
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
	const providerSelection = selectControl("模型服务商");
	await selectValue(providerSelection, "deepseek");
	const defaultModelControl = selectControl("默认模型");
	const defaultModelOptions = await selectListbox(defaultModelControl);
	assert.ok((await defaultModelOptions.getByRole("option").count()) >= 2);
	await defaultModelControl.press("Escape");
	await defaultModelOptions.waitFor({ state: "hidden" });
	const providerKey = page.getByLabel("API Key", { exact: true });
	assert.equal(await providerKey.inputValue(), "");
	await providerKey.fill("demo-provider-draft");
	await selectValue(providerSelection, "openai");
	assert.equal(await providerKey.inputValue(), "");
	await selectValue(providerSelection, "deepseek");
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
	assert.deepEqual(executors.filter((item) => !item.id.startsWith("acp-")).map((item) => item.id), ["codex", "claude", "kimi", "antigravity"]);
	const qwen = executors.find((item) => item.id === "acp-qwen-code");
	assert.equal(qwen.enabled, false);
	assert.match(qwen.installCommand, /^npm install --global @qwen-code\/qwen-code@/);
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
	await selectValue(externalQuestion.getByRole("combobox", { name: "q0", exact: true }), "blue");
	await externalQuestion.getByRole("checkbox", { name: "test", exact: true }).check();
	await submitExternalAnswers.click();
	await externalQuestion.waitFor({ state: "hidden" });
	await until(async () => (await page.evaluate((id) => window.pi.externalAgents.snapshot(id), externalQuestionTask.id)).status === "completed", "external question completes");
	const answeredExternalQuestion = await page.evaluate((id) => window.pi.externalAgents.snapshot(id), externalQuestionTask.id);
	assert.deepEqual(JSON.parse(answeredExternalQuestion.output), { action: "accept", content: { q0: "blue", q1: ["test"] } });
	checks.push("external structured questions stay inline, preserve the chat focus and return native structured answers");
	const fakeCodex = join(root, "codex-fixture");
	await cp(join(repo, "test/fixtures/external-codex.mjs"), fakeCodex);
	await chmod(fakeCodex, 0o700);
	await page.evaluate((executable) => window.pi.externalAgents.configure({ id: "codex", executable, enabled: true }), fakeCodex);
	await page.getByRole("button", { name: "后台任务与 Worktree", exact: true }).click();
	const nativeTasksDrawer = page.getByRole("dialog", { name: "后台任务、子 Agent 与 Worktree (/tasks)", exact: true });
	await selectValue(nativeTasksDrawer.getByRole("combobox", { name: "任务执行器", exact: true }), "kimi");
	await nativeTasksDrawer.getByRole("textbox", { name: "新建后台任务指令", exact: true }).fill("timeline");
	await nativeTasksDrawer.getByRole("textbox", { name: "任务模型", exact: true }).fill("kimi-k3");
	await nativeTasksDrawer.getByRole("textbox", { name: "任务思考强度", exact: true }).fill("high");
	await nativeTasksDrawer.getByRole("button", { name: "启动", exact: true }).click();
	const nativeTimeline = nativeTasksDrawer.getByRole("region", { name: "执行时间线", exact: true });
	await nativeTimeline.getByText("读取时间线演示文件", { exact: true }).waitFor();
	await nativeTimeline.getByText("运行中", { exact: true }).waitFor();
	const timelineQuestion = nativeTasksDrawer.getByRole("region", { name: "外部 Agent 提问", exact: true });
	await selectValue(timelineQuestion.getByRole("combobox", { name: "q0", exact: true }), "continue");
	await timelineQuestion.getByRole("button", { name: "提交回答", exact: true }).click();
	await nativeTasksDrawer.getByText("本地时间线演示完成", { exact: true }).waitFor();
	await nativeTimeline.getByText(/费用.*0[.,]012/).waitFor();
	const timelineTask = await page.evaluate(async () => (await window.pi.externalAgents.list()).find((task) => task.title === "timeline"));
	assert.equal(timelineTask.model, "kimi-k3");
	assert.equal(timelineTask.effort, "high");
	await nativeTasksDrawer.getByRole("button", { name: "返回列表", exact: true }).click();
	await nativeTasksDrawer.locator(".cc-tool-ctrl-row").filter({ has: page.getByText("timeline", { exact: true }) })
		.getByRole("button", { name: "详情", exact: true }).click();
	await nativeTimeline.getByText("读取时间线演示文件", { exact: true }).waitFor();
	await nativeTimeline.getByText(/费用.*0[.,]012/).waitFor();
	await nativeTimeline.getByText("工具输出", { exact: true }).click();
	await nativeTimeline.getByText("本地演示工具输出", { exact: true }).waitFor();
	checks.push("the task launcher picks an available native executor and the external timeline streams and replays its plan, tool output and reported cost");

	await nativeTasksDrawer.getByRole("textbox", { name: "新建后台任务指令", exact: true }).fill("comparison fixture");
	await nativeTasksDrawer.getByRole("button", { name: "启动", exact: true }).click();
	await nativeTasksDrawer.getByText("turn 1: comparison fixture", { exact: true }).waitFor();
	assert.equal(await nativeTimeline.count(), 1);
	assert.equal(await nativeTimeline.getByText("读取时间线演示文件", { exact: true }).count(), 0);
	await nativeTasksDrawer.getByRole("button", { name: "比较多种方案", exact: true }).click();
	const candidateForm = nativeTasksDrawer.getByRole("group", { name: "启动方案对比", exact: true });
	await candidateForm.getByRole("button", { name: "添加第三种方案", exact: true }).click();
	await candidateForm.getByRole("combobox", { name: "方案 3 执行器", exact: true }).waitFor();
	await candidateForm.getByRole("button", { name: "移除第三种方案", exact: true }).click();
	for (const index of [1, 2]) await candidateForm.getByRole("combobox", { name: `方案 ${index} 执行器`, exact: true }).selectOption("kimi");
	await candidateForm.getByRole("button", { name: "运行 2 种方案", exact: true }).click();
	await nativeTasksDrawer.getByText("相同结果 ×2", { exact: true }).waitFor();
	const comparisonTasks = await page.evaluate(async () => (await window.pi.externalAgents.list()).filter((task) => task.comparisonId));
	assert.equal(comparisonTasks.length, 2);
	assert.equal(new Set(comparisonTasks.map((task) => task.comparisonId)).size, 1);
	assert.equal(new Set(comparisonTasks.map((task) => task.worktreeId)).size, 2);
	checks.push("explicit comparison launches separate candidate worktrees and deduplicates equivalent successful outputs in the result view");

	await nativeTasksDrawer.getByRole("textbox", { name: "新建后台任务指令", exact: true }).fill("changes fixture");
	await nativeTasksDrawer.getByRole("button", { name: "启动", exact: true }).click();
	await nativeTasksDrawer.getByText("IMPLEMENTER_EXPLANATION_PRIVATE", { exact: true }).waitFor();
	await nativeTasksDrawer.getByRole("textbox", { name: "外部任务补充指令", exact: true }).fill("changes follow-up");
	await nativeTasksDrawer.getByRole("button", { name: "继续协作", exact: true }).click();
	await nativeTasksDrawer.getByText("第二轮本地模拟改动完成", { exact: true }).waitFor();
	const changedTask = await page.evaluate(async () => (await window.pi.externalAgents.list()).find((task) => task.title === "changes fixture"));
	assert.equal(changedTask.turn, 2);
	await nativeTasksDrawer.getByRole("button", { name: "独立审查", exact: true }).click();
	const reviewTask = (id) => page.evaluate(async (source) => (await window.pi.externalAgents.list()).find((task) => task.reviewOf === source), id);
	await until(async () => (await reviewTask(changedTask.id))?.status === "completed", "the local read-only independent review completes");
	const independentReview = await reviewTask(changedTask.id);
	assert.equal(independentReview.executor, "codex");
	assert.equal(independentReview.readOnly, true);
	assert.match(independentReview.output, /Original requirement \(JSON string\)\n\n"changes fixture"/);
	assert.match(independentReview.output, /external-fixture-alpha\.txt/);
	assert.match(independentReview.output, /external-fixture-beta\.txt/);
	assert.doesNotMatch(independentReview.output, /IMPLEMENTER_EXPLANATION_PRIVATE|第二轮本地模拟改动完成/);
	await nativeTasksDrawer.getByRole("button", { name: "查看被审查任务", exact: true }).click();
	const externalChanges = nativeTasksDrawer.getByRole("region", { name: "外部任务改动", exact: true });
	await externalChanges.getByLabel("改动文件").selectOption("external-fixture-alpha.txt");
	await externalChanges.getByText("updated second turn", { exact: true }).waitFor();
	await externalChanges.getByRole("button", { name: "应用此文件", exact: true }).click();
	await externalChanges.getByText("已应用到项目", { exact: true }).waitFor();
	assert.equal(await readFile(join(project, "external-fixture-alpha.txt"), "utf8"), "first change\nupdated second turn\n");
	await externalChanges.getByRole("button", { name: "丢弃此文件改动", exact: true }).click();
	await externalChanges.getByText("已丢弃此文件改动", { exact: true }).waitFor();
	await assert.rejects(access(join(changedTask.workingDirectory, "external-fixture-alpha.txt")), { code: "ENOENT" });
	await rm(join(project, "external-fixture-alpha.txt"));
	await until(async () => (await externalChanges.getByLabel("改动文件").inputValue()) === "external-fixture-beta.txt", "discarded file leaves the actionable list");
	await externalChanges.getByRole("button", { name: "应用到项目", exact: true }).click();
	await externalChanges.getByText("已应用到项目", { exact: true }).waitFor();
	assert.equal(await readFile(join(project, "external-fixture-beta.txt"), "utf8"), "second change\n");
	await assert.rejects(access(join(project, "external-fixture-alpha.txt")), { code: "ENOENT" });
	await rm(join(project, "external-fixture-beta.txt"));
	await nativeTasksDrawer.getByRole("button", { name: "关闭对话框", exact: true }).click();
	checks.push("an independent read-only CLI receives only the original requirement and cumulative diff, and the diff UI applies and discards without conflating their target directories");

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
	await page.locator(".cc-tool-ctrl-name strong").getByText("Codex", { exact: true }).waitFor();
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
	const xtermTextarea = page.locator(".terminal-panel .xterm-helper-textarea");
	await xtermTextarea.waitFor({ state: "attached" });
	await xtermTextarea.focus();
	await page.keyboard.type("echo UI_PTY_PANEL_OK");
	await page.keyboard.press("Enter");
	await page.locator(".terminal-panel .xterm-rows").filter({ hasText: "UI_PTY_PANEL_OK" }).waitFor();
	await page.getByRole("button", { name: "纯文本视图", exact: true }).click();
	await page.locator(".terminal-output").filter({ hasText: "UI_PTY_PANEL_OK" }).waitFor();
	await page.getByRole("button", { name: "全真终端", exact: true }).click();
	await page.locator(".terminal-panel .xterm-rows").waitFor();
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

	const permissionControl = selectControl("权限模式");
	await selectValue(permissionControl, "plan");
	await until(
		async () => permissionOf(await snapshot()) === "plan",
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
	await selectValue(selectControl("Hook 类型"), "http");
	await page.getByRole("textbox", { name: "Hook URL", exact: true }).fill(new URL("/hook-test", previewUrl).href);
	await page.getByRole("button", { name: "添加 Hook", exact: true }).click();
	await page.getByText(new URL("/hook-test", previewUrl).href, { exact: true }).waitFor();
	await selectValue(selectControl("Hook 类型"), "command");
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
	await page.getByRole("button", { name: "确认删除 Skill e2e-skill", exact: true }).click();
	await until(async () => (await page.getByText("/e2e-skill", { exact: true }).count()) === 0, "e2e-skill deleted");
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
	await page.getByText(/^延迟加载 \d+ 个工具$/).waitFor();
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();

	const keyboardMenu = page.getByRole("button", { name: "更多工具", exact: true });
	await keyboardMenu.click();
	await keyboardMenu.press("ArrowDown");
	await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
	await page.keyboard.press("Escape");
	await page.getByRole("menu", { name: "更多工具菜单" }).waitFor({ state: "hidden" });
	assert.equal(await keyboardMenu.evaluate((element) => document.activeElement === element), true);

	await openMore("命令面板");
	await page.getByRole("dialog", { name: "命令面板 (⌘P)", exact: true }).waitFor();
	await page.locator(".search-results button").filter({ hasText: "会话内关键词搜索" }).click();
	await page.getByRole("search", { name: "会话内查找", exact: true }).waitFor();
	await page.emulateMedia({ reducedMotion: "reduce" });
	const find = page.getByRole("textbox", { name: "查找会话内容", exact: true });
	const matchTrace = await page.evaluateHandle(() => {
		const matches = [...document.querySelectorAll(".cl-scroll .cl-msg")].filter((node) => node.textContent.includes("问候函数"));
		const previous = Element.prototype.scrollIntoView;
		const calls = [];
		Element.prototype.scrollIntoView = function (options) {
			const index = matches.indexOf(this);
			if (index >= 0) calls.push({ index, behavior: options?.behavior });
			previous.call(this, options);
		};
		return { count: matches.length, calls, restore: () => { Element.prototype.scrollIntoView = previous; } };
	});
	assert.ok(await matchTrace.evaluate((trace) => trace.count) >= 2);
	await find.fill("问候函数");
	await find.press("Enter");
	await find.press("Enter");
	await find.press("Shift+Enter");
	assert.deepEqual(await matchTrace.evaluate((trace) => trace.calls), [
		{ index: 0, behavior: "instant" },
		{ index: 1, behavior: "instant" },
		{ index: 0, behavior: "instant" },
	]);
	await matchTrace.evaluate((trace) => trace.restore());
	await matchTrace.dispose();
	await find.press("Escape");
	assert.equal(await input.evaluate((element) => document.activeElement === element), true);
	checks.push("Hooks UI, Skills manager, rules hierarchy, /context breakdown and transcript search");

	const transcriptScroll = page.locator(".cl-scroll");
	const jumpLatest = page.locator(".cc-jump-latest");
	for (const reducedMotion of ["reduce", "no-preference"]) {
		await page.emulateMedia({ reducedMotion });
		await transcriptScroll.evaluate((element) => { element.scrollTop = 0; });
		await jumpLatest.waitFor();
		const updates = await transcriptScroll.evaluateHandle((element) => {
			const changes = [];
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const [action, nodes] of [["add", record.addedNodes], ["remove", record.removedNodes]]) {
						for (const node of nodes) if (node instanceof HTMLElement && node.matches(".cc-jump-latest")) changes.push(action);
					}
				}
			});
			observer.observe(element, { childList: true });
			return { changes, stop: () => observer.disconnect() };
		});
		await jumpLatest.click();
		await jumpLatest.waitFor({ state: "detached" });
		await page.waitForFunction(() => {
			const element = document.querySelector(".cl-scroll");
			return element.scrollHeight - element.clientHeight - element.scrollTop < 2;
		});
		assert.deepEqual(await updates.evaluate((watch) => watch.changes), ["remove"]);
		await updates.evaluate((watch) => watch.stop());
		await updates.dispose();
	}
	checks.push("jump to latest reaches the bottom without flashing in either motion mode");

	await selectValue(permissionControl, "acceptEdits");
	await until(
		async () => permissionOf(await snapshot()) === "acceptEdits",
		"acceptEdits permission mode",
	);
	await selectValue(permissionControl, "ask");
	await until(
		async () => permissionOf(await snapshot()) === "ask",
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
	await selectValue(selectControl("保存位置"), "user");
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
	await selectValue(selectControl("作用域"), "user");
	await selectValue(selectControl("传输方式"), "http");
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
	const sidebarParentId = (await snapshot()).active.id;
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
	const parentRow = page.locator(`[data-conv-id=${JSON.stringify(sidebarParentId)}]`);
	const childFold = parentRow.locator("..").getByRole("button", { name: /子 Agent 会话/ });
	if (await childFold.getAttribute("aria-expanded") !== "true") await childFold.click();
	const childListId = await childFold.getAttribute("aria-controls");
	assert.ok(childListId, "The child fold button identifies its owned list");
	const childRow = page.locator(`[id=${JSON.stringify(childListId)}]`).locator(".cl-conv-child");
	await childRow.click();
	await until(async () => (await snapshot()).active?.parentConversationId === sidebarParentId, "switch to the child from the sidebar");
	const activeChildId = (await snapshot()).active.id;
	await childFold.click();
	assert.equal(await childFold.getAttribute("aria-expanded"), "false", "A selected child does not override the user's collapse");
	await childRow.waitFor({ state: "hidden" });
	assert.equal((await snapshot()).active.id, activeChildId);
	await parentRow.click();
	await until(async () => (await snapshot()).active?.id === sidebarParentId, "return from the collapsed child to its parent");
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
		const timing = selectControl("补充指令发送时机");
		assert.equal((await timing.textContent()).trim(), "本轮结束后");
		if (withImage) {
			await timing.press("Enter");
			await timing.press("ArrowDown");
			const activeId = await timing.getAttribute("aria-activedescendant");
			const steeringOption = page.getByRole("option", { name: /下一工具步骤/ });
			assert.equal(activeId, await steeringOption.getAttribute("id"));
			const response = page.locator(".cl-transcript").getByText(/^流式恢复验证：/).first();
			const length = (await response.textContent()).length;
			await until(async () => (await response.textContent()).length > length + 5, "new streaming output");
			assert.equal(await timing.getAttribute("aria-activedescendant"), activeId);
			await timing.press("Space");
		}
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
	await startStream();
	const previousBounds = await application.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		const bounds = win.getBounds();
		win.setBounds({ width: 960, height: 650 });
		return bounds;
	});
	const queueConversation = (await snapshot()).active.id;
	for (let index = 1; index <= 10; index++) {
		const result = await page.evaluate(({ id, text }) =>
			window.pi.sendPrompt(id, { text, attachments: [] }, "followUp"), {
			id: queueConversation,
			text: [`第 ${index} 条补充指令`, "检查测试用例和结果", "记录输入输出和耗时", "保留本地结果"].join("\n"),
		});
		assert.equal(result.disposition, "queued");
	}
	const queueList = queue.getByRole("group", { name: "指令列表", exact: true });
	const stopTask = page.getByRole("button", { name: "停止任务", exact: true });
	await until(async () => await queueList.locator(".cc-queue-item").count() === 10, "all queued instructions");
	assert.ok(await queueList.evaluate((list) => list.scrollHeight > list.clientHeight));
	await queueList.focus();
	await queueList.press("End");
	await until(() => queueList.evaluate((list) => list.scrollTop > 0), "keyboard scrolling in the queue");
	for (const control of [input, stopTask, queue.getByRole("button", { name: "停止并发送队列", exact: true })]) {
		assert.ok(await control.evaluate((element) => {
			const { top, bottom } = element.getBoundingClientRect();
			return top >= 0 && bottom <= window.innerHeight;
		}));
	}
	await queue.getByRole("button", { name: "撤回到输入框", exact: true }).click();
	await queue.waitFor({ state: "hidden" });
	await stopTask.click();
	await idle();
	await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), previousBounds);
	checks.push("long queues scroll by keyboard while the narrow-window composer and stop actions stay visible");

	await newChat();
	await submit("检查本轮代码基线");
	await idle();
	const review = page.getByRole("button", { name: "质量鉴定", exact: true });
	await review.waitFor({ state: "hidden" });
	const externalEdit = join(project, "src/grail-review-readiness-fixture.txt");
	await writeFile(externalEdit, "External editor change\n");
	await until(() => review.isEnabled(), "quality review becomes available after an external edit");
	await rm(externalEdit);
	await review.waitFor({ state: "hidden" });
	checks.push("quality review updates when external edits appear and return to the baseline");

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
		args: testArgs,
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
	const permissions = selectControl("权限模式");
	for (const [mode, text] of [["read", "有大文件时的只读提问"], ["ask", "有大文件时的普通提问"]]) {
		await selectValue(permissions, mode);
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
		await selectValue(permissions, mode);
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
	await submit("现在怎么样了");
	await page.getByText("演示比赛状态查询结束。", { exact: true }).waitFor();
	await idle();
	const submissions = (await snapshot()).messages.filter((message) => message.role === "toolResult").slice(-2);
	assert.deepEqual(submissions.map((message) => message.isError), [false, true]);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\nsubmissions\n");
	const remoteApproval = page.getByRole("region", { name: /远端写入/ });
	await submit("请删除演示云端作业");
	await page.getByText("演示远端操作结束。", { exact: true }).waitFor();
	await idle();
	assert.equal(await remoteApproval.count(), 0);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\nsubmissions\ndelete\n");

	await newChat();
	assert.equal(permissionOf(await snapshot()), "ask");
	assert.equal((await snapshot()).conversations.find((item) => item.id === autoConversationId)?.permissionMode, "auto");
	await submit("请删除演示云端作业");
	await remoteApproval.waitFor();
	assert.equal(await remoteApproval.getByRole("button", { name: /始终允许/ }).count(), 0);
	assert.equal(await readFile(kaggleLog, "utf8"), "status\nsubmissions\ndelete\n");
	await remoteApproval.getByRole("button", { name: "仅本次执行", exact: true }).click();
	await page.getByText("演示远端操作结束。", { exact: true }).waitFor();
	await idle();
	assert.equal(await readFile(kaggleLog, "utf8"), "status\nsubmissions\ndelete\ndelete\n");
	checks.push("status-only requests cannot mutate the remote queue; explicit writes follow auto and manual approval modes");

	await openMore("工具与权限");
	await page.getByRole("tab", { name: /权限规则/ }).click();
	const localComputeGuard = page.getByRole("checkbox", { name: "拦截已识别的本机推理与评测命令（此项目）" });
	await localComputeGuard.click();
	await until(() => localComputeGuard.isChecked(), "local compute preference applied");
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
	const localComputeMarker = join(project, "local-compute-ran");
	await writeFile(join(project, "llama-server"), '#!/bin/sh\ntouch local-compute-ran\n', { mode: 0o755 });
	await assert.rejects(page.evaluate(() => window.pi.command({ type: "bash", command: "./llama-server" })), /禁止启动本机推理/);
	await assert.rejects(access(localComputeMarker));
	await page.getByRole("button", { name: "后台任务与 Worktree", exact: true }).click();
	const remoteDrawer = page.getByRole("dialog", { name: "后台任务、子 Agent 与 Worktree (/tasks)", exact: true });
	await remoteDrawer.getByRole("tab", { name: /远端任务/ }).click();
	await remoteDrawer.getByLabel("检查 Notebook 配置").setInputFiles({
		name: "kernel-metadata.json", mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify({ id: "fixture/notebook-demo", code_file: "eval.ipynb", enable_gpu: "true", enable_internet: "false" })),
	});
	await remoteDrawer.getByText(/未指定加速器型号/).waitFor();
	await remoteDrawer.getByRole("button", { name: "关闭预检结果", exact: true }).click();
	await remoteDrawer.getByRole("button", { name: "添加跟踪", exact: true }).click();
	await remoteDrawer.getByLabel("Notebook 标识").fill("fixture/notebook-demo");
	await remoteDrawer.getByLabel("版本号").fill("3");
	await remoteDrawer.getByRole("button", { name: "开始跟踪", exact: true }).click();
	await remoteDrawer.getByText("fixture/notebook-demo · v3", { exact: true }).waitFor();
	await remoteDrawer.getByText("尚未确认", { exact: true }).waitFor();
	if (contestScreenshots) {
		await mkdir(contestScreenshots, { recursive: true });
		await page.screenshot({ path: join(contestScreenshots, "remote-job-tracking.png") });
	}
	await remoteDrawer.getByRole("button", { name: "移除跟踪", exact: true }).click();
	await remoteDrawer.getByText("此会话暂无远端任务。", { exact: true }).waitFor();
	await remoteDrawer.getByRole("button", { name: "关闭对话框", exact: true }).click();
	await openMore("工具与权限");
	await page.getByRole("tab", { name: /权限规则/ }).click();
	await localComputeGuard.click();
	await until(async () => !(await localComputeGuard.isChecked()), "local compute preference restored");
	await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
	checks.push("project local compute gate and offline remote-job tracking are available through the desktop UI");

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
	await drawer.locator(".cc-tool-ctrl-row").filter({ hasText: "演示本轮后台命令" })
		.getByText("已停止", { exact: true }).waitFor();
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

	await newChat();
	await setPermissionMode("auto");
	await submit("验证运行中工具折叠和 Markdown 表格");
	const liveTool = page.locator(".cl-tool.running > .cc-tool-row").filter({ hasText: /等待工具折叠验证|release-tool-card/ });
	await liveTool.waitFor();
	assert.equal(await liveTool.getAttribute("aria-expanded"), "true");
	await liveTool.click();
	assert.equal(await liveTool.getAttribute("aria-expanded"), "false");
	await liveTool.click();
	assert.equal(await liveTool.getAttribute("aria-expanded"), "true");
	await liveTool.click();
	await writeFile(join(project, "release-tool-card.flag"), "go\n");
	await idle();
	const wideTable = page.locator(".cl-scroll").getByRole("table").filter({ hasText: "本地命令" });
	await wideTable.waitFor();
	assert.equal(await wideTable.getByRole("columnheader").count(), 28);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	let tableGeometry;
	await until(async () => {
		tableGeometry = await wideTable.evaluate((table) => {
			const scroller = table.parentElement;
			const transcript = table.closest(".cl-scroll");
			if (!table.isConnected || !scroller || !transcript) return null;
			const previous = scroller.scrollLeft;
			scroller.scrollLeft = 32;
			const metrics = {
				tableOffset: scroller.scrollLeft,
				tableContentWidth: scroller.scrollWidth,
				tableViewportWidth: scroller.clientWidth,
				transcriptContentWidth: transcript.scrollWidth,
				transcriptViewportWidth: transcript.clientWidth,
			};
			scroller.scrollLeft = previous;
			return metrics;
		});
		return tableGeometry !== null;
	}, "wide table mounted within the transcript");
	assert.ok(tableGeometry.tableOffset > 0 &&
		tableGeometry.transcriptContentWidth <= tableGeometry.transcriptViewportWidth + 1,
		`Wide tables should scroll without spreading the conversation. ${JSON.stringify(tableGeometry)}`);
	checks.push("running command cards collapse and wide GFM tables scroll independently");

	const sidebarWindow = await application.browserWindow(page);
	const sidebarWindowSize = await sidebarWindow.evaluate((win) => win.getSize());
	await sidebarWindow.evaluate((win) => win.setSize(1024, 620));
	await page.waitForFunction(() => window.innerWidth === 1024 && window.innerHeight === 620);
	const sidebar = page.getByRole("complementary", { name: "项目与会话", exact: true });
	const workspaceFold = sidebar.getByRole("button", { name: "工作目录", exact: true });
	const workspaceExpanded = await workspaceFold.getAttribute("aria-expanded");
	assert.ok(workspaceExpanded === "true" || workspaceExpanded === "false");
	await workspaceFold.click();
	assert.notEqual(await workspaceFold.getAttribute("aria-expanded"), workspaceExpanded);
	await workspaceFold.click();
	const finishedTasks = sidebar.getByRole("button", { name: /^最近结束/ });
	await finishedTasks.waitFor();
	assert.equal(await finishedTasks.getAttribute("aria-expanded"), "false");
	await finishedTasks.click();
	await sidebar.locator(".cc-attention-finished .cc-attention-row").first().waitFor();

	const activeTitle = (await snapshot()).active.title;
	const menuTrigger = sidebar.getByRole("button", { name: `会话操作：${activeTitle}`, exact: true });
	await sidebar.locator(".cl-conv[aria-current='page']").hover();
	await menuTrigger.click();
	const sessionMenu = page.getByRole("menu", { name: `会话「${activeTitle}」操作`, exact: true });
	await sessionMenu.getByRole("menuitem", { name: "重命名", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await sessionMenu.waitFor({ state: "hidden" });
	await until(() => menuTrigger.evaluate((trigger) => trigger === document.activeElement), "restore focus to the session menu trigger");

	const sidebarScroll = sidebar.locator(".cl-side-scroll");
	const previousOffset = await sidebarScroll.evaluate(async (element) => {
		element.scrollTop = element.scrollHeight - element.clientHeight;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		return element.scrollTop;
	});
	assert.ok(previousOffset > 0, "The sidebar fixture needs an overflowing conversation list");
	await sidebar.getByRole("button", { name: "收起侧栏", exact: true }).click();
	await page.locator(".cc-sidebar-track").waitFor({ state: "detached" });
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	await until(() => sidebarScroll.evaluate((element, offset) =>
		Math.abs(element.scrollTop - offset) <= 1, previousOffset), "restore the sidebar list scroll position");
	assert.equal(await finishedTasks.getAttribute("aria-expanded"), "true");
	await sidebarWindow.evaluate((win) => win.setSize(950, 620));
	await page.waitForFunction(() => window.innerWidth === 950);
	await page.waitForFunction(() => {
		const title = document.querySelector(".cl-side-title");
		return title && title.scrollWidth <= title.clientWidth;
	});
	await sidebarWindow.evaluate((win, size) => win.setSize(...size), sidebarWindowSize);
	await sidebarWindow.dispose();
	checks.push("sidebar disclosures, discoverable session menu and scroll restoration after collapse");

	await newChat();
	await setPermissionMode("auto");
	const statusAccordion = page.locator(".cc-conversation-status summary");
	const sideQuestion = page.locator(".cc-btw-card");
	const sideAnswer = sideQuestion.getByText(/^本地侧问回复。/);
	await submit("/btw 验证侧问面板一");
	await sideAnswer.waitFor();
	await statusAccordion.click();
	assert.equal(await statusAccordion.getAttribute("aria-expanded"), "false");
	await submit("/btw 验证侧问面板二");
	await sideQuestion.getByText("/btw 验证侧问面板二", { exact: true }).waitFor();
	assert.equal(await statusAccordion.getAttribute("aria-expanded"), "true");
	await statusAccordion.click();
	await sideAnswer.waitFor({ state: "attached" });
	assert.equal(await statusAccordion.getAttribute("aria-expanded"), "false");
	await statusAccordion.click();
	await sideQuestion.getByRole("button", { name: "关闭", exact: true }).click();
	checks.push("/btw opens a collapsed conversation activity disclosure and respects manual collapse after submission");

	const imagePath = join(project, "timeline-image.png");
	await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64"));
	await writeFile(join(project, "timeline-write.txt"), "old row one\nold row two\nold row three\nold row four\n");
	await page.getByLabel("选择附件", { exact: true }).setInputFiles(imagePath);
	await submit("验证时间线增删行");
	await page.getByText("时间线验证已完成。", { exact: true }).waitFor();
	await idle();
	const timelineMessages = (await snapshot()).messages;
	assert.deepEqual(timelineMessages.filter((message) => message.role === "toolResult").map((message) => message.isError),
		[false, false, false, false, false]);
	const writeSpotlight = page.locator(".cc-edit-spotlight-row").filter({ hasText: "timeline-write.txt" });
	await writeSpotlight.getByText("已写入", { exact: true }).waitFor();
	await writeSpotlight.getByText("3 行", { exact: true }).waitFor();
	assert.equal(await writeSpotlight.locator(".cc-tool-diff-stat").count(), 0);
	const updateSpotlights = page.locator(".cc-edit-spotlight-row").filter({ hasText: "已更新" });
	const exactSpotlight = updateSpotlights.filter({ has: page.getByText("+1", { exact: true }) });
	await exactSpotlight.getByText("-1", { exact: true }).waitFor();
	if (await exactSpotlight.getAttribute("aria-expanded") !== "true") await exactSpotlight.click();
	await exactSpotlight.locator("..").locator(".cc-diff-add .tok-keyword").getByText("const", { exact: true }).waitFor();
	const broadSpotlight = updateSpotlights.filter({ hasText: "差异预览" });
	assert.equal(await broadSpotlight.locator(".cc-tool-diff-stat").count(), 0);
	const broadDiff = broadSpotlight.locator("..");
	await broadDiff.getByText("改动前（未逐行对比）", { exact: true }).waitFor();
	await broadDiff.getByText("改动后（未逐行对比）", { exact: true }).waitFor();
	assert.equal(await broadDiff.locator(".cc-diff-add, .cc-diff-del").count(), 0);
	checks.push("transcript write counts and exact or bounded edit previews describe actual line changes");

	const currentComposer = page.getByRole("textbox", { name: "输入任务", exact: true });
	await currentComposer.fill("图片预览期间保留这份草稿");
	const checkPreview = async (thumbnail) => {
		await thumbnail.focus();
		await page.keyboard.press("Enter");
		const dialog = page.locator("dialog.cc-image-preview-modal[open]");
		await dialog.waitFor();
		const close = dialog.getByRole("button", { name: "关闭对话框", exact: true });
		assert.ok(await close.evaluate((button) => button === document.activeElement));
		await page.evaluate(() => document.querySelector('textarea[aria-label="输入任务"]').focus());
		assert.ok(await close.evaluate((button) => button === document.activeElement));
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("Tab");
			assert.ok(await dialog.evaluate((node) => node.contains(document.activeElement) || document.activeElement === document.body));
		}
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		await until(() => thumbnail.evaluate((button) => button === document.activeElement), "restore thumbnail focus");
		assert.equal(await currentComposer.inputValue(), "图片预览期间保留这份草稿");
	};
	await checkPreview(page.getByRole("button", { name: "放大预览：用户附件预览", exact: true }));
	const timelineGroup = page.locator(".cc-tool-group-head").filter({ hasText: "编辑 4 个文件" });
	await timelineGroup.click();
	await page.locator(".cl-tool > .cc-tool-row").filter({ hasText: "timeline-image.png" }).click();
	await checkPreview(page.getByRole("button", { name: "放大预览：读取 timeline-image.png", exact: true }));
	assert.equal((await snapshot()).messages.length, timelineMessages.length);
	checks.push("user and tool image previews are keyboard-operable, keep background focus inert and restore focus");

	const prWindow = await application.browserWindow(page);
	const prInitialSize = await prWindow.evaluate((win) => win.getSize());
	await prWindow.evaluate((win) => win.setSize(980, 650));
	await page.waitForFunction(() => window.innerWidth === 980);
	await page.getByRole("button", { name: "代码修改", exact: true }).click();
	await page.getByRole("button", { name: "整个工作区", exact: true }).click();
	await page.locator(".workspace-review-git summary").click();
	await page.getByRole("button", { name: "PR 与 CI", exact: true }).click();
	await page.getByText("#123 本地演示 PR", { exact: true }).waitFor();
	const mergeMethods = selectControl("自动合并方式");
	assert.deepEqual(await mergeMethods.locator("option").allTextContents(), ["Squash", "Merge", "Rebase"]);
	for (const method of ["merge", "rebase"]) {
		await mergeMethods.selectOption(method);
		await page.getByRole("button", { name: "开启自动合并", exact: true }).click();
		await page.getByText(`已开启自动合并（${method}）。`, { exact: true }).waitFor();
	}
	assert.equal(await readFile(join(cliFixtures, "gh-commands"), "utf8"), "pr merge 123 --auto --merge\npr merge 123 --auto --rebase\n");
	await prWindow.evaluate((win, size) => win.setSize(...size), prInitialSize);
	await prWindow.dispose();
	checks.push("native PR merge options work in a narrow Git inspector with no CI checks");

	await page.getByRole("button", { name: "代码修改", exact: true }).click();
	await newChat();
	const fixtureReply = page.getByText("已收到补充指令，客户端与 Pi 引擎连接正常。", { exact: true });
	for (const [index, message] of ["保留上下文压缩前的早期需求。", "这条指令留在近期上下文中。"].entries()) {
		await submit(message);
		await fixtureReply.nth(index).waitFor();
		await idle();
	}
	await submit("/compact 验证压缩状态");
	await page.locator(".cc-dock-state-label").filter({ hasText: "正在压缩上下文" }).waitFor();
	const completion = page.getByRole("status").filter({ hasText: "手动压缩上下文已完成" });
	await completion.waitFor();
	assert.match(await completion.innerText(), /压缩前 [\d,]+ tokens · 压缩后约 [\d,]+ tokens/);
	await idle();
	await page.getByRole("button", { name: /Ctx 待更新/ }).click();
	const telemetry = page.getByRole("region", { name: "会话遥测明细", exact: true });
	await telemetry.locator(".cc-telemetry-meter-row").getByText(/^待更新/).waitFor();
	assert.equal(await telemetry.locator(".cc-telemetry-bar").count(), 0);
	await page.keyboard.press("Escape");
	await completion.getByRole("button", { name: "关闭压缩提示", exact: true }).click();
	await completion.waitFor({ state: "hidden" });
	await page.reload();
	await ready();
	const summary = page.getByText(/^上下文摘要 · 压缩前/);
	const summaryCard = page.locator(".cl-tool.done").filter({ has: summary });
	await summary.click();
	await summaryCard.getByText("本地演示压缩摘要。保留了用户的原始要求、任务执行进展和下一步验证。", { exact: true }).waitFor();
	await submit("/context");
	const contextDialog = page.getByRole("dialog", { name: "项目记忆与会话状态", exact: true });
	const contextMeter = contextDialog.locator('[aria-label="上下文分段占用条"]');
	await contextDialog.getByText("上下文占用待更新", { exact: true }).waitFor();
	assert.equal(await contextMeter.count(), 0);
	await contextDialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
	await submit("压缩后的下一条任务。");
	await idle();
	await page.getByRole("button", { name: /Ctx \d+%/ }).waitFor();
	await submit("/context");
	await contextMeter.waitFor();
	await contextDialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
	checks.push("real SDK compaction shows progress, a completion estimate, and a persisted summary while context usage waits for the next reply");

	if (workspaceScreenshots) await mkdir(workspaceScreenshots, { recursive: true });
	await newChat();
	const originalText = "复核编辑重发原文\n\n附件 例子：\n这段仍是正文。\n\n<pi-desktop-workspace-context>\n这是用户输入的字面文本。\n</pi-desktop-workspace-context>";
	await page.getByRole("textbox", { name: "输入任务", exact: true }).fill(originalText);
	await page.getByLabel("选择附件", { exact: true }).setInputFiles([
		{ name: "报告：初稿.txt", mimeType: "text/plain", buffer: Buffer.from("这是正文附件。\n\n附件 仍是附件正文：\n保留。") },
		{ name: "复核图片.png", mimeType: "image/png",
			buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC", "base64") },
	]);
	const originalPicture = page.getByRole("button", { name: "移除附件 复核图片.png", exact: true });
	await originalPicture.waitFor();
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	const originalPrompt = page.locator(".cl-msg-user").filter({ hasText: "复核编辑重发原文" });
	await originalPrompt.waitFor();
	await idle();
	await page.reload();
	await ready();
	await originalPrompt.hover();
	await originalPrompt.getByRole("button", { name: "编辑并重新发送", exact: true }).click();
	await originalPicture.waitFor();
	await page.getByRole("button", { name: "移除附件 报告：初稿.txt", exact: true }).waitFor();
	assert.equal(await page.getByRole("textbox", { name: "输入任务", exact: true }).inputValue(), originalText);
	await originalPrompt.waitFor({ state: "hidden" });
	if (workspaceScreenshots) await page.screenshot({ path: join(workspaceScreenshots, "edit-and-resend.png"), scale: "css" });
	checks.push("editing a persisted message restores exact text and both attachment chips after reload");

	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await originalPrompt.waitFor();
	await idle();
	await newChat();
	await submit("全文搜索回归的会话标题");
	await idle();
	await submit('这行正文包含 "SEARCH_HISTORY_FIXTURE"。');
	await page.locator(".cl-msg-user").filter({ hasText: "SEARCH_HISTORY_FIXTURE" }).waitFor();
	await idle();
	await page.keyboard.press("Meta+k");
	const historySearch = page.getByRole("combobox", { name: "搜索会话标题或项目", exact: true });
	await historySearch.fill('"SEARCH_HISTORY_FIXTURE"');
	const exactHistoryHit = page.getByRole("option").filter({ hasText: "全文搜索回归的会话标题" });
	await exactHistoryHit.waitFor();
	assert.equal(await exactHistoryHit.evaluate((result) => {
		const icon = result.querySelector(".cc-palette-icon").getBoundingClientRect();
		const title = result.querySelector(".cc-palette-result-text strong").getBoundingClientRect();
		const project = result.querySelector(".cc-palette-result-text > span").getBoundingClientRect();
		return icon.right < title.left && icon.top < project.bottom && project.top >= title.bottom;
	}), true, "The result icon stays beside the copy and the project sits below the title");
	if (workspaceScreenshots) await page.screenshot({ path: join(workspaceScreenshots, "history-search.png"), scale: "css" });
	await historySearch.fill("NO_MATCHING_SESSION_6789");
	await historySearch.press("Enter");
	await historySearch.waitFor();
	await exactHistoryHit.waitFor({ state: "hidden" });
	await page.keyboard.press("Escape");
	checks.push("history search finds quoted content and cannot open stale results for a different query");

	await newChat();
	await page.evaluate(() => window.pi.saveSettings({ permission: "ask", theme: "light", editor: "vscode" }));
	await setPermissionMode("auto");
	await submit("验证独立 Worktree 的编辑器定位");
	const worktreeRow = page.locator(".cc-subagent-row").filter({ hasText: "独立 Worktree 定位" });
	await worktreeRow.waitFor();
	const worktreeTask = await page.evaluate(async () => (await window.pi.tasks.list()).find((item) => item.title === "独立 Worktree 定位"));
	assert.ok(worktreeTask?.worktreeId && worktreeTask?.workingDirectory);
	await worktreeRow.click();
	await page.getByRole("button", { name: "返回主会话", exact: true }).waitFor();
	await page.getByRole("button", { name: "读取 1 个文件", exact: true }).click();
	await application.evaluate(({ shell }) => {
		globalThis.verifyEditorUri = undefined;
		globalThis.verifyEditorOriginal = shell.openExternal;
		shell.openExternal = async (uri) => { globalThis.verifyEditorUri = uri; };
	});
	try {
		await page.getByRole("button", { name: "在编辑器中打开 src/greeting.mjs", exact: true }).click();
		let editorUri;
		await until(async () => { editorUri = await application.evaluate(() => globalThis.verifyEditorUri); return Boolean(editorUri); }, "child editor URL");
		assert.ok(decodeURI(editorUri).includes(`${worktreeTask.workingDirectory}/src/greeting.mjs`), editorUri);
		if (workspaceScreenshots) await page.screenshot({ path: join(workspaceScreenshots, "worktree-transcript.png"), scale: "css" });
	} finally {
		await application.evaluate(({ shell }) => { shell.openExternal = globalThis.verifyEditorOriginal; });
	}
	await page.getByRole("button", { name: "返回主会话", exact: true }).click();
	await idle();
	checks.push("opening a tool path in a child transcript resolves through its actual Worktree");

	await submit("并行子Agent展示验证");
	const agentGroup = page.locator(".cc-subagent-run-group").filter({ hasText: "调查问候函数" }).last();
	// The calls stream in one by one; wait for the finished three-agent header before counting.
	await agentGroup.locator(".cc-subagent-run-group-head").filter({ hasText: "3 个 Agent 完成" }).waitFor();
	await idle();
	assert.equal(await agentGroup.locator(".cc-subagent-run-row.in-group").count(), 3, "three agents of one message share one block");
	assert.equal(await agentGroup.locator(".cc-subagent-run-branch").last().textContent(), "└");
	for (const row of await agentGroup.locator(".cc-subagent-run-row.in-group").all())
		assert.match(await row.locator(".cc-subagent-run-metrics").textContent(), /次工具 · .*tokens · \d+s/);
	if (process.env.PI_AGENT_ROWS_SCREENSHOT) await agentGroup.screenshot({ path: process.env.PI_AGENT_ROWS_SCREENSHOT, scale: "css", animations: "disabled" });
	await agentGroup.locator(".cc-subagent-run-head").first().click();
	await agentGroup.getByText("并行展示子任务：问候函数", { exact: true }).waitFor();
	checks.push("parallel Agent calls render as one tree-branch block with live metrics and an expandable brief");

	await submit("任务清单展示验证");
	await idle();
	const todoRows = page.locator(".cc-todo-update").filter({ hasText: "更新任务清单" });
	await todoRows.nth(1).waitFor();
	assert.match(await todoRows.nth(0).locator(".cc-todo-update-text").textContent(), /^创建了 3 项任务 · 0\/3$/);
	assert.match(await todoRows.nth(1).locator(".cc-todo-update-text").textContent(), /^完成「读取问候函数」，开始「运行测试」 · 1\/3$/);
	const pinned = page.locator(".cc-pinned-todos");
	await pinned.locator(".cc-todo-list").waitFor();
	assert.match(await pinned.locator(".cc-pinned-todos-title").textContent(), /任务进度 \(1\/3\) · 正在运行测试/);
	const pinnedItems = pinned.locator(".cc-todo-item");
	assert.equal(await pinnedItems.count(), 3, "the pinned list starts expanded");
	assert.equal(await pinnedItems.nth(0).locator(".cc-todo-box").textContent(), "☒");
	assert.equal(await pinnedItems.nth(0).evaluate((node) => getComputedStyle(node.querySelector(".cc-todo-text")).textDecorationLine), "line-through");
	assert.equal(await pinnedItems.nth(1).getAttribute("aria-current"), "step");
	assert.equal(await pinnedItems.nth(1).locator(".cc-todo-text").textContent(), "正在运行测试", "the current item shows its activeForm");
	assert.equal(await pinnedItems.nth(2).locator(".cc-todo-box").textContent(), "☐");
	if (process.env.PI_TODO_SCREENSHOT) {
		await todoRows.nth(1).locator(".cc-todo-update-head").click();
		await todoRows.nth(1).locator(".cc-todo-list").waitFor();
		await page.locator(".cl-conversation").screenshot({ path: process.env.PI_TODO_SCREENSHOT, scale: "css", animations: "disabled" });
		await todoRows.nth(1).locator(".cc-todo-update-head").click();
	}
	await pinned.getByRole("button", { name: "完成并收起" }).click();
	await pinned.waitFor({ state: "detached" });
	checks.push("TodoWrite calls show one-line deltas in the transcript and a pinned, expanded ☐/☒ checklist with the activeForm of the current item");

	// ultracode keyword: it glows while typed, runs only that turn, and marks the prompt afterwards.
	const composerBox = page.getByRole("textbox", { name: "输入任务", exact: true });
	await composerBox.fill("请用 ultracode 检查标记");
	await page.locator(".cc-keyword-mirror .cc-ultracode-word").filter({ hasText: "ultracode" }).waitFor();
	await page.locator(".cc-keyword-hint").filter({ hasText: "本轮按 ultracode 运行" }).waitFor();
	await composerBox.fill("/ultracode on");
	assert.equal(await page.locator(".cc-keyword-mirror").count(), 0, "the slash command is not the keyword");
	await submit("请用 ultracode 检查标记");
	await idle();
	const markedPrompt = page.locator(".cl-msg-user").filter({ hasText: "请用 ultracode 检查标记" }).last();
	await markedPrompt.locator(".cc-prompt-tier").waitFor();
	const afterKeyword = await snapshot();
	assert.equal(afterKeyword.active.codingTier, undefined, "the keyword does not change the standing tier");
	assert.equal(afterKeyword.active.turnTier, undefined, "the keyword turn has ended");
	assert.equal(await page.locator(".cc-dock-header .cc-ultracode-badge").count(), 0, "no badge once the keyword turn ended");
	const plainPrompt = page.locator(".cl-msg-user").filter({ hasText: "任务清单展示验证" }).last();
	assert.equal(await plainPrompt.locator(".cc-prompt-tier").count(), 0, "earlier standard prompts carry no marker");
	await selectValue(selectControl("编排档位"), "ultracode");
	await page.locator(".cc-dock-header .cc-ultracode-badge").filter({ hasText: /^ultracode$/ }).waitFor();
	await composerBox.fill("ultracode 再来一次");
	assert.equal(await page.locator(".cc-keyword-mirror").count(), 0, "a standing ultracode conversation needs no keyword");
	await composerBox.fill("");
	if (process.env.PI_ULTRACODE_SCREENSHOT) await page.locator(".cl-conversation").screenshot({ path: process.env.PI_ULTRACODE_SCREENSHOT, scale: "css", animations: "disabled" });
	await selectValue(selectControl("编排档位"), "standard");
	await page.locator(".cc-dock-header .cc-ultracode-badge").waitFor({ state: "detached" });
	checks.push("the ultracode keyword glows while typed, runs only its own turn, marks that prompt, and a standing ultracode conversation shows a dock badge");

	await page.evaluate(() => window.pi.externalAgents.configure({ id: "claude", enabled: false }));
	const multiDialog = page.getByRole("dialog", { name: "设置与模型连接", exact: true });
	const multiSettingsGroup = multiDialog.getByRole("group", { name: "multi 档位：外部 Agent 协作", exact: true });
	const openMultiSettings = async () => {
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await multiDialog.getByRole("searchbox", { name: "搜索设置项", exact: true }).fill("multi");
		await multiSettingsGroup.waitFor();
	};
	const saveMultiSettings = async () => {
		await multiDialog.getByRole("button", { name: "保存设置", exact: true }).click();
		await multiDialog.waitFor({ state: "detached" });
	};
	const controllerModel = selectControl("主控模型");
	const controllerThinking = selectControl("主控思考强度");
	const executorModels = [
		["Codex", "gpt-5.4"],
		["Claude Code", "sonnet"],
		["Kimi Code", "kimi-k2.7-code"],
	];
	const kimiThinking = multiDialog.getByLabel("Kimi Code 思考强度", { exact: true });
	const selectedModel = selectControl("选择模型");
	if ((await snapshot()).state?.model?.id !== "desktop-demo-1") {
		await (await selectListbox(selectedModel)).getByRole("option", { name: "本地演示模型", exact: true }).click();
		await until(async () => (await snapshot()).state?.model?.id === "desktop-demo-1", "the baseline conversation model");
	}
	await selectValue(selectControl("思考强度"), "low");
	await until(async () => (await snapshot()).state?.thinkingLevel === "low", "the baseline conversation effort");
	await openMultiSettings();
	await selectValue(controllerModel, "desktop-demo/desktop-demo-2");
	await selectValue(controllerThinking, "high");
	for (const [name, model] of executorModels) await multiDialog.getByLabel(`${name} 模型`, { exact: true }).fill(model);
	await selectValue(selectControl("Codex 思考强度"), "high");
	await selectValue(selectControl("Claude Code 思考强度"), "medium");
	await kimiThinking.fill("high");
	await saveMultiSettings();
	assert.deepEqual((await snapshot()).settings.multiAgent, {
		controller: { model: { provider: "desktop-demo", id: "desktop-demo-2" }, thinkingLevel: "high" },
		executors: {
			codex: { model: "gpt-5.4", effort: "high" },
			claude: { model: "sonnet", effort: "medium" },
			kimi: { model: "kimi-k2.7-code", effort: "high" },
		},
	});
	await openMultiSettings();
	assert.match(await controllerModel.textContent(), /本地演示模型 · 备用/);
	assert.equal((await controllerThinking.textContent()).trim(), "高");
	for (const [name, model] of executorModels) assert.equal(await multiDialog.getByLabel(`${name} 模型`, { exact: true }).inputValue(), model);
	assert.equal((await selectControl("Codex 思考强度").textContent()).trim(), "high");
	assert.equal((await selectControl("Claude Code 思考强度").textContent()).trim(), "medium");
	assert.equal(await kimiThinking.inputValue(), "high");
	if (workspaceScreenshots) await multiSettingsGroup.screenshot({ path: join(workspaceScreenshots, "multi-settings.png"), scale: "css", animations: "disabled" });
	await kimiThinking.fill("max");
	await multiDialog.getByRole("button", { name: "取消", exact: true }).click();
	await page.getByRole("dialog", { name: "放弃未保存的设置更改？", exact: true }).getByRole("button", { name: "放弃更改", exact: true }).click();
	await multiDialog.waitFor({ state: "detached" });
	assert.equal((await snapshot()).settings.multiAgent.executors.kimi.effort, "high");
	checks.push("multi-only settings save and reopen all controller and executor fields and prompt before discarding a draft");

	await selectValue(selectControl("编排档位"), "multi");
	const multiBadge = page.locator(".cc-dock-header .cc-multi-badge").filter({ hasText: /^multi$/ });
	await multiBadge.waitFor();
	if (workspaceScreenshots) await page.locator(".cl-composer-box").screenshot({ path: join(workspaceScreenshots, "multi-tier.png"), scale: "css", animations: "disabled" });
	await submit("/ultracode off");
	await page.getByText("ultracode 档位当前未开启。", { exact: true }).waitFor();
	assert.equal((await snapshot()).active.codingTier, "multi");
	await submit("验证 multi 主控");
	await page.getByText("本地主控验证 multi/desktop-demo-2/high", { exact: true }).waitFor();
	await idle();
	const afterMulti = await snapshot();
	assert.equal(afterMulti.state?.model?.id, "desktop-demo-1");
	assert.equal(afterMulti.state?.thinkingLevel, "low");
	await submit("验证 multi 主控 ultracode");
	await page.getByText("本地主控验证 ultracode/desktop-demo-1/low", { exact: true }).waitFor();
	await idle();
	await multiBadge.waitFor();
	await submit("/multi off");
	await multiBadge.waitFor({ state: "detached" });
	await submit("验证 multi 主控关闭");
	await page.getByText("本地主控验证 standard/desktop-demo-1/low", { exact: true }).waitFor();
	await idle();
	checks.push("multi tier selector, independent slash toggle, local controller model and effort, and baseline routing outside multi turns");

	await openMultiSettings();
	await selectValue(controllerModel, "");
	await selectValue(controllerThinking, "");
	for (const [name] of executorModels) await multiDialog.getByLabel(`${name} 模型`, { exact: true }).fill("");
	await selectValue(selectControl("Codex 思考强度"), "");
	await selectValue(selectControl("Claude Code 思考强度"), "");
	await kimiThinking.fill("");
	await saveMultiSettings();
	assert.equal((await snapshot()).settings.multiAgent, undefined);
	checks.push("restoring all multi settings to defaults clears the persisted overrides");

	await openMultiSettings();
	await multiDialog.getByRole("button", { name: "应用极致", exact: true }).click();
	await until(async () => (await snapshot()).settings.multiProfiles?.active === "极致", "applying a discovered profile");
	assert.ok((await snapshot()).settings.multiAgent.implementation);
	await multiDialog.getByRole("button", { name: "基于此方案编辑" }).last().click();
	await multiDialog.getByLabel("方案名称", { exact: true }).fill("本地开发");
	await multiDialog.getByLabel("默认实现执行器").selectOption("kimi");
	await multiDialog.getByLabel("Kimi Code 模型", { exact: true }).fill("kimi-k3");
	await multiDialog.getByRole("button", { name: "另存方案", exact: true }).click();
	await until(async () => (await snapshot()).settings.multiProfiles.saved.some(p => p.name === "本地开发"), "saving a named custom profile");
	await multiDialog.getByRole("button", { name: "应用已保存方案" }).click();
	await until(async () => (await snapshot()).settings.multiProfiles.active === "本地开发", "switching to the named profile");
	assert.equal((await snapshot()).settings.multiAgent.executors.kimi.model, "kimi-k3");
	await multiDialog.getByRole("button", { name: "撤销切换" }).click();
	await until(async () => (await snapshot()).settings.multiProfiles.active === "极致", "undoing a profile change");
	await page.keyboard.press("Escape");
	await multiDialog.waitFor({ state: "detached" });
	checks.push("native model discovery, one-click recommended profiles, custom roles and saved profile switching with undo");


	await page.evaluate(
		(proj) => window.pi.permissions.upsert({ id: "e2e-allow-wf", scope: "project", project: proj, action: "allow", tool: "WorkflowRun" }),
		originalSession.project,
	);
	await submit("工作流进度树验证");
	const wfTree = page.locator(".cc-wf-tree").last();
	await wfTree.locator(".cc-wf-title").filter({ hasText: "三段式审查" }).waitFor();
	await wfTree.locator(".cc-wf-metrics").filter({ hasText: /完成 · 3 个 Agent/ }).waitFor({ timeout: 60000 });
	await idle();
	// A finished run collapses to its summary line; expand it to read the tree.
	assert.equal(await wfTree.getByText("开始分阶段审查", { exact: true }).count(), 0);
	await wfTree.locator(".cc-wf-head").click();
	await wfTree.getByText("开始分阶段审查", { exact: true }).waitFor();
	const phaseGroup = wfTree.locator(".cc-wf-group").filter({ hasText: "审查" }).first();
	assert.equal(await phaseGroup.locator(".cc-wf-step").count(), 2, "both parallel steps sit under their phase");
	await wfTree.locator(".cc-wf-step").filter({ hasText: "汇总结论" }).waitFor();
	assert.match(await wfTree.locator(".cc-wf-step").first().locator(".cc-wf-step-metrics").textContent(), /tokens · \d+s|\d+s/);
	if (process.env.PI_WORKFLOW_TREE_SCREENSHOT) await wfTree.screenshot({ path: process.env.PI_WORKFLOW_TREE_SCREENSHOT, scale: "css", animations: "disabled" });
	// Workflow steps belong to the run's tree, not the subagent panel.
	assert.equal(await page.locator(".cc-subagent-row").filter({ hasText: "审查 csv" }).count(), 0);
	await page.evaluate(() => window.pi.permissions.remove("e2e-allow-wf"));
	checks.push("a model-started workflow renders a live phase tree at its tool call and keeps its steps out of the subagent panel");

	checks.push(...await verifyWorkspaceNavigation({ page, root, agentDir, cliFixtures, ready, workspaceScreenshots }));
	checks.push(await verifyCommitDraft(executable));
	if (process.platform === "darwin") checks.push(await verifyWerewolf(executable, workspaceScreenshots ? join(workspaceScreenshots, "werewolf-evidence.png") : undefined));

	assert.deepEqual(pageErrors, []);
	if (capture)
		for (const name of ["client-light.png", "client-dark.png"])
			assert.ok((await stat(join(repo, "docs/screenshots", name))).size < 1024 * 1024);
	console.log(JSON.stringify({ passed: checks, screenshots: capture ? "docs/screenshots" : undefined, contestScreenshots, workspaceScreenshots }, null, 2));
	if (process.argv.includes("--inspect") && process.stdin.isTTY) {
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
		console.log("Packaged client ready for manual inspection. Press Enter to close it.");
		process.stdin.resume();
		await new Promise((resolve) => process.stdin.once("data", resolve));
		process.stdin.pause();
	}
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
