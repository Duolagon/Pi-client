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
	SquarePen,
} from "lucide-react";
import type { Conversation, DesktopAPI, PermissionMode, Snapshot } from "../shared.ts";
import { IconButton, Modal, PiMark } from "../prototype/ui.tsx";
import { useDesktop } from "./useDesktop.ts";
import { TranscriptView } from "./TranscriptView.tsx";
import { LiveComposer } from "./LiveComposer.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { WorkspacePanel } from "./WorkspacePanel.tsx";
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
	const [shellInput, setShellInput] = useState("");
	const [rename, setRename] = useState<string | null>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const shell = useRef<HTMLDivElement>(null);
	const stickToEnd = useRef(true);
	useEffect(() => {
		stickToEnd.current = true;
	}, [snapshot?.active?.id]);
	useEffect(() => {
		if (stickToEnd.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
	}, [history, running]);
	useEffect(() => {
		shell.current?.scrollTo({ top: shell.current.scrollHeight });
	}, [app.terminal]);
	const blocked = running || changing || bashBusy;
	const project = snapshot?.projects.find((item) => item.path === snapshot.active?.project);
	const switchTo = (operation: () => ReturnType<DesktopAPI["snapshot"]>) => {
		setSearching(false);
		setPane(null);
		void app.switchTo(operation);
	};
	const savePermission = async (permission: PermissionMode) => {
		if (!snapshot) return;
		await app.switchTo(() => api.saveSettings({ permission, theme: snapshot.settings.theme }));
	};
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			if (event.key.toLowerCase() === "k") {
				event.preventDefault();
				setQuery("");
				setSearching(true);
			}
			if (event.key.toLowerCase() === "n" && snapshot?.active && !blocked) {
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
	return (
		<div className={`desktop-app live-app ${sidebar ? "" : "cl-side-hidden"} ${pane ? "has-inspector" : ""}`}>
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
					</div>
					<div className="cl-top-tools">
						<IconButton icon={RefreshCw} label="刷新会话" disabled={blocked} onClick={() => void app.refresh()} />
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
							onClick={() => setPane(pane === "changes" ? null : "changes")}
							active={pane === "changes"}
						/>
						<IconButton
							icon={Files}
							label="项目文件"
							onClick={() => setPane(pane === "files" ? null : "files")}
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
								<TranscriptView transcript={history} />
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
						<LiveComposer
							snapshot={snapshot}
							draft={app.draft}
							setDraft={app.setDraft}
							running={running}
							changing={changing || bashBusy}
							send={app.send}
							stop={() => void app.command({ type: "abort" })}
							command={app.command}
							setPermission={(permission) => void savePermission(permission)}
							openSettings={() => setSettings(true)}
							fail={app.fail}
						/>
						<div className="cl-statusbar">
							<span>{project?.name ?? "未选择项目"}</span>
							<span>
								{snapshot.stats
									? `Token ${snapshot.stats.tokens.total.toLocaleString()} · $${snapshot.stats.cost.toFixed(4)}`
									: ""}
							</span>
							<button disabled={blocked || !history.messages.length} onClick={() => void app.command({ type: "compact" })}>
								压缩上下文
							</button>
							<span className="cl-status-state">{running ? "执行中" : ready ? "准备就绪" : "连接异常"}</span>
						</div>
					</div>
					{terminalOpen && (
						<section className="terminal-panel" aria-label="集成终端">
							<header>
								<span>
									<TerminalIcon size={14} />
									Pi 命令执行
								</span>
								<span className="terminal-demo">{snapshot.active?.project}</span>
								{bashBusy && <button onClick={() => void app.command({ type: "abort_bash" })}>停止命令</button>}
								<IconButton icon={X} label="关闭终端" onClick={() => setTerminalOpen(false)} />
							</header>
							<div className="terminal-output" ref={shell}>
								<pre>{app.terminal || "直接输入命令在当前项目运行，输出会加入会话上下文。"}</pre>
								<form
									onSubmit={(event) => {
										event.preventDefault();
										if (shellInput.trim()) {
											void app.bash(shellInput.trim());
											setShellInput("");
										}
									}}
								>
									<label htmlFor="shell-command">$</label>
									<input
										id="shell-command"
										aria-label="终端命令"
										value={shellInput}
										onChange={(event) => setShellInput(event.target.value)}
										disabled={blocked || !ready || !snapshot.active || snapshot.settings.permission === "read"}
										placeholder={
											snapshot.settings.permission === "read" ? "只读模式下不可执行命令" : "输入命令后按 Enter"
										}
									/>
								</form>
							</div>
						</section>
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
				<PermissionDialog key={app.requests[0].id} request={app.requests[0]} respond={app.respond} fail={app.fail} />
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
