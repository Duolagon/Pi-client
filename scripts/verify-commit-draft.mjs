import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

export async function verifyCommitDraft(executable) {
	await access(executable);

	const fixture = await mkdtemp(join(tmpdir(), "pi-ui-commit-draft-"));
	const repository = join(fixture, "repository");
	const project = join(repository, "workspace");
	const agentDir = join(fixture, "agent");
	const probe = join(fixture, "model-request.json");
	const release = join(fixture, "release-model-reply");
	const exec = promisify(execFile);
	const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const git = (...args) => exec("git", args, { cwd: repository, env: gitEnv }).then(({ stdout }) => stdout.trim());
	const fixtureProvider = "desktop-commit-test";

	async function waitForModelRequest() {
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			if (await access(probe).then(() => true, () => false)) return;
			await delay(25);
		}
		throw new Error("The local fixture model did not receive a commit draft request");
	}

	let application;
	try {
		await mkdir(project, { recursive: true });
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: fixtureProvider, defaultModel: "commit-fixture", thinkingLevel: "off",
			retry: { enabled: false }, compaction: { enabled: false },
		}));
		await writeFile(join(agentDir, "extensions", "commit-fixture.js"), `
	import { access, rename, writeFile } from "node:fs/promises";
	import { setTimeout as delay } from "node:timers/promises";
	import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
	const provider = ${JSON.stringify(fixtureProvider)};
	const api = "desktop-commit-test-api";
	const faux = fauxProvider({ provider, api, models: [{ id: "commit-fixture" }], tokensPerSecond: 1000 });
	export default function (pi) {
		pi.registerProvider(provider, {
			api, apiKey: "fixture-only", baseUrl: "http://127.0.0.1:0", models: faux.models,
			streamSimple(model, context, options) {
				faux.setResponses([async () => {
					const probe = process.env.PI_FIXTURE_COMMIT_PROBE;
					await writeFile(probe + ".tmp", JSON.stringify(context.messages));
					await rename(probe + ".tmp", probe);
					const deadline = Date.now() + 12000;
					while (Date.now() < deadline) {
						if (await access(process.env.PI_FIXTURE_COMMIT_REPLY).then(() => true, () => false))
							return fauxAssistantMessage("fix: 模型返回的说明");
						await delay(25);
					}
					throw new Error("The test did not release the local model");
				}]);
				return faux.provider.streamSimple(model, context, options);
			},
		});
	}
	`);
		await writeFile(join(project, "change.txt"), "base workspace\n");
		await writeFile(join(repository, "sibling.txt"), "base sibling\n");
		await git("init", "--initial-branch=main");
		await git("config", "user.name", "Desktop Test");
		await git("config", "user.email", "desktop@example.invalid");
		await git("config", "commit.gpgSign", "false");
		await git("add", "--", "workspace/change.txt", "sibling.txt");
		await git("commit", "-m", "test: Prepare commit draft fixture");
		const originalHead = await git("rev-parse", "HEAD");
		await writeFile(join(project, "change.txt"), "STAGED_WORKSPACE_FIXTURE\n");
		await writeFile(join(repository, "sibling.txt"), "STAGED_SIBLING_FIXTURE\n");
		await git("add", "--", "workspace/change.txt", "sibling.txt");
		await writeFile(join(project, "change.txt"), "UNSTAGED_WORKSPACE_FIXTURE\n");

		const env = {
			...gitEnv, HOME: fixture, ELECTRON_RUN_AS_NODE: undefined,
			PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_DATA_DIR: join(fixture, "desktop"),
			PI_DESKTOP_WORKSPACE: project, PI_FIXTURE_COMMIT_PROBE: probe, PI_FIXTURE_COMMIT_REPLY: release,
		};
		for (const name of Object.keys(env)) {
			if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS|^LANGFUSE_)/.test(name))
				delete env[name];
		}
		application = await electron.launch({
			executablePath: executable, env, args: process.platform === "darwin" ? ["--use-mock-keychain"] : [], timeout: 30000,
		});
		const page = await application.firstWindow();
		page.setDefaultTimeout(15000);
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.waitForFunction(async (provider) => {
			const snapshot = await window.pi.snapshot();
			return snapshot.engineStatus === "ready" && snapshot.state?.model?.provider === provider;
		}, fixtureProvider);
		await page.getByRole("button", { name: "代码修改", exact: true }).click();
		const gitPanel = page.locator(".workspace-review-git");
		await gitPanel.locator("summary").click();
		await page.getByRole("button", { name: "取消暂存 change.txt", exact: true }).waitFor();

		const draft = gitPanel.getByRole("button", { name: "拟定说明", exact: true });
		const input = gitPanel.getByRole("textbox", { name: "Git 提交说明", exact: true });
		const submit = gitPanel.getByRole("button", { name: "提交", exact: true });
		const scopeError = page.getByRole("alert").filter({ hasText: "仓库其他目录还有已暂存修改" });
		const expectScopeError = async (alert) => {
			try { await alert.waitFor(); }
			catch (cause) {
				const alerts = await page.getByRole("alert").allTextContents();
				throw new Error(`Expected the Git scope guard. Visible alerts: ${JSON.stringify(alerts)}`, { cause });
			}
		};
		await draft.click();
		await expectScopeError(scopeError);
		await scopeError.evaluate((element) => element.setAttribute("data-fixture-seen", "true"));
		await assert.rejects(access(probe), { code: "ENOENT" });
		await input.fill("fix: 不应提交隐藏文件");
		await submit.click();
		await expectScopeError(scopeError.and(page.locator(":not([data-fixture-seen])")));
		assert.equal(await git("rev-parse", "HEAD"), originalHead);
		assert.equal(await git("diff", "--cached", "--name-only"), "sibling.txt\nworkspace/change.txt");

		await git("reset", "-q", "HEAD", "--", "sibling.txt");
		await input.fill("");
		await draft.click();
		await waitForModelRequest();
		const generating = gitPanel.getByRole("button", { name: "生成中…", exact: true });
		await generating.waitFor();
		const request = await readFile(probe, "utf8");
		assert.match(request, /STAGED_WORKSPACE_FIXTURE/);
		assert.doesNotMatch(request, /UNSTAGED_WORKSPACE_FIXTURE|STAGED_SIBLING_FIXTURE/);
		const manualSubject = "fix: 保留我手写的说明";
		await input.fill(manualSubject);
		await writeFile(release, "");
		await generating.waitFor({ state: "hidden" });
		assert.equal(await input.inputValue(), manualSubject);
		await submit.click();
		await page.getByText(/^已提交 [a-f0-9]+$/).waitFor();
		assert.equal(await git("log", "-1", "--format=%s"), manualSubject);
		assert.equal(await git("show", "HEAD:workspace/change.txt"), "STAGED_WORKSPACE_FIXTURE");
		assert.equal(await readFile(join(project, "change.txt"), "utf8"), "UNSTAGED_WORKSPACE_FIXTURE\n");
		assert.equal(await git("show", "HEAD:sibling.txt"), "base sibling");
		assert.equal(await readFile(join(repository, "sibling.txt"), "utf8"), "STAGED_SIBLING_FIXTURE\n");
		assert.deepEqual(pageErrors, []);
		return "workspace commit draft and commit scope, partial staging, and manual text during a late model reply";
	} finally {
		try { await application?.close(); }
		finally { await rm(fixture, { recursive: true, force: true }); }
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const executableIndex = process.argv.indexOf("--executable");
	const executable = executableIndex < 0
		? join(appRoot, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Desktop.app/Contents/MacOS/Pi Desktop")
		: resolve(process.argv[executableIndex + 1]);
	console.log(await verifyCommitDraft(executable));
}
