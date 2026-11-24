import { BrowserWindow, session } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreviewInspectInput, PreviewInspectResult, PreviewInteraction, PreviewInteractiveElement } from "./preview-check-types.ts";

export interface PreviewCheck {
	url: string;
	title: string;
	status: number;
	elapsedMs: number;
	errors: string[];
}

export function localPreviewUrl(input: string): URL {
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password)
		throw new Error("网页验证仅支持本机开发地址。");
	return url;
}

/** Cheap reachability check for the preview panel: does anything answer on this local address? */
export async function probePreview(input: string): Promise<boolean> {
	const url = localPreviewUrl(input);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	try {
		await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

let checking = false;

export async function checkPreview(input: string, mobile: boolean): Promise<PreviewCheck> {
	const url = localPreviewUrl(input);
	if (checking) throw new Error("本地网页正在验证。");
	checking = true;
	const started = Date.now();
	const isolated = session.fromPartition("pi-preview-check", { cache: false });
	const errors: string[] = [];
	let status = 0;
	let page: BrowserWindow | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		isolated.setPermissionCheckHandler(() => false);
		isolated.webRequest.onBeforeRequest((request, callback) => {
			const target = new URL(request.url);
			const sameOrigin = target.origin === url.origin && ["http:", "https:"].includes(target.protocol);
			callback({ cancel: !sameOrigin || !["GET", "HEAD", "OPTIONS"].includes(request.method) || Boolean(target.username || target.password) });
		});
		isolated.webRequest.onCompleted((request) => {
			if (request.resourceType === "mainFrame") status = request.statusCode;
		});
		isolated.webRequest.onErrorOccurred((request) => {
			if (request.resourceType !== "mainFrame" && errors.length < 20)
				errors.push(`${new URL(request.url).pathname.slice(0, 400)} ${request.error}`);
		});
		isolated.on("will-download", cancelDownload);
		page = new BrowserWindow({
			show: false, width: mobile ? 390 : 1280, height: mobile ? 844 : 820,
			webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
		});
		const contents = page.webContents;
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event) => event.preventDefault());
		contents.on("console-message", ({ level, message }) => {
			if (level === "error" && errors.length < 20) errors.push(message.slice(0, 1200));
		});
		await Promise.race([
			contents.loadURL(url.href).then(() => new Promise((resolve) => setTimeout(resolve, 400))),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("本地网页加载超时。")), 10000); }),
		]);
		return { url: contents.getURL(), title: contents.getTitle().slice(0, 200), status, elapsedMs: Date.now() - started, errors };
	} finally {
		clearTimeout(timer);
		if (page && !page.isDestroyed()) page.destroy();
		isolated.removeListener("will-download", cancelDownload);
		try {
			await isolated.clearStorageData();
		} finally {
			checking = false;
		}
	}
}

function cancelDownload(event: Electron.Event) { event.preventDefault(); }

