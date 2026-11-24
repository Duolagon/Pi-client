import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Columns2, ExternalLink, FileCode2, Folder, Maximize2, Minimize2, Minus, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { IconButton, Modal } from "../prototype/ui.tsx";
import type { Change, CodeIntelligence, CodePosition, FileEntry, GitCheckpoint, Workspace } from "../shared.ts";
import { CodeLines, UnifiedDiffView, type DiffReviewAnchor } from "./DiffView.tsx";
import { diffHunkCount } from "./diff-lines.ts";
import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { SurfacePresence, prefersReducedMotion } from "./Presence.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import { AnimatedDetails, SmoothCollapse } from "./SmoothCollapse.tsx";
import { formatReviewNotes, readReviewView, reviewLocation, reviewRevision, saveReviewView, type ReviewPosition, type ReviewView } from "./workspace-review-state.ts";
import "./workspace-review.css";

const defaultPosition: ReviewPosition = { hunk: 0, top: 0 };
const workspaceSource = "workspace";
const maxNotes = 24;
const maxNoteLength = 2000;
const worktreeStatuses: Record<string, string> = { A: "新增", C: "复制", D: "删除", M: "修改", R: "重命名", T: "类型变化", U: "未解决" };

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function WorkspacePanel({
	pane,
	setPane,
	close,
	revision,
	project,
	conversationId,
	checkpointId,
	onSendReview,
	onOpenCheckpoint,
	focusReview,
	onToggleReviewFocus,
	readOnly = false,
	onReferenceFile,
	onWorkspaceMutated,
	onNotice,
	onOpenInEditor,
}: {
	pane: "files" | "changes";
	setPane: (pane: "files" | "changes") => void;
	close: () => void;
	revision: number;
	project?: string;
	conversationId?: string;
	/** Checkpoint of the exact turn selected for review. */
	checkpointId?: string;
	onSendReview?: (message: string) => Promise<void>;
	onOpenCheckpoint?: (checkpointId: string, path?: string) => void;
	focusReview?: boolean;
	onToggleReviewFocus?: () => void;
	readOnly?: boolean;
	onReferenceFile?: (path: string) => void;
	onWorkspaceMutated?: () => void;
	onNotice?: (message: string) => void;
	onOpenInEditor?: (relativePath: string, line?: number) => void;
}) {
	const viewKey = conversationId ?? project ?? "no-project";
	const [, renderView] = useState(0);
	const view = readReviewView(viewKey);
	const updateView = (update: (current: ReviewView) => ReviewView) => {
		saveReviewView(viewKey, update(readReviewView(viewKey)));
		renderView((value) => value + 1);
	};
	const scope = view.scope ?? (checkpointId ? "turn" : "workspace");
	const turnReview = pane === "changes" && scope === "turn";
	const turnPosition = view.turn.checkpointId === checkpointId ? view.turn : defaultPosition;
	const position = turnReview ? turnPosition : view.workspace;
	const selectedPath = pane === "files" ? view.files.path : position.path;
	const nameStart = (selectedPath?.lastIndexOf("/") ?? -1) + 1;
	const source = turnReview ? checkpointId : workspaceSource;
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [checkpoint, setCheckpoint] = useState<GitCheckpoint>();
	const [loaded, setLoaded] = useState<{ requestId: string; path: string; text: string }>();
	const [commitMessage, setCommitMessage] = useState("");
	const [mutating, setMutating] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");
	const [listError, setListError] = useState("");
	const [contentError, setContentError] = useState<{ requestId: string; message: string }>();
	const [directoryLoading, setDirectoryLoading] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [intelligence, setIntelligence] = useState<CodeIntelligence | null>(null);
	const [analyzing, setAnalyzing] = useState(false);
	const [line, setLine] = useState("1");
	const [column, setColumn] = useState("1");
	const [discard, setDiscard] = useState<Change>();
	const [discardVersion, setDiscardVersion] = useState<string>();
	const [undo, setUndo] = useState<{ checkpoint: GitCheckpoint; path: string }>();
	const scroller = useRef<HTMLDivElement>(null);
	const noteEditor = useRef<HTMLTextAreaElement>(null);
	const focusNoteOnMount = useRef<Element | null>(null);
	const focusNoteEditor = () => {
		if (noteEditor.current) noteEditor.current.focus();
		else focusNoteOnMount.current = document.activeElement;
	};
	useLayoutEffect(() => {
		const origin = focusNoteOnMount.current;
		focusNoteOnMount.current = null;
		if (origin && document.activeElement === origin) noteEditor.current?.focus();
	}, [view.draft?.id]);
	const requestId = JSON.stringify([viewKey, pane, source, selectedPath, refresh, turnReview ? 0 : revision]);
	const content = loaded?.requestId === requestId ? loaded : undefined;
	const activeCheckpoint = checkpoint?.id === checkpointId ? checkpoint : undefined;
	const filteredTurnFiles = activeCheckpoint?.changes.filter((entry) =>
		entry.beforeKind === "file" || entry.afterKind === "file" || entry.beforeKind === "symlink" || entry.afterKind === "symlink") ?? [];
	const stagedChanges = workspace?.changes.filter((entry) => entry.staged) ?? [];
	const unstagedChanges = workspace?.changes.filter((entry) => entry.unstaged || !entry.staged) ?? [];
	const reviewPaths = turnReview ? filteredTurnFiles.map((entry) => entry.path) : workspace?.changes.map((entry) => entry.path) ?? [];
	const fileIndex = selectedPath ? reviewPaths.indexOf(selectedPath) : -1;
	const hunkCount = pane === "changes" && content ? diffHunkCount(content.text) : 0;
	const activeHunk = Math.max(0, Math.min(position.hunk, hunkCount - 1));

	const setPosition = (next: ReviewPosition) => updateView((current) => turnReview
		? { ...current, turn: { ...next, checkpointId } }
		: { ...current, workspace: next });

	const readDiff = async (forSource: string, path: string) => {
		if (forSource === workspaceSource) {
			return conversationId ? window.pi.tasks.diff(conversationId, path) : window.pi.diff(path);
		}
		const result = await window.pi.git.diff({ checkpointId: forSource, conversationId, path });
		if (result.checkpointId !== forSource) throw new Error("读到的差异不属于当前检查点。");
		const file = result.files.find((entry) => entry.path === path);
		if (!file) throw new Error("这个文件不在所选检查点中。");
		return file.diff;
	};

	useEffect(() => {
		if (pane !== "files") return;
		let current = true;
		setDirectoryLoading(true);
		setListError("");
		const files = conversationId ? window.pi.tasks.files(conversationId, view.files.directory) : window.pi.files(view.files.directory);
		void files.then((rows) => {
			if (current) setEntries(rows);
		}).catch((cause) => {
			if (current) setListError(errorMessage(cause));
		}).finally(() => {
			if (current) setDirectoryLoading(false);
		});
		return () => { current = false; };
	}, [pane, conversationId, view.files.directory, revision, refresh]);

	useEffect(() => {
		if (pane !== "changes" || turnReview) return;
		let current = true;
		setListError("");
		const getWorkspace = conversationId ? window.pi.tasks.workspace(conversationId) : window.pi.workspace();
		void getWorkspace.then((result) => {
			if (current) setWorkspace(result);
		}).catch((cause) => {
			if (current) setListError(errorMessage(cause));
		});
		return () => { current = false; };
	}, [pane, turnReview, conversationId, revision, refresh]);

	useEffect(() => {
		if (!turnReview || !checkpointId) return;
		let current = true;
		setListError("");
		void window.pi.git.list(conversationId).then((items) => {
			if (!current) return;
			const exact = items.find((item) => item.id === checkpointId && item.finishedAt !== undefined);
			setCheckpoint(exact);
			if (!exact) setListError("找不到本轮已完成的检查点。");
		}).catch((cause) => {
			if (current) setListError(errorMessage(cause));
		});
		return () => { current = false; };
	}, [turnReview, checkpointId, conversationId, refresh]);

	const firstTurnFile = filteredTurnFiles[0]?.path;
	useEffect(() => {
		if (turnReview && firstTurnFile && !selectedPath) setPosition({ path: firstTurnFile, hunk: 0, top: 0 });
	}, [turnReview, firstTurnFile, selectedPath]);

	useEffect(() => {
		if (!selectedPath || !source) return;
		let current = true;
		const fetchContent = async (): Promise<string> => {
			if (pane === "changes") return readDiff(source, selectedPath);
			const result = conversationId ? await window.pi.tasks.readFile(conversationId, selectedPath) : await window.pi.readFile(selectedPath);
			return result.content;
		};
		void fetchContent().then((result) => {
			if (current) setLoaded({ path: selectedPath, text: result, requestId });
		}).catch((cause) => {
			if (current) setContentError({ requestId, message: errorMessage(cause) });
		});
		return () => { current = false; };
	}, [requestId]);

	useLayoutEffect(() => {
		if (!content || !scroller.current) return;
		if (pane === "files" && view.files.line !== undefined) {
			scroller.current.querySelector(`#workspace-line-${view.files.line}`)?.scrollIntoView({ block: "center" });
		} else {
			scroller.current.scrollTop = pane === "files" ? view.files.top : position.top;
		}
	}, [content, pane, view.files.line, view.diffMode]);

	useEffect(() => () => {
		saveReviewView(viewKey, readReviewView(viewKey));
	}, [viewKey, pane]);

	useEffect(() => {
		if (!discard) return;
		let current = true;
		const kind = discard.status === "??" ? "untracked" : "tracked";
		void window.pi.gitDiscardPreview({ path: discard.path, kind, conversationId }).then((preview) => {
			if (current) setDiscardVersion(preview.version);
		}).catch((cause) => {
			if (current) setError(errorMessage(cause));
		});
		return () => { current = false; };
	}, [discard, conversationId]);

	const saveScroll = () => {
		if (!content || !scroller.current) return;
		const current = readReviewView(viewKey);
		if (pane === "files") {
			current.files.top = scroller.current.scrollTop;
		} else {
			const currentPosition = turnReview ? current.turn : current.workspace;
			if (turnReview && current.turn.checkpointId !== checkpointId) return;
			currentPosition.top = scroller.current.scrollTop;
		}
	};

	const open = (path: string, jump?: number) => {
		setIntelligence(null);
		setError("");
		if (pane === "files") {
			updateView((current) => ({ ...current, files: { ...current.files, path, line: jump, top: 0 } }));
			setLine(String(jump ?? 1));
			setColumn("1");
		} else {
			setPosition({ path, hunk: 0, top: 0 });
		}
	};

	const jumpToHunk = (index: number) => {
		if (!content || index < 0 || index >= hunkCount) return;
		const hunk = scroller.current?.querySelector<HTMLElement>(`[data-diff-hunk="${index}"]`);
		if (hunk) {
			hunk.scrollIntoView({ behavior: prefersReducedMotion() ? "instant" : "smooth", block: "start" });
			hunk.dataset.hunkFlash = "true";
			window.setTimeout(() => {
				if (hunk.dataset.hunkFlash === "true") delete hunk.dataset.hunkFlash;
			}, 950);
		}
		setPosition({ ...position, hunk: index, top: scroller.current?.scrollTop ?? position.top });
	};

	const inspect = async (at?: CodePosition) => {
		if (!conversationId || !content) return;
		setAnalyzing(true);
		setError("");
		try {
			setIntelligence(await window.pi.inspectCode(conversationId, content.path, at));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setAnalyzing(false);
		}
	};

	const addReview = async (anchor: DiffReviewAnchor) => {
		if (!content || !source) return;
		const origin = document.activeElement;
		try {
			const version = await reviewRevision(content.text);
			const match = (note: NonNullable<ReviewView["draft"]>) =>
				note.path === content.path && note.source === source && note.side === anchor.side &&
				note.line === anchor.line && note.section === anchor.section;
			const editing = readReviewView(viewKey).draft;
			if (editing?.note.trim() && !match(editing)) {
				setError("请先保存或取消正在编辑的评审意见。");
				return;
			}
			setError("");
			if (document.activeElement === origin) focusNoteEditor();
			updateView((current) => {
				const existing = current.notes.find(match);
				const draft = current.draft && match(current.draft) ? current.draft : undefined;
				return { ...current, draft: {
					...anchor, source, path: content.path, version,
					id: draft?.id ?? existing?.id ?? crypto.randomUUID(),
					note: draft?.note ?? existing?.note ?? "",
				} };
			});
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const saveNote = (event: React.FormEvent) => {
		event.preventDefault();
		const draft = readReviewView(viewKey).draft;
		if (!draft?.note.trim()) return;
		if (view.notes.length >= maxNotes && !view.notes.some((note) => note.id === draft.id)) {
			setError(`最多暂存 ${maxNotes} 条评审意见，请先发送或移除一条。`);
			return;
		}
		setError("");
		updateView((current) => {
			const exists = current.notes.some((note) => note.id === draft.id);
			return {
				...current,
				notes: exists ? current.notes.map((note) => note.id === draft.id ? draft : note) : [...current.notes, draft],
				draft: undefined,
			};
		});
	};

	const sendReview = async () => {
		if (!onSendReview || !view.notes.length || view.draft?.note.trim()) return;
		setSending(true);
		setError("");
		const notes = [...view.notes];
		try {
			const files = new Map<string, Promise<string>>();
			for (const note of notes) {
				const key = JSON.stringify([note.source, note.path]);
				if (!files.has(key)) files.set(key, readDiff(note.source, note.path).then(reviewRevision));
			}
			await Promise.all(notes.map(async (note) => {
				const version = await files.get(JSON.stringify([note.source, note.path]));
				if (version !== note.version)
					throw new Error(`${note.path} 的改动已更新。请在新差异中重新选中对应行，或移除旧意见。`);
			}));
			await onSendReview(formatReviewNotes(notes));
			const sentIds = new Set(notes.map((note) => note.id));
			updateView((current) => ({ ...current, notes: current.notes.filter((note) => !sentIds.has(note.id)) }));
			onNotice?.(`已发送 ${notes.length} 条评审意见。`);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSending(false);
		}
	};

	const runGit = async (operation: () => Promise<Workspace>, notice?: string) => {
		setMutating(true);
		setError("");
		try {
			setWorkspace(await operation());
			onWorkspaceMutated?.();
			if (notice) onNotice?.(notice);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setMutating(false);
		}
	};

	const commit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!commitMessage.trim()) return;
		void runGit(async () => {
			const result = await window.pi.gitCommit(commitMessage);
			setCommitMessage("");
			onNotice?.(`已提交 ${result.hash}`);
			return result.workspace;
		});
	};

	const discardFile = async () => {
		if (!discard || !discardVersion || mutating) return;
		setMutating(true);
		setError("");
		try {
			const kind = discard.status === "??" ? "untracked" : "tracked";
			const result = await window.pi.gitDiscard({ path: discard.path, kind, conversationId, expectedVersion: discardVersion });
			setWorkspace(result.workspace);
			if (selectedPath === discard.path) setPosition(defaultPosition);
			setUndo(result.undoCheckpoint ? { checkpoint: result.undoCheckpoint, path: discard.path } : undefined);
			setDiscard(undefined);
			onWorkspaceMutated?.();
			onNotice?.(result.disposition === "trashed" ? `已将 ${discard.path} 移到废纸篓。` : `已还原 ${discard.path}，可从检查点撤销。`);
		} catch (cause) {
			setDiscardVersion(undefined);
			setError(errorMessage(cause));
		} finally {
			setMutating(false);
		}
	};

	const splitPath = (fullPath: string) => {
		const idx = fullPath.lastIndexOf("/");
		return idx === -1 ? { dir: "", base: fullPath } : { dir: fullPath.slice(0, idx + 1), base: fullPath.slice(idx + 1) };
	};

	const statusTone = (label: string) =>
		label === "新增" ? "added" : label === "删除" ? "deleted" : label === "未跟踪" ? "untracked" : "modified";

	const renderWorkspaceFile = (change: Change, staged: boolean) => {
		const statusLabel = change.status === "??" ? "未跟踪" : (worktreeStatuses[staged ? change.status[0] : change.status.at(-1)!] ?? "修改");
		const parts = splitPath(change.path);
		return (
			<div key={`${staged ? "staged" : "unstaged"}-${change.path}`} className="cc-change-row">
				<button type="button" className="cc-change-open" aria-current={change.path === selectedPath ? "true" : undefined} onClick={() => open(change.path)}>
					<FileCode2 size={14} />
					<span className="file-name" title={change.path}>
						{parts.dir && <em className="cc-file-dir">{parts.dir}</em>}
						<strong className="cc-file-base">{parts.base}</strong>
					</span>
					<span className={`cc-status-tag status-${statusTone(statusLabel)}`}>{statusLabel}</span>
				</button>
				{onOpenInEditor && <OpenInEditorButton path={change.path} open={onOpenInEditor} />}
				{!readOnly && (
					<div className="cc-git-row-btns">
						<button type="button" className="cc-git-icon" title={staged ? "取消暂存" : "暂存修改"}
							aria-label={`${staged ? "取消暂存" : "暂存"} ${change.path}`} disabled={mutating}
							onClick={() => void runGit(() => staged ? window.pi.gitUnstage([change.path]) : window.pi.gitStage([change.path]))}>
							{staged ? <Minus size={13} /> : <Plus size={13} />}
						</button>
						{!staged && <button type="button" className="cc-git-icon danger"
							title={change.status === "??" ? "移到废纸篓" : "还原未暂存修改"}
							aria-label={`${change.status === "??" ? "移到废纸篓" : "还原未暂存修改"} ${change.path}`}
							disabled={mutating} onClick={() => { setError(""); setDiscardVersion(undefined); setDiscard(change); }}>
							{change.status === "??" ? <Trash2 size={13} /> : <RotateCcw size={13} />}
						</button>}
					</div>
				)}
			</div>
		);
	};

	return (
		<aside className={`inspector workspace-review ${pane === "changes" ? "workspace-review-changes" : ""}`} aria-label="真实项目工作区">
			<header className="inspector-header workspace-review-header">
				{pane === "changes" && (
					<button type="button" className="cc-mini-btn workspace-review-back" onClick={close}>
						<ArrowLeft size={13} /> 返回聊天
					</button>
				)}
				<SlidingTabList variant="compact" className="workspace-review-tabs" role="tablist" aria-label="工作区视图">
					<button role="tab" aria-selected={pane === "changes"} onClick={() => setPane("changes")}>改动</button>
					<button role="tab" aria-selected={pane === "files"} onClick={() => setPane("files")}>文件</button>
				</SlidingTabList>
				<div className="workspace-review-header-actions">
					{pane === "changes" && onToggleReviewFocus && <IconButton icon={focusReview ? Minimize2 : Maximize2}
						label={focusReview ? "返回并排视图" : "专注审查"} onClick={onToggleReviewFocus} active={focusReview}
						className="workspace-review-focus" />}
					<IconButton icon={RefreshCw} label="刷新项目文件" onClick={() => setRefresh((value) => value + 1)} />
					<IconButton icon={X} label="关闭工作区面板" onClick={close} />
				</div>
			</header>
			{(error && !discard) || listError ? <div className="live-error" role="alert">{(error && !discard) || listError}</div> : null}
			{pane === "changes" && (
				<>
					<div className="workspace-review-scopes" role="group" aria-label="查看改动范围">
						<SlidingTabList variant="pill" className="cc-scope-pill-group">
							<button type="button" className="cc-scope-pill-btn" aria-pressed={scope === "turn"}
								onClick={() => { setListError(""); updateView((current) => ({ ...current, scope: "turn" })); }}>本轮改动</button>
							<button type="button" className="cc-scope-pill-btn" aria-pressed={scope === "workspace"}
								onClick={() => { setListError(""); updateView((current) => ({ ...current, scope: "workspace" })); }}>整个工作区</button>
						</SlidingTabList>
						{turnReview && activeCheckpoint?.finishedAt && <time title={activeCheckpoint.label} dateTime={new Date(activeCheckpoint.finishedAt).toISOString()}>
							{new Date(activeCheckpoint.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						</time>}
					</div>
					{undo && onOpenCheckpoint && (
						<div className="workspace-review-undo" role="status">
							<span>已还原 {undo.path}</span>
							<button type="button" className="cc-mini-btn" onClick={() => onOpenCheckpoint(undo.checkpoint.id, undo.path)}>撤销还原</button>
						</div>
					)}
					{!turnReview && workspace?.isGit && (
						<AnimatedDetails
							className="workspace-review-git"
							summary={
								<>
									Git 操作 <span>{workspace.branch}</span>
								</>
							}
						>
							<div className="cc-workspace-git-body">
								<PullRequestPanel conversationId={conversationId} branch={workspace.branch} readOnly={readOnly} />
								{!readOnly && workspace.changes.length > 0 && (
									<>
										<div className="cc-git-bulk">
											<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => void runGit(() => window.pi.gitStage())}>
												<Plus size={12} /> 全部暂存
											</button>
											{stagedChanges.length > 0 && (
												<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => void runGit(() => window.pi.gitUnstage())}>
													<Minus size={12} /> 全部取消暂存
												</button>
											)}
										</div>
										<form className="cc-commit-box" onSubmit={commit}>
											<input aria-label="Git 提交说明" placeholder={stagedChanges.length ? `提交 ${stagedChanges.length} 个已暂存文件…` : "先暂存修改…"}
												value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} disabled={mutating || !stagedChanges.length} />
											<button type="submit" className="primary-button" disabled={mutating || !stagedChanges.length || !commitMessage.trim()}>
												<Check size={13} /> 提交
											</button>
										</form>
									</>
								)}
							</div>
						</AnimatedDetails>
					)}
					{turnReview && !checkpointId && <p className="subtle-note workspace-review-hint">当前轮次没有可关联的检查点。可查看整个工作区的未提交改动。</p>}
					{turnReview && checkpointId && !activeCheckpoint && !listError && <p className="subtle-note workspace-review-hint" role="status">正在读取本轮检查点…</p>}
					{turnReview && !!activeCheckpoint?.excludedFiles && <p className="subtle-note workspace-review-hint">
						{activeCheckpoint.excludedFiles} 个文件超出快照容量，无法在本轮对比。
					</p>}
					{!turnReview && (
						<p className="subtle-note workspace-review-hint">
							{workspace ? (workspace.isGit ? "包含所有未提交改动，也可能有本轮开始前的手工修改。" : "当前目录没有 Git 仓库。") : (listError ? "无法加载工作区改动。" : "正在读取工作区改动…")}
						</p>
					)}
					<div className="workspace-review-body">
						<div className="changed-file-list workspace-review-files" aria-label="改动文件">
							{turnReview ? (
								<>
									{filteredTurnFiles.length > 0 && <div className="cc-change-section">本轮变更 · {filteredTurnFiles.length} 个文件</div>}
									{filteredTurnFiles.map((change) => {
										const statusLabel = { added: "新增", modified: "修改", deleted: "删除", "type-changed": "类型变化" }[change.status];
										const parts = splitPath(change.path);
										return (
											<div key={change.path} className="cc-change-row">
												<button type="button" className="cc-change-open" aria-current={change.path === selectedPath ? "true" : undefined} onClick={() => open(change.path)}>
													<FileCode2 size={14} />
													<span className="file-name" title={change.path}>
														{parts.dir && <em className="cc-file-dir">{parts.dir}</em>}
														<strong className="cc-file-base">{parts.base}</strong>
													</span>
													<span className={`cc-status-tag status-${statusTone(statusLabel)}`}>{statusLabel}</span>
												</button>
											</div>
										);
									})}
									{activeCheckpoint && !filteredTurnFiles.length && <p className="subtle-note">本轮没有可审查的文件改动。</p>}
								</>
							) : (
								<>
									{stagedChanges.length > 0 && <div className="cc-change-section">已暂存 ({stagedChanges.length})</div>}
									{stagedChanges.map((change) => renderWorkspaceFile(change, true))}
									{unstagedChanges.length > 0 && <div className="cc-change-section">未暂存与未跟踪 ({unstagedChanges.length})</div>}
									{unstagedChanges.map((change) => renderWorkspaceFile(change, false))}
									{workspace?.isGit && !workspace.changes.length && <p className="subtle-note">工作区没有未提交的修改。</p>}
								</>
							)}
						</div>
						{selectedPath && source && (
							<div className="workspace-review-preview">
								<div className="workspace-review-navigation">
									<div className="workspace-review-path" title={selectedPath}>
										{nameStart > 0 && <span>{selectedPath.slice(0, nameStart)}</span>}
										<strong>{selectedPath.slice(nameStart)}</strong>
									</div>
									<div className="workspace-review-toolbar">
										{fileIndex >= 0 && reviewPaths.length > 1 && <div className="workspace-review-stepper" role="group" aria-label="切换文件">
											<IconButton icon={ArrowLeft} label="上个文件" disabled={fileIndex <= 0} onClick={() => open(reviewPaths[fileIndex - 1])} />
											<span>{fileIndex + 1} / {reviewPaths.length}</span>
											<IconButton icon={ArrowRight} label="下个文件" disabled={fileIndex >= reviewPaths.length - 1} onClick={() => open(reviewPaths[fileIndex + 1])} />
										</div>}
										{hunkCount > 1 && <div className="workspace-review-stepper" role="group" aria-label="定位差异">
											<IconButton icon={ChevronUp} label="上一处" disabled={activeHunk === 0} onClick={() => jumpToHunk(activeHunk - 1)} />
											<span aria-live="polite">{activeHunk + 1} / {hunkCount}</span>
											<IconButton icon={ChevronDown} label="下一处" disabled={activeHunk >= hunkCount - 1} onClick={() => jumpToHunk(activeHunk + 1)} />
										</div>}
										<div className="workspace-review-actions" role="group" aria-label="差异操作">
											<button type="button" className="cc-mini-btn" title="切换统一/分栏对比" onClick={() => updateView((current) => ({ ...current, diffMode: current.diffMode === "split" ? "unified" : "split" }))}>
												<Columns2 size={12} /> {view.diffMode === "split" ? "分栏" : "统一"}
											</button>
											{onOpenInEditor && <IconButton icon={ExternalLink} label="在编辑器打开" onClick={() => onOpenInEditor(selectedPath)} />}
											{onReferenceFile && <button type="button" className="cc-mini-btn" onClick={() => onReferenceFile(selectedPath)}>引用</button>}
											{turnReview && checkpointId && onOpenCheckpoint && !readOnly && content && (
												<button type="button" className="cc-mini-btn" onClick={() => onOpenCheckpoint(checkpointId, selectedPath)}>
													<RotateCcw size={12} /> 恢复此文件…
												</button>
											)}
										</div>
									</div>
								</div>
								<div className="live-file-content live-diff workspace-review-diff" ref={scroller} onScroll={saveScroll}>
									{content ? <UnifiedDiffView diff={content.text} mode={view.diffMode} hideFileHeader onReview={onSendReview && !sending ? (anchor) => void addReview(anchor) : undefined} />
										: contentError?.requestId === requestId ? <p className="subtle-note" role="alert">{contentError.message}</p>
											: <p className="subtle-note" role="status">正在读取文件差异…</p>}
								</div>
							</div>
						)}
					</div>
					<SurfacePresence show={Boolean(view.draft || view.notes.length > 0)} direction="up" group="review-notes">
						{(notesRef) => (
						<div ref={notesRef} className="workspace-review-notes" aria-label="评审意见">
							<SmoothCollapse open={Boolean(view.draft)}>
								{view.draft && (
									<form className="workspace-review-note-editor" onSubmit={saveNote}>
										<label>{reviewLocation(view.draft)}
											<textarea aria-label="逐行评审反馈" ref={noteEditor} maxLength={maxNoteLength} value={view.draft.note}
												onChange={(event) => updateView((current) => current.draft
													? { ...current, draft: { ...current.draft, note: event.target.value } } : current)} />
										</label>
										<div>
											<button type="submit" className="cc-mini-btn" disabled={!view.draft.note.trim() || sending}>保存评审意见</button>
											<button type="button" className="cc-mini-btn" onClick={() => updateView((current) => ({ ...current, draft: undefined }))}>取消</button>
										</div>
									</form>
								)}
							</SmoothCollapse>
							{view.notes.length > 0 && (
								<>
									<ul>
										{view.notes.map((note) => (
											<li key={note.id}>
												<div><strong>{reviewLocation(note)}</strong><p>{note.note}</p></div>
												<div>
													<button type="button" className="cc-mini-btn" disabled={sending || (!!view.draft?.note.trim() && view.draft.id !== note.id)} aria-label={`编辑意见 ${reviewLocation(note)}`}
																onClick={() => { focusNoteEditor(); updateView((current) => ({ ...current, draft: note })); }}>编辑</button>
													<button type="button" className="cc-mini-btn" disabled={sending} aria-label={`移除意见 ${reviewLocation(note)}`}
														onClick={() => updateView((current) => ({ ...current, notes: current.notes.filter((item) => item.id !== note.id), draft: current.draft?.id === note.id ? undefined : current.draft }))}>移除</button>
												</div>
											</li>
										))}
									</ul>
									<button type="button" className="primary-button" disabled={!onSendReview || sending || !!view.draft?.note.trim()} onClick={() => void sendReview()}>
										{sending ? "正在发送…" : `发送 ${view.notes.length} 条评审意见`}
									</button>
								</>
							)}
						</div>
						)}
					</SurfacePresence>
				</>
			)}
			{pane === "files" && (
				<div key={selectedPath ? `file:${selectedPath}` : `dir:${view.files.directory}`} className="cc-files-stage cc-tab-panel">
					{selectedPath ? (
						<>
							<div className="file-preview-heading">
								<button type="button" onClick={() => updateView((current) => ({ ...current, files: { directory: current.files.directory, top: 0 } }))}>
									<ArrowLeft size={14} /> 返回
								</button>
								<span title={selectedPath}>{selectedPath}</span>
								{conversationId && <button type="button" className="cc-mini-btn" disabled={analyzing || !content} onClick={() => void inspect()}>{analyzing ? "分析中…" : "代码分析"}</button>}
								{onOpenInEditor && <button type="button" className="cc-mini-btn" onClick={() => onOpenInEditor(selectedPath)}><ExternalLink size={12} /> 编辑器</button>}
								{onReferenceFile && <button type="button" className="cc-mini-btn" onClick={() => onReferenceFile(selectedPath)}>引用</button>}
							</div>
							{intelligence && (
								<section className="cc-code-inspector">
									<form onSubmit={(event) => { event.preventDefault(); void inspect({ line: Number(line), column: Number(column) }); }}>
										<input type="number" required min="1" aria-label="定义查询行号" value={line} onChange={(event) => setLine(event.target.value)} />
										<input type="number" required min="1" aria-label="定义查询列号" value={column} onChange={(event) => setColumn(event.target.value)} />
										<button type="submit" className="cc-mini-btn" disabled={analyzing}>查找定义</button>
									</form>
									{intelligence.definitions.map((item, index) => <button type="button" key={index} onClick={() => open(item.path, item.line)}>{item.path}:{item.line}:{item.column}</button>)}
									<AnimatedDetails
										defaultOpen={intelligence.diagnostics.length > 0}
										summary={intelligence.diagnosticsComplete === false ? "语言服务器尚未报告诊断" : `诊断 ${intelligence.diagnostics.length}`}
									>
										{intelligence.diagnostics.map((item, index) => <button type="button" key={index} onClick={() => updateView((current) => ({ ...current, files: { ...current.files, line: item.line } }))}>{item.line}:{item.column} {item.message}</button>)}
									</AnimatedDetails>
									<AnimatedDetails summary={`符号 ${intelligence.symbols.length}`}>
										{intelligence.symbols.map((item, index) => <button type="button" key={index} onClick={() => updateView((current) => ({ ...current, files: { ...current.files, line: item.line } }))}>{item.name} · {item.line}</button>)}
									</AnimatedDetails>
								</section>
							)}
							<div className="live-file-content" ref={scroller} onScroll={saveScroll}>
								{content ? (content.text ? <CodeLines content={content.text} activeLine={view.files.line} /> : <p className="subtle-note">空文件</p>)
									: contentError?.requestId === requestId ? <p className="subtle-note" role="alert">{contentError.message}</p>
										: <p className="subtle-note cc-shimmer-text" role="status">正在读取文件…</p>}
							</div>
						</>
					) : (
						<>
							<div className="file-preview-heading">
								<button type="button" disabled={!view.files.directory} onClick={() => updateView((current) => ({ ...current,
									files: { directory: current.files.directory.split("/").slice(0, -1).join("/"), top: 0 } }))}>
									<ArrowLeft size={14} /> 上一级
								</button>
								<span>{view.files.directory || "项目根目录"}</span>
							</div>
							<div className="file-tree">
								{entries.map((entry) => (
									<button type="button" key={entry.path} onClick={() => entry.directory
										? updateView((current) => ({ ...current, files: { directory: entry.path, top: 0 } }))
										: open(entry.path)}>
										{entry.directory ? <Folder size={15} /> : <FileCode2 size={15} />}
										<span>{entry.name}</span>
									</button>
								))}
								{directoryLoading ? <p className="subtle-note cc-shimmer-text" role="status">正在读取目录…</p>
									: !entries.length && !listError && <p className="subtle-note">目录为空。</p>}
							</div>
						</>
					)}
				</div>
			)}
			{discard && (
				<Modal title={discard.status === "??" ? "将未跟踪文件移到废纸篓" : "还原未暂存修改"} close={() => { if (!mutating) setDiscard(undefined); }}>
					<div className="simple-dialog workspace-review-discard">
						<p><code>{discard.path}</code></p>
						<p>{discard.status === "??" ? "可在系统废纸篓中找回此文件。" : "文件将恢复到 Git 暂存区的版本。当前内容会保存在撤销检查点中。"}</p>
						{error ? <div className="live-error" role="alert">{error}</div>
							: !discardVersion && <p className="subtle-note" role="status">正在确认当前文件状态…</p>}
						<div>
							<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => { open(discard.path); setDiscard(undefined); }}>查看差异</button>
							<button type="button" className="cc-mini-btn" disabled={mutating} onClick={() => { setError(""); setDiscard(undefined); }}>取消</button>
							<button type="button" className="primary-button" disabled={mutating || !discardVersion} onClick={() => void discardFile()}>
								{mutating ? "正在处理…" : discard.status === "??" ? "移到废纸篓" : "确认还原"}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</aside>
	);
}

function OpenInEditorButton({ path, open }: { path: string; open: (path: string) => void }) {
	return (
		<button type="button" className="cc-git-icon cc-open-editor-btn" title="在编辑器中打开"
			aria-label={`在编辑器中打开 ${path}`} onClick={() => open(path)}>
			<ExternalLink size={12} />
		</button>
	);
}
