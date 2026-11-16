import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
	PanelLeft,
	ListTodo,
	Terminal as TerminalIcon,
	Files,
	Globe,
	GitCompareArrows,
	ChevronDown,
	GitBranch,
	Search,
	X,
	Check,
	FolderOpen,
	Plus,
	MessageSquare,
	ChevronRight,
} from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Composer } from "./Composer";
import { Chat } from "./Chat";
import { Inspector } from "./Inspector";
import { Settings, type Theme } from "./Settings";
import { Terminal } from "./Terminal";
import { IconButton, Modal } from "./ui";
import { initialSessions, type Mode, type Panel, type Session, type SessionStatus } from "./data";
import "./style.css";
type Overlay = "search" | "settings" | "project" | "rename" | "commit" | null;
interface SavedState {
	theme: Theme;
	mode: Mode;
	model: string;
	sessions: Session[];
	active: string;
}
const storageKey = "pi-desktop-prototype-v1";
function readSaved(): Partial<SavedState> {
	try {
		const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as SavedState | null;
		if (
			!value ||
			!Array.isArray(value.sessions) ||
			!value.sessions.every(
				(session) =>
					typeof session.id === "string" &&
					typeof session.title === "string" &&
					typeof session.project === "string" &&
					Array.isArray(session.messages),
			)
		)
			return {};
		return {
			...value,
			sessions: value.sessions.map((session) => ({
				...session,
				status: session.status === "working" ? "stopped" : session.status,
			})),
		};
	} catch {
		return {};
	}
}
function App() {
	const [saved] = useState(readSaved);
	const [sessions, setSessions] = useState<Session[]>(saved.sessions?.length ? saved.sessions : initialSessions);
	const [active, setActive] = useState(saved.active ?? "search");
	const [theme, setTheme] = useState<Theme>(saved.theme ?? "light");
	const [mode, setMode] = useState<Mode>(saved.mode ?? "手动确认");
	const [model, setModel] = useState(saved.model ?? "Claude Sonnet");
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [panel, setPanel] = useState<Panel | null>("changes");
	const [selectedFile, setSelectedFile] = useState(0);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [rename, setRename] = useState("");
	const [projectPath, setProjectPath] = useState("");
	const [commitMessage, setCommitMessage] = useState("feat: Add session search");
	const [toast, setToast] = useState("");
	const [inspectorWidth, setInspectorWidth] = useState(450);
	const [sidebarWidth, setSidebarWidth] = useState(248);
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const scrollArea = useRef<HTMLDivElement>(null);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const conversation = sessions.find((session) => session.id === active) ?? sessions[0];
	const isNew = Boolean(conversation.custom && conversation.messages.length === 0);
	const filtered = sessions.filter((session) =>
		`${session.title} ${session.project}`.toLowerCase().includes(searchQuery.toLowerCase()),
	);
	const notify = useCallback((message: string) => {
		setToast(message);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(""), 4200);
	}, []);
	const updateStatus = useCallback(
		(id: string, status: SessionStatus) =>
			setSessions((items) => items.map((session) => (session.id === id ? { ...session, status } : session))),
		[],
	);
	const create = useCallback(
		(project?: string, title = "新会话") => {
			const id = crypto.randomUUID();
			setSessions((items) => [
				{
					id,
					title,
					project: project ?? conversation.project,
					time: "刚刚",
					status: "idle",
					custom: true,
					messages: [],
				},
				...items,
			]);
			setActive(id);
			setPanel(null);
			setOverlay(null);
			return id;
		},
		[conversation.project],
	);
	const select = (id: string) => {
		setActive(id);
		setOverlay(null);
	};
	const stop = () => {
		const timer = timers.current.get(active);
		if (timer) clearTimeout(timer);
		timers.current.delete(active);
		updateStatus(active, "stopped");
		notify("已停止演示任务");
	};
	const schedule = (id: string, status: SessionStatus, delay: number) => {
		const previous = timers.current.get(id);
		if (previous) clearTimeout(previous);
		timers.current.set(
			id,
			setTimeout(() => {
				updateStatus(id, status);
				timers.current.delete(id);
			}, delay),
		);
	};
	const send = (text: string) => {
		setSessions((items) =>
			items.map((session) =>
				session.id === active
					? {
							...session,
							title: session.messages.length === 0 && session.custom ? text.slice(0, 24) : session.title,
							messages: [...session.messages, text],
							status: "working",
						}
					: session,
			),
		);
		schedule(active, mode === "手动确认" ? "approval" : "done", 1900);
	};
	const approve = () => {
		updateStatus(active, "working");
		schedule(active, "done", 1600);
	};
	const archive = (id: string) => {
		if (sessions.length === 1) {
			notify("请先创建另一个会话，再归档当前会话。");
			return;
		}
		const timer = timers.current.get(id);
		if (timer) clearTimeout(timer);
		setSessions((items) => items.filter((session) => session.id !== id));
		if (id === active) setActive(sessions.find((session) => session.id !== id)!.id);
		notify("已从原型列表归档；可用“重置演示”恢复。");
	};
	const openPanel = (next: Panel) => setPanel(next);
	const togglePanel = (next: Panel) => setPanel((current) => (current === next ? null : next));
	const changeTheme = (next: Theme) => {
		setTheme(next);
	};
	useEffect(() => {
		if (conversation.messages.length) scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight });
	}, [conversation.messages.length, conversation.status]);
	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);
	useEffect(() => {
		try {
			localStorage.setItem(storageKey, JSON.stringify({ theme, mode, model, sessions, active }));
		} catch {
			/* Storage may be disabled in a local preview. */
		}
	}, [theme, mode, model, sessions, active]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			if (["n", "k", ",", "b", "`"].includes(event.key.toLowerCase())) event.preventDefault();
			if (event.key.toLowerCase() === "n") create();
			if (event.key.toLowerCase() === "k") {
				setSearchQuery("");
				setOverlay("search");
			}
			if (event.key === ",") setOverlay("settings");
			if (event.key.toLowerCase() === "b") setSidebarOpen((open) => !open);
			if (event.key === "`") setTerminalOpen((open) => !open);
		};
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [create]);
	useEffect(
		() => () => {
			for (const timer of timers.current.values()) clearTimeout(timer);
			if (toastTimer.current) clearTimeout(toastTimer.current);
		},
		[],
	);
	const resize = (kind: "sidebar" | "inspector", start: React.PointerEvent<HTMLDivElement>) => {
		const startX = start.clientX;
		const width = kind === "sidebar" ? sidebarWidth : inspectorWidth;
		const move = (event: PointerEvent) => {
			const value = width + (event.clientX - startX) * (kind === "sidebar" ? 1 : -1);
			if (kind === "sidebar") setSidebarWidth(Math.max(210, Math.min(330, value)));
			else setInspectorWidth(Math.max(330, Math.min(window.innerWidth * 0.53, value)));
		};
		const finish = () => {
			document.body.classList.remove("resizing");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", finish);
		};
		document.body.classList.add("resizing");
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", finish);
	};
	const reset = () => {
		for (const timer of timers.current.values()) clearTimeout(timer);
		timers.current.clear();
		setSessions(initialSessions);
		setActive("search");
		setPanel("changes");
		setOverlay(null);
		setMode("手动确认");
		setTerminalOpen(false);
		notify("已恢复初始演示场景");
	};
	return (
		<div
			className={`desktop-app ${!sidebarOpen ? "sidebar-collapsed" : ""} ${panel ? "has-inspector" : ""}`}
			style={{ "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
		>
			{sidebarOpen && (
				<>
					<Sidebar
						sessions={sessions}
						active={active}
						select={select}
						create={(project) => create(project)}
						search={() => {
							setSearchQuery("");
							setOverlay("search");
						}}
						settings={() => setOverlay("settings")}
						collapse={() => setSidebarOpen(false)}
						archive={archive}
						project={() => setOverlay("project")}
					/>
					<div
						className="resize-handle sidebar-handle"
						role="separator"
						aria-label="调整会话侧栏宽度"
						aria-orientation="vertical"
						aria-valuenow={sidebarWidth}
						onPointerDown={(event) => resize("sidebar", event)}
					/>
				</>
			)}
			<div className="workspace-main">
				<header className="workspace-titlebar">
					<div className="session-heading">
						{!sidebarOpen && <IconButton icon={PanelLeft} label="展开侧栏" onClick={() => setSidebarOpen(true)} />}
						<button
							className="session-title-button"
							onClick={() => {
								setRename(conversation.title);
								setOverlay("rename");
							}}
						>
							{conversation.title}
							<ChevronDown size={13} />
						</button>
						{conversation.status === "approval" && (
							<span className="waiting-badge">
								<span />
								待确认
							</span>
						)}
					</div>
					<div className="workspace-tools">
						<IconButton
							icon={ListTodo}
							label="会话详情"
							onClick={() => togglePanel("details")}
							active={panel === "details"}
						/>
						<IconButton
							icon={TerminalIcon}
							label="终端"
							onClick={() => setTerminalOpen(!terminalOpen)}
							active={terminalOpen}
						/>
						<IconButton
							icon={GitCompareArrows}
							label="代码修改"
							onClick={() => togglePanel("changes")}
							active={panel === "changes"}
						/>
						<IconButton
							icon={Globe}
							label="应用预览"
							onClick={() => togglePanel("preview")}
							active={panel === "preview"}
						/>
						<IconButton icon={Files} label="项目文件" onClick={() => togglePanel("files")} active={panel === "files"} />
						<button className="reset-demo" onClick={reset} title="重置演示状态">
							重置演示
						</button>
					</div>
				</header>
				<div className="main-body">
					<div className={`conversation-column ${isNew ? "new-conversation" : ""}`}>
						<div className="conversation-scroll" key={`chat-${active}`} ref={scrollArea}>
							<Chat
								session={conversation}
								approve={approve}
								reject={() => updateStatus(active, "stopped")}
								panel={openPanel}
								notify={notify}
								suggestion={send}
								mode={mode}
								fork={() => {
									create(conversation.project, `${conversation.title} · 分叉`);
									notify("已新建分叉会话（交互演示）");
								}}
							/>
						</div>
						<Composer
							key={`composer-${active}`}
							send={send}
							busy={conversation.status === "working"}
							stop={stop}
							mode={mode}
							setMode={setMode}
							model={model}
							setModel={setModel}
							project={conversation.project}
							isNew={isNew}
							openProject={() => setOverlay("project")}
							notify={notify}
						/>
						{!isNew && (
							<div className="session-statusbar">
								<span>
									<span className={`status-indicator ${conversation.status}`} />
									{conversation.status === "approval"
										? "等待授权"
										: conversation.status === "working"
											? "正在工作"
											: conversation.status === "stopped"
												? "已停止"
												: "准备就绪"}
								</span>
								<button onClick={() => togglePanel("details")}>
									上下文 9%
									<span className="context-ring" />
								</button>
								<span className="prototype-footnote">原型预览</span>
							</div>
						)}
					</div>
					{terminalOpen && (
						<Terminal
							close={() => setTerminalOpen(false)}
							status={conversation.status}
							project={conversation.project}
						/>
					)}
				</div>
			</div>
			{panel && (
				<>
					<div
						className="resize-handle inspector-handle"
						role="separator"
						aria-label="调整工作区面板宽度"
						aria-orientation="vertical"
						aria-valuenow={inspectorWidth}
						onPointerDown={(event) => resize("inspector", event)}
					/>
					<Inspector
						panel={panel}
						setPanel={setPanel}
						close={() => setPanel(null)}
						selected={selectedFile}
						select={setSelectedFile}
						notify={notify}
						comment={(file) => {
							send(`请进一步检查 @${file} 的修改，特别是边界情况。`);
							notify("已将文件反馈添加到会话");
						}}
						commit={() => setOverlay("commit")}
						project={conversation.project}
					/>
				</>
			)}
			{overlay === "settings" && (
				<Settings
					close={() => setOverlay(null)}
					theme={theme}
					setTheme={changeTheme}
					mode={mode}
					setMode={setMode}
					notify={notify}
				/>
			)}
			{overlay === "search" && (
				<Modal title="搜索会话" close={() => setOverlay(null)}>
					<div className="search-dialog-input">
						<Search size={18} />
						<input
							autoFocus
							aria-label="搜索会话标题或项目"
							placeholder="搜索标题或项目…"
							value={searchQuery}
							onChange={(event) => setSearchQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && filtered[0]) select(filtered[0].id);
							}}
						/>
						<kbd>Esc</kbd>
					</div>
					<div className="search-results">
						{filtered.map((session) => (
							<button key={session.id} onClick={() => select(session.id)}>
								<MessageSquare size={16} />
								<div>
									<strong>{session.title}</strong>
									<span>
										{session.project} · {session.time}
									</span>
								</div>
								<ChevronRight size={14} />
							</button>
						))}
						{!filtered.length && (
							<div className="empty-result">
								<Search size={24} />
								<strong>没有找到相关会话</strong>
								<span>试试其他标题或项目名称</span>
							</div>
						)}
					</div>
					<footer className="dialog-footer">
						搜索结果 {filtered.length} 个<span>Enter 打开首个结果</span>
					</footer>
				</Modal>
			)}
			{overlay === "project" && (
				<Modal title="选择项目" close={() => setOverlay(null)}>
					<div className="project-dialog">
						<p>选择一个示例项目，或输入路径预览新项目会话。</p>
						{["pi", "my-website"].map((project) => (
							<button className="project-option" key={project} onClick={() => create(project)}>
								<FolderOpen size={20} />
								<span>
									<strong>{project}</strong>
									<small>~/Projects/{project}</small>
								</span>
								<ChevronRight size={16} />
							</button>
						))}
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (projectPath.trim()) {
									create(projectPath.trim().split("/").filter(Boolean).pop() ?? projectPath);
									setProjectPath("");
								}
							}}
						>
							<label className="field-label">
								项目路径（演示）
								<input
									aria-label="项目路径"
									placeholder="/Users/you/Projects/my-project"
									value={projectPath}
									onChange={(event) => setProjectPath(event.target.value)}
								/>
							</label>
							<button className="primary-button" type="submit" disabled={!projectPath.trim()}>
								<Plus size={14} />
								创建项目会话
							</button>
						</form>
						<p className="subtle-note">原型不会读取此目录。正式版将使用 macOS 文件夹选择器。</p>
					</div>
				</Modal>
			)}
			{overlay === "rename" && (
				<Modal title="重命名会话" close={() => setOverlay(null)}>
					<form
						className="simple-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							if (!rename.trim()) return;
							setSessions((items) =>
								items.map((session) => (session.id === active ? { ...session, title: rename.trim() } : session)),
							);
							setOverlay(null);
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
							<button type="button" className="secondary-button" onClick={() => setOverlay(null)}>
								取消
							</button>
							<button className="primary-button" disabled={!rename.trim()}>
								保存
							</button>
						</div>
					</form>
				</Modal>
			)}
			{overlay === "commit" && (
				<Modal title="提交修改" close={() => setOverlay(null)}>
					<form
						className="simple-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							setOverlay(null);
							notify("提交交互演示完成，未执行真实 Git 提交。");
						}}
					>
						<div className="commit-branch">
							<GitBranch size={16} />
							feature/session-search<span className="tag">演示</span>
						</div>
						<label className="field-label">
							提交说明
							<textarea
								autoFocus
								rows={3}
								value={commitMessage}
								onChange={(event) => setCommitMessage(event.target.value)}
							/>
						</label>
						<div className="commit-files">
							<span>3 个文件</span>
							<span className="diff-count">
								<b>+83</b>
								<i>−12</i>
							</span>
						</div>
						<p className="subtle-note">此处仅预览提交流程，不会修改 Git 仓库。</p>
						<div className="dialog-actions">
							<button type="button" className="secondary-button" onClick={() => setOverlay(null)}>
								取消
							</button>
							<button className="primary-button" disabled={!commitMessage.trim()}>
								确认提交（演示）
							</button>
						</div>
					</form>
				</Modal>
			)}
			{toast && (
				<div className="toast" role="status">
					<Check size={15} />
					<span>{toast}</span>
					<button aria-label="关闭提示" onClick={() => setToast("")}>
						<X size={13} />
					</button>
				</div>
			)}
		</div>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
