import { BrowserWindow, Menu, session } from "electron";
import { randomUUID } from "node:crypto";
import { allowsKaggleBrowserNavigation, kaggleNotebookReference, kaggleNotebookSelection, kaggleNotebookUrl, type KaggleNotebookSnapshot, type KaggleSelection } from "./kaggle-browser.ts";
import { kaggleComputerWorld, kaggleNotebookScript, kaggleNotebookSnapshot } from "./kaggle-computer-use.ts";

const partition = "persist:pi-kaggle-browser";
const title = "Kaggle Notebook · Pi Desktop";
type NotebookPage = {
	contents: Electron.WebContents;
	href: string;
	reference: string;
	revision: number;
	processId: number;
	routingId: number;
};

export class KaggleBrowserWindows {
	private windows = new Map<string, BrowserWindow>();
	private revisions = new WeakMap<Electron.WebContents, number>();
	private running = new Set<string>();
	private accountSession?: Electron.Session;

	closeAll(): void {
		for (const window of this.windows.values()) {
			if (!window.isDestroyed()) window.destroy();
		}
	}

	async inspect(conversationId: string, signal?: AbortSignal): Promise<KaggleNotebookSnapshot> {
		signal?.throwIfAborted();
		const page = this.notebookPage(conversationId);
		const raw: unknown = await page.contents.executeJavaScriptInIsolatedWorld(kaggleComputerWorld, [
			{ code: kaggleNotebookScript(page.href, { kind: "inspect" }) },
		], false);
		signal?.throwIfAborted();
		this.assertSamePage(conversationId, page);
		const snapshot = kaggleNotebookSnapshot(page.reference, raw);
		if (!snapshot) throw new Error("Kaggle 页面当前无法读取。");
		return snapshot;
	}

	async runAll(
		conversationId: string,
		approve: (notebookUrl: string) => Promise<boolean>,
		signal?: AbortSignal,
	): Promise<{ notebookUrl: string; clicked: true }> {
		signal?.throwIfAborted();
		if (this.running.has(conversationId)) throw new Error("此会话已有一次 Run All 操作正在处理。");
		const page = this.notebookPage(conversationId);
		const nonce = randomUUID();
		const execute = (kind: "arm" | "click" | "clear"): Promise<unknown> =>
			page.contents.executeJavaScriptInIsolatedWorld(kaggleComputerWorld, [
				{ code: kaggleNotebookScript(page.href, { kind, nonce }) },
			], false);
		this.running.add(conversationId);
		try {
			if (await execute("arm") !== true)
				throw new Error("请让 Kaggle 编辑器显示唯一可用的 Run All 控件（如需，先打开 Run 菜单）。");
			signal?.throwIfAborted();
			this.assertSamePage(conversationId, page);
			if (!await approve(page.reference)) throw new Error("Run All 未获确认。");
			signal?.throwIfAborted();
			this.assertSamePage(conversationId, page);
			if (await execute("click") !== true) throw new Error("Kaggle 的 Run All 控件已变化，本次未执行。");
			return { notebookUrl: page.reference, clicked: true };
		} finally {
			if (this.samePage(conversationId, page)) await execute("clear").catch(() => {});
			this.running.delete(conversationId);
		}
	}

	private notebookPage(conversationId: string): NotebookPage {
		const window = this.windows.get(conversationId);
		if (!window || window.isDestroyed()) throw new Error("请先在当前会话打开 Pi 的 Kaggle Notebook 浏览器。");
		const contents = window.webContents;
		const href = contents.getURL();
		const reference = kaggleNotebookReference(href);
		const frame = contents.mainFrame;
		if (!reference || frame.url !== href || frame.parent || frame.detached || contents.isLoadingMainFrame())
			throw new Error("请在当前会话打开已加载的 Kaggle Notebook 页面。");
		return { contents, href, reference, revision: this.revisions.get(contents) ?? 0, processId: frame.processId, routingId: frame.routingId };
	}

	private samePage(conversationId: string, page: NotebookPage): boolean {
		try {
			const current = this.notebookPage(conversationId);
			return current.contents === page.contents && current.href === page.href && current.revision === page.revision &&
				current.processId === page.processId && current.routingId === page.routingId;
		} catch { return false; }
	}

	private assertSamePage(conversationId: string, page: NotebookPage): void {
		if (!this.samePage(conversationId, page)) throw new Error("Kaggle 页面已切换，请在目标 Notebook 上重试。");
	}

	async open(conversationId: string, value: string, onSelection: (selection: KaggleSelection) => void): Promise<void> {
		const url = kaggleNotebookUrl(value);
		if (!url) throw new Error("请输入 HTTPS Kaggle Notebook 链接，例如 https://www.kaggle.com/code/用户名/笔记本名。");
		let window = this.windows.get(conversationId);
		if (!window || window.isDestroyed()) {
			if (!this.accountSession) {
				this.accountSession = session.fromPartition(partition);
				this.accountSession.setPermissionCheckHandler(() => false);
				this.accountSession.setPermissionRequestHandler((_webContents, _permission, respond) => respond(false));
				this.accountSession.on("will-download", (event) => event.preventDefault());
			}
			const browser = new BrowserWindow({
				title,
				width: 1220,
				height: 800,
				minWidth: 580,
				minHeight: 440,
				webPreferences: {
					session: this.accountSession,
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
					devTools: false,
				},
			});
			window = browser;
			this.windows.set(conversationId, browser);
			browser.on("closed", () => this.windows.delete(conversationId));
			browser.on("page-title-updated", (event) => event.preventDefault());
			const contents = browser.webContents;
			const advanceRevision = () => this.revisions.set(contents, (this.revisions.get(contents) ?? 0) + 1);
			contents.on("did-start-navigation", (event) => { if (event.isMainFrame) advanceRevision(); });
			contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) advanceRevision(); });
			contents.on("will-navigate", (event) => {
				if (!allowsKaggleBrowserNavigation(event.url)) event.preventDefault();
			});
			contents.on("will-redirect", (event) => {
				if (event.isMainFrame && !allowsKaggleBrowserNavigation(event.url)) event.preventDefault();
			});
			contents.setWindowOpenHandler(({ url: destination }) => {
				if (allowsKaggleBrowserNavigation(destination)) {
					queueMicrotask(() => {
						if (!contents.isDestroyed()) void contents.loadURL(destination).catch(() => {});
					});
				}
				return { action: "deny" };
			});
			contents.on("context-menu", (_event, params) => {
				const selection = kaggleNotebookSelection({
					conversationId, pageUrl: params.pageURL, frameUrl: params.frameURL,
					text: params.selectionText, editable: params.isEditable,
				});
				Menu.buildFromTemplate([
					{
						label: "预览所选文本并附加到 Pi 草稿",
						enabled: Boolean(selection),
						click: () => {
							if (selection && !contents.isDestroyed() && contents.getURL() === params.pageURL) onSelection(selection);
						},
					},
					{ type: "separator" },
					{ role: "copy", enabled: params.editFlags.canCopy },
					{ role: "paste", enabled: params.isEditable && params.editFlags.canPaste },
					{ type: "separator" },
					{
						label: "返回上一页",
						enabled: contents.navigationHistory.canGoBack(),
						click: () => contents.navigationHistory.goBack(),
					},
					{ role: "reload", label: "重新加载" },
				]).popup({ window: browser });
			});
		}
		window.show();
		window.focus();
		if (window.webContents.getURL() !== url.href) {
			try {
				await window.loadURL(url.href);
			} catch {
				throw new Error("无法打开 Kaggle Notebook，请检查网络和链接后重试。");
			}
		}
	}
}
