import assert from "node:assert/strict";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function makeProjects(root) {
	const first = join(root, "workspace-navigation-first");
	const other = join(root, "workspace-navigation-other");
	const nested = join(first, "src/ui/deep");
	await Promise.all([mkdir(nested, { recursive: true }), mkdir(other)]);
	await Promise.all([
		writeFile(join(first, "src/ui/nav-first.ts"), "export const firstWorkspaceNavigationFile = 1;\n"),
		writeFile(join(first, "src/ui/nav-second.ts"), "export const secondWorkspaceNavigationFile = 2;\n"),
		writeFile(join(first, "src/ui/navigation-shared.md"), "Current directory result.\n"),
		writeFile(join(nested, "navigation-shared.md"), "Selected nested navigation result.\n"),
		writeFile(join(other, "nav-other.md"), "Only in the second workspace.\n"),
		...Array.from({ length: 36 }, async (_, i) => {
			const dir = join(first, `package-${String(i).padStart(2, "0")}`);
			await mkdir(dir);
			await writeFile(join(dir, "navigation-shared.md"), "Shallower result outside the current directory.\n");
		}),
	]);
	return Promise.all([realpath(first), realpath(other)]);
}

async function whileDebouncePaused(page, duration, operation) {
	// Holding only the search debounce proves the old result is unavailable before
	// the new response, even on a slower CI machine.
	const restore = await page.evaluateHandle((duration) => {
		const previous = window.setTimeout;
		const timers = [];
		window.setTimeout = function (handler, wait, ...args) {
			if (wait !== duration) return previous.call(this, handler, wait, ...args);
			const timer = previous.call(this, handler, 60_000, ...args);
			timers.push(timer);
			return timer;
		};
		return () => {
			window.setTimeout = previous;
			timers.forEach((id) => window.clearTimeout(id));
		};
	}, duration);
	try {
		await operation();
	} finally {
		await restore.evaluate((restore) => restore());
		await restore.dispose();
	}
}

async function selectWorkspace(page, path) {
	await page.getByRole("button", { name: "切换工作目录", exact: true }).click();
	await page.getByRole("menu", { name: "工作目录列表" }).getByRole("menuitemradio")
		.filter({ hasText: path.split("/").at(-1) }).click();
	await page.waitForFunction(async (path) => (await window.pi.snapshot()).active?.project === path, path);
}

async function commandPalette(page) {
	await page.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
	const dialog = page.getByRole("dialog", { name: "命令面板 (⌘P)", exact: true });
	await dialog.waitFor();
	return dialog;
}

async function openFromPalette(page, name) {
	const dialog = await commandPalette(page);
	const query = dialog.getByRole("combobox", { name: "搜索客户端命令" });
	await query.fill(name);
	const option = dialog.getByRole("option").filter({ hasText: `打开文件：${name}` });
	await option.click();
	await dialog.waitFor({ state: "detached" });
}

