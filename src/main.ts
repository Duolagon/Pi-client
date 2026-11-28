import { maximumImageDataLength, maximumPromptLength, type ComposerAttachment, type PromptImage } from "./composer-draft.ts";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, screen, shell } from "electron";
import { readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DesktopService } from "./backend.ts";
import { installWorkspaceHandlers } from "./workspace-ipc.ts";
import { installSessionHandlers } from "./session-ipc.ts";
import { installControlHandlers } from "./control-ipc.ts";
import { installExternalHandlers } from "./external-ipc.ts";
import { installP8Handlers } from "./p8-ipc.ts";
import type { Command, ConnectionInput, DesktopAPI } from "./shared.ts";
import { checkPreview, probePreview, runPreviewCheck } from "./preview-check.ts";
import { KaggleBrowserWindows } from "./kaggle-browser-window.ts";
import { captureShellEnvironment, mergeNetworkEnvironment } from "./tool-path.ts";
import { MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS } from "./delegation-limits.ts";
import { parseFallbackModelUpdate, parseModelRoutingUpdate } from "./model-routing.ts";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { DesktopLog, describeError } from "./desktop-log.ts";
import { MAX_USAGE_DAYS } from "./usage-stats.ts";
import { EDITOR_CHOICES, editorChoice, editorUrl, launchesCode, parseOpenInEditorInput, resolveEditorTarget, type EditorChoice } from "./editor-open.ts";
import { validOutputStyleName } from "./output-styles.ts";
import { parseGrailModelUpdate, validGrailMaxCost, validGrailTimeout } from "./grail-judge.ts";
import { createPiTracing, takeLangfuseEnvironment } from "./langfuse-tracing.ts";
import { loadLocalLangfuseConfig, saveLocalLangfuseConfig } from "./langfuse-local-config.ts";

app.setName("Pi Desktop");
if (process.env.PI_DESKTOP_DATA_DIR) app.setPath("userData", process.env.PI_DESKTOP_DATA_DIR);
const tracingContent = process.argv.includes("--enable-langfuse-content") ? true :
	process.argv.includes("--disable-langfuse-content") ? false : undefined;
const tracingCommand = process.argv.includes("--configure-langfuse") ? "configure" :
	process.argv.includes("--check-langfuse") ? "check" : tracingContent !== undefined ? "content" : undefined;
// Electron keys the lock on the userData directory, so a second launch with the
// same data focuses the open window while separate data directories still coexist.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
	if (tracingCommand) {
		process.stderr.write("请退出正在运行的 Pi Desktop，再配置或验证 Langfuse。\n", () => app.exit(1));
	} else app.quit();
}
app.on("second-instance", () => {
	if (!window || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
});
// Local diagnostic log only; nothing is uploaded. Records carry no prompts, model output or settings.
const logDir = join(app.getPath("userData"), "logs");
const log = new DesktopLog({ dir: logDir });
const tracingEnvironment = takeLangfuseEnvironment(process.env);
process.on("uncaughtExceptionMonitor", (error) => log.error("uncaughtException", { error: describeError(error) }));
process.on("unhandledRejection", (reason) => log.error("unhandledRejection", { error: describeError(reason) }));
app.on("render-process-gone", (_event, _contents, details) =>
	log.error("render-process-gone", { reason: details.reason, exitCode: details.exitCode }),
);
app.on("child-process-gone", (_event, details) =>
	log.error("child-process-gone", { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name }),
);
let window: BrowserWindow | null = null;
let service: DesktopService;
let ready: Promise<unknown>;
let quitting = false;
let grailWorkspaceWatch: { project: string; close: () => void } | undefined;
let grailWatchConversationId: string | undefined;
const indexPath = join(__dirname, "index.html");
const kaggleBrowser = new KaggleBrowserWindows();

function watchGrailWorkspace(project: string | undefined) {
	if (grailWorkspaceWatch?.project === project) return;
	grailWorkspaceWatch?.close();
	grailWorkspaceWatch = undefined;
	if (!project) return;

	try {
		const watcher = watch(project, { recursive: true, persistent: false });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			clearTimeout(timer);
			watcher.close();
		};
		grailWorkspaceWatch = { project, close };
		watcher.on("change", (_event, filename) => {
			if (filename?.toString().split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (grailWorkspaceWatch?.close !== close || !window || window.webContents.isDestroyed()) return;
				const conversationId = grailWatchConversationId;
				if (conversationId && service.grailWatchProject(conversationId) === project)
					window.webContents.send("pi:grail:event", { type: "grail_workspace_changed", conversationId });
			}, 650);
		});
		watcher.on("error", () => {
			if (grailWorkspaceWatch?.close === close) watchGrailWorkspace(undefined);
		});
	} catch {
		// Some filesystems cannot be watched. Window focus still refreshes readiness.
	}
}

