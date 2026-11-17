import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	FolderOpen,
	Plus,
	Search,
	Settings,
	Files,
	GitCompareArrows,
	Terminal as TerminalIcon,
	PanelLeftClose,
	PanelLeftOpen,
	Download,
	RefreshCw,
	X,
	ShieldCheck,
	ShieldAlert,
	SquarePen,
	Archive,
	History,
	ListTodo,
	SlidersHorizontal,
	GitFork,
	BookOpen,
	Globe,
	Command as CommandIcon,
	Check,
	Circle,
	LoaderCircle,
} from "lucide-react";
import type {
	Conversation,
	DesktopAPI,
	DesktopTask,
	ExternalTask,
	PermissionMode,
	ProjectTrustDecision,
	Snapshot,
} from "../shared.ts";
import { IconButton, Modal, PiMark } from "../prototype/ui.tsx";
import { useDesktop } from "./useDesktop.ts";
import { TranscriptView, type TodoItem } from "./TranscriptView.tsx";
import { LiveComposer, type BuiltinSlashAction } from "./LiveComposer.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { WorkspacePanel } from "./WorkspacePanel.tsx";
import { ControlsDialog } from "./ControlsDialog.tsx";
import { CheckpointsDialog } from "./CheckpointsDialog.tsx";
import { TasksDrawer } from "./TasksDrawer.tsx";
import { SessionsDialog } from "./SessionsDialog.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { MemoryStatusDialog } from "./MemoryStatusDialog.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
import { ProjectTrustDialog } from "./ProjectTrustDialog.tsx";
import "../prototype/style.css";
import "./style.css";

