import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopService } from "./backend.ts";
import { installWorkspaceHandlers } from "./workspace-ipc.ts";
import { installSessionHandlers } from "./session-ipc.ts";
import { installControlHandlers } from "./control-ipc.ts";
import { installExternalHandlers } from "./external-ipc.ts";
import { installP8Handlers } from "./p8-ipc.ts";
import type { Command, ConnectionInput, DesktopAPI } from "./shared.ts";
import { checkPreview, probePreview } from "./preview-check.ts";
import { captureShellEnvironment, mergeNetworkEnvironment } from "./tool-path.ts";
import { MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS } from "./delegation-limits.ts";
import { parseModelRoutingUpdate } from "./model-routing.ts";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

app.setName("Pi Desktop");
if (process.env.PI_DESKTOP_DATA_DIR) app.setPath("userData", process.env.PI_DESKTOP_DATA_DIR);
// Electron keys the lock on the userData directory, so a second launch with the
// same data focuses the open window while separate data directories still coexist.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
	if (!window || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
});
let window: BrowserWindow | null = null;
let service: DesktopService;
let ready: Promise<unknown>;
let quitting = false;
const indexPath = join(__dirname, "index.html");

function createWindow() {
	window = new BrowserWindow({
		width: 1480,
		height: 980,
		minWidth: 780,
		minHeight: 620,
		title: "Pi Desktop",
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 20, y: 17 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f1e1a" : "#fafaf7",
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	void window.loadFile(indexPath);
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(({ url }) => {
		const target = new URL(url);
		if (["http:", "https:"].includes(target.protocol)) void shell.openExternal(url);
		return { action: "deny" };
	});
	// Only allow writing text to the clipboard (copy buttons); every other permission stays denied.
	window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
		callback(permission === "clipboard-sanitized-write"),
	);
	window.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");
	window.on("focus", () => updateDock());
	window.on("closed", () => {
		window = null;
	});
}

function string(value: unknown, label: string, max = 32768): string {
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label}格式错误。`);
	return value;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求参数格式错误。");
	return value as Record<string, unknown>;
}
function connection(value: unknown): ConnectionInput {
	const record = object(value);
	if (!["anthropic", "openai", "google", "openrouter", "deepseek"].includes(String(record.provider)))
		throw new Error("服务商无效。");
	if (record.mode !== undefined && record.mode !== "preset" && record.mode !== "custom")
		throw new Error("连接方式无效。");
	if (
		record.api !== undefined &&
		!["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(
			String(record.api),
		)
	)
		throw new Error("接口协议无效。");
	for (const field of ["apiKey", "baseUrl", "modelId", "keyCommand"])
		if (record[field] !== undefined) string(record[field], field, 16384);
	if (record.headers !== undefined) {
		const headers = object(record.headers);
		if (Object.keys(headers).length > 32) throw new Error("自定义请求头最多 32 个。");
		for (const [name, value] of Object.entries(headers)) {
			if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error(`请求头名称无效：${name.slice(0, 40)}`);
			if (/[\r\n\0]/.test(string(value, "请求头的值", 8192))) throw new Error("请求头的值不能包含换行。");
		}
	}
	return record as unknown as ConnectionInput;
}
function command(value: unknown): Command {
	const record = object(value);
	const type = string(record.type, "命令", 100);
	switch (type) {
		case "prompt":
		case "steer":
		case "follow_up":
			string(record.message, "消息", 2 * 1024 * 1024);
			if (record.streamingBehavior !== undefined && !["steer", "followUp"].includes(String(record.streamingBehavior)))
				throw new Error("排队模式无效。");
			if (record.images !== undefined) {
				if (!Array.isArray(record.images) || record.images.length > 10) throw new Error("图片参数错误。");
				for (const image of record.images) {
					const block = object(image);
					if (block.type !== "image") throw new Error("图片格式错误。");
					string(block.data, "图片", 10 * 1024 * 1024);
					string(block.mimeType, "图片类型", 100);
				}
			}
			break;
		case "bash":
			string(record.command, "终端命令", 128 * 1024);
			if (record.excludeFromContext !== undefined && typeof record.excludeFromContext !== "boolean")
				throw new Error("上下文选项无效。");
			break;
		case "set_model":
			string(record.provider, "服务商", 300);
			string(record.modelId, "模型", 500);
			break;
		case "set_thinking_level":
			if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(record.level)))
				throw new Error("思考强度无效。");
			break;
		case "compact":
			if (record.customInstructions !== undefined) string(record.customInstructions, "压缩指令");
			break;
		case "get_entries":
			if (record.since !== undefined) string(record.since, "会话条目");
			break;
		case "set_auto_compaction":
		case "set_auto_retry":
			if (typeof record.enabled !== "boolean") throw new Error("选项无效。");
			break;
		case "abort":
		case "abort_bash":
		case "abort_retry":
		case "clear_queue":
		case "get_state":
		case "get_messages":
		case "get_available_models":
		case "get_available_thinking_levels":
		case "get_session_stats":
		case "get_commands":
		case "get_tree":
		case "get_last_assistant_text":
			break;
		default:
			throw new Error("桌面端不支持此命令。");
	}
	// All accepted discriminants and their wire fields were checked above.
	return record as Command;
}

function installHandlers() {
	const handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) =>
		ipcMain.handle(channel, async (event, ...args: unknown[]) => {
			if (
				!window ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				event.senderFrame.url !== pathToFileURL(indexPath).href
			)
				throw new Error("不受信任的桌面请求。");
			await ready;
			return action(...args);
		});
	handle("pi:preview:check", (url, mobile) => checkPreview(string(url, "预览地址", 4096), mobile === true));
	handle("pi:preview:probe", (url) => probePreview(string(url, "预览地址", 4096)));
	handle("pi:snapshot", () => service.snapshot());
	handle("pi:open-project", async () => {
		const result = await dialog.showOpenDialog(window!, { title: "打开项目文件夹", properties: ["openDirectory"] });
		return result.canceled || !result.filePaths[0] ? null : service.selectProject(result.filePaths[0]);
	});
	handle("pi:select-project", (path) => service.selectProject(string(path, "项目路径")));
	handle("pi:project-trust", (input) => {
		const record = object(input);
		const project = string(record.project, "项目路径", 4096);
		if (record.decision !== "trusted" && record.decision !== "untrusted")
			throw new Error("项目信任决定无效。");
		return service.setProjectTrust({ project, decision: record.decision });
	});
	handle("pi:new-conversation", () => service.newConversation());
	handle("pi:select-conversation", (id) => service.selectConversation(string(id, "会话 ID", 200)));
	handle("pi:remove-conversation", (id) => service.removeConversation(string(id, "会话 ID", 200)));
	handle("pi:rename", (id, title) =>
		service.renameConversation(string(id, "会话 ID", 200), string(title, "会话名称", 160)),
	);
	handle("pi:command", (input, id) => service.command(command(input), id === undefined ? undefined : string(id, "会话 ID", 200)));
	handle("pi:respond", async (input, id) => {
		const record = object(input);
		string(record.id, "确认 ID", 300);
		if (
			record.type !== "extension_ui_response" ||
			!(record.cancelled === true || typeof record.confirmed === "boolean" || typeof record.value === "string")
		)
			throw new Error("确认响应格式错误。");
		if (typeof record.value === "string") string(record.value, "确认内容", 1024 * 1024);
		try {
			return await service.respond(record as RpcExtensionUIResponse, id === undefined ? undefined : string(id, "会话 ID", 200));
		} finally {
			updateDock();
		}
	});
	handle("pi:files", (path) => service.files(string(path, "文件路径")));
	handle("pi:read-file", (path) => service.readFile(string(path, "文件路径")));
	handle("pi:workspace", () => service.workspace());
	handle("pi:workspace:create-draft-pr", (id, input) => {
		const draft = object(input);
		return service.createDraftPullRequest(string(id, "会话 ID", 200), {
			branch: string(draft.branch, "源分支", 255),
			title: string(draft.title, "PR 标题", 256),
			body: string(draft.body, "PR 说明", 32768),
			base: draft.base === undefined ? undefined : string(draft.base, "目标分支", 255),
		});
	});
	handle("pi:pull-request", (id, number) => {
		if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1))
			throw new Error("PR 编号无效。");
		return service.pullRequest(string(id, "会话 ID", 200), number);
	});
	handle("pi:diff", (path) => service.diff(string(path, "文件路径")));
	handle("pi:settings", (input) => {
		const settings = object(input);
		if (
			!["ask", "acceptEdits", "auto", "read", "plan"].includes(String(settings.permission)) ||
			!["light", "dark", "grail", "system"].includes(String(settings.theme))
		)
			throw new Error("设置格式错误。");
		if (settings.sandboxOffline !== undefined && typeof settings.sandboxOffline !== "boolean") throw new Error("沙箱网络设置格式错误。");
		if (settings.sandbox !== undefined && typeof settings.sandbox !== "boolean")
			throw new Error("沙箱开关格式错误。");
		if (settings.notifications !== undefined && typeof settings.notifications !== "boolean")
			throw new Error("通知开关格式错误。");
		if (settings.subagentDefaultBackground !== undefined && typeof settings.subagentDefaultBackground !== "boolean")
			throw new Error("子 Agent 默认后台设置格式错误。");
		if (settings.forkSubagent !== undefined && typeof settings.forkSubagent !== "boolean")
			throw new Error("子 Agent fork 开关设置格式错误。");
		if (settings.confineSubagentBash !== undefined && typeof settings.confineSubagentBash !== "boolean")
			throw new Error("子 Agent 沙箱隔离设置格式错误。");
		if (settings.cronEnabled !== undefined && typeof settings.cronEnabled !== "boolean")
			throw new Error("定时唤醒设置格式错误。");
		if (settings.agentTeams !== undefined && typeof settings.agentTeams !== "boolean")
			throw new Error("实验性 Agent Teams 设置格式错误。");
		if (
			settings.maxSubagentDepth !== undefined &&
			(!Number.isSafeInteger(settings.maxSubagentDepth) ||
				(settings.maxSubagentDepth as number) < 1 ||
				(settings.maxSubagentDepth as number) > 3)
		)
			throw new Error("子 Agent 最大嵌套深度需为 1–3 的整数。");
		if (
			settings.maxConcurrentSubagents !== undefined &&
			(!Number.isSafeInteger(settings.maxConcurrentSubagents) ||
				(settings.maxConcurrentSubagents as number) < 1 ||
				(settings.maxConcurrentSubagents as number) > 20)
		)
			throw new Error("最大并发子 Agent 数量需为 1–20 的整数。");
		if (
			settings.foregroundSubagentTimeoutMs !== undefined &&
			(!Number.isSafeInteger(settings.foregroundSubagentTimeoutMs) ||
				(settings.foregroundSubagentTimeoutMs as number) < 0 ||
				(settings.foregroundSubagentTimeoutMs as number) > MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS)
		)
			throw new Error("前台子 Agent 等待时长格式错误。");
		if (settings.modelRouting !== undefined) parseModelRoutingUpdate(settings.modelRouting);
		if (settings.proxy !== undefined) string(settings.proxy, "代理地址", 2048);
		if (settings.noProxy !== undefined) string(settings.noProxy, "代理例外", 4096);
		if (settings.caFile !== undefined) string(settings.caFile, "CA 证书路径", 4096);
		if (
			settings.maxCostUsd !== undefined &&
			settings.maxCostUsd !== null &&
			(typeof settings.maxCostUsd !== "number" || !Number.isFinite(settings.maxCostUsd) || settings.maxCostUsd < 0.01 || settings.maxCostUsd > 100000)
		)
			throw new Error("费用上限需为 0.01–100000 美元。");
		if (
			settings.minBalance !== undefined &&
			settings.minBalance !== null &&
			(typeof settings.minBalance !== "number" || !Number.isFinite(settings.minBalance) || settings.minBalance < 0.01 || settings.minBalance > 1000000)
		)
			throw new Error("余额底线需为 0.01–1000000。");
		if (settings.disableAllHooks !== undefined && typeof settings.disableAllHooks !== "boolean")
			throw new Error("Hooks 开关格式错误。");
		if (settings.provider !== undefined) connection(settings);
		if (settings.agentDir !== undefined) string(settings.agentDir, "Pi 配置目录", 16384);
		return service.saveSettings(settings as Parameters<DesktopAPI["saveSettings"]>[0]);
	});
	handle("pi:test-connection", (input) => service.testConnection(connection(input)));
	handle("pi:provider-balance", (input) => service.providerBalance(connection(input)));
	handle("pi:export", async () => {
		const result = await dialog.showSaveDialog(window!, {
			title: "导出会话",
			defaultPath: "pi-session.html",
			filters: [{ name: "HTML", extensions: ["html"] }],
		});
		return result.canceled || !result.filePath ? null : service.exportConversation(result.filePath);
	});
	installWorkspaceHandlers(handle, service, command);
	installSessionHandlers(handle, service);
	installControlHandlers(handle, service);
	installExternalHandlers(handle, service);
	installP8Handlers(handle, service);
}

let dockBounce: number | undefined;
/** Dock badge shows the approvals waiting; cleared when none remain. */
function updateDock(requestAttention = false) {
	if (process.platform !== "darwin" || !app.dock || !service) return;
	const count = service.pendingApprovalCount();
	app.dock.setBadge(count ? String(count) : "");
	if (!count && dockBounce !== undefined) {
		app.dock.cancelBounce(dockBounce);
		dockBounce = undefined;
	}
	const focused = Boolean(window && !window.isDestroyed() && window.isFocused());
	if (requestAttention && count && !focused && dockBounce === undefined) dockBounce = app.dock.bounce("critical");
}

void app.whenReady().then(() => {
	if (!primaryInstance) return;
	const runtimeDir = app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "runtime");
	const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	service = new DesktopService({
		dataDir: app.getPath("userData"),
		runtimeDir,
		ptyHelperPath: app.isPackaged ? join(process.resourcesPath, "native/pty-host") : join(__dirname, "native/pty-host"),
		executable: process.execPath,
		env: environment,
		initialProject: process.env.PI_DESKTOP_WORKSPACE,
		encrypt: (value) => {
			if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用。");
			return safeStorage.encryptString(value).toString("base64");
		},
		decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
	});
	ready = captureShellEnvironment().then(({ path, network }) => {
		environment.PATH = path;
		mergeNetworkEnvironment(environment, network);
		return service.initialize();
	});
	const notifyDesktop = (title: string, body: string) => {
		if (process.env.PI_OFFLINE === "1" || !Notification.isSupported()) return;
		if (window && !window.webContents.isDestroyed() && window.isFocused()) return;
		void service.snapshot().then((snap) => {
			if (snap.settings.notifications === false) return;
			const note = new Notification({ title, body: body.slice(0, 160) });
			note.on("click", () => {
				if (window && !window.isDestroyed()) {
					if (window.isMinimized()) window.restore();
					window.focus();
				}
			});
			note.show();
		}).catch(() => {});
	};
	service.subscribe((packet) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:event", packet);
		if (packet.event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(packet.event.method)) {
			const reqTitle = "title" in packet.event ? packet.event.title : undefined;
			notifyDesktop("Pi 需要你的确认", reqTitle === "__PI_ASK_QUESTIONS__" ? "模型发起了结构化提问，请查看并选择。" : (reqTitle ?? "工具执行等待批准"));
			updateDock(true);
		} else if (packet.event.type === "agent_settled") {
			updateDock();
			notifyDesktop("Pi 任务已结束", packet.event.aborted ? "当前回合已停止。" : "回复与工具执行已完成。");
		}
	});
	// Last status seen per task: bookkeeping updates (a delivered result, a detached child)
	// re-emit an unchanged status and must not raise the OS notification again.
	const taskStatuses = new Map<string, string>();
	service.subscribeTasks((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:task:event", event);
		if (event.type === "task_updated") updateDock(event.task.status === "waiting_for_input");
		if (event.type === "task_updated") {
			const previous = taskStatuses.get(event.task.id);
			taskStatuses.set(event.task.id, event.task.status);
			// A task first seen in its final state finished before this process watched it.
			if (previous === undefined || previous === event.task.status) return;
			if (event.task.status === "waiting_for_input") notifyDesktop("后台子任务需要确认", event.task.title);
			else if (event.task.status === "completed") notifyDesktop("后台子任务已完成", event.task.title);
			else if (event.task.status === "failed") notifyDesktop("后台子任务失败", event.task.error || event.task.title);
		}
	});
	service.subscribeTerminals((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:terminal:event", event);
	});
	service.subscribeControls((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:controls:event", event);
	});
	service.subscribeExternal((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:external:event", event);
	});
	service.subscribeTodos((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:todos:event", event);
	});
	service.subscribeMonitors((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:monitor:event", event);
	});
	service.subscribeCron((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:cron:event", event);
	});
	service.subscribeTeams((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:teams:event", event);
	});
	service.subscribeWorkflows((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:workflow:event", event);
	});
	installHandlers();
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ label: "Pi Desktop", submenu: [{ role: "about" }, { role: "hide" }, { role: "quit" }] },
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				],
			},
			{
				label: "View",
				submenu: [
					{ role: "reload" },
					{ role: "toggleDevTools" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ role: "togglefullscreen" },
				],
			},
			{ role: "windowMenu" },
		]),
	);
	createWindow();
	app.on("activate", () => {
		if (!window) createWindow();
	});
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
	if (quitting || !service) return;
	event.preventDefault();
	quitting = true;
	void service.close().finally(() => app.quit());
});
