import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, GitPullRequest, MessageSquareCode, Plus, RefreshCw, Send } from "lucide-react";
import { formatPullRequestCommentsPrompt, type PullRequestComment, type PullRequestMergeMethod, type PullRequestStatus } from "../shared.ts";
import { SelectPopover } from "./SelectPopover.tsx";
import { SmoothCollapse } from "./SmoothCollapse.tsx";

export function PullRequestPanel({ conversationId, branch, readOnly }: { conversationId?: string; branch: string; readOnly: boolean }) {
	const [open, setOpen] = useState(false);
	const [number, setNumber] = useState("");
	const [selected, setSelected] = useState<number>();
	const [pr, setPr] = useState<PullRequestStatus | null>();
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	const [watch, setWatch] = useState(false);
	const [creating, setCreating] = useState(false);
	const [showDraft, setShowDraft] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftBody, setDraftBody] = useState("");
	const [base, setBase] = useState("");
	const [created, setCreated] = useState<string>();
	const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("squash");
	const [togglingAutoMerge, setTogglingAutoMerge] = useState(false);
	const [comments, setComments] = useState<PullRequestComment[] | null>(null);
	const [loadingComments, setLoadingComments] = useState(false);
	const [sendingComments, setSendingComments] = useState(false);
	const [statusNote, setStatusNote] = useState("");
	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!conversationId || readOnly || !draftTitle.trim() || creating) return;
		setCreating(true);
		setError("");
		try {
			const result = await window.pi.createDraftPullRequest(conversationId, { branch, title: draftTitle.trim(), body: draftBody, base: base.trim() || undefined });
			setNumber(String(result.number));
			setSelected(result.number);
			setCreated(result.url);
			setShowDraft(false);
			setPr(undefined);
			setComments(null);
			setRevision((value) => value + 1);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
		}
	};

	const toggleAutoMerge = async () => {
		if (!conversationId || !pr || readOnly || togglingAutoMerge) return;
		setTogglingAutoMerge(true);
		setError("");
		setStatusNote("");
		try {
			const nextEnabled = !pr.autoMerge?.enabled;
			const updated = await window.pi.setPullRequestAutoMerge(conversationId, pr.number, nextEnabled, mergeMethod);
			if (updated) setPr(updated);
			setStatusNote(nextEnabled ? `已开启自动合并（${mergeMethod}）。` : "已关闭自动合并。");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setTogglingAutoMerge(false);
		}
	};

	const loadComments = async () => {
		if (!conversationId || !pr || loadingComments) return;
		setLoadingComments(true);
		setError("");
		setStatusNote("");
		try {
			const list = await window.pi.pullRequestComments(conversationId, pr.number);
			setComments(list);
			if (list.length === 0) setStatusNote("当前 PR 暂无评审评论。");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingComments(false);
		}
	};

	const sendCommentsToAgent = async () => {
		if (!conversationId || !pr || !comments || comments.length === 0 || readOnly || sendingComments) return;
		setSendingComments(true);
		setError("");
		setStatusNote("");
		try {
			const message = formatPullRequestCommentsPrompt(pr, comments);
			await window.pi.command({ type: "prompt", message }, conversationId);
			setStatusNote(`已将 ${comments.length} 条 PR 评论发送给 Agent 处理。`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSendingComments(false);
		}
	};

	useEffect(() => {
		if (!open || !conversationId) return;
		let active = true;
		let busy = false;
		const read = async () => {
			if (busy) return;
			busy = true;
			try {
				const next = await window.pi.pullRequest(conversationId, selected);
				if (active) { setPr(next); setError(""); }
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				busy = false;
			}
		};
		void read();
		const timer = watch ? setInterval(() => void read(), 30_000) : undefined;
		return () => { active = false; clearInterval(timer); };
	}, [conversationId, open, selected, revision, watch]);

	return (
		<section className={`cc-pr-panel ${open ? "is-open" : ""}`.trim()} aria-label="PR 与 CI">
			<button type="button" className="cc-pr-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
				<GitPullRequest size={13} />
				<span>PR 与 CI</span>
				<ChevronRight size={13} className={`cl-tool-chevron ${open ? "open" : ""}`} />
			</button>
			<SmoothCollapse open={open}>
				<div className="cc-pr-body">
					<form className="cc-pr-bar" onSubmit={(event) => {
						event.preventDefault();
						setPr(undefined);
						setComments(null);
						setStatusNote("");
						setSelected(number ? Number(number) : undefined);
						setRevision((value) => value + 1);
					}}>
						<input aria-label="PR 编号" type="number" min="1" step="1" value={number} placeholder="当前分支的 PR" onChange={(event) => setNumber(event.target.value)} />
						<button className="cc-mini-btn" type="submit"><RefreshCw size={11} /> 刷新</button>
						<label className="live-setting-toggle cc-pr-watch">
							<input type="checkbox" checked={watch} onChange={(event) => setWatch(event.target.checked)} />
							<span>跟踪 CI</span>
						</label>
					</form>
					{created && (
						<a className="cc-pr-link" href={created} target="_blank" rel="noreferrer">
							<ExternalLink size={12} /> 已创建草稿 PR
						</a>
					)}
					{!readOnly && branch && branch !== "HEAD" && pr === null && !showDraft && (
						<button type="button" className="cc-mini-btn" onClick={() => setShowDraft(true)}>
							<Plus size={12} /> 填写草稿 PR
						</button>
					)}
					<SmoothCollapse open={showDraft}>
						<form className="cc-pr-draft" onSubmit={(event) => void create(event)}>
							<p className="subtle-note">从已推送的 <code>{branch}</code> 分支创建 GitHub 草稿 PR。</p>
							<input aria-label="草稿 PR 标题" required maxLength={256} placeholder="标题" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
							<input aria-label="草稿 PR 目标分支" placeholder="目标分支（默认仓库主分支）" value={base} onChange={(e) => setBase(e.target.value)} />
							<textarea aria-label="草稿 PR 说明" rows={3} placeholder="变更说明" value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
							<div className="cc-pr-draft-actions">
								<button className="primary-button" type="submit" disabled={creating || readOnly || !draftTitle.trim()}>
									{creating ? "创建中…" : "创建 GitHub 草稿 PR"}
								</button>
								<button className="cc-mini-btn" type="button" disabled={creating} onClick={() => setShowDraft(false)}>取消</button>
							</div>
						</form>
					</SmoothCollapse>
					{error ? (
						<p className="live-error" role="alert">{error}</p>
					) : pr === undefined ? (
						<p className="subtle-note cc-shimmer-text">正在读取 PR 与 CI 状态…</p>
					) : pr === null ? (
						<p className="subtle-note">当前分支还没有关联 PR。</p>
					) : (
						<div className="cc-pr-card">
							<div className="cc-pr-card-head">
								<a className="cc-pr-title" href={pr.url} target="_blank" rel="noreferrer">
									<span>#{pr.number} {pr.title}</span>
									<ExternalLink size={12} />
								</a>
								<span className="cc-source-tag">{pr.isDraft ? "草稿" : pr.state}</span>
							</div>
							<p className="cc-pr-meta">
								<code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code>
								{pr.reviewDecision ? ` · ${pr.reviewDecision}` : ""}
								{pr.autoMerge?.enabled ? ` · 自动合并已开启${pr.autoMerge.mergeMethod ? ` (${pr.autoMerge.mergeMethod})` : ""}` : ""}
							</p>
							<div className="cc-pr-actions">
								{!readOnly && pr.state === "OPEN" && (
									<>
										{!pr.autoMerge?.enabled && (
											<SelectPopover
												ariaLabel="自动合并方式"
												direction="down"
												value={mergeMethod}
												disabled={togglingAutoMerge}
												options={[
													{ value: "squash", label: "Squash" },
													{ value: "merge", label: "Merge" },
													{ value: "rebase", label: "Rebase" },
												]}
												onChange={(val) => setMergeMethod(val as PullRequestMergeMethod)}
											/>
										)}
										<button type="button" className="cc-mini-btn" disabled={togglingAutoMerge} onClick={() => void toggleAutoMerge()}>
											{togglingAutoMerge ? "处理中…" : pr.autoMerge?.enabled ? "关闭自动合并" : "开启自动合并"}
										</button>
									</>
								)}
								<button type="button" className="cc-mini-btn" disabled={loadingComments} onClick={() => void loadComments()}>
									<MessageSquareCode size={12} /> {loadingComments ? "拉取中…" : "拉取 PR 评论"}
								</button>
								{!readOnly && comments && comments.length > 0 && (
									<button type="button" className="cc-mini-btn primary" disabled={sendingComments} onClick={() => void sendCommentsToAgent()}>
										<Send size={11} /> {sendingComments ? "发送中…" : `一键交给 Agent 处理 (${comments.length})`}
									</button>
								)}
							</div>
							{statusNote && <p className="subtle-note">{statusNote}</p>}
							{pr.checks.length > 0 && (
								<ul className="cc-pr-checks">
									{pr.checks.map((check, i) => {
										const ok = /pass|success/i.test(check.status);
										const failCheck = /fail|error/i.test(check.status);
										return (
											<li key={i}>
												<span className={`cc-dot ${ok ? "ok" : failCheck ? "err" : "run"}`} />
												<span>{check.name}</span>
												<small>{check.status}</small>
											</li>
										);
									})}
								</ul>
							)}
							{comments && comments.length > 0 && (
								<ul className="cc-pr-comments" aria-label="PR 评论列表">
									{comments.map((comment) => (
										<li key={comment.id}>
											<div className="cc-pr-comment-head">
												<strong>@{comment.author}</strong>
												{comment.path && <code>{comment.path}{comment.line ? `:${comment.line}` : ""}</code>}
												{comment.kind === "review" && comment.state && <span className="cc-source-tag">{comment.state}</span>}
											</div>
											<p>{comment.body.slice(0, 300)}{comment.body.length > 300 ? "…" : ""}</p>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			</SmoothCollapse>
		</section>
	);
}