function encryptLocal(value: string): string {
	if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"))
		throw new Error("系统安全存储不可用。");
	return safeStorage.encryptString(value).toString("base64");
}

function decryptLocal(value: string): string {
	return safeStorage.decryptString(Buffer.from(value, "base64"));
}

async function configureLocalTracing(dataDir: string): Promise<void> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > 16_384) throw new Error("Langfuse 配置无效。");
		chunks.push(bytes);
	}
	await saveLocalLangfuseConfig(dataDir, JSON.parse(Buffer.concat(chunks).toString("utf8")), encryptLocal);
}

async function checkLocalTracing(dataDir: string): Promise<string> {
	const saved = await loadLocalLangfuseConfig(dataDir, decryptLocal);
	const tracing = createPiTracing({ ...saved, LANGFUSE_RELEASE: app.getVersion() }, () => {});
	if (!tracing) throw new Error("本机 Langfuse 配置不可用。");
	const traceId = tracing.startRun("setup", "setup", undefined, "setup");
	tracing.finishRun("setup", "success");
	await tracing.close();
	if (!traceId) throw new Error("无法生成 Langfuse 验证追踪。");
	return traceId;
}

async function configureTracingContent(dataDir: string, captureContent: boolean): Promise<void> {
	const saved = await loadLocalLangfuseConfig(dataDir, decryptLocal);
	if (!saved) throw new Error("请先保存本机 Langfuse 配置。");
	await saveLocalLangfuseConfig(dataDir, {
		baseUrl: saved.LANGFUSE_BASE_URL, publicKey: saved.LANGFUSE_PUBLIC_KEY, secretKey: saved.LANGFUSE_SECRET_KEY, captureContent,
	}, encryptLocal);
}

interface SavedWindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized?: boolean;
	isFullScreen?: boolean;
}

function loadWindowState(): SavedWindowState {
	const workArea = screen.getPrimaryDisplay().workArea;
	const fallback: SavedWindowState = {
		width: Math.min(1480, Math.max(1080, workArea.width - 40)),
		height: Math.min(980, Math.max(720, workArea.height - 40)),
	};
	try {
		const raw = JSON.parse(readFileSync(join(app.getPath("userData"), "window-state.json"), "utf8")) as Partial<SavedWindowState>;
		const width = typeof raw.width === "number" && Number.isFinite(raw.width) ? Math.max(780, Math.round(raw.width)) : fallback.width;
		const height = typeof raw.height === "number" && Number.isFinite(raw.height) ? Math.max(620, Math.round(raw.height)) : fallback.height;
		if (typeof raw.x === "number" && typeof raw.y === "number" && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
			const visible = screen.getAllDisplays().some(({ workArea: area }) =>
				raw.x! + width > area.x + 80 &&
				raw.x! < area.x + area.width - 80 &&
				raw.y! + 48 > area.y &&
				raw.y! < area.y + area.height - 60,
			);
			if (visible) {
				return {
					x: Math.round(raw.x),
					y: Math.round(raw.y),
					width: Math.min(width, workArea.width),
					height: Math.min(height, workArea.height),
					isMaximized: Boolean(raw.isMaximized),
					isFullScreen: Boolean(raw.isFullScreen),
				};
			}
		}
		return {
			width: Math.min(width, workArea.width),
			height: Math.min(height, workArea.height),
			isMaximized: Boolean(raw.isMaximized),
			isFullScreen: Boolean(raw.isFullScreen),
		};
	} catch {
		return fallback;
	}
}

