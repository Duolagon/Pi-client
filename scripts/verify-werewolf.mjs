import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { createModelEndpoint } from "../test/fixtures/model-endpoint.ts";

async function waitFor(predicate, description) {
	const deadline = Date.now() + 25000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

export async function verifyWerewolf(executable, screenshot, inspect = false) {
	await access(executable);
	const fixture = await mkdtemp(join(tmpdir(), "pi-ui-werewolf-"));
	const project = join(fixture, "project");
	const agentDir = join(fixture, "agent");
	const oldMessage = "PRIVATE_PREVIOUS_TURN_WEREWOLF_SMOKE";
	const testedRequirement = "核验 math.mjs 中 price(2) 返回的实际值。";
	const missingRequirement = "确认商品币种。";
	const requirement = `请${testedRequirement}${missingRequirement}`;
	const falseReply = "price(2) 返回 2。";
	const plannerMarker = "你是独立的编码验收工程师";
	const probePlan = JSON.stringify({
		claims: [{ quote: falseReply, requirement: testedRequirement, description: "核验 price(2) 的返回值", probe: {
			kind: "behavior", op: "equal",
			left: { call: { module: "math.mjs", exportName: "price", args: [{ literal: 2 }] } },
			right: { literal: 2 },
		} }, { requirement: missingRequirement, description: "商品币种没有核验记录" }],
	});
	let releaseReview;
	const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
	let endpoint;
	let application;
	let page;
	let conversationId;
	try {
		endpoint = await createModelEndpoint(async ({ body }) => {
			const prompt = JSON.stringify(body.messages ?? []);
			if (prompt.includes(plannerMarker)) {
				await reviewGate;
				return probePlan;
			}
			return prompt.includes(requirement) ? falseReply : "旧轮已记录。";
		});
		await mkdir(project, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(project, "math.mjs"), "export function price(x) { return x + 1; }\n");
		const exec = promisify(execFile);
		const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		const git = (...args) => exec("git", args, { cwd: project, env: gitEnv });
		await git("init", "--initial-branch=main");
		await git("add", "math.mjs");
		await git("-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "test: Prepare Werewolf fixture");

		const env = {
			...gitEnv, HOME: fixture, ELECTRON_RUN_AS_NODE: undefined, PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_DATA_DIR: join(fixture, "desktop"), PI_DESKTOP_WORKSPACE: project,
		};
		for (const name of Object.keys(env)) {
			if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS|PI_DESKTOP_KEY|PI_DESKTOP_CONNECTIONS|^LANGFUSE_)/.test(name)) delete env[name];
		}
		application = await electron.launch({
			executablePath: executable, env, args: process.platform === "darwin" ? ["--use-mock-keychain"] : [], timeout: 30000,
		});
		page = await application.firstWindow();
		page.setDefaultTimeout(25000);
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		conversationId = await page.evaluate(async (baseUrl) => {
			const initial = await window.pi.snapshot();
			await window.pi.setProjectTrust({ project: initial.active.project, decision: "trusted" });
			const configured = await window.pi.saveSettings({
				permission: "ask", theme: "light", provider: "openai", mode: "custom", api: "openai-completions", apiKey: "werewolf-fixture-only", modelId: "gpt-4o-mini", baseUrl, useAsDefault: true,
			});
			return configured.active.id;
		}, `${endpoint.baseUrl}/v1`);
		await page.reload();
		await waitFor(() => page.evaluate(async () => {
			const snapshot = await window.pi.snapshot();
			return snapshot.engineStatus === "ready" && snapshot.state?.model?.id === "gpt-4o-mini";
		}), "the loopback model");
		await page.evaluate(() => {
			globalThis.__werewolfSmokeEvents = [];
			window.pi.werewolf.onEvent((state) => globalThis.__werewolfSmokeEvents.push(state.reviews.map((review) => review.status)));
		});
		const submit = async (text) => {
			await page.getByRole("textbox", { name: "输入任务", exact: true }).fill(text);
			await page.getByRole("button", { name: "发送任务", exact: true }).click();
		};
		assert.equal((await page.evaluate((id) => window.pi.werewolf.state(id), conversationId)).enabled, false);
		await submit(oldMessage);
		await page.locator("article.cl-msg-ai").getByText("旧轮已记录。", { exact: true }).waitFor();
		await waitFor(() => page.evaluate(async () => !(await window.pi.snapshot()).state?.isStreaming), "the unsupervised reply to finish");
		await page.getByRole("button", { name: "更多工具", exact: true }).click();
		await page.getByRole("menuitem", { name: "启用狼人核验", exact: true }).click();
		await waitFor(() => page.evaluate(async (id) => (await window.pi.werewolf.state(id)).enabled, conversationId), "werewolf opt-in");
		await submit(requirement);
		const currentReply = page.locator("article.cl-msg-ai").filter({ hasText: falseReply });
		await currentReply.getByRole("button", { name: "核验中", exact: true }).waitFor();
		releaseReview();
		await waitFor(() => page.evaluate(async (id) => (await window.pi.werewolf.state(id)).reviews.some((review) => review.status !== "pending"), conversationId), "the werewolf result");
		const verdict = currentReply.getByRole("button", { name: /狼人 · 与证据矛盾/ });
		await verdict.click();
		const dialog = page.getByRole("dialog", { name: "狼人核验", exact: true });
		await dialog.getByText(falseReply, { exact: true }).waitFor();
		await dialog.getByText("幻觉率", { exact: true }).waitFor();
		await dialog.getByText("声明核验覆盖率", { exact: true }).waitFor();
		await dialog.getByText("复现", { exact: true }).waitFor();
		assert.equal(await dialog.getByText("100%（1/1）", { exact: true }).count(), 2);
		assert.ok((await dialog.innerText()).includes("验收要求"));
		await dialog.getByText(missingRequirement, { exact: true }).waitFor();
		await dialog.getByRole("button", { name: "重放证据", exact: true }).click();
		await dialog.getByText("重放结果 · 断言未通过", { exact: true }).waitFor();
		if (screenshot) await page.screenshot({ path: screenshot, scale: "css" });
		const planner = endpoint.requests.filter(({ body }) => JSON.stringify(body.messages).includes(plannerMarker));
		assert.equal(planner.length, 1);
		const plannerPrompt = JSON.stringify(planner[0].body.messages);
		assert.match(plannerPrompt, /price/);
		assert.ok(!plannerPrompt.includes(oldMessage), "The independent planner must not inherit the previous turn.");

		await page.reload();
		await verdict.waitFor();
		assert.equal(await page.locator("article.cl-msg-ai").filter({ hasText: "旧轮已记录。" }).getByRole("button", { name: /狼人/ }).count(), 0);
		assert.deepEqual(pageErrors, []);
		if (inspect && process.stdin.isTTY) {
			await verdict.click();
			await dialog.getByText(falseReply, { exact: true }).waitFor();
			await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
			console.log("Werewolf report is open for manual inspection. Press Enter to close the isolated test app.");
			process.stdin.resume();
			await new Promise((resolve) => process.stdin.once("data", resolve));
			process.stdin.pause();
		}
		return "werewolf opt-in, independent evidence probe, report and reload on the originating assistant reply";
	} catch (cause) {
		const footers = await page?.locator(".cl-ai-meta").allTextContents().catch(() => []);
		const reviewStates = await page?.evaluate(async (id) => ({
			events: globalThis.__werewolfSmokeEvents,
			reviews: id ? (await window.pi.werewolf.state(id)).reviews.map(({ replyEntryId, replyTimestamp, status, error }) => ({ replyEntryId, replyTimestamp, status, error })) : [],
		}), conversationId).catch(() => undefined);
		throw new Error(`Werewolf packaged smoke failed. Footers ${JSON.stringify(footers)}; review states ${JSON.stringify(reviewStates)}.`, { cause });
	} finally {
		releaseReview();
		try { await application?.close(); }
		finally {
			await endpoint?.close();
			await rm(fixture, { recursive: true, force: true });
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const flag = process.argv.indexOf("--executable");
	const executable = flag < 0
		? join(repo, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Desktop.app/Contents/MacOS/Pi Desktop")
		: resolve(process.argv[flag + 1]);
	const screenshotFlag = process.argv.indexOf("--screenshot");
	const screenshot = screenshotFlag < 0 ? undefined : resolve(process.argv[screenshotFlag + 1]);
	console.log(await verifyWerewolf(executable, screenshot, process.argv.includes("--inspect")));
}
