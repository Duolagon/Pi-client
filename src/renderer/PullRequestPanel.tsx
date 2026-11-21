import { useEffect, useState } from "react";
import { formatPullRequestCommentsPrompt, type PullRequestComment, type PullRequestMergeMethod, type PullRequestStatus } from "../shared.ts";

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
		<section className="cc-pr-panel" aria-label="PR 与 CI">
			<button type="button" className="cc-mini-btn" aria-expanded={open} onClick={() => setOpen(!open)}>PR 与 CI</button>
			{open && <>
				<form onSubmit={(event) => {
					event.preventDefault();
					setPr(undefined);
					setComments(null);
					setStatusNote("");
					setSelected(number ? Number(number) : undefined);
					setRevision((value) => value + 1);
				}}>
					<input aria-label="PR 编号" type="number" min="1" step="1" value={number} placeholder="当前分支的 PR" onChange={(event) => setNumber(event.target.value)} />
					<button className="cc-mini-btn" type="submit">刷新</button>
					<label><input type="checkbox" checked={watch} onChange={(event) => setWatch(event.target.checked)} /> 跟踪 CI</label>
				</form>
				{created && <a href={created} target="_blank" rel="noreferrer">已创建草稿 PR</a>}
				{!readOnly && branch && branch !== "HEAD" && pr === null && !showDraft && <button type="button" className="cc-mini-btn" onClick={() => setShowDraft(true)}>填写草稿 PR</button>}
				{showDraft && <form className="cc-pr-draft" onSubmit={(event) => void create(event)}>
					<p>从已推送的 {branch} 分支创建 GitHub 草稿 PR。</p>
					<input aria-label="草稿 PR 标题" required maxLength={256} placeholder="标题" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
					<input aria-label="草稿 PR 目标分支" placeholder="目标分支（默认仓库主分支）" value={base} onChange={(e) => setBase(e.target.value)} />
					<textarea aria-label="草稿 PR 说明" placeholder="变更说明" value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
					<button className="cc-mini-btn" type="submit" disabled={creating || readOnly || !draftTitle.trim()}>创建 GitHub 草稿 PR</button>
					<button className="cc-mini-btn" type="button" disabled={creating} onClick={() => setShowDraft(false)}>取消</button>
				</form>}
				{error ? <p role="alert">{error}</p> : pr === undefined ? <p>正在读取…</p> : pr === null ? <p>当前分支还没有 PR。</p> : <>
					<a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a>
					<p>
						{pr.headRefName} → {pr.baseRefName} · {pr.isDraft ? "草稿" : pr.state}
						{pr.reviewDecision ? ` · ${pr.reviewDecision}` : ""}
						{pr.autoMerge?.enabled ? ` · 自动合并已开启${pr.autoMerge.mergeMethod ? ` (${pr.autoMerge.mergeMethod})` : ""}` : ""}
					</p>
					<div className="cc-pr-actions" style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", margin: "6px 0" }}>
						{!readOnly && pr.state === "OPEN" && <>
							{!pr.autoMerge?.enabled && (
								<select aria-label="自动合并方式" value={mergeMethod} onChange={(e) => setMergeMethod(e.target.value as PullRequestMergeMethod)} disabled={togglingAutoMerge}>
									<option value="squash">Squash</option>
									<option value="merge">Merge</option>
									<option value="rebase">Rebase</option>
								</select>
							)}
							<button type="button" className="cc-mini-btn" disabled={togglingAutoMerge} onClick={() => void toggleAutoMerge()}>
								{togglingAutoMerge ? "处理中…" : pr.autoMerge?.enabled ? "关闭自动合并" : "开启自动合并"}
							</button>
						</>}
						<button type="button" className="cc-mini-btn" disabled={loadingComments} onClick={() => void loadComments()}>
							{loadingComments ? "拉取中…" : "拉取 PR 评论"}
						</button>
						{!readOnly && comments && comments.length > 0 && (
							<button type="button" className="cc-mini-btn" disabled={sendingComments} onClick={() => void sendCommentsToAgent()}>
								{sendingComments ? "发送中…" : `一键交给 Agent 处理 (${comments.length})`}
							</button>
						)}
					</div>
					{statusNote && <p className="subtle-note">{statusNote}</p>}
					{pr.checks.length > 0 && <ul>{pr.checks.map((check, i) => <li key={i}>{check.name} · {check.status}</li>)}</ul>}
					{comments && comments.length > 0 && (
						<ul className="cc-pr-comments" aria-label="PR 评论列表">
							{comments.map((comment) => (
								<li key={comment.id}>
									<strong>@{comment.author}</strong>
									{comment.path ? ` · ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""}
									{comment.kind === "review" && comment.state ? ` (${comment.state})` : ""}
									<p style={{ margin: "2px 0 6px", whiteSpace: "pre-wrap" }}>{comment.body.slice(0, 300)}{comment.body.length > 300 ? "…" : ""}</p>
								</li>
							))}
						</ul>
					)}
				</>}
			</>}
		</section>
	);
}
