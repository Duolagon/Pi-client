import { useEffect, useState } from "react";
import type { PullRequestStatus } from "../shared.ts";

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
			setRevision((value) => value + 1);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
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
					<p>{pr.headRefName} → {pr.baseRefName} · {pr.isDraft ? "草稿" : pr.state}{pr.reviewDecision ? ` · ${pr.reviewDecision}` : ""}</p>
					{pr.checks.length > 0 && <ul>{pr.checks.map((check, i) => <li key={i}>{check.name} · {check.status}</li>)}</ul>}
				</>}
			</>}
		</section>
	);
}