const DAY = 24 * 60 * 60 * 1000;
function dayStart(value: number): number {
	const date = new Date(value);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function dayLabel(timestamp: number, now: number): string {
	const diff = Math.floor((dayStart(now) - dayStart(timestamp)) / DAY);
	if (diff <= 0) return "今天";
	if (diff === 1) return "昨天";
	if (diff < 7) return "近 7 天";
	if (diff < 30) return "近 30 天";
	return "更早";
}
function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function projectName(snapshot: Snapshot, path: string): string {
	const found = snapshot.projects.find((item) => item.path === path);
	return found?.name ?? path.split("/").filter(Boolean).pop() ?? path;
}
function grouped(snapshot: Snapshot): { label: string; items: Conversation[] }[] {
	const now = Date.now();
	const order = ["今天", "昨天", "近 7 天", "近 30 天", "更早"];
	const buckets = new Map<string, Conversation[]>();
	for (const session of [...snapshot.conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
		const label = dayLabel(session.updatedAt, now);
		const list = buckets.get(label) ?? [];
		list.push(session);
		buckets.set(label, list);
	}
	return order.filter((label) => buckets.has(label)).map((label) => ({ label, items: buckets.get(label)! }));
}

function Desktop({ api }: { api: DesktopAPI }) {
	const app = useDesktop(api);
	const { snapshot, history, running, changing, bashBusy } = app;
	const [sidebar, setSidebar] = useState(true);
	const [settings, setSettings] = useState(false);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [pane, setPane] = useState<"changes" | "files" | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [controlsTab, setControlsTab] = useState<"tools" | "permissions" | "executors" | null>(null);
	const [checkpointsOpen, setCheckpointsOpen] = useState(false);
	const [rewindQuery, setRewindQuery] = useState<string | undefined>(undefined);
	const [tasksOpen, setTasksOpen] = useState(false);
	const [taskInitialId, setTaskInitialId] = useState<string | undefined>(undefined);
	const [sessionsOpen, setSessionsOpen] = useState(false);
	const [memoryTab, setMemoryTab] = useState<"memory" | "status" | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [trustOpen, setTrustOpen] = useState(false);
	const [trustBusy, setTrustBusy] = useState(false);
	const [todoExpanded, setTodoExpanded] = useState(false);
	const [tasksMap, setTasksMap] = useState<Record<string, DesktopTask>>({});
	const [externalTasksMap, setExternalTasksMap] = useState<Record<string, ExternalTask>>({});
	const [gitSummary, setGitSummary] = useState<{ branch: string; count: number; isGit: boolean } | null>(null);
	const [rename, setRename] = useState<string | null>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const stickToEnd = useRef(true);
	useEffect(() => {
		stickToEnd.current = true;
	}, [snapshot?.active?.id]);
	useEffect(() => {
		setTrustOpen(false);
	}, [snapshot?.active?.project]);
	useEffect(() => {
		if (stickToEnd.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
	}, [history, running]);
	useEffect(() => {
		let active = true;
		void api.tasks.list().then((list) => {
			if (!active) return;
			const next: Record<string, DesktopTask> = {};
			for (const t of list) next[t.id] = t;
			setTasksMap(next);
		}).catch(() => {});
		void api.externalAgents.list().then((list) => {
			if (!active) return;
			const next: Record<string, ExternalTask> = {};
			for (const t of list) next[t.id] = t;
			setExternalTasksMap(next);
		}).catch(() => {});
		const unsub = api.tasks.onEvent((event) => {
			if (event.type === "task_updated") {
				setTasksMap((prev) => {
					const current = prev[event.task.id];
					if (current && current.revision >= event.task.revision) return prev;
					return { ...prev, [event.task.id]: event.task };
				});
			}
		});
		const unsubExt = api.externalAgents.onEvent((packet) => {
			if (packet.event.type === "task_updated") {
				const t = packet.event.task;
				setExternalTasksMap((prev) => {
					const current = prev[t.id];
					if (current && current.revision >= t.revision) return prev;
					return { ...prev, [t.id]: t };
				});
			}
		});
		return () => {
			active = false;
			unsub();
			unsubExt();
		};
	}, [api]);
	useEffect(() => {
		if (!snapshot?.active?.project) {
			setGitSummary(null);
			return;
		}
		let active = true;
		void api
			.workspace()
			.then((ws) => {
				if (active) setGitSummary({ branch: ws.branch, count: ws.changes.length, isGit: ws.isGit });
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [snapshot?.active?.project, app.revision]);
	const blocked = running || changing || bashBusy;
	const project = snapshot?.projects.find((item) => item.path === snapshot.active?.project);
	const taskList = [...Object.values(tasksMap), ...Object.values(externalTasksMap)];
	const activeTaskCount = taskList.filter((t) => t.status === "running" || t.status === "queued").length;
	const waitingTaskCount = taskList.filter((t) => t.status === "waiting_for_input").length;
	const switchTo = (operation: () => ReturnType<DesktopAPI["snapshot"]>) => {
		setSearching(false);
		setPane(null);
		void app.switchTo(operation);
	};
	const savePermission = async (permission: PermissionMode) => {
		if (!snapshot) return;
		if (permission !== "read" && planMode) setPlanMode(false);
		await app.switchTo(() => api.saveSettings({ permission, theme: snapshot.settings.theme }));
	};
	const decideTrust = async (decision: ProjectTrustDecision) => {
		if (!snapshot?.trust || trustBusy) return;
		setTrustBusy(true);
		try {
			app.apply(await api.setProjectTrust({ project: snapshot.trust.project, decision }));
			app.setNotice(decision === "trusted" ? "项目配置已加载。" : "项目配置已禁用。");
			setTrustOpen(false);
		} catch (error) {
			app.fail(error);
		} finally {
			setTrustBusy(false);
		}
	};
	const togglePlanMode = async () => {
		if (!snapshot) return;
		if (planMode) {
			setPlanMode(false);
			await savePermission("ask");
		} else {
			setPlanMode(true);
			if (snapshot.settings.permission !== "read") await savePermission("read");
			if (!app.draft.trim()) app.setDraft("请先以只读方式调研相关代码并输出详细实现计划，待我确认后再修改文件：\n");
		}
	};
	const approvePlanAndExecute = async (mode: PermissionMode) => {
		if (!snapshot) return;
		setPlanMode(false);
		await app.switchTo(() => api.saveSettings({ permission: mode, theme: snapshot.settings.theme }));
		await app.send({ type: "prompt", message: "计划已批准。请严格按上述计划实施代码修改并运行相关测试验证。", images: [] });
	};
	const sendInitPrompt = () => {
		app.setDraft("请分析当前项目结构、构建脚本、测试命令和代码规范，创建或更新根目录的 AGENTS.md 项目指南文件。");
	};
	const handleBuiltinSlash = (action: BuiltinSlashAction) => {
		if (action === "compact") {
			if (!blocked && history.messages.length) void app.command({ type: "compact" });
		} else if (action === "new") {
			if (!blocked && snapshot?.active) switchTo(() => api.newConversation());
		} else if (action === "permissions") {
			setControlsTab("permissions");
		} else if (action === "mcp") {
			setControlsTab("tools");
		} else if (action === "rewind") {
			setRewindQuery(undefined);
			setCheckpointsOpen(true);
		} else if (action === "tasks") {
			setTaskInitialId(undefined);
			setTasksOpen(true);
		} else if (action === "sessions") {
			setSessionsOpen(true);
		} else if (action === "memory") {
			setMemoryTab("memory");
		} else if (action === "status") {
			setMemoryTab("status");
		} else if (action === "init") {
			sendInitPrompt();
		} else if (action === "preview") {
			setPane(null);
			setPreviewUrl((prev) => prev ?? "http://localhost:3000");
		} else if (action === "cost") {
			const s = snapshot?.stats;
			if (s) {
				app.setNotice(
					`会话统计：输入 ${s.tokens.input} · 输出 ${s.tokens.output} · 总计 ${s.tokens.total} tokens · 费用 $${s.cost.toFixed(4)}`,
				);
			} else {
				app.setNotice("当前会话暂无 Token 统计。");
			}
		} else if (action === "plan") {
			void togglePlanMode();
		}
	};
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const lower = event.key.toLowerCase();
			if (lower === "k") {
				event.preventDefault();
				setQuery("");
				setSearching(true);
			}
			if (lower === "p") {
				event.preventDefault();
				setPaletteOpen((open) => !open);
			}
			if (lower === "n" && snapshot?.active && !blocked) {
				event.preventDefault();
				switchTo(() => api.newConversation());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
	if (!snapshot)
		return (
			<div className="cl-start">
				<PiMark />
				<h1>Pi Desktop</h1>
				<p>{app.error || "正在连接本地 Pi…"}</p>
				{app.error && (
					<button className="primary-button" onClick={() => void app.refresh()}>
						重试连接
					</button>
				)}
			</div>
		);
	const ready = snapshot.engineStatus === "ready";
	const groups = grouped(snapshot);
	const latestTodos: TodoItem[] = (() => {
		for (let i = history.messages.length - 1; i >= 0; i--) {
			const msg = history.messages[i];
			if (msg.role !== "assistant") continue;
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const block = msg.content[j];
				if (block.type === "toolCall" && block.name === "TodoWrite" && block.arguments && typeof block.arguments === "object") {
					const todos = (block.arguments as { todos?: TodoItem[] }).todos;
					if (Array.isArray(todos)) return todos;
				}
			}
		}
		return [];
	})();
	const lastMessage = history.messages[history.messages.length - 1];
	const showPlanApproval =
		planMode &&
		snapshot.settings.permission === "read" &&
		!running &&
		!blocked &&
		Boolean(lastMessage && lastMessage.role === "assistant");
	const paletteActions: PaletteAction[] = [
		{ id: "new", label: "新建会话", shortcut: "⌘N", keywords: "new session clear", disabled: blocked || !snapshot.active, run: () => switchTo(() => api.newConversation()) },
		{ id: "search", label: "搜索历史会话", shortcut: "⌘K", keywords: "search find", run: () => { setQuery(""); setSearching(true); } },
		{ id: "open", label: "打开项目文件夹", keywords: "open project folder", disabled: blocked, run: () => void app.switchTo(() => api.openProject()) },
		{ id: "plan", label: planMode ? "退出 Plan 计划模式" : "进入 Plan 计划模式", keywords: "plan mode readonly", disabled: blocked, run: () => void togglePlanMode() },
		{ id: "rewind", label: "检查点与代码回滚 (/rewind)", keywords: "git checkpoint restore", disabled: !snapshot.active, run: () => { setRewindQuery(undefined); setCheckpointsOpen(true); } },
		{ id: "tasks", label: "后台任务、子 Agent 与 Worktree (/tasks)", keywords: "subagent external codex claude kimi", run: () => { setTaskInitialId(undefined); setTasksOpen(true); } },
		{ id: "tools", label: "工具与 MCP 开关 (/mcp)", keywords: "tools mcp enable", run: () => setControlsTab("tools") },
		{ id: "perms", label: "细粒度权限规则 (/permissions)", keywords: "allow ask deny rules", run: () => setControlsTab("permissions") },
		{ id: "sessions", label: "会话分支树与 CLI 历史导入 (/sessions)", keywords: "tree fork clone cli", disabled: !snapshot.active, run: () => setSessionsOpen(true) },
		{ id: "memory", label: "项目记忆 AGENTS.md / CLAUDE.md (/memory)", keywords: "memory rules instructions", disabled: !snapshot.active, run: () => setMemoryTab("memory") },
		{ id: "status", label: "运行与上下文状态 (/status)", keywords: "status tokens cost model", run: () => setMemoryTab("status") },
		{ id: "init", label: "/init 生成项目 AGENTS.md 指南", keywords: "init onboard agents.md", disabled: !snapshot.active, run: () => sendInitPrompt() },
		{ id: "preview", label: previewUrl ? "关闭本地网页预览" : "打开本地网页预览 (/preview)", keywords: "web preview localhost", run: () => { setPane(null); setPreviewUrl((v) => (v ? null : "http://localhost:3000")); } },
		{ id: "terminal", label: terminalOpen ? "关闭终端面板" : "打开终端 / PTY 面板", keywords: "terminal bash pty", run: () => setTerminalOpen((v) => !v) },
		{ id: "changes", label: "查看 Git 修改与暂存提交", keywords: "git diff stage commit", run: () => { setPreviewUrl(null); setPane(pane === "changes" ? null : "changes"); } },
		{ id: "files", label: "浏览项目文件", keywords: "files explorer", run: () => { setPreviewUrl(null); setPane(pane === "files" ? null : "files"); } },
		{ id: "compact", label: "压缩会话上下文 (/compact)", keywords: "compact context", disabled: blocked || !history.messages.length, run: () => void app.command({ type: "compact" }) },
		{ id: "settings", label: "打开客户端与模型设置", keywords: "settings model api key theme", run: () => setSettings(true) },
	];
	return (
		<div className={`desktop-app live-app ${sidebar ? "" : "cl-side-hidden"} ${pane || previewUrl ? "has-inspector" : ""}`}>
			<nav className="cl-rail" aria-label="主导航">
				{sidebar ? (
					<IconButton icon={PanelLeftClose} label="收起侧栏" onClick={() => setSidebar(false)} />
				) : (
					<IconButton icon={PanelLeftOpen} label="展开侧栏" onClick={() => setSidebar(true)} />
				)}
				<IconButton
					icon={SquarePen}
					label="新建会话"
					disabled={blocked || !snapshot.active}
					onClick={() => switchTo(() => api.newConversation())}
				/>
				<IconButton
					icon={Search}
					label="搜索会话"
					onClick={() => {
						setQuery("");
						setSearching(true);
					}}
				/>
				<IconButton icon={FolderOpen} label="打开项目" disabled={blocked} onClick={() => void app.switchTo(() => api.openProject())} />
				<span className="cl-rail-spacer" />
				<IconButton icon={Settings} label="设置" active={settings} onClick={() => setSettings(true)} />
			</nav>
			{sidebar && (
				<aside className="cl-side" aria-label="项目与会话">
					<div className="cl-side-head">
						<span className="cl-side-title">会话</span>
					</div>
					<div className="cl-side-actions">
						<button className="cl-side-action" disabled={blocked || !snapshot.active} onClick={() => switchTo(() => api.newConversation())}>
							<Plus size={16} />
							<span>新建会话</span>
							<kbd>⌘N</kbd>
						</button>
						<button
							className="cl-side-action"
							onClick={() => {
								setQuery("");
								setSearching(true);
							}}
						>
							<Search size={16} />
							<span>搜索会话</span>
							<kbd>⌘K</kbd>
						</button>
						<button className="cl-side-action" disabled={blocked} onClick={() => void app.switchTo(() => api.openProject())}>
							<FolderOpen size={16} />
							<span>打开项目</span>
						</button>
					</div>
					<div className="cl-side-scroll">
						{groups.map((group) => (
							<section className="cl-group" key={group.label}>
								<div className="cl-group-label">{group.label}</div>
								{group.items.map((session) => (
									<button
										className={`cl-conv ${session.id === snapshot.active?.id ? "selected" : ""}`}
										key={session.id}
										disabled={blocked}
										onClick={() => switchTo(() => api.selectConversation(session.id))}
										aria-current={session.id === snapshot.active?.id ? "page" : undefined}
									>
										<span className="cl-conv-title">{session.title}</span>
										<span className="cl-conv-sub">
											{projectName(snapshot, session.project)} · {formatTime(session.updatedAt)}
										</span>
									</button>
								))}
							</section>
						))}
						{!snapshot.conversations.length && <p className="cl-side-empty">还没有会话。打开项目，开始第一次编码任务。</p>}
					</div>
					<div className="cl-side-foot">
						<span className={`cl-engine ${ready ? "ok" : ""}`}>
							<i />
							{ready ? "Pi 引擎已连接" : "Pi 引擎未就绪"}
						</span>
						<span className="cl-foot-project">{project?.name ?? "本地工作区"}</span>
					</div>
				</aside>
			)}
			<main className="cl-main">
				<header className="cl-top">
					<div className="cl-top-title">
						<button
							className="cl-title-button"
							disabled={blocked || !snapshot.active}
							onClick={() => setRename(snapshot.active?.title ?? "")}
						>
							{snapshot.active?.title ?? "打开一个项目开始"}
						</button>
						{project && (
							<span className="cc-project-pill" title={project.path}>
								{project.name}
								{gitSummary?.isGit && gitSummary.branch ? ` · ${gitSummary.branch}` : ""}
							</span>
						)}
					</div>
					<div className="cl-top-tools">
						{snapshot.trust?.required && (
							<IconButton
								icon={ShieldCheck}
								label={
									snapshot.trust.decision === "trusted"
										? "项目配置：已信任"
										: snapshot.trust.decision === "untrusted"
											? "项目配置：已禁用"
											: "项目配置：待决定"
								}
								active={trustOpen}
								onClick={() => setTrustOpen(true)}
							/>
						)}
						<IconButton icon={History} label="检查点与回滚" disabled={!snapshot.active} onClick={() => { setRewindQuery(undefined); setCheckpointsOpen(true); }} />
						<span className="cc-tool-btn-wrap">
							<IconButton icon={ListTodo} label="后台任务与 Worktree" onClick={() => { setTaskInitialId(undefined); setTasksOpen(true); }} />
							{(activeTaskCount > 0 || waitingTaskCount > 0) && (
								<span className={`cc-topbar-badge ${waitingTaskCount > 0 ? "warn" : ""}`}>
									{waitingTaskCount > 0 ? `!${waitingTaskCount}` : activeTaskCount}
								</span>
							)}
						</span>
						<IconButton icon={SlidersHorizontal} label="工具与权限" onClick={() => setControlsTab("tools")} />
						<IconButton icon={GitFork} label="会话分支树" disabled={!snapshot.active} onClick={() => setSessionsOpen(true)} />
						<IconButton icon={BookOpen} label="项目记忆与状态" disabled={!snapshot.active} onClick={() => setMemoryTab("memory")} />
						<IconButton icon={Globe} label="本地网页预览" onClick={() => { setPane(null); setPreviewUrl((v) => (v ? null : "http://localhost:3000")); }} active={Boolean(previewUrl)} />
						<IconButton icon={CommandIcon} label="命令面板" onClick={() => setPaletteOpen(true)} />
						<IconButton icon={RefreshCw} label="刷新会话" disabled={blocked} onClick={() => void app.refresh()} />
						<IconButton icon={Archive} label="压缩上下文" disabled={blocked || !history.messages.length} onClick={() => void app.command({ type: "compact" })} />
						<IconButton
							icon={Download}
							label="导出会话"
							disabled={blocked || !snapshot.active}
							onClick={() => {
								void api
									.exportConversation()
									.then((path) => {
										if (path) app.setNotice(`会话已导出：${path}`);
									})
									.catch(app.fail);
							}}
						/>
						<IconButton icon={TerminalIcon} label="终端" onClick={() => setTerminalOpen(!terminalOpen)} active={terminalOpen} />
						<IconButton
							icon={GitCompareArrows}
							label="代码修改"
							onClick={() => { setPreviewUrl(null); setPane(pane === "changes" ? null : "changes"); }}
							active={pane === "changes"}
						/>
						<IconButton
							icon={Files}
							label="项目文件"
							onClick={() => { setPreviewUrl(null); setPane(pane === "files" ? null : "files"); }}
							active={pane === "files"}
						/>
					</div>
				</header>
				{(app.error || snapshot.engineError) && (
					<div className="cl-banner cl-banner-error" role="alert">
						<span>{app.error || snapshot.engineError}</span>
						<button
							onClick={() => {
								app.setError("");
								if (snapshot.engineError) void app.refresh();
							}}
							aria-label="关闭错误提示"
						>
							<X size={14} />
						</button>
					</div>
				)}
				{app.notice && (
					<div className="cl-banner" role="status">
						<span>{app.notice}</span>
						<button aria-label="关闭状态提示" onClick={() => app.setNotice("")}>
							<X size={14} />
						</button>
					</div>
				)}
				{snapshot.trust?.required && !snapshot.trust.decision && (
					<div className="cl-trust-banner" role="alert">
						<ShieldCheck size={16} />
						<div className="cl-trust-text">
							<strong>项目配置尚未加载</strong>
							<span>
								检测到 {snapshot.trust.resources.join("、")}。信任后才会加载项目 MCP、Skills 与设置。
							</span>
						</div>
						<button
							type="button"
							className="secondary-button"
							disabled={trustBusy || blocked}
							onClick={() => void decideTrust("trusted")}
						>
							信任并加载
						</button>
						<button
							type="button"
							className="cc-mini-btn"
							disabled={trustBusy || blocked}
							onClick={() => void decideTrust("untrusted")}
						>
							保持禁用
						</button>
					</div>
				)}
				{snapshot.settings.permission === "auto" && (
					<div className="cl-auto-warning" role="status">
						<ShieldAlert size={16} />
						<span>
							<strong>跳过确认模式</strong>：Pi 可在不询问的情况下执行命令；当前没有 OS 沙箱。
						</span>
						<button type="button" className="secondary-button" disabled={blocked} onClick={() => void savePermission("ask")}>
							切回手动确认
						</button>
					</div>
				)}
				{!snapshot.models.length && (
					<div className="cl-connect">
						<ShieldCheck size={17} />
						<span>尚未找到可用模型。可复用 Pi 的登录配置，或在设置中连接模型服务。</span>
						<button className="secondary-button" onClick={() => setSettings(true)}>
							模型连接设置
						</button>
					</div>
				)}
				<div className="cl-body">
					<div className="cl-conversation">
						<div
							className="cl-scroll"
							ref={scroll}
							onScroll={(event) => {
								const element = event.currentTarget;
								stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
							}}
						>
							{history.messages.length ? (
								<TranscriptView
									transcript={history}
									tasks={Object.values(tasksMap)}
									externalTasks={Object.values(externalTasksMap)}
									onOpenTask={(id) => {
										setTaskInitialId(id);
										setTasksOpen(true);
									}}
									onRewindPrompt={(promptText) => {
										setRewindQuery(promptText);
										setCheckpointsOpen(true);
									}}
									onForkPrompt={(promptText) => {
										void api.sessions
											.forkMessages(snapshot.active?.id)
											.then(async ({ messages }) => {
												const match = messages.find((m) => m.text.trim() === promptText.trim() || promptText.includes(m.text.slice(0, 40)));
												if (match) {
													await api.sessions.fork({ conversationId: snapshot.active?.id, entryId: match.entryId, activate: true });
													await app.refresh();
												} else {
													setSessionsOpen(true);
												}
											})
											.catch(app.fail);
									}}
									onOpenPreview={(url) => {
										setPane(null);
										setPreviewUrl(url);
									}}
								/>
							) : (
								<div className="cl-empty">
									<PiMark />
									<h1>{snapshot.active ? "开始一个真实编码任务" : "选择项目文件夹"}</h1>
									<p>
										{snapshot.active
											? "Pi 会读取项目文件、修改代码并执行工具。"
											: "打开你要工作的目录，Pi 会在该目录中运行。"}
									</p>
									{!snapshot.active && (
										<button className="primary-button" onClick={() => void app.switchTo(() => api.openProject())}>
											打开项目
										</button>
									)}
									{snapshot.active && <p className="cl-empty-path">{snapshot.active.project}</p>}
									<div className="cc-empty-hints">
										<span><kbd>⌘N</kbd> 新建会话</span>
										<span><kbd>⌘K</kbd> 搜索会话</span>
										<span><kbd>/</kbd> 斜杠命令</span>
										<span><kbd>Shift+Enter</kbd> 换行</span>
									</div>
								</div>
							)}
							{running && (
								<div className="cl-working" role="status">
									<span className="cl-spinner" />
									Pi 正在工作
									{snapshot.state?.pendingMessageCount ? ` · ${snapshot.state.pendingMessageCount} 条指令待处理` : ""}
								</div>
							)}
						</div>
						{latestTodos.length > 0 && (
							<div className="cc-pinned-todos">
								<button type="button" className="cc-pinned-todos-head" onClick={() => setTodoExpanded((v) => !v)}>
									<span>
										任务进度 ({latestTodos.filter((t) => t.status === "completed").length}/{latestTodos.length})
										{latestTodos.find((t) => t.status === "in_progress")
											? ` · ${latestTodos.find((t) => t.status === "in_progress")!.content}`
											: ""}
									</span>
									<span>{todoExpanded ? "收起" : "展开"}</span>
								</button>
								{todoExpanded && (
									<div className="cc-pinned-todos-list">
										{latestTodos.map((item) => (
											<div key={item.id} className={`cc-todo-row ${item.status}`}>
												{item.status === "completed" ? (
													<Check size={12} className="ok" />
												) : item.status === "in_progress" ? (
													<LoaderCircle size={12} className="spin run" />
												) : (
													<Circle size={11} className="pending" />
												)}
												<span>{item.content}</span>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{showPlanApproval && (
							<div className="cc-plan-bar" role="region" aria-label="计划审批">
								<span>Plan 模式调研已完成，是否按计划开始实施？</span>
								<div className="cc-plan-bar-actions">
									<button
										type="button"
										className="primary-button"
										title="除规则外不再询问；命令以本机权限运行"
										onClick={() => void approvePlanAndExecute("auto")}
									>
										批准计划 · 跳过确认
									</button>
									<button type="button" className="secondary-button" onClick={() => void approvePlanAndExecute("ask")}>
										批准计划 · 逐项确认
									</button>
									<button type="button" className="cc-mini-btn" onClick={() => void togglePlanMode()}>
										退出 Plan
									</button>
								</div>
							</div>
						)}
						<LiveComposer
							key={snapshot.active?.id ?? "no-conversation"}
							snapshot={snapshot}
							draft={app.draft}
							setDraft={app.setDraft}
							running={running}
							changing={changing || bashBusy}
							planMode={planMode}
							onTogglePlanMode={() => void togglePlanMode()}
							send={app.send}
							stop={() => void app.command({ type: "abort" })}
							command={app.command}
							setPermission={(permission) => void savePermission(permission)}
							openSettings={() => setSettings(true)}
							onBuiltinSlash={handleBuiltinSlash}
							fail={app.fail}
						/>
					</div>
					{terminalOpen && (
						<TerminalPanel
							conversationId={snapshot.active?.id}
							project={snapshot.active?.project}
							ready={ready}
							blocked={blocked}
							readOnly={snapshot.settings.permission === "read"}
							bashBusy={bashBusy}
							bashOutput={app.terminal}
							onRunBash={(cmd) => app.bash(cmd)}
							onAbortBash={() => void app.command({ type: "abort_bash" })}
							onClose={() => setTerminalOpen(false)}
							fail={app.fail}
						/>
					)}
				</div>
			</main>
			{pane && (
				<WorkspacePanel
					key={`${snapshot.active?.project}-${pane}`}
					pane={pane}
					setPane={setPane}
					close={() => setPane(null)}
					revision={app.revision}
					project={snapshot.active?.project}
					readOnly={snapshot.settings.permission === "read"}
					onReferenceFile={(filePath) => {
						const prefix = app.draft && !app.draft.endsWith(" ") && !app.draft.endsWith("\n") ? `${app.draft} ` : app.draft;
						app.setDraft(`${prefix}@${filePath} `);
					}}
					onWorkspaceMutated={() => void app.refresh()}
					onNotice={(msg) => app.setNotice(msg)}
				/>
			)}
			{!pane && previewUrl && (
				<PreviewPanel
					initialUrl={previewUrl}
					close={() => setPreviewUrl(null)}
				/>
			)}
			{trustOpen && snapshot.trust?.required && (
				<ProjectTrustDialog
					trust={snapshot.trust}
					busy={trustBusy || blocked}
					close={() => setTrustOpen(false)}
					decide={(decision) => void decideTrust(decision)}
				/>
			)}
			{settings && (
				<SettingsDialog
					settings={snapshot.settings}
					presets={snapshot.providerPresets}
					busy={blocked}
					close={() => setSettings(false)}
					apply={app.apply}
					fail={app.fail}
				/>
			)}
			{searching && (
				<Modal title="搜索会话" close={() => setSearching(false)}>
					<div className="search-dialog-input">
						<Search size={17} />
						<input
							autoFocus
							aria-label="搜索会话标题或项目"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索标题或项目路径…"
						/>
					</div>
					<div className="search-results">
						{snapshot.conversations
							.filter((session) => `${session.title} ${session.project}`.toLowerCase().includes(query.toLowerCase()))
							.map((session) => (
								<button
									disabled={blocked}
									key={session.id}
									onClick={() => switchTo(() => api.selectConversation(session.id))}
								>
									<div>
										<strong>{session.title}</strong>
										<span>{session.project}</span>
									</div>
								</button>
							))}
					</div>
				</Modal>
			)}
			{rename !== null && (
				<Modal title="重命名会话" close={() => setRename(null)}>
					<form
						className="simple-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							if (snapshot.active && rename.trim()) {
								void app.switchTo(() => api.renameConversation(snapshot.active!.id, rename.trim()));
								setRename(null);
							}
						}}
					>
						<label className="field-label">
							会话名称
							<input
								autoFocus
								aria-label="会话名称"
								value={rename}
								onChange={(event) => setRename(event.target.value)}
							/>
						</label>
						<div className="dialog-actions">
							<button className="primary-button" disabled={!rename.trim()}>
								保存名称
							</button>
						</div>
					</form>
				</Modal>
			)}
			{app.requests[0] && (
				<PermissionDialog
					key={app.requests[0].id}
					request={app.requests[0]}
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					respond={app.respond}
					fail={app.fail}
				/>
			)}
			{controlsTab && (
				<ControlsDialog
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					initialTab={controlsTab}
					close={() => setControlsTab(null)}
					fail={app.fail}
				/>
			)}
			{checkpointsOpen && (
				<CheckpointsDialog
					conversationId={snapshot.active?.id}
					initialQuery={rewindQuery}
					close={() => setCheckpointsOpen(false)}
					onRestored={(msg) => {
						app.setNotice(msg);
						void app.refresh();
					}}
					fail={app.fail}
				/>
			)}
			{tasksOpen && (
				<TasksDrawer
					project={snapshot.active?.project}
					initialTaskId={taskInitialId}
					close={() => setTasksOpen(false)}
					onNotice={(msg) => app.setNotice(msg)}
					fail={app.fail}
				/>
			)}
			{sessionsOpen && (
				<SessionsDialog
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					onSnapshot={() => void app.refresh()}
					onEditorText={(text) => app.setDraft(text)}
					close={() => setSessionsOpen(false)}
					fail={app.fail}
				/>
			)}
			{memoryTab && (
				<MemoryStatusDialog
					initialTab={memoryTab}
					snapshot={snapshot}
					gitBranch={gitSummary?.branch}
					onInitPrompt={sendInitPrompt}
					onNotice={(msg) => app.setNotice(msg)}
					close={() => setMemoryTab(null)}
					fail={app.fail}
				/>
			)}
			{paletteOpen && (
				<CommandPalette
					actions={paletteActions}
					close={() => setPaletteOpen(false)}
				/>
			)}
		</div>
	);
}
// Preload presence is a host boundary: browser-only previews have no privileged bridge.
createRoot(document.getElementById("root")!).render(
	window.pi ? (
		<Desktop api={window.pi} />
	) : (
		<div className="cl-start">
			<PiMark />
			<h1>请在 Pi Desktop 桌面应用中打开</h1>
			<p>真实项目访问和 Pi 引擎通过桌面进程连接，此页面没有模拟后端。</p>
		</div>
	),
);