async function verifyFiles(page, first, other, screenshots) {
	const workspace = page.getByRole("complementary", { name: "真实项目工作区" });
	const tree = workspace.getByRole("tree", { name: "项目文件树" });
	const filesButton = page.getByRole("button", { name: "项目文件", exact: true });
	const closePanel = workspace.getByRole("button", { name: "关闭工作区面板", exact: true });
	const back = workspace.getByRole("button", { name: "返回", exact: true });
	const preview = workspace.locator(".live-file-content");
	const dialog = await commandPalette(page);
	const query = dialog.getByRole("combobox", { name: "搜索客户端命令" });
	await query.fill("nav-first.ts");
	const oldHit = dialog.getByRole("option").filter({ hasText: "打开文件：nav-first.ts" });
	await oldHit.waitFor();
	await whileDebouncePaused(page, 60, async () => {
		await query.fill("workspace-nav-no-such-file");
		await oldHit.waitFor({ state: "detached" });
		await dialog.getByText("正在搜索文件…", { exact: true }).waitFor();
		await query.press("Enter");
		assert.equal(await dialog.count(), 1, "Enter cannot open an old file during a new search");
	});
	await query.fill("nav-first.ts");
	await oldHit.click();
	await preview.getByText(/firstWorkspaceNavigationFile/).waitFor();
	await workspace.getByRole("tab", { name: "改动", exact: true }).click();
	await openFromPalette(page, "nav-second.ts");
	await preview.getByText(/secondWorkspaceNavigationFile/).waitFor();
	await openFromPalette(page, "nav-first.ts");
	await preview.getByText(/firstWorkspaceNavigationFile/).waitFor();

	await back.click();
	const selected = tree.getByRole("treeitem", { name: "nav-first.ts", exact: true });
	await selected.waitFor();
	assert.equal(await selected.getAttribute("aria-current"), "page");
	await workspace.getByRole("button", { name: "上一级", exact: true }).click();
	await workspace.getByRole("button", { name: "上一级", exact: true }).click();
	const src = tree.getByRole("treeitem", { name: "src", exact: true });
	await src.press("ArrowRight");
	const ui = tree.getByRole("treeitem", { name: "ui", exact: true });
	await ui.waitFor();
	assert.equal(await src.getAttribute("aria-expanded"), "true");
	await src.press("ArrowRight");
	assert.equal(await ui.evaluate((item) => item === document.activeElement), true);
	await ui.press("ArrowLeft");
	assert.equal(await src.evaluate((item) => item === document.activeElement), true);
	await ui.press("Shift+Enter");
	await workspace.locator(".file-preview-heading").getByText("src/ui", { exact: true }).waitFor();

	const filter = workspace.getByRole("searchbox", { name: "过滤项目文件" });
	const local = workspace.getByRole("button", { name: "src/ui/navigation-shared.md", exact: true });
	const deep = workspace.getByRole("button", { name: "src/ui/deep/navigation-shared.md", exact: true });
	await filter.fill("navigation-shared.md");
	await deep.waitFor();
	assert.deepEqual((await workspace.locator(".file-tree button").allTextContents()).slice(0, 2), [
		"src/ui/navigation-shared.md", "src/ui/deep/navigation-shared.md",
	]);
	await whileDebouncePaused(page, 70, async () => {
		await filter.fill("workspace-filter-no-such-file");
		await workspace.getByText("正在搜索文件…", { exact: true }).waitFor();
		assert.equal(await local.count(), 0, "A new filter clears the old clickable results");
	});
	await filter.fill("navigation-shared.md");
	await deep.click();
	await preview.getByText("Selected nested navigation result.", { exact: true }).waitFor();
	const actions = workspace.getByRole("group", { name: "文件操作", exact: true });
	assert.deepEqual((await actions.getByRole("button").allTextContents()).map((label) => label.trim()), ["复制", "代码分析", "编辑器", "引用"]);
	assert.equal(await actions.evaluate((toolbar) => Array.from(toolbar.querySelectorAll("button")).every((button) =>
		getComputedStyle(button).whiteSpace === "nowrap" &&
		button.getBoundingClientRect().right <= toolbar.getBoundingClientRect().right)), true);
	if (screenshots) await page.screenshot({ path: join(screenshots, "workspace-file-preview.png"), scale: "css", animations: "disabled" });
	await closePanel.click();
	await workspace.waitFor({ state: "detached" });
	await filesButton.click();
	await preview.getByText("Selected nested navigation result.", { exact: true }).waitFor();
	await back.click();
	await workspace.locator(".file-preview-heading").getByText("src/ui/deep", { exact: true }).waitFor();
	assert.equal(await filter.inputValue(), "");
	assert.equal(await tree.getByRole("treeitem", { name: "navigation-shared.md", exact: true }).getAttribute("aria-current"), "page");

	await closePanel.click();
	await selectWorkspace(page, other);
	await filesButton.click();
	await tree.getByRole("treeitem", { name: "nav-other.md", exact: true }).waitFor();
	assert.equal(await preview.count(), 0, "Opening Files in the other project does not replay the palette request");
	await closePanel.click();
	await selectWorkspace(page, first);
}

async function verifyLanguageInspection(page, cliFixtures) {
	const executable = join(cliFixtures, "typescript-language-server");
	const started = join(cliFixtures, "navigation-lsp-started");
	const release = join(cliFixtures, "navigation-lsp-release");
	const oldDiagnostic = "previous workspace file diagnostic";
	const newDiagnostic = "current workspace file diagnostic";
	await writeFile(executable, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const started = ${JSON.stringify(started)};
const release = ${JSON.stringify(release)};
let buffer = Buffer.alloc(0);
function send(packet) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...packet }));
	process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
