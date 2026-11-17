import { useEffect, useState } from "react";
import { ArrowLeft, FileCode2, Folder, RefreshCw, X } from "lucide-react";
import { IconButton } from "../prototype/ui.tsx";
import { CodeLines, UnifiedDiffView } from "./DiffView.tsx";
import type { FileEntry, Workspace } from "../shared.ts";

export function WorkspacePanel({
	pane,
	setPane,
	close,
	revision,
	project,
	onReferenceFile,
}: {
	pane: "files" | "changes";
	setPane: (pane: "files" | "changes") => void;
	close: () => void;
	revision: number;
	project?: string;
	onReferenceFile?: (path: string) => void;
}) {
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [directory, setDirectory] = useState("");
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [content, setContent] = useState<{ path: string; content: string } | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		setDirectory("");
		setContent(null);
	}, [project, pane]);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		const load = async () => {
			try {
				if (pane === "files") {
					const files = await window.pi.files(directory);
					if (active) setEntries(files);
				} else {
					const next = await window.pi.workspace();
					if (active) setWorkspace(next);
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (active) setLoading(false);
			}
		};
		void load();
		return () => {
			active = false;
		};
	}, [directory, pane, revision, refresh, project]);
	const open = async (path: string) => {
		setError("");
		setLoading(true);
		try {
			setContent(pane === "files" ? await window.pi.readFile(path) : { path, content: await window.pi.diff(path) });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};
	return (
		<aside className="inspector" aria-label="真实项目工作区">
			<header className="inspector-header">
				<div role="tablist" aria-label="工作区视图">
					<button role="tab" aria-selected={pane === "changes"} onClick={() => setPane("changes")}>
						修改{workspace?.changes.length ? ` ${workspace.changes.length}` : ""}
					</button>
					<button role="tab" aria-selected={pane === "files"} onClick={() => setPane("files")}>
						文件
					</button>
				</div>
				<div>
					<IconButton
						icon={RefreshCw}
						label="刷新项目文件"
						onClick={() => {
							setRefresh((value) => value + 1);
							if (content) void open(content.path);
						}}
					/>
					<IconButton icon={X} label="关闭工作区面板" onClick={close} />
				</div>
			</header>
			{error && (
				<div className="live-error" role="alert">
					{error}
				</div>
			)}
			{content ? (
				<>
					<div className="file-preview-heading">
						<button onClick={() => setContent(null)}>
							<ArrowLeft size={14} />
							返回
						</button>
						<span title={content.path}>{content.path}</span>
						{onReferenceFile && (
							<button type="button" className="cc-mini-btn" onClick={() => onReferenceFile(content.path)} title="插入 @文件引用 到输入框">
								@引用
							</button>
						)}
					</div>
					{pane === "changes" ? (
						<div className="live-file-content live-diff">
							<UnifiedDiffView diff={content.content} />
						</div>
					) : (
						<div className="live-file-content">
							{content.content ? <CodeLines content={content.content} /> : <p className="subtle-note">空文件</p>}
						</div>
					)}
				</>
			) : pane === "files" ? (
				<>
					<div className="file-preview-heading">
						<button disabled={!directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>
							<ArrowLeft size={14} />
							上一级
						</button>
						<span>{directory || "项目根目录"}</span>
					</div>
					<div className="file-tree">
						{entries.map((entry) => (
							<button
								key={entry.path}
								onClick={() => (entry.directory ? setDirectory(entry.path) : void open(entry.path))}
							>
								{entry.directory ? <Folder size={15} /> : <FileCode2 size={15} />}
								<span>{entry.name}</span>
							</button>
						))}
						{!loading && !entries.length && <p className="subtle-note">目录为空。</p>}
					</div>
				</>
			) : (
				<>
					<div className="changes-overview">
						<p>{workspace?.isGit ? `分支：${workspace.branch}` : "当前目录不是 Git 仓库"}</p>
					</div>
					<div className="changed-file-list">
						{workspace?.changes.map((change) => (
							<button key={change.path} onClick={() => void open(change.path)}>
								<FileCode2 size={14} />
								<span className="file-name">{change.path}</span>
								<span>{change.status}</span>
							</button>
						))}
						{!loading && workspace?.isGit && !workspace.changes.length && (
							<p className="subtle-note">工作区没有修改。</p>
						)}
					</div>
				</>
			)}
			{loading && (
				<p className="subtle-note live-panel-status" role="status">
					正在读取…
				</p>
			)}
		</aside>
	);
}
