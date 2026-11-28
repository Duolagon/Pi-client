import { useEffect, useState, type FormEvent } from "react";
import type { ExternalTask } from "../external-types.ts";
import type { GitCheckpointDiff, GitRestoreResult } from "../git-types.ts";
import { UnifiedDiffView } from "./DiffView.tsx";

export function ExternalTaskChanges({ task, fail }: { task: ExternalTask; fail(error: unknown): void }) {
	const checkpoint = task.changes?.checkpointId;
	const [metadata, setMetadata] = useState<GitCheckpointDiff>();
	const summary = metadata?.checkpointId === checkpoint ? metadata : undefined;
	const files = summary?.files ?? [];
	const [selected, setSelected] = useState("");
	const path = files.some((file) => file.path === selected) ? selected : files[0]?.path;
	const [diff, setDiff] = useState<GitCheckpointDiff>();
	const [outcome, setOutcome] = useState<{ action: "apply" | "discard"; result: GitRestoreResult }>();
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const active = ["queued", "running", "waiting_for_input"].includes(task.status);
	const incomplete = summary?.truncated || Boolean(summary?.excludedFiles);

	useEffect(() => {
		setDiff(undefined);
		setOutcome(undefined);
		setComment("");
	}, [checkpoint]);

	useEffect(() => {
		if (!checkpoint) return;
		let current = true;
		void window.pi.externalAgents.diff(task.id, checkpoint, undefined, false).then(
			(value) => { if (current) setMetadata(value); },
			(error) => { if (current) fail(error); },
		);
		return () => { current = false; };
	}, [task.id, checkpoint, task.revision, fail]);

	useEffect(() => {
		if (!checkpoint || !path) return;
		let current = true;
		setDiff(undefined);
		void window.pi.externalAgents.diff(task.id, checkpoint, path).then(
			(value) => { if (current) setDiff(value); },
			(error) => { if (current) fail(error); },
		);
		return () => { current = false; };
	}, [task.id, checkpoint, path, fail]);

	if (!checkpoint || !summary) return null;
	if (!files.length && outcome?.action === "discard" && !incomplete)
		return <section className="live-external-changes" aria-label="外部任务改动"><p role="status">已丢弃此文件改动</p></section>;
	if (!files.length) return incomplete ? (
		<section className="live-external-changes" aria-label="外部任务改动">
			<h4>累计改动</h4>
			<p className="subtle-note">部分文件未纳入检查点。可在 Worktree 中查看：{task.workingDirectory}</p>
		</section>
	) : null;
	const change = async (action: "apply" | "discard", paths?: string[]) => {
		if (busy) return;
		setBusy(true);
		try {
			const result = await window.pi.externalAgents.changeFiles({ taskId: task.id, checkpointId: checkpoint, action, paths });
			setOutcome({ action, result });
		} catch (error) { fail(error); }
		finally { setBusy(false); }
	};
	const sendComment = async (event: FormEvent) => {
		event.preventDefault();
		if (!comment.trim() || busy) return;
		setBusy(true);
		try {
			await window.pi.externalAgents.send({
				taskId: task.id, runInBackground: true,
				message: `用户对任务累计改动的评审意见（${JSON.stringify(path)}）：\n${comment.trim()}`,
			});
			setComment("");
		} catch (error) { fail(error); }
		finally { setBusy(false); }
	};
	const file = diff?.checkpointId === checkpoint && diff.files[0]?.path === path ? diff.files[0] : undefined;
	return (
		<section className="live-external-changes" aria-label="外部任务改动">
			<h4>累计改动 · {files.length}{summary.truncated ? "+" : ""} 个路径</h4>
			<p className="subtle-note">{task.workingDirectory}</p>
			<label>改动文件 <select value={path} onChange={(event) => setSelected(event.target.value)}>
				{files.map((entry) => <option key={entry.path} value={entry.path}>{entry.path} · {entry.status}</option>)}
			</select></label>
			{file?.truncated || file?.binary
				? <p className="subtle-note">{file.path} · {file.binary ? "二进制文件" : "差异过大"}</p>
				: file?.diff && <UnifiedDiffView diff={file.diff} filePath={file.path} />}
			{incomplete && <p className="subtle-note">检查点摘要只包含部分路径，可逐个处理已列出的文件。</p>}
			<div className="dialog-actions">
				<button type="button" className="secondary-button" disabled={busy || active || !path} onClick={() => void change("discard", [path!])}>丢弃此文件改动</button>
				<button type="button" className="secondary-button" disabled={busy || active || !path} onClick={() => void change("apply", [path!])}>应用此文件</button>
				<button type="button" className="primary-button" disabled={busy || active || incomplete} onClick={() => void change("apply")}>应用到项目</button>
			</div>
			{outcome && <div role="status">
				{outcome.result.status === "conflict" ? "冲突检查未通过" : outcome.result.status === "partial" ? "部分文件已处理" :
					outcome.result.status === "unchanged" ? "文件已处于目标状态" : outcome.action === "apply" ? "已应用到项目" : "已丢弃此文件改动"}
				{outcome.result.conflicts.length > 0 && <ul>{outcome.result.conflicts.map((item, index) =>
					<li key={index}>{item.path} {item.reason}</li>)}</ul>}
			</div>}
			<form onSubmit={(event) => void sendComment(event)}>
				<label>评审意见 <textarea aria-label="评审意见" value={comment} maxLength={16000} onChange={(event) => setComment(event.target.value)} /></label>
				<button type="submit" className="secondary-button" disabled={busy || active || !comment.trim()}>发回执行器</button>
			</form>
		</section>
	);
}
