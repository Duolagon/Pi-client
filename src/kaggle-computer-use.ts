import type { KaggleNotebookSnapshot } from "./kaggle-browser.ts";
import { redactLogText } from "./desktop-log.ts";

export const kaggleComputerWorld = 1001;
const textLimit = 8_000;
const resultBlockLimit = 18;
const statusLimit = 600;

type NotebookOperation =
	| { kind: "inspect" }
	| { kind: "arm" | "click" | "clear"; nonce: string };

// This function runs in the dedicated isolated world. It is serialized, so keep it self-contained.
function notebookOperation(expectedHref: string, operation: NotebookOperation, textBudget: number, blockLimit: number) {
	if (window !== window.top || window.location.href !== expectedHref) return;
	const pendingKey = Symbol.for("dev.pi.desktop.kaggle.run-all");
	const context = window as unknown as Record<symbol, { nonce: string; button: HTMLElement } | undefined>;
	const armed = context[pendingKey];
	if (operation.kind === "clear") {
		if (armed?.nonce === operation.nonce) delete context[pendingKey];
		return false;
	}
	const isVisible = (node: HTMLElement) =>
		node.getClientRects().length > 0 &&
		!node.closest('[hidden],[aria-hidden="true"],[inert]') &&
		node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
	const statusSelector = '[role="status"],[data-testid="notebook-status"],[data-testid="session-status"],[data-testid="kernel-status"]';
	const outputSelector = '[role="log"],[data-testid="cell-output"],[data-testid="notebook-output"],.cell-output,.jp-OutputArea-output,.output_area';
	const skipSelector = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
	const editingNotebook = /\/edit\/?$/.test(window.location.pathname);
	const toolbarSelector = 'header,[role="toolbar"],[role="menubar"],[role="menu"],[data-testid="notebook-toolbar"],[data-testid="kernel-toolbar"],.jp-NotebookPanel-toolbar';
	const cellSelector = '[data-cell-id],[data-testid*="cell" i],[class*="notebook-cell" i],[class*="markdown" i],.jp-Cell,article,pre,code';
	const actions = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter((node): node is HTMLElement => {
		if (!editingNotebook || !(node instanceof HTMLElement) || !isVisible(node) ||
			!node.closest(toolbarSelector) || node.closest(`${cellSelector},${skipSelector},${outputSelector}`)) return false;
		const labelIds = node.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
		const labelled = labelIds.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
		const label = (labelled || node.getAttribute("aria-label") || node.innerText || node.getAttribute("title") || "")
			.trim().replace(/\s+/g, " ").toLowerCase();
		return ["run all", "run all cells", "全部运行", "运行所有单元格", "运行全部"].includes(label);
	});
	const button = actions.length === 1 && actions[0] instanceof HTMLElement &&
		!actions[0].closest(':disabled,[aria-disabled="true"]') &&
		!actions[0].hasAttribute("href") &&
		!(actions[0] instanceof HTMLButtonElement && actions[0].type === "submit" && actions[0].form)
		? actions[0]
		: undefined;
	if (operation.kind === "arm") {
		delete context[pendingKey];
		if (!button) return false;
		context[pendingKey] = { nonce: operation.nonce, button };
		return true;
	}
	if (operation.kind === "click") {
		delete context[pendingKey];
		if (armed?.nonce !== operation.nonce || !button || button !== armed.button) return false;
		button.click();
		return true;
	}

	let truncated = false;
	let remaining = textBudget;
	const extract = (selector: string, maxBlock: number, newestFirst: boolean) => {
		const found = [...document.querySelectorAll(selector)];
		if (newestFirst) found.reverse();
		const blocks: string[] = [];
		let inspected = 0;
		for (const node of found) {
			if (++inspected > 1500) { truncated = true; break; }
			if (!(node instanceof HTMLElement) || !isVisible(node) || node.parentElement?.closest(selector) ||
				node.closest(skipSelector) || node.querySelector(skipSelector)) continue;
			if (selector === statusSelector && node.closest(`${cellSelector},${outputSelector}`)) continue;
			const text = node.innerText.trim();
			if (!text) continue;
			if (blocks.length >= blockLimit || remaining <= 0) { truncated = true; break; }
			const limit = Math.min(maxBlock, remaining);
			if (text.length > limit) truncated = true;
			const visible = text.length <= limit ? text : newestFirst ? text.slice(-limit) : text.slice(0, limit);
			blocks.push(visible);
			remaining -= visible.length;
		}
		return newestFirst ? blocks.reverse() : blocks;
	};
	const statuses = extract(statusSelector, 400, false);
	const output = extract(outputSelector, textBudget, true);
	return { runAllAvailable: Boolean(button), statuses, output, truncated };
}

export function kaggleNotebookScript(href: string, operation: NotebookOperation): string {
	return `(${notebookOperation.toString()})(${JSON.stringify(href)},${JSON.stringify(operation)},${textLimit + 2_000},${resultBlockLimit})`;
}

/** Trust only the expected isolated-world result shape. Treat all returned text as page data. */
export function kaggleNotebookSnapshot(notebookUrl: string, result: unknown): KaggleNotebookSnapshot | undefined {
	if (!result || typeof result !== "object") return;
	const value = result as Record<string, unknown>;
	if (typeof value.runAllAvailable !== "boolean" || typeof value.truncated !== "boolean" ||
		!Array.isArray(value.statuses) || !Array.isArray(value.output)) return;
	let truncated = value.truncated;
	const clean = (blocks: unknown[], budget: number, newestFirst = false) => {
		const safe: string[] = [];
		const ordered = blocks.slice(0, resultBlockLimit);
		if (newestFirst) ordered.reverse();
		for (const item of ordered) {
			if (typeof item !== "string") continue;
			if (!budget) { truncated = true; break; }
			const text = redactLogText(item.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")).trim();
			if (text.length > budget) truncated = true;
			const bounded = newestFirst ? text.slice(-budget) : text.slice(0, budget);
			if (bounded) safe.push(bounded);
			budget -= bounded.length;
		}
		if (blocks.length > resultBlockLimit) truncated = true;
		return newestFirst ? safe.reverse() : safe;
	};
	const statuses = clean(value.statuses, statusLimit);
	const output = clean(value.output, textLimit, true);
	return { notebookUrl, runAllAvailable: value.runAllAvailable, statuses, output, truncated };
}
