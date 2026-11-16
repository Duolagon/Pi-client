import { useState } from "react";
import {
	PanelLeftClose,
	Plus,
	Search,
	SlidersHorizontal,
	ChevronDown,
	ChevronRight,
	Settings,
	Circle,
	Archive,
	FolderOpen,
	Code2,
	MoreHorizontal,
} from "lucide-react";
import { IconButton, PiMark } from "./ui";
import type { Session } from "./data";

interface Props {
	sessions: Session[];
	active: string;
	select: (id: string) => void;
	create: (project?: string) => void;
	search: () => void;
	settings: () => void;
	collapse: () => void;
	archive: (id: string) => void;
	project: () => void;
}
export function Sidebar({ sessions, active, select, create, search, settings, collapse, archive, project }: Props) {
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [sessionMenu, setSessionMenu] = useState<string | null>(null);
	const projects = [...new Set(sessions.map((session) => session.project))];
	return (
		<aside className="sidebar" aria-label="项目与会话">
			<div className="sidebar-titlebar">
				<div className="traffic-lights" aria-hidden="true">
					<i />
					<i />
					<i />
				</div>
				<IconButton icon={PanelLeftClose} label="收起侧栏" onClick={collapse} />
			</div>
			<div className="brand-row">
				<PiMark />
				<span>Pi</span>
				<span className="desktop-label">Desktop</span>
				<span className="code-mode">
					<Code2 size={15} />
					Code
				</span>
			</div>
			<nav className="primary-nav" aria-label="主导航">
				<button onClick={() => create()} className="nav-row">
					<Plus size={18} />
					<span>新建会话</span>
					<kbd>⌘ N</kbd>
				</button>
				<button onClick={search} className="nav-row">
					<Search size={17} />
					<span>搜索会话</span>
					<kbd>⌘ K</kbd>
				</button>
				<button onClick={settings} className="nav-row">
					<SlidersHorizontal size={17} />
					<span>自定义</span>
				</button>
			</nav>
			<div className="sessions-scroll">
				<div className="section-label">
					<span>项目</span>
					<IconButton icon={FolderOpen} label="打开项目" onClick={project} />
				</div>
				{projects.map((name) => (
					<section key={name} className="project-group">
						<div className="project-heading">
							<button
								onClick={() =>
									setCollapsed((items) =>
										items.includes(name) ? items.filter((item) => item !== name) : [...items, name],
									)
								}
								aria-expanded={!collapsed.includes(name)}
							>
								{collapsed.includes(name) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
								<span>{name}</span>
							</button>
							<IconButton icon={Plus} label={`在 ${name} 中新建会话`} onClick={() => create(name)} />
						</div>
						{!collapsed.includes(name) &&
							sessions
								.filter((session) => session.project === name)
								.map((session) => (
									<div key={session.id} className={`session-row ${active === session.id ? "selected" : ""}`}>
										<button
											className="session-select"
											onClick={() => select(session.id)}
											aria-current={active === session.id ? "page" : undefined}
										>
											<span className={`session-dot ${session.status}`} aria-hidden="true">
												{session.status === "approval" ? (
													<Circle size={7} fill="currentColor" />
												) : session.status === "working" ? (
													<span className="tiny-spinner" />
												) : null}
											</span>
											<span className="session-title">{session.title}</span>
										</button>
										<button
											className="session-more"
											aria-label={`${session.title}的更多操作`}
											onClick={() => setSessionMenu(sessionMenu === session.id ? null : session.id)}
										>
											<MoreHorizontal size={15} />
										</button>
										{sessionMenu === session.id && (
											<div className="session-menu">
												<button
													onClick={() => {
														archive(session.id);
														setSessionMenu(null);
													}}
												>
													<Archive size={14} />
													归档会话
												</button>
											</div>
										)}
									</div>
								))}
					</section>
				))}
				<button className="open-project" onClick={project}>
					<Plus size={14} />
					打开其他项目
				</button>
			</div>
			<div className="sidebar-footer">
				<div className="prototype-label">
					<span />
					交互原型 · 演示数据
				</div>
				<div className="account-row">
					<div className="avatar">L</div>
					<div>
						<strong>本地工作区</strong>
						<span>Pi Desktop Preview</span>
					</div>
					<IconButton icon={Settings} label="设置" onClick={settings} />
				</div>
			</div>
		</aside>
	);
}
