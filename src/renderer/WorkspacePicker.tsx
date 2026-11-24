import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, FolderPlus, GitBranch } from "lucide-react";
import { menuKeyNav } from "../prototype/ui.tsx";
import { SurfacePresence } from "./Presence.tsx";
import type { Project } from "../shared.ts";

function shortenPath(path: string): string {
	const normalized = path.replace(/^\/Users\/[^/]+/, "~");
	if (normalized.length <= 42) return normalized;
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 3) return normalized;
	return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

export function WorkspacePicker({
	projects,
	activeProject,
	gitBranch,
	disabled,
	variant,
	onSelectProject,
	onOpenProject,
}: {
	projects: Project[];
	activeProject?: Project;
	gitBranch?: string;
	disabled?: boolean;
	variant: "topbar" | "composer";
	onSelectProject: (path: string) => void;
	onOpenProject: () => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const triggerLabel = variant === "topbar" ? "切换工作目录" : "工作目录";

	return (
		<div className={`cc-ws-picker cc-ws-picker-${variant}`} ref={rootRef} onKeyDown={menuKeyNav}>
			<button
				type="button"
				className={`cc-ws-trigger ${variant === "composer" ? "cl-pill" : "cc-ws-topbar-btn"} ${open ? "open" : ""} ${!activeProject ? "empty" : ""}`}
				aria-label={triggerLabel}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				title={activeProject ? `当前工作目录：${activeProject.path}` : "选择工作目录"}
				onClick={() => setOpen((prev) => !prev)}
			>
				<Folder size={13} className="cc-ws-icon" />
				<span className="cc-ws-name">{activeProject ? activeProject.name : "选择工作目录"}</span>
				{variant === "topbar" && activeProject && gitBranch && (
					<span className="cc-ws-branch" title={gitBranch}>
						<GitBranch size={11} />
						<span>{gitBranch}</span>
					</span>
				)}
				<ChevronDown size={12} className="cc-ws-caret" />
			</button>
			<SurfacePresence show={open} direction={variant === "composer" ? "up" : "down"}>
				{(menuRef) => (
				<div
					ref={menuRef}
					className={`cc-ws-menu ${variant === "composer" ? "up" : "down"}`}
					role="menu"
					aria-label="工作目录列表"
				>
					<div className="cc-ws-menu-head">
						<span className="cc-ws-menu-title">工作目录</span>
						{activeProject && (
							<code className="cc-ws-menu-path" title={activeProject.path}>
								{shortenPath(activeProject.path)}
							</code>
						)}
					</div>
					<div className="cc-ws-menu-list">
						{projects.length > 0 ? (
							projects.map((item) => {
								const isActive = item.path === activeProject?.path;
								return (
									<button
										key={item.path}
										type="button"
										role="menuitemradio"
										aria-checked={isActive}
										className={`cc-ws-menu-item ${isActive ? "active" : ""}`}
										onClick={() => {
											setOpen(false);
											if (!isActive) onSelectProject(item.path);
										}}
									>
										<Folder size={14} className="cc-ws-item-icon" />
										<span className="cc-ws-item-text">
											<strong>{item.name}</strong>
											<small title={item.path}>{shortenPath(item.path)}</small>
										</span>
										{isActive && <Check size={14} className="cc-ws-item-check" />}
									</button>
								);
							})
						) : (
							<div className="cc-ws-menu-empty">尚未打开任何工作目录</div>
						)}
					</div>
					<div className="cc-ws-menu-foot">
						<button
							type="button"
							role="menuitem"
							className="cc-ws-open-btn"
							onClick={() => {
								setOpen(false);
								onOpenProject();
							}}
						>
							<FolderPlus size={14} />
							<span>选择其他文件夹…</span>
						</button>
					</div>
				</div>
				)}
			</SurfacePresence>
		</div>
	);
}