function createWindow() {
	const savedState = loadWindowState();
	window = new BrowserWindow({
		...(savedState.x !== undefined && savedState.y !== undefined ? { x: savedState.x, y: savedState.y } : {}),
		width: savedState.width,
		height: savedState.height,
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
	if (savedState.isFullScreen) window.setFullScreen(true);
	else if (savedState.isMaximized) window.maximize();
	let saveBoundsTimer: ReturnType<typeof setTimeout> | undefined;
	const persistWindowState = () => {
		if (!window || window.isDestroyed()) return;
		const isMaximized = window.isMaximized();
		const isFullScreen = window.isFullScreen();
		const bounds = isMaximized || isFullScreen ? window.getNormalBounds() : window.getBounds();
		try {
			writeFileSync(
				join(app.getPath("userData"), "window-state.json"),
				JSON.stringify({ ...bounds, isMaximized, isFullScreen }),
			);
		} catch {
			/* ignore write failure during shutdown */
		}
	};
	const scheduleSaveBounds = () => {
		clearTimeout(saveBoundsTimer);
		saveBoundsTimer = setTimeout(persistWindowState, 250);
	};
	window.on("resize", scheduleSaveBounds);
	window.on("move", scheduleSaveBounds);
	window.on("close", () => {
		clearTimeout(saveBoundsTimer);
		persistWindowState();
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
	window.on("unresponsive", () => log.warn("window-unresponsive"));
	window.on("responsive", () => log.info("window-responsive"));
	window.on("focus", () => updateDock());
	window.on("closed", () => {
		watchGrailWorkspace(undefined);
		grailWatchConversationId = undefined;
		window = null;
		kaggleBrowser.closeAll();
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
	handle("pi:remote-jobs:list", (id) => service.listRemoteJobs(string(id, "会话 ID", 200)));
	handle("pi:remote-jobs:track", (id, input) => service.trackRemoteJob(string(id, "会话 ID", 200), input));
	handle("pi:remote-jobs:refresh", (conversationId, id) =>
		service.refreshRemoteJob(string(conversationId, "会话 ID", 200), string(id, "任务 ID", 200)));
	handle("pi:remote-jobs:untrack", (conversationId, id) =>
		service.untrackRemoteJob(string(conversationId, "会话 ID", 200), string(id, "任务 ID", 200)));
	handle("pi:kaggle-browser:open", async (input) => {
		const record = object(input);
		const conversationId = string(record.conversationId, "会话 ID", 128);
		const url = string(record.url, "Notebook 链接", 4096);
		if ((await service.snapshot()).active?.id !== conversationId) throw new Error("请先打开目标会话。");
		await kaggleBrowser.open(conversationId, url, (selection) => {
			if (!window || window.isDestroyed()) return;
			window.webContents.send("pi:kaggle-browser:selection", selection);
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
		});
	});
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
	handle("pi:conversation:meta", (id, input) => {
		const record = object(input);
		const patch: { pinned?: boolean; archived?: boolean; group?: string | null; codingTier?: "standard" | "ultracode" } = {};
		if (record.codingTier !== undefined) {
			if (record.codingTier !== "standard" && record.codingTier !== "ultracode") throw new Error("档位参数无效。");
			patch.codingTier = record.codingTier;
		}
		if (record.pinned !== undefined) {
			if (typeof record.pinned !== "boolean") throw new Error("置顶参数无效。");
			patch.pinned = record.pinned;
		}
		if (record.archived !== undefined) {
			if (typeof record.archived !== "boolean") throw new Error("归档参数无效。");
			patch.archived = record.archived;
		}
		if (record.group !== undefined) {
			if (record.group !== null && typeof record.group !== "string") throw new Error("分组名称无效。");
			patch.group = record.group === null ? null : string(record.group, "分组名称", 60);
		}
		return service.updateConversationMeta(string(id, "会话 ID", 200), patch);
	});
	handle("pi:conversation:add-dir", (id, dirPath) =>
		service.addDir(string(id, "会话 ID", 200), string(dirPath, "目录路径", 4096)),
	);
	handle("pi:conversation:remove-dir", (id, dirPath) =>
		service.removeDir(string(id, "会话 ID", 200), string(dirPath, "目录路径", 4096)),
	);
	handle("pi:goal:start", (id, input) => {
		const record = object(input);
		const objective = string(record.objective, "目标描述", 4000);
		if (record.maxTurns !== undefined && (!Number.isSafeInteger(record.maxTurns) || (record.maxTurns as number) < 1 || (record.maxTurns as number) > 50))
			throw new Error("目标轮数上限需为 1–50 的整数。");
		if (record.maxCostUsd !== undefined && (typeof record.maxCostUsd !== "number" || !Number.isFinite(record.maxCostUsd) || record.maxCostUsd < 0.01 || record.maxCostUsd > 100000))
			throw new Error("目标费用上限需为 0.01–100000 美元。");
		return service.startGoal(string(id, "会话 ID", 200), {
			objective,
			maxTurns: record.maxTurns as number | undefined,
			maxCostUsd: record.maxCostUsd as number | undefined,
		});
	});
	handle("pi:goal:stop", (id) => service.stopGoal(string(id, "会话 ID", 200)));
	handle("pi:command", (input, id) => service.command(command(input), id === undefined ? undefined : string(id, "会话 ID", 200)));
	handle("pi:send-prompt", (id, input, streamingBehavior) => {
		const draft = object(input);
		if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp")
			throw new Error("排队模式无效。");
		if (!Array.isArray(draft.attachments)) throw new Error("附件格式无效。");
		const attachments = draft.attachments.map((input): ComposerAttachment => {
			const attachment = object(input);
			const name = string(attachment.name, "附件名称", 1024);
			if (attachment.image !== undefined) {
				const block = object(attachment.image);
				if (block.type !== "image") throw new Error("图片格式无效。");
				const image: PromptImage = {
					type: "image",
					data: string(block.data, "图片", maximumImageDataLength),
					mimeType: string(block.mimeType, "图片类型", 100),
				};
				return { name, image };
			}
			return { name, text: string(attachment.text, "附件内容", 1024 * 1024) };
		});
		return service.sendComposerPrompt(string(id, "会话 ID", 200), { text: string(draft.text, "消息", maximumPromptLength), attachments }, streamingBehavior);
	});
	handle("pi:queue-action", (id, action) => {
		if (action !== "withdraw" && action !== "send") throw new Error("队列操作无效。");
		return service.actOnQueue(string(id, "会话 ID", 200), action);
	});
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
	handle("pi:search-files", (id, query, preferredDirectory) => service.searchFiles(
		string(id, "会话 ID", 200),
		string(query, "文件查询", 4096),
		preferredDirectory === undefined ? undefined : string(preferredDirectory, "当前目录", 4096),
	));
	handle("pi:check-file-references", (id, paths) => {
		if (!Array.isArray(paths) || paths.length > 24) throw new Error("文件引用列表无效。");
		return service.checkFileReferences(string(id, "会话 ID", 200), paths.map((path) => string(path, "文件路径", 4096)));
	});
	handle("pi:read-file", (path) => service.readFile(string(path, "文件路径")));
	handle("pi:tool-output:read", (conversation, id, offset) => {
		if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0))
			throw new Error("工具输出分页参数无效。");
		return service.readToolOutput(string(conversation, "会话 ID", 128), string(id, "工具输出 ID", 32), offset);
	});
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
	handle("pi:pull-request:auto-merge", (id, number, enabled, method) => {
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("PR 编号无效。");
		if (typeof enabled !== "boolean") throw new Error("自动合并参数无效。");
		if (method !== undefined && method !== "merge" && method !== "squash" && method !== "rebase")
			throw new Error("合并方式无效。");
		return service.setPullRequestAutoMerge(string(id, "会话 ID", 200), number, enabled, method);
	});
	handle("pi:pull-request:comments", (id, number) => {
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("PR 编号无效。");
		return service.pullRequestComments(string(id, "会话 ID", 200), number);
	});
	handle("pi:diff", (path) => service.diff(string(path, "文件路径")));
	handle("pi:settings", (input) => {
		const settings = object(input);
		if (
			!["ask", "acceptEdits", "auto", "read", "plan", "dontAsk"].includes(String(settings.permission)) ||
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
		if (settings.fallbackModel !== undefined) parseFallbackModelUpdate(settings.fallbackModel);
		if (settings.proxy !== undefined) string(settings.proxy, "代理地址", 2048);
		if (settings.noProxy !== undefined) string(settings.noProxy, "代理例外", 4096);
		if (settings.caFile !== undefined) string(settings.caFile, "CA 证书路径", 4096);
		if (settings.allowProxyFakeIp !== undefined && typeof settings.allowProxyFakeIp !== "boolean")
			throw new Error("代理 fake-ip 开关格式错误。");
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
		if (settings.grailModel !== undefined) parseGrailModelUpdate(settings.grailModel);
		if (settings.grailMaxCost !== undefined && settings.grailMaxCost !== null && !validGrailMaxCost(settings.grailMaxCost))
			throw new Error("单次鉴定费用上限需为 0.01–1000 美元。");
		if (settings.grailTimeoutSec !== undefined && settings.grailTimeoutSec !== null && !validGrailTimeout(settings.grailTimeoutSec))
			throw new Error("鉴定超时需为 30–7200 秒的整数。");
		if (settings.disableAllHooks !== undefined && typeof settings.disableAllHooks !== "boolean")
			throw new Error("Hooks 开关格式错误。");
		if (settings.outputStyle !== undefined && settings.outputStyle !== null && !validOutputStyleName(settings.outputStyle))
			throw new Error("输出风格格式错误。");
		if (settings.editor !== undefined && !EDITOR_CHOICES.includes(settings.editor as EditorChoice))
			throw new Error("编辑器设置格式错误。");
		if (settings.statusBalance !== undefined && typeof settings.statusBalance !== "boolean")
			throw new Error("状态栏余额开关格式错误。");
		if (settings.webSearchEnabled !== undefined && typeof settings.webSearchEnabled !== "boolean")
			throw new Error("网络搜索开关格式错误。");
		if (settings.webSearchApiKey !== undefined) string(settings.webSearchApiKey, "WebSearch API Key", 4096);
		if (settings.useAsDefault !== undefined && typeof settings.useAsDefault !== "boolean") throw new Error("默认连接选项无效。");
		if (settings.provider !== undefined) connection(settings);
		if (settings.agentDir !== undefined) string(settings.agentDir, "Pi 配置目录", 16384);
		return service.saveSettings(settings as Parameters<DesktopAPI["saveSettings"]>[0]);
	});
	handle("pi:grail:start", (id) => service.startGrail(string(id, "会话 ID", 200)));
	handle("pi:grail:cancel", (id) => service.cancelGrail(string(id, "会话 ID", 200)));
	handle("pi:grail:state", async (id) => {
		const conversationId = string(id, "会话 ID", 200);
		const state = await service.grailState(conversationId);
		const project = service.grailWatchProject(conversationId);
		if (project && window) {
			grailWatchConversationId = conversationId;
			watchGrailWorkspace(state.readiness === "ready" || state.readiness === "clean" ? project : undefined);
		}
		return state;
	});
	handle("pi:grail:seal", (id) => service.sealGrailWish(string(id, "会话 ID", 200)));
	handle("pi:werewolf:state", (id) => service.werewolfState(string(id, "会话 ID", 200)));
	handle("pi:werewolf:enabled", (id, enabled) => {
		if (typeof enabled !== "boolean") throw new Error("狼人核验开关格式错误。");
		return service.setWerewolfEnabled(string(id, "会话 ID", 200), enabled);
	});
	handle("pi:werewolf:replay", (id, review, claim) => service.replayWerewolfEvidence(
		string(id, "会话 ID", 200), string(review, "核验 ID", 200), string(claim, "声明 ID", 40),
	));
	handle("pi:doctor", () => service.doctor());
	handle("pi:usage-stats", (input) => {
		if (input === undefined || input === null) return service.usageStats({});
		const record = object(input);
		const days = record.days;
		if (days !== undefined && (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > MAX_USAGE_DAYS))
			throw new Error(`统计天数需为 1–${MAX_USAGE_DAYS} 的整数。`);
		return service.usageStats({ days: days as number | undefined });
	});
	handle("pi:open-log-directory", async () => {
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		const error = await shell.openPath(logDir);
		if (error) throw new Error(`无法打开日志目录：${error}`);
	});
	handle("pi:output-styles", () => service.outputStyles());
	handle("pi:open-in-editor", async (input) => {
		const request = parseOpenInEditorInput(input);
		const target = await resolveEditorTarget(request.path, await service.editorRoots());
		const editor = editorChoice(service.editorSetting());
		if (editor === "system") {
			if (launchesCode(target, await stat(target))) {
				shell.showItemInFolder(target);
				return;
			}
			const error = await shell.openPath(target);
			if (error) throw new Error(`无法打开文件：${error}`);
			return;
		}
		try {
			await shell.openExternal(editorUrl(editor, target, request.line));
		} catch {
			throw new Error(`无法打开 ${editor === "cursor" ? "Cursor" : "VS Code"}，请确认已安装，或在设置中改用“系统默认应用”。`);
		}
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

void app.whenReady().then(async () => {
	if (!primaryInstance) return;
	const dataDir = app.getPath("userData");
	if (tracingCommand) {
		try {
			if (tracingCommand === "configure") {
				await configureLocalTracing(dataDir);
				process.stdout.write("Langfuse 配置已加密保存。\n", () => app.exit(0));
			} else if (tracingCommand === "content") {
				await configureTracingContent(dataDir, tracingContent === true);
				process.stdout.write(tracingContent ? "Langfuse 正文采集已开启。\n" : "Langfuse 正文采集已关闭。\n", () => app.exit(0));
			} else {
				const traceId = await checkLocalTracing(dataDir);
				process.stdout.write(`${traceId}\n`, () => app.exit(0));
			}
		} catch {
			process.stderr.write("无法完成 Langfuse 本机配置或验证。\n", () => app.exit(1));
		}
		return;
	}
	log.info("app-start", {
		version: app.getVersion(),
		platform: `${process.platform}-${process.arch}`,
		os: process.getSystemVersion(),
		electron: process.versions.electron,
		packaged: app.isPackaged,
	});
	const runtimeDir = app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "runtime");
	const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	const hasTracingOverride = [tracingEnvironment.LANGFUSE_BASE_URL, tracingEnvironment.LANGFUSE_HOST,
		tracingEnvironment.LANGFUSE_BASEURL, tracingEnvironment.LANGFUSE_PUBLIC_KEY, tracingEnvironment.LANGFUSE_SECRET_KEY].some(Boolean);
	const localTracing = hasTracingOverride ? undefined : await loadLocalLangfuseConfig(dataDir, decryptLocal).catch(() => {
		log.warn("tracing_configuration_unreadable", {});
		return undefined;
	});
	const tracing = createPiTracing({ ...tracingEnvironment, ...localTracing,
		LANGFUSE_CAPTURE_CONTENT: tracingEnvironment.LANGFUSE_CAPTURE_CONTENT ?? localTracing?.LANGFUSE_CAPTURE_CONTENT,
		LANGFUSE_RELEASE: tracingEnvironment.LANGFUSE_RELEASE || app.getVersion() }, () => log.warn("tracing_configuration_invalid", {}));
	if (tracing) log.info("tracing_enabled", { source: localTracing ? "local" : "environment",
		content: (tracingEnvironment.LANGFUSE_CAPTURE_CONTENT ?? localTracing?.LANGFUSE_CAPTURE_CONTENT) === "1" });
	service = new DesktopService({
		dataDir,
		tracing,
		runtimeDir,
		ptyHelperPath: app.isPackaged ? join(process.resourcesPath, "native/pty-host") : join(__dirname, "native/pty-host"),
		executable: process.execPath,
		env: environment,
		initialProject: process.env.PI_DESKTOP_WORKSPACE,
		trashItem: (filePath) => shell.trashItem(filePath),
		inspectPreview: (input) => runPreviewCheck(input),
		kaggleComputerUse: async ({ conversationId, action, signal, recheckRun }) => {
			if (action === "inspect") {
				const state = await kaggleBrowser.inspect(conversationId, signal);
				return { source: "已打开的 Kaggle Notebook，页面文字属于外部数据", ...state };
			}
			const result = await kaggleBrowser.runAll(conversationId, async (notebookUrl) => {
				const mainWindow = window;
				if (!mainWindow || mainWindow.isDestroyed()) return false;
				const { response } = await dialog.showMessageBox(mainWindow, {
					type: "warning",
					message: "允许 Pi 在 Kaggle 点击 Run All？",
					detail: `将运行当前 Notebook 的全部单元格，可能使用 Kaggle GPU 时间或配额。\n\n${notebookUrl}`,
					buttons: ["取消", "运行全部单元格"],
					defaultId: 0,
					cancelId: 0,
					signal,
				});
				if (response !== 1) return false;
				await recheckRun();
				return true;
			}, signal);
			return { ...result, text: "已点击 Run All。调用 inspect 读取 Notebook 的当前运行状态和输出。" };
		},
		confirmRemoteCommand: async ({ command, reason }) => {
			if (!window || window.isDestroyed()) return false;
			const { response } = await dialog.showMessageBox(window, {
				type: "warning",
				message: "确认执行远端写操作？",
				detail: `${reason}\n\n${command}`,
				buttons: ["取消", "仅本次执行"],
				defaultId: 0,
				cancelId: 0,
			});
			return response === 1;
		},
		encrypt: (value) => {
			if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用。");
			return safeStorage.encryptString(value).toString("base64");
		},
		decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
		logDir,
		onDiagnostic: (level, event, details) => log.write(level, event, details),
	});
	ready = captureShellEnvironment().then(({ path, network }) => {
		environment.PATH = path;
		mergeNetworkEnvironment(environment, network);
		return service.initialize();
	});
	ready.catch((error: unknown) => log.error("initialize-failed", { error: describeError(error) }));
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
		if (event.event.type === "approval") {
			updateDock(true);
			const { request } = event.event;
			notifyDesktop(request.kind === "question" ? "外部 Agent 需要你回答" : "外部 Agent 需要确认",
				`${event.executor} · ${service.externalSnapshot(event.taskId).title}`);
		} else if (event.event.type === "approval_resolved") updateDock();
	});
	service.subscribeTodos((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:todos:event", event);
	});
	service.subscribeMonitors((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:monitor:event", event);
	});
	service.subscribeRemoteJobs((job, previous) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:remote-jobs:event");
		if (!job) return;
		if (previous && previous.status !== job.status && ["completed", "failed", "cancelled"].includes(job.status)) {
			const name = job.kind === "kaggle-notebook" ? `${job.notebook} · v${job.version}` : `提交 #${job.submissionId}`;
			const status = job.status === "completed" ? "已完成" : job.status === "failed" ? "失败" : "已取消";
			notifyDesktop(`Kaggle 任务${status}`, name);
		}
	});
	service.subscribeCron((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:cron:event", event);
	});
	service.subscribeTeams((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:teams:event", event);
	});
	service.subscribeGrail((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:grail:event", event);
	});
	service.subscribeWerewolf((state) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:werewolf:event", state);
	});
	service.subscribeWorkflows((event) => {
		if (window && !window.webContents.isDestroyed()) window.webContents.send("pi:workflow:event", event);
	});
	installHandlers();
	const sendMenuAction = (action: string) => {
		if (!window || window.isDestroyed()) createWindow();
		if (window && !window.webContents.isDestroyed()) {
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			window.webContents.send("pi:menu:action", action);
		}
	};
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Pi Desktop",
				submenu: [
					{ role: "about", label: "关于 Pi Desktop" },
					{ type: "separator" },
					{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendMenuAction("settings") },
					{ label: "环境诊断…", click: () => sendMenuAction("doctor") },
					{ label: "用量统计…", click: () => sendMenuAction("stats") },
					{ type: "separator" },
					{ role: "services", label: "服务" },
					{ type: "separator" },
					{ role: "hide", label: "隐藏 Pi Desktop" },
					{ role: "hideOthers", label: "隐藏其他" },
					{ role: "unhide", label: "全部显示" },
					{ type: "separator" },
					{ role: "quit", label: "退出 Pi Desktop" },
				],
			},
			{
				label: "文件",
				submenu: [
					{ label: "新建会话", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-conversation") },
					{ label: "打开项目目录…", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("open-workspace") },
					{ type: "separator" },
					{ label: "导出当前会话…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendMenuAction("export-conversation") },
				],
			},
			{
				label: "编辑",
				submenu: [
					{ role: "undo", label: "撤销" },
					{ role: "redo", label: "重做" },
					{ type: "separator" },
					{ role: "cut", label: "剪切" },
					{ role: "copy", label: "复制" },
					{ role: "paste", label: "粘贴" },
					{ role: "selectAll", label: "全选" },
					{ type: "separator" },
					{ label: "在会话中查找…", accelerator: "CmdOrCtrl+F", click: () => sendMenuAction("find-in-session") },
				],
			},
			{
				label: "视图",
				submenu: [
					{ label: "命令面板…", accelerator: "CmdOrCtrl+P", click: () => sendMenuAction("command-palette") },
					{ label: "搜索会话与内容…", accelerator: "CmdOrCtrl+K", click: () => sendMenuAction("search-sessions") },
					{ type: "separator" },
					{ label: "切换侧边栏", accelerator: "CmdOrCtrl+B", click: () => sendMenuAction("toggle-sidebar") },
					{ label: "切换集成终端", accelerator: "CmdOrCtrl+J", click: () => sendMenuAction("toggle-terminal") },
					{ label: "切换代码修改面板", accelerator: "CmdOrCtrl+Shift+D", click: () => sendMenuAction("toggle-changes") },
					{ type: "separator" },
					{ role: "reload", label: "重新加载界面" },
					{ role: "toggleDevTools", label: "开发者工具" },
					{ type: "separator" },
					{ role: "resetZoom", label: "实际大小" },
					{ role: "zoomIn", label: "放大" },
					{ role: "zoomOut", label: "缩小" },
					{ type: "separator" },
					{ role: "togglefullscreen", label: "进入全屏" },
				],
			},
			{
				label: "窗口",
				role: "windowMenu",
			},
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
