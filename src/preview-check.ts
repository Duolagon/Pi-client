import { BrowserWindow, session } from "electron";

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
