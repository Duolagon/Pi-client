import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableFlag = process.argv.indexOf("--executable");
const executable = executableFlag < 0
	? join(repo, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Desktop.app/Contents/MacOS/Pi Desktop")
	: resolve(process.argv[executableFlag + 1]);
const screenshots = process.argv.includes("--screenshots") ? join(repo, "artifacts", "engine-verification") : undefined;
await access(executable);
const root = await mkdtemp(join(tmpdir(), "pi-engine-check-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const exec = promisify(execFile);

async function waitFor(read, label, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = await read();
		if (result) return result;
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function prepareProject() {
	for (const name of ["alpha", "beta"]) {
		const directory = join(project, "packages", name);
		const uppercase = name.toUpperCase();
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "feature.mjs"), 'export const value = "initial";\n');
		await writeFile(join(directory, "feature.test.mjs"), [
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'import { value } from "./feature.mjs";',
			`test("${name} exports its package value", () => {`,
			"  for (let index = 0; index < 176; index++) {",
			`    const label = index === 80 ? "${uppercase}_LOG_MIDDLE" : "${uppercase}_TRACE_ROW";`,
			'    console.log(label + " " + String(index).padStart(3, "0") + " " + "x".repeat(64));',
			"  }",
			`  assert.equal(value, "${uppercase}");`,
			"});",
			"",
		].join("\n"));
	}
	await writeFile(join(project, "packages/alpha/AGENTS.md"), "E2E_ALPHA_RULE\nKeep the Alpha export uppercase. Run its package test.\n");
	const rules = join(project, "packages/beta/.claude/rules");
	await mkdir(rules, { recursive: true });
	await writeFile(join(rules, "module.md"), "---\npaths:\n  - feature.mjs\n---\nE2E_BETA_RULE\nKeep the Beta export uppercase. Run its package test.\n");
	await writeFile(join(project, "lint.mjs"), [
		'import assert from "node:assert/strict";',
		'import { readFileSync } from "node:fs";',
		'for (const name of ["alpha", "beta"]) {',
		'  const source = readFileSync(`packages/${name}/feature.mjs`, "utf8");',
		'  assert.doesNotMatch(source, /[ \\t]+$/m, `Trailing whitespace in ${name}`);',
		'}',
		'console.log("Both modules passed the whitespace check.");',
		"",
	].join("\n"));
	await writeFile(join(project, "package.json"), JSON.stringify({
		name: "engine-enhancements-fixture",
		private: true,
		scripts: {
			test: "node --test packages/alpha/feature.test.mjs packages/beta/feature.test.mjs",
			check: "node --check packages/alpha/feature.mjs && node --check packages/beta/feature.mjs",
			lint: "node lint.mjs",
		},
	}));
	await exec("git", ["init", "-q", "--initial-branch=main", project], { env: gitEnv });
	await exec("git", ["add", "."], { cwd: project, env: gitEnv });
	await exec("git", ["-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid",
		"-c", "commit.gpgSign=false", "commit", "-qm", "test: Seed two packages"], { cwd: project, env: gitEnv });
}

let application;
let page;
try {
	await prepareProject();
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	for (const file of ["engine-enhancements-provider.js", "grail-provider.js"])
		await cp(join(repo, "test", "fixtures", file), join(agentDir, "extensions", file));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "engine-check", defaultModel: "engine-check-1", retry: { enabled: false }, compaction: { enabled: false },
	}));

	const reviewLog = join(root, "review.jsonl");
	const shell = join(root, "fixture-shell");
	await writeFile(shell, `#!/bin/sh
if [ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ]; then
	exec /bin/sh -c "$4"
fi
exec /bin/sh "$@"
`, { mode: 0o755 });
	const env = {
		...process.env, HOME: root, SHELL: shell, ELECTRON_RUN_AS_NODE: undefined,
		PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_DATA_DIR: join(root, "desktop"), PI_DESKTOP_WORKSPACE: project,
		PI_OFFLINE: "1", GRAIL_TEST_LOG: reviewLog,
	};
	for (const key of Object.keys(env)) {
		if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS|^LANGFUSE_)/.test(key))
			delete env[key];
	}
	application = await electron.launch({
		executablePath: executable, args: process.platform === "darwin" ? ["--use-mock-keychain"] : [], env,
	});
	page = await application.firstWindow();
	page.setDefaultTimeout(20000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const snapshot = () => page.evaluate(() => window.pi.snapshot());
	const ready = () => waitFor(async () => {
		const state = await snapshot();
		return state.engineStatus === "ready" && state.state?.model?.provider === "engine-check" && state;
	}, "local model ready");
	const initial = await ready();
	await page.evaluate((path) => window.pi.setProjectTrust({ project: path, decision: "trusted" }), initial.active.project);
	await ready();
	await page.evaluate(() => window.pi.saveSettings({
		permission: "ask", theme: "light", grailModel: { provider: "grail-test", id: "grail-judge-1" },
	}));
	const mode = page.getByRole("combobox", { name: "权限模式", exact: true });
	await mode.click();
	await page.getByRole("listbox").locator('[role="option"][value="auto"]').click();
	await page.getByRole("button", { name: "启用全部放行", exact: true }).click();
	await waitFor(async () => (await snapshot()).active?.permissionMode === "auto", "the fixture conversation's permission mode");

	await page.getByRole("textbox", { name: "输入任务", exact: true }).fill("修复 Alpha 和 Beta 两个模块的导出值，按各自目录规则运行测试。完成后需要复核。");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	const outcome = page.getByText(/两个子目录已修复，已从完整日志找回 Beta 诊断，可以复核。|链路失败：/).last();
	await outcome.waitFor({ timeout: 45000 });
	assert.equal(await outcome.innerText(), "两个子目录已修复，已从完整日志找回 Beta 诊断，可以复核。");
	await waitFor(async () => !(await snapshot()).state?.isStreaming, "agent idle");
	assert.equal(await readFile(join(project, "packages/alpha/feature.mjs"), "utf8"), 'export const value = "ALPHA";\n');
	assert.equal(await readFile(join(project, "packages/beta/feature.mjs"), "utf8"), 'export const value = "BETA";\n');

	const failedGroup = page.locator(".cc-tool-group-head").filter({ hasText: "有失败步骤" });
	if ((await failedGroup.getAttribute("aria-expanded")) === "false") await failedGroup.click();
	const failedTest = page.locator(".cl-tool.error").filter({ hasText: "node --test packages/beta/feature.test.mjs" });
	const failedTestRow = failedTest.locator(".cc-tool-row").first();
	if ((await failedTestRow.getAttribute("aria-expanded")) === "false") await failedTestRow.click();
	await failedTest.getByRole("button", { name: "查看完整输出", exact: true }).click();
	const original = failedTest.locator('pre[aria-label="工具原文"]').filter({ hasText: "BETA_LOG_MIDDLE" });
	await original.waitFor();
	await original.scrollIntoViewIfNeeded();
	if (screenshots) {
		await mkdir(screenshots, { recursive: true });
		await page.screenshot({ path: join(screenshots, "tool-output.png"), scale: "css" });
	}

	const review = page.getByRole("button", { name: "质量鉴定", exact: true });
	await review.click();
	const verdict = await waitFor(async () => {
		const state = await page.evaluate((id) => window.pi.grail.state(id), initial.active.id);
		return state.verdicts.at(-1);
	}, "persisted Grail verdict", 45000);
	assert.equal(verdict.grade, "grail", JSON.stringify(verdict.reasons));
	assert.equal(verdict.steps.objective.status, "pass");
	const testRun = verdict.steps.objective.runs.find((run) => run.name === "test");
	assert.equal(testRun.testCount, 2);
	assert.ok(testRun.outputBytes > 24 * 1024);
	assert.deepEqual(verdict.steps.objective.checks.map(({ name, status }) => [name, status]), [
		["test", "pass"], ["check", "pass"], ["lint", "pass"],
	]);
	assert.match(verdict.evidence.source.testedTree, /^[a-f0-9]{40,64}$/);
	assert.notEqual(verdict.evidence.source.testedTree, verdict.evidence.source.baselineTree);
	assert.deepEqual(verdict.files.map((file) => file.path).sort(), ["packages/alpha/feature.mjs", "packages/beta/feature.mjs"]);
	assert.deepEqual([...new Set(verdict.steps.comparison.findings.flatMap((finding) => finding.citations.map((cite) => cite.file)))].sort(),
		["packages/alpha/feature.mjs", "packages/beta/feature.mjs"]);
	const reviews = (await readFile(reviewLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(reviews.map((entry) => entry.step), ["blind", "comparison"]);
	assert.notEqual(reviews[0].cwd, reviews[1].cwd);
	assert.notEqual(reviews[1].cwd, project);
	assert.match(reviews[1].prompt, /\+ 1 \| export const value = "ALPHA";/);
	assert.match(reviews[1].prompt, /\+ 1 \| export const value = "BETA";/);

	await page.reload();
	await ready();
	await page.getByRole("button", { name: "优秀", exact: true }).click();
	const report = page.getByRole("dialog", { name: "质量鉴定报告", exact: true });
	await report.getByRole("heading", { name: "客观检查", exact: true }).waitFor();
	await report.getByText("查看鉴定快照", { exact: true }).click();
	const testedTree = report.locator("dt:has-text('客观检查源码') + dd");
	assert.equal(await testedTree.innerText(), verdict.evidence.source.testedTree);
	const testResult = report.locator("li").filter({ hasText: "npm run test" }).first();
	await testResult.getByText("查看命令输出", { exact: true }).click();
	const reviewOutput = testResult.locator('pre[aria-label="命令输出"]').filter({ hasText: "BETA_LOG_MIDDLE" });
	await reviewOutput.waitFor();
	await reviewOutput.scrollIntoViewIfNeeded();
	assert.match(await testResult.innerText(), /退出码 0/);
	assert.deepEqual(pageErrors, []);
	if (screenshots) {
		await mkdir(screenshots, { recursive: true });
		await page.screenshot({ path: join(screenshots, "review.png"), scale: "css" });
	}
	console.log(JSON.stringify({
		passed: "nested rules, long-log recovery, repaired tests, and independent review",
		testCount: testRun.testCount,
		reviewLogBytes: testRun.outputBytes,
		checks: verdict.steps.objective.checks,
		screenshots,
	}, null, 2));
	if (process.argv.includes("--inspect") && process.stdin.isTTY) {
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
		console.log("Quality report is open. Press Enter to close the isolated test app.");
		process.stdin.resume();
		await new Promise((resolve) => process.stdin.once("data", resolve));
		process.stdin.pause();
	}
} catch (error) {
	const artifacts = join(repo, "artifacts", "engine-verification");
	await mkdir(artifacts, { recursive: true });
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	throw error;
} finally {
	await application?.close();
	await rm(root, { recursive: true, force: true });
}