function receive(packet) {
	if (packet.method === "initialize") {
		send({ id: packet.id, result: { capabilities: { documentSymbolProvider: true } } });
	}
	if (packet.method !== "textDocument/documentSymbol") return;
	const { uri } = packet.params.textDocument;
	const older = uri.endsWith("/nav-first.ts");
	const answer = () => {
		const message = older ? ${JSON.stringify(oldDiagnostic)} : ${JSON.stringify(newDiagnostic)};
		const result = older ? [{ name: "oldInspection", selectionRange: { start: { line: 0, character: 0 } } }] : [];
		send({ id: packet.id, result });
		send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, message, severity: 2 }] } });
	};
	if (!older) {
		answer();
		return;
	}
	writeFileSync(started, "");
	const waiting = setInterval(() => {
		if (!existsSync(release)) return;
		clearInterval(waiting);
		answer();
	}, 20);
	process.stdin.once("end", () => clearInterval(waiting));
}
process.stdin.on("data", (data) => {
	buffer = Buffer.concat([buffer, data]);
	while (buffer.length) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
		const start = end + 4;
		if (buffer.length < start + length) return;
		receive(JSON.parse(buffer.subarray(start, start + length).toString()));
		buffer = buffer.subarray(start + length);
	}
});
`, { mode: 0o755, flag: "wx" });
	let observed;
	try {
		await openFromPalette(page, "nav-first.ts");
		const workspace = page.getByRole("complementary", { name: "真实项目工作区" });
		const analyze = workspace.getByRole("button", { name: "代码分析", exact: true });
		await analyze.click();
		const deadline = Date.now() + 7_000;
		let wasStarted = false;
		while (!wasStarted && Date.now() < deadline) {
			wasStarted = await access(started).then(() => true, () => false);
			if (!wasStarted) await delay(20);
		}
		assert.equal(wasStarted, true, "The language server is holding the first file's response");
		await openFromPalette(page, "nav-second.ts");
		await workspace.locator(".live-file-content").getByText(/secondWorkspaceNavigationFile/).waitFor();
		observed = await page.evaluateHandle(() => {
			let found = false;
			const observer = new MutationObserver(() => {
				found ||= Boolean(document.querySelector(".cc-code-inspector")?.textContent.includes("符号 1"));
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			return { found: () => found, stop: () => observer.disconnect() };
		});
		await writeFile(release, "");
		await analyze.click();
		await workspace.getByRole("button", { name: new RegExp(newDiagnostic) }).waitFor();
		assert.equal(await observed.evaluate((observer) => observer.found()), false);
		await workspace.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
	} finally {
		if (observed) {
			await observed.evaluate((observer) => observer.stop());
			await observed.dispose();
		}
		await writeFile(release, "");
		await rm(executable, { force: true });
	}
}

async function verifyLongTranscript(page, agentDir, project, ready, screenshots) {
	const sessionId = "workspace-navigation-history";
	const historyDir = join(agentDir, "sessions");
	await mkdir(historyDir, { recursive: true });
	const marker = "Historical navigation target with a unique phrase";
	const timestamp = new Date().toISOString();
	const entries = Array.from({ length: 85 }, (_, i) => ({
		type: "message", id: `nav-turn-${i}`, parentId: i ? `nav-turn-${i - 1}` : null, timestamp,
		message: { role: "user", content: i === 8 ? marker : `Historical navigation fixture row ${i + 1}.`, timestamp: Date.parse(timestamp) + i },
	}));
	const file = join(historyDir, `${sessionId}.jsonl`);
	await writeFile(file, [
		{ type: "session", version: 3, id: sessionId, timestamp, cwd: project },
		...entries,
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	try {
		await page.evaluate(async ({ project, sessionId }) => {
			const history = await window.pi.sessions.history({ project });
			const item = history.sessions.find((entry) => entry.sourceSessionId === sessionId);
			if (!item) throw new Error("Could not discover the synthetic long transcript.");
			await window.pi.sessions.importHistory({ token: item.token, activate: true });
		}, { project, sessionId });
		await page.reload();
		await ready();
		await page.emulateMedia({ reducedMotion: "reduce" });
		const scroll = page.locator(".cl-scroll");
		const target = scroll.locator(".cl-msg").filter({ hasText: marker });
		const earlier = scroll.getByRole("button", { name: /^显示更早的.*条对话记录$/ });
		await earlier.waitFor();
		assert.equal(await target.count(), 0, "The fixture marker starts outside the rendered history window");
		await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
		const find = page.getByRole("textbox", { name: "查找会话内容", exact: true });
		await find.fill(marker);
		await find.press("Enter");
		await target.waitFor();
		const inReadingArea = (node) => {
			const viewport = node.closest(".cl-scroll").getBoundingClientRect();
			const item = node.getBoundingClientRect();
			return item.bottom > viewport.top && item.top < viewport.bottom;
		};
		assert.equal(await target.evaluate(inReadingArea), true);
		await find.press("Escape");
		await find.waitFor({ state: "hidden" });
		assert.equal(await target.count(), 1, "Closing Find retains the older selected message");
		assert.equal(await target.evaluate(inReadingArea), true, "Closing Find keeps the older match in the reading area");
		if (screenshots) await page.screenshot({ path: join(screenshots, "workspace-history-match.png"), scale: "css", animations: "disabled" });
	} finally {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await rm(file, { force: true });
	}
}

export async function verifyWorkspaceNavigation({ page, root, agentDir, cliFixtures, ready, workspaceScreenshots }) {
	if (workspaceScreenshots) await mkdir(workspaceScreenshots, { recursive: true });
	const [first, other] = await makeProjects(root);
	await page.evaluate(async ({ first, other }) => {
		await window.pi.selectProject(other);
		await window.pi.selectProject(first);
		await window.pi.setProjectTrust({ project: first, decision: "trusted" });
	}, { first, other });
	await page.reload();
	await ready();
	await verifyFiles(page, first, other, workspaceScreenshots);
	await verifyLanguageInspection(page, cliFixtures);
	await verifyLongTranscript(page, agentDir, first, ready, workspaceScreenshots);
	return [
		"workspace search rejects stale results, ranks the current directory, and preserves file and keyboard navigation across projects",
		"a delayed language-server response never attaches to a different file",
		"closing transcript search keeps an older match rendered and in view",
	];
}
