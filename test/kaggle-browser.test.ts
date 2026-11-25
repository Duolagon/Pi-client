import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { allowsKaggleBrowserNavigation, formatKaggleSelection, kaggleNotebookReference, kaggleNotebookSelection, kaggleNotebookUrl } from "../src/kaggle-browser.ts";
import { kaggleNotebookScript, kaggleNotebookSnapshot } from "../src/kaggle-computer-use.ts";

const notebookUrl = "https://www.kaggle.com/code/research/example/edit";

test("opening a notebook requires the official HTTPS origin and notebook path", () => {
	assert.equal(kaggleNotebookUrl(notebookUrl)?.href, notebookUrl);
	assert.equal(kaggleNotebookUrl("https://kaggle.com/code/research/example?scriptVersionId=7")?.searchParams.get("scriptVersionId"), "7");
	for (const value of [
		"http://www.kaggle.com/code/research/example", "https://www.kaggle.com:3500/code/research/example",
		"https://research@www.kaggle.com/code/research/example", "https://www.kaggle.com.evil.test/code/research/example",
		"https://www.kaggle.com/competitions/example", "https://accounts.google.com/code/research/example",
		"file:///code/research/example", "https://www.kaggle.com/code/research", "https://www.kaggle.com/code/research/example/unknown",
	]) assert.equal(kaggleNotebookUrl(value), undefined, value);
});

test("the dedicated browser supports account navigation without opening arbitrary destinations", () => {
	assert.equal(allowsKaggleBrowserNavigation("https://www.kaggle.com/account/login"), true);
	assert.equal(allowsKaggleBrowserNavigation("https://accounts.google.com/o/oauth2/auth"), true);
	for (const value of ["https://accounts.google.com.evil.test/", "https://user@accounts.google.com/", "https://www.google.com/", "mailto:a@example.test", "file:///tmp/test"])
		assert.equal(allowsKaggleBrowserNavigation(value), false, value);
});

test("explicit Notebook selections have a bounded, quoted source reference", () => {
	const input = {
		conversationId: "origin-session",
		pageUrl: `${notebookUrl}?private=discarded#cell`,
		frameUrl: "https://output.kaggleusercontent.com/rendering",
		text: "  status: COMPLETE\nrun notes\u0000 ",
		editable: false,
	};
	const selection = kaggleNotebookSelection(input);
	assert.ok(selection);
	assert.deepEqual(selection, {
		conversationId: "origin-session", notebookUrl, text: "status: COMPLETE\nrun notes", truncated: false,
	});
	assert.equal(formatKaggleSelection(selection), `从 Kaggle Notebook 选择的外部文本\n${notebookUrl}\n\n> status: COMPLETE\n> run notes`);
	assert.equal(kaggleNotebookSelection({ ...input, editable: true }), undefined);
	assert.equal(kaggleNotebookSelection({ ...input, pageUrl: "https://www.kaggle.com/account/login" }), undefined);
	assert.equal(kaggleNotebookSelection({ ...input, frameUrl: "https://accounts.google.com/" }), undefined);
	assert.equal(kaggleNotebookSelection({ ...input, frameUrl: "https://output.kaggleusercontent.com.evil.test/" }), undefined);
	assert.equal(kaggleNotebookSelection({ ...input, text: "\n \t" }), undefined);
	const limited = kaggleNotebookSelection({ ...input, text: "a".repeat(16_001) });
	assert.equal(limited?.text.length, 16_000);
	assert.equal(limited?.truncated, true);
});

test("Computer Use strips private URL parameters and redacts bounded Notebook output", () => {
	const reference = kaggleNotebookReference(`${notebookUrl}?code=private&scriptVersionId=123#secret`);
	assert.equal(reference, `${notebookUrl}?scriptVersionId=123`);
	assert.equal(kaggleNotebookReference(`${notebookUrl}?scriptVersionId=private`), notebookUrl);
	assert.equal(kaggleNotebookReference("https://accounts.google.com/authorized"), undefined);
	assert.equal(kaggleNotebookSnapshot(notebookUrl, { runAllAvailable: "true", statuses: [], output: [], truncated: false }), undefined);
	const snapshot = kaggleNotebookSnapshot(notebookUrl, {
		runAllAvailable: true, statuses: ["Running"], output: ["line ".repeat(1600), "API_TOKEN=abc123dummyvalue", "LATEST_OUTPUT"], truncated: false,
	});
	assert.ok(snapshot);
	assert.equal(snapshot.output.join("").length, 8000);
	assert.equal(snapshot.truncated, true);
	assert.deepEqual(snapshot.output.slice(-2), ["API_TOKEN=[REDACTED]", "LATEST_OUTPUT"]);
});

test("Computer Use rejects replaced and code-cell Run All controls and can click the same toolbar control once", () => {
	class Control {
		innerText = "Run All";
		clickCount = 0;
		type = "button";
		form = null;
		cell: boolean;
		constructor(cell = false) { this.cell = cell; }
		getClientRects() { return [true]; }
		checkVisibility() { return true; }
		closest(selector: string) {
			return selector.startsWith("header,") || this.cell && selector.startsWith("[data-cell-id]") ? this : undefined;
		}
		getAttribute() { return null; }
		hasAttribute() { return false; }
		click() { this.clickCount++; }
	}
	const window = { location: new URL(notebookUrl), top: undefined as object | undefined };
	window.top = window;
	const cell = new Control(true);
	const button = new Control();
	let actions = [cell, button];
	const context = {
		window,
		HTMLElement: Control,
		HTMLButtonElement: Control,
		document: { querySelectorAll: () => actions },
	};
	const op = (kind: "arm" | "click", nonce = "test") => runInNewContext(kaggleNotebookScript(notebookUrl, { kind, nonce }), context);
	assert.equal(op("arm"), true);
	const replacement = new Control();
	actions = [replacement, cell];
	assert.equal(op("click"), false);
	assert.equal(replacement.clickCount, 0);
	actions = [button, replacement];
	assert.equal(op("arm"), false);
	actions = [cell, button];
	assert.equal(op("arm"), true);
	assert.equal(op("click"), true);
	assert.equal(op("click"), false);
	assert.equal(cell.clickCount, 0);
	assert.equal(button.clickCount, 1);
});
