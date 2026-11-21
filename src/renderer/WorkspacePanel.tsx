import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Columns2, FileCode2, Folder, Minus, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { IconButton } from "../prototype/ui.tsx";
import { CodeLines, UnifiedDiffView } from "./DiffView.tsx";
import type { Change, CodeIntelligence, CodePosition, FileEntry, Workspace } from "../shared.ts";

export function WorkspacePanel({
	pane,
	setPane,
	close,
	revision,
	project,
	conversationId,
	onReviewNote,
	readOnly = false,
	onReferenceFile,
	onWorkspaceMutated,
	onNotice,
}: {
	pane: "files" | "changes";
	setPane: (pane: "files" | "changes") => void;
	close: () => void;
	revision: number;
	project?: string;
	conversationId?: string;
	onReviewNote?: (note: string) => void;
	readOnly?: boolean;
	onReferenceFile?: (path: string) => void;
	onWorkspaceMutated?: () => void;
	onNotice?: (message: string) => void;
}) {
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [directory, setDirectory] = useState("");
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [content, setContent] = useState<{ path: string; content: string } | null>(null);
	const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
	const [commitMessage, setCommitMessage] = useState("");
	const [mutating, setMutating] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [review, setReview] = useState<{side: "old" | "new"; line: number} | null>(null);
	const [note, setNote] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [intelligence, setIntelligence] = useState<CodeIntelligence | null>(null);
	const [analyzing, setAnalyzing] = useState(false);
	const [activeLine, setActiveLine] = useState<number>();
	const [line, setLine] = useState("1");
	const [column, setColumn] = useState("1");

	useEffect(() => {
		if (activeLine) document.getElementById(`workspace-line-${activeLine}`)?.scrollIntoView({ block: "center" });
	}, [activeLine, content]);

	const inspect = async (at?: CodePosition) => {
		if (!conversationId || !content) return;
		setAnalyzing(true);
		setError("");
		try {
			setIntelligence(await window.pi.inspectCode(conversationId, content.path, at));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setAnalyzing(false);
		}
	};

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

	const open = async (path: string, jump?: number) => {
		setIntelligence(null);
		setActiveLine(jump);
		setLine(String(jump ?? 1));
		setColumn("1");
		setReview(null);
		setNote("");
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

	const runGit = async (op: () => Promise<Workspace>, notice?: string) => {
		setMutating(true);
		setError("");
		try {
			const next = await op();
			setWorkspace(next);
			onWorkspaceMutated?.();
			if (notice) onNotice?.(notice);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setMutating(false);
		}
	};

	const commit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!commitMessage.trim()) return;
		setMutating(true);
		setError("");
		try {
			const res = await window.pi.gitCommit(commitMessage);
			setWorkspace(res.workspace);
			setCommitMessage("");
			onWorkspaceMutated?.();
			onNotice?.(`已提交 ${res.hash}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setMutating(false);
		}
	};

	const stagedChanges: Change[] = workspace?.changes.filter((c) => c.staged) ?? [];
	const unstagedChanges: Change[] = workspace?.changes.filter((c) => c.unstaged || !c.staged) ?? [];

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
						{pane === "changes" && (
							<button
								type="button"
								className={`cc-mini-btn ${diffMode === "split" ? "active" : ""}`}
								onClick={() => setDiffMode((m) => (m === "unified" ? "split" : "unified"))}
								title="切换统一/分栏对比"
							>
								<Columns2 size={12} /> {diffMode === "split" ? "分栏" : "统一"}
							</button>
						)}
						{pane === "files" && conversationId && <button type="button" className="cc-mini-btn" disabled={analyzing} onClick={() => void inspect()}>{analyzing ? "分析中…" : "代码分析"}</button>}
						{onReferenceFile && (
							<button type="button" className="cc-mini-btn" onClick={() => onReferenceFile(content.path)} title="插入 @文件引用 到输入框">
								@引用
							</button>
						)}
					</div>
					{pane === "changes" ? (
						<div className="live-file-content live-diff">
							<UnifiedDiffView diff={content.content} mode={diffMode} onReview={onReviewNote && ((side, line) => setReview({ side, line }))} />
							{review && <form className="cc-review-note" onSubmit={(event) => {
								event.preventDefault();
								if (!note.trim()) return;
								onReviewNote?.(`评审反馈 ${content.path}（${review.side === "old" ? "原文件" : "新文件"}第 ${review.line} 行）\n${note.trim()}`);
								setReview(null);
								setNote("");
							}}>
								<label>第 {review.line} 行的反馈
									<textarea aria-label="逐行评审反馈" value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
								</label>
								<button className="cc-mini-btn" type="submit" disabled={!note.trim()}>加入会话草稿</button>
								<button className="cc-mini-btn" type="button" onClick={() => setReview(null)}>取消</button>
							</form>}
						</div>
					) : (
						<>
							{intelligence && <section className="cc-code-inspector">
								<form onSubmit={(event) => { event.preventDefault(); void inspect({ line: Number(line), column: Number(column) }); }}>
									<input type="number" required min="1" aria-label="定义查询行号" value={line} onChange={(event) => setLine(event.target.value)} />
									<input type="number" required min="1" aria-label="定义查询列号" value={column} onChange={(event) => setColumn(event.target.value)} />
									<button className="cc-mini-btn" disabled={analyzing}>查找定义</button>
								</form>
								{intelligence.definitions.map((item, index) => <button type="button" key={index} onClick={() => void open(item.path, item.line)}>{item.path}:{item.line}:{item.column}</button>)}
								<details open={intelligence.diagnostics.length > 0}>
									<summary>诊断 {intelligence.diagnostics.length}</summary>
									{intelligence.diagnostics.map((item, index) => <button type="button" key={index} onClick={() => setActiveLine(item.line)}>{item.line}:{item.column} {item.message}</button>)}
								</details>
								<details>
									<summary>符号 {intelligence.symbols.length}</summary>
									{intelligence.symbols.map((item, index) => <button type="button" key={index} onClick={() => setActiveLine(item.line)}>{item.name} · {item.line}:{item.column}</button>)}
								</details>
							</section>}
							<div className="live-file-content">
								{content.content ? <CodeLines content={content.content} activeLine={activeLine} /> : <p className="subtle-note">空文件</p>}
							</div>
						</>
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
					{workspace?.isGit && <PullRequestPanel conversationId={conversationId} branch={workspace.branch} readOnly={readOnly} />}
					<div className="changes-overview cc-git-overview">
						<p>{workspace?.isGit ? `分支：${workspace.branch}` : "当前目录不是 Git 仓库"}</p>
						{workspace?.isGit && workspace.changes.length > 0 && !readOnly && (
							<div className="cc-git-bulk">
								<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => void runGit(() => window.pi.gitStage())}>
									<Plus size={12} /> 全部暂存
								</button>
								{stagedChanges.length > 0 && (
									<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => void runGit(() => window.pi.gitUnstage())}>
										<Minus size={12} /> 全部取消
									</button>
								)}
							</div>
						)}
					</div>

					{workspace?.isGit && !readOnly && (stagedChanges.length > 0 || workspace.changes.length > 0) && (
						<form className="cc-commit-box" onSubmit={(e) => void commit(e)}>
							<input
								aria-label="Git 提交说明"
								placeholder={stagedChanges.length ? `提交 ${stagedChanges.length} 个已暂存文件…` : "先暂存修改后填写提交说明…"}
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
								disabled={mutating || !stagedChanges.length}
							/>
							<button
								type="submit"
								className="primary-button"
								disabled={mutating || !stagedChanges.length || !commitMessage.trim()}
							>
								<Check size={13} /> 提交
							</button>
						</form>
					)}

					<div className="changed-file-list">
						{stagedChanges.length > 0 && (
							<div className="cc-change-section">已暂存 ({stagedChanges.length})</div>
						)}
						{stagedChanges.map((change) => (
							<div key={`staged-${change.path}`} className="cc-change-row">
								<button type="button" className="cc-change-open" onClick={() => void open(change.path)}>
									<FileCode2 size={14} />
									<span className="file-name" title={change.path}>{change.path}</span>
									<span>{change.status}</span>
								</button>
								{!readOnly && (
									<button
										type="button"
										className="cc-git-icon"
										title="取消暂存"
										aria-label={`取消暂存 ${change.path}`}
										disabled={mutating}
										onClick={() => void runGit(() => window.pi.gitUnstage([change.path]))}
									>
										<Minus size={13} />
									</button>
								)}
							</div>
						))}

						{unstagedChanges.length > 0 && (
							<div className="cc-change-section">未暂存与未跟踪 ({unstagedChanges.length})</div>
						)}
						{unstagedChanges.map((change) => (
							<div key={`unstaged-${change.path}`} className="cc-change-row">
								<button type="button" className="cc-change-open" onClick={() => void open(change.path)}>
									<FileCode2 size={14} />
									<span className="file-name" title={change.path}>{change.path}</span>
									<span>{change.status}</span>
								</button>
								{!readOnly && (
									<div className="cc-git-row-btns">
										<button
											type="button"
											className="cc-git-icon"
											title="暂存修改"
											aria-label={`暂存 ${change.path}`}
											disabled={mutating}
											onClick={() => void runGit(() => window.pi.gitStage([change.path]))}
										>
											<Plus size={13} />
										</button>
										<button
											type="button"
											className="cc-git-icon danger"
											title="放弃修改"
											aria-label={`放弃修改 ${change.path}`}
											disabled={mutating}
											onClick={() => void runGit(() => window.pi.gitDiscard([change.path]), `已还原 ${change.path}`)}
										>
											<RotateCcw size={12} />
										</button>
									</div>
								)}
							</div>
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