async function executePreviewAction(contents: Electron.WebContents, action: PreviewInteraction): Promise<string> {
	if (action.type === "wait") {
		const ms = Math.max(50, Math.min(5000, Math.round(action.ms)));
		await new Promise((resolve) => setTimeout(resolve, ms));
		return `wait ${ms}ms`;
	}
	if (action.type === "wait_for") {
		const timeoutMs = Math.max(200, Math.min(5000, Math.round(action.timeoutMs ?? 3000)));
		const deadline = Date.now() + timeoutMs;
		const sel = JSON.stringify(action.selector);
		while (Date.now() < deadline) {
			const found = await contents.executeJavaScript(`Boolean(document.querySelector(${sel}))`, true);
			if (found) return `wait_for ${action.selector} (found)`;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`等待元素超时：${action.selector}`);
	}
	if (action.type === "click") {
		const sel = JSON.stringify(action.selector);
		const result = await contents.executeJavaScript(
			`(() => {
				const el = document.querySelector(${sel});
				if (!el) return { ok: false, error: "未找到元素" };
				if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
				if (typeof el.focus === "function") el.focus();
				el.click();
				return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || "").trim().slice(0, 80) };
			})()`,
			true,
		) as { ok: boolean; error?: string; tag?: string; text?: string };
		if (!result.ok) throw new Error(`点击失败 (${action.selector})：${result.error}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
		return `click ${action.selector} (<${result.tag}>${result.text ? ` "${result.text}"` : ""})`;
	}
	if (action.type === "fill") {
		const sel = JSON.stringify(action.selector);
		const val = JSON.stringify(action.value);
		const result = await contents.executeJavaScript(
			`(() => {
				const el = document.querySelector(${sel});
				if (!el) return { ok: false, error: "未找到输入框" };
				if (typeof el.focus === "function") el.focus();
				const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				if (setter) setter.call(el, ${val});
				else el.value = ${val};
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return { ok: true };
			})()`,
			true,
		) as { ok: boolean; error?: string };
		if (!result.ok) throw new Error(`输入失败 (${action.selector})：${result.error}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		return `fill ${action.selector}`;
	}
	if (action.type === "scroll") {
		const sel = action.selector ? JSON.stringify(action.selector) : "null";
		const y = typeof action.y === "number" && Number.isFinite(action.y) ? Math.round(action.y) : 400;
		await contents.executeJavaScript(
			`(() => {
				const sel = ${sel};
				if (sel) {
					const el = document.querySelector(sel);
					if (el && typeof el.scrollIntoView === "function") { el.scrollIntoView({ block: "center" }); return; }
				}
				window.scrollBy(0, ${y});
			})()`,
			true,
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		return action.selector ? `scroll to ${action.selector}` : `scroll y=${y}`;
	}
	return "noop";
}

/**
 * Rich headless local-web verification for the model's PreviewCheck tool:
 * loads a loopback URL in an isolated sandboxed Electron BrowserWindow,
 * runs optional UI actions (click, fill, wait, wait_for, scroll), reads DOM
 * text/HTML/interactive elements, captures console & network errors, and
 * optionally saves a bounded JPEG screenshot.
 */
export async function runPreviewCheck(input: PreviewInspectInput): Promise<PreviewInspectResult> {
	const url = localPreviewUrl(input.url);
	if (checking) throw new Error("本地网页正在验证，请稍候重试。");
	checking = true;
	const started = Date.now();
	const isolated = session.fromPartition("pi-preview-check", { cache: false });
	const errors: string[] = [];
	const actionLog: string[] = [];
	let status = 0;
	let page: BrowserWindow | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		isolated.setPermissionCheckHandler(() => false);
		const allowLocalMutations = Boolean(input.actions?.length);
		isolated.webRequest.onBeforeRequest((request, callback) => {
			try {
				const target = new URL(request.url);
				const sameOrigin = target.origin === url.origin && ["http:", "https:"].includes(target.protocol);
				const methodAllowed = allowLocalMutations
					? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)
					: ["GET", "HEAD", "OPTIONS"].includes(request.method);
				callback({ cancel: !sameOrigin || !methodAllowed || Boolean(target.username || target.password) });
			} catch {
				callback({ cancel: true });
			}
		});
		isolated.webRequest.onCompleted((request) => {
			if (request.resourceType === "mainFrame") status = request.statusCode;
		});
		isolated.webRequest.onErrorOccurred((request) => {
			if (request.resourceType !== "mainFrame" && errors.length < 30) {
				errors.push(`${new URL(request.url).pathname.slice(0, 400)} ${request.error}`);
			}
		});
		isolated.on("will-download", cancelDownload);
		page = new BrowserWindow({
			show: false,
			width: input.mobile ? 390 : 1280,
			height: input.mobile ? 844 : 820,
			webPreferences: {
				session: isolated,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				backgroundThrottling: false,
			},
		});
		const contents = page.webContents;
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		// Allow same-origin navigation triggered by clicks, block cross-origin.
		contents.on("will-navigate", (event, targetUrl) => {
			try {
				if (new URL(targetUrl).origin !== url.origin) event.preventDefault();
			} catch {
				event.preventDefault();
			}
		});
		contents.on("console-message", ({ level, message }) => {
			if (level === "error" && errors.length < 30) errors.push(message.slice(0, 1200));
		});
		await Promise.race([
			contents.loadURL(url.href).then(() => new Promise((resolve) => setTimeout(resolve, 400))),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("本地网页加载超时。")), 15000);
			}),
		]);
		clearTimeout(timer);

		for (const action of (input.actions ?? []).slice(0, 20)) {
			const logEntry = await executePreviewAction(contents, action);
			actionLog.push(logEntry);
		}

		let domText: string | undefined;
		let domHtml: string | undefined;
		let interactiveElements: PreviewInteractiveElement[] | undefined;

		if (input.readDom !== false) {
			const selArg = input.selector ? JSON.stringify(input.selector) : "null";
			const snapshot = (await contents.executeJavaScript(
				`(() => {
					const sel = ${selArg};
					const root = sel ? document.querySelector(sel) : document.body;
					const domText = root ? (root.innerText || root.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 16000) : "";
					const domHtml = sel && root ? root.outerHTML.slice(0, 16000) : "";
					const nodes = Array.from(document.querySelectorAll("a[href], button, input, textarea, select, [role='button']")).slice(0, 40);
					const interactiveElements = nodes.map((el) => {
						const tag = el.tagName.toLowerCase();
						const id = el.id ? "#" + el.id : "";
						const name = el.getAttribute("name") ? \`[name="\${el.getAttribute("name")}"]\` : "";
						const testId = el.getAttribute("data-testid") ? \`[data-testid="\${el.getAttribute("data-testid")}"]\` : "";
						const aria = el.getAttribute("aria-label") ? \`[aria-label="\${el.getAttribute("aria-label")}"]\` : "";
						const selector = testId || id || (name ? tag + name : "") || (aria ? tag + aria : "") || tag;
						const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || "").toString().replace(/\\s+/g, " ").trim().slice(0, 80);
						return {
							tag,
							text,
							selector,
							...(el.getAttribute("type") ? { type: el.getAttribute("type") } : {}),
							...(el.disabled ? { disabled: true } : {}),
						};
					});
					return { domText, domHtml, interactiveElements };
				})()`,
				true,
			)) as { domText: string; domHtml: string; interactiveElements: PreviewInteractiveElement[] };
			domText = snapshot.domText || undefined;
			domHtml = snapshot.domHtml || undefined;
			interactiveElements = snapshot.interactiveElements;
		}

		let screenshotPath: string | undefined;
		let screenshotBase64: string | undefined;
		if (input.screenshot) {
			const captured = await contents.capturePage();
			let image = captured;
			const size = captured.getSize();
			if (Math.max(size.width, size.height) > 1280) {
				image = captured.resize(size.width > size.height ? { width: 1280 } : { height: 1280 });
			}
			let jpeg = image.toJPEG(76);
			if (jpeg.byteLength > 350 * 1024) {
				jpeg = image.resize({ width: Math.max(1, Math.round(image.getSize().width * 0.65)) }).toJPEG(60);
			}
			if (jpeg.byteLength > 350 * 1024) throw new Error("预览截图超出 350 KB 的大小限制。");
			screenshotBase64 = jpeg.toString("base64");
			if (input.screenshotDir) {
				await mkdir(input.screenshotDir, { recursive: true, mode: 0o700 });
				screenshotPath = join(input.screenshotDir, `preview-${Date.now()}.jpg`);
				await writeFile(screenshotPath, jpeg, { mode: 0o600 });
			}
		}

		return {
			url: contents.getURL(),
			title: contents.getTitle().slice(0, 200),
			status,
			elapsedMs: Date.now() - started,
			errors,
			actionLog,
			...(domText !== undefined ? { domText } : {}),
			...(domHtml !== undefined ? { domHtml } : {}),
			...(interactiveElements ? { interactiveElements } : {}),
			...(screenshotPath ? { screenshotPath } : {}),
			...(screenshotBase64 ? { screenshotBase64, screenshotMimeType: "image/jpeg" } : {}),
		};
	} finally {
		clearTimeout(timer);
		if (page && !page.isDestroyed()) page.destroy();
		isolated.removeListener("will-download", cancelDownload);
		try {
			await isolated.clearStorageData();
		} finally {
			checking = false;
		}
	}
}
