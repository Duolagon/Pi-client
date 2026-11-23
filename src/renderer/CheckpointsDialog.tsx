import { useEffect, useRef, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { UnifiedDiffView } from "./DiffView.tsx";
import type { GitCheckpoint, GitCheckpointDiff } from "../shared.ts";
import "./checkpoints-dialog.css";

function formatTime(ts: number): string {
	return new Date(ts).toLocaleString("zh-CN", {
		month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
	});
}

const statusLabels: Record<GitCheckpoint["status"], string> = {
	pending: "尚未记录完成",
	ready: "可以恢复",
	"partially-restored": "已恢复部分文件",
	restored: "已恢复",
};

const changeLabels = {
	added: "新增", modified: "修改", deleted: "删除", "type-changed": "类型改变",
};

type Preview = {
	conversationId?: string;
	checkpointId: string;
} & ({ status: "loading" } | { status: "ready"; diff: GitCheckpointDiff } | { status: "error"; message: string });

export function CheckpointsDialog({
	conversationId,
	initialCheckpointId,
	initialPath,
	readOnly,
	close,
	onRestored,
}: {
	conversationId?: string;
	initialCheckpointId?: string;
	initialPath?: string;
	readOnly?: boolean;
	close: () => void;
	onRestored: (message: string) => void;
}) {
	const [list, setList] = useState<{ conversationId?: string; checkpoints: GitCheckpoint[] }>();
	const [listError, setListError] = useState("");
	const [selected, setSelected] = useState<string>();
	const [preview, setPreview] = useState<Preview>();
	const [listRetry, setListRetry] = useState(0);
	const [previewRetry, setPreviewRetry] = useState(0);
	const [confirm, setConfirm] = useState<{ checkpointId: string; paths: string[]; all: boolean }>();
	const [restoring, setRestoring] = useState(false);
	const [restoreError, setRestoreError] = useState("");
	const focusedFile = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let active = true;
		setList(undefined);
		setListError("");
		void window.pi.git.list(conversationId).then((checkpoints) => {
			if (!active) return;
			const sorted = [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
			setList({ conversationId, checkpoints: sorted });
			setSelected(initialCheckpointId ?? (sorted.find((cp) => cp.changes.length > 0) ?? sorted[0])?.id);
		}).catch((error: Error) => {
			if (active) setListError(error.message);
		});
		return () => { active = false; };
	}, [conversationId, initialCheckpointId, listRetry]);

	const checkpoints = list?.conversationId === conversationId ? list?.checkpoints : undefined;
	const activeCp = checkpoints?.find((cp) => cp.id === selected);

	useEffect(() => {
		setConfirm(undefined);
		setRestoreError("");
		if (!activeCp || activeCp.status === "pending") {
			setPreview(undefined);
			return;
		}
		const checkpointId = activeCp.id;
		const target = { checkpointId, conversationId };
		let active = true;
		setPreview({ ...target, status: "loading" });
		void window.pi.git.diff(target).then((diff) => {
			if (!active) return;
			if (diff.checkpointId !== checkpointId) throw new Error("文件预览与所选检查点不一致。");
			setPreview({ ...target, status: "ready", diff });
		}).catch((error: Error) => {
			if (active) setPreview({ ...target, status: "error", message: error.message });
		});
		return () => { active = false; };
	}, [conversationId, activeCp?.id, activeCp?.status === "pending", previewRetry]);

	const currentPreview = preview && preview.checkpointId === activeCp?.id && preview.conversationId === conversationId
		? preview : undefined;
	const diff = currentPreview?.status === "ready" ? currentPreview.diff : undefined;
	const canRestore = Boolean(diff && diff.files.length > 0 && activeCp?.status !== "restored" && !readOnly && !restoring);
	const desiredPath = activeCp?.id === initialCheckpointId ? initialPath : undefined;

	useEffect(() => {
		if (diff && desiredPath) focusedFile.current?.scrollIntoView({ block: "nearest" });
	}, [diff, desiredPath]);

	const requestRestore = (path?: string) => {
		if (!canRestore || !diff) return;
		const paths = diff.files.filter((file) => path === undefined || path === file.path).map((file) => file.path);
		if (!paths.length) return;
		setRestoreError("");
		setConfirm({ checkpointId: diff.checkpointId, paths, all: path === undefined });
	};

	const restore = async () => {
		if (!canRestore || !confirm || confirm.checkpointId !== diff?.checkpointId) return;
		setRestoring(true);
		setRestoreError("");
		try {
			const res = await window.pi.git.restore({
				checkpointId: confirm.checkpointId, conversationId, paths: confirm.all ? undefined : confirm.paths,
			});
			setList((current) => current?.conversationId === conversationId && current
				? { ...current, checkpoints: current.checkpoints.map((cp) => cp.id === res.checkpoint.id ? res.checkpoint : cp) }
				: current);
			setConfirm(undefined);
			if (res.conflicts.length) {
				setRestoreError(`有文件无法安全恢复。已恢复 ${res.restored.length} 个文件。\n${res.conflicts
					.map((conflict) => [conflict.path, conflict.reason].filter(Boolean).join(" — ")).join("\n")}`);
			} else {
				onRestored(res.restored.length ? `已恢复 ${res.restored.length} 个文件` : "所选文件已是检查点记录的版本");
			}
		} catch (error) {
			setRestoreError(error instanceof Error ? error.message : String(error));
		} finally {
			setRestoring(false);
		}
	};

	return (
		<Modal title="检查点与代码回滚 (/rewind)" close={() => { if (!restoring) close(); }} wide>
			<div className="simple-dialog">
				<div className="cc-rewind-layout">
					<div className="cc-rewind-list" aria-label="检查点列表">
						{!checkpoints && !listError && <p className="subtle-note" role="status">正在读取检查点…</p>}
						{listError && <p role="alert">{listError} <button type="button" className="cc-mini-btn" onClick={() => setListRetry((value) => value + 1)}>重试</button></p>}
						{checkpoints?.map((cp) => (
							<button
								type="button"
								key={cp.id}
								className={`cc-rewind-item ${cp.id === selected ? "active" : ""}`}
								aria-pressed={cp.id === selected}
								disabled={restoring}
								onClick={() => { setSelected(cp.id); setConfirm(undefined); }}
							>
								<div className="cc-rewind-title">
									<History size={13} />
									<span>{cp.label || "自动检查点"}</span>
								</div>
								<div className="cc-rewind-meta">
									<span>{formatTime(cp.createdAt)}</span>
									<span>{cp.changes.length} 个文件</span>
									<span className="cc-source-tag">{statusLabels[cp.status]}</span>
								</div>
							</button>
						))}
					</div>
					<div className="cc-rewind-detail">
						{checkpoints && !activeCp && (
							<div className="cc-empty-state">
								<History size={22} aria-hidden="true" />
								<strong>{initialCheckpointId ? "找不到指定的检查点" : "此会话还没有检查点"}</strong>
								<p>{checkpoints.length ? "可以选择列表中的其他检查点查看。" : "可写会话在开始执行前会记录工作区版本。"}</p>
							</div>
						)}
						{activeCp && (
							<div className="cc-rewind-head">
								<div>
									<strong>{activeCp.label || "检查点"}</strong>
									<span className="cc-rewind-sub"> · {activeCp.changes.length} 个文件</span>
									{Boolean(activeCp.excludedFiles) && (
										<p className="subtle-note">有 {activeCp.excludedFiles} 个文件超出快照容量，无法通过此检查点恢复。</p>
									)}
								</div>
								<button type="button" className="secondary-button" disabled={!canRestore} onClick={() => requestRestore()}>
									<RotateCcw size={13} /> 全部恢复到此检查点
								</button>
							</div>
						)}
						{activeCp?.status === "pending" && <p className="subtle-note">检查点仍在记录，任务结束后可查看。</p>}
						{readOnly && activeCp && <p className="subtle-note">在可写模式下可以恢复工作区文件。</p>}
						{activeCp && activeCp.status !== "pending" && (!currentPreview || currentPreview.status === "loading") && (
							<p className="subtle-note" role="status">正在读取所选检查点的文件差异…</p>
						)}
						{currentPreview?.status === "error" && (
							<p role="alert">{currentPreview.message} <button type="button" className="cc-mini-btn" onClick={() => setPreviewRetry((value) => value + 1)}>重试预览</button></p>
						)}
						{confirm && confirm.checkpointId === diff?.checkpointId && (
							<section className="cc-rewind-confirm" aria-label="确认恢复范围">
								<strong>恢复到 {activeCp?.label} · {activeCp && formatTime(activeCp.createdAt)}</strong>
								<p>此操作会恢复以下 {confirm.paths.length} 个文件的工作区内容，保留 Git 暂存区和会话历史。检查点之后新增的文件会被移除。</p>
								<ul>{confirm.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
								<div className="cc-rewind-confirm-actions">
									<button type="button" className="cc-mini-btn" disabled={restoring} onClick={() => setConfirm(undefined)}>取消</button>
									<button type="button" className="primary-button" disabled={!canRestore} onClick={() => void restore()}>
										{restoring ? "正在恢复…" : `确认恢复 ${confirm.paths.length} 个文件`}
									</button>
								</div>
							</section>
						)}
						{restoreError && <p className="live-error" role="alert" style={{ whiteSpace: "pre-line" }}>{restoreError}</p>}
						<div className="cc-rewind-files">
							{diff?.files.map((file) => (
								<div key={file.path} className="cc-rewind-file" ref={file.path === desiredPath ? focusedFile : undefined}>
									<div className="cc-rewind-file-bar">
										<code>{file.path}</code>
										<span className="cc-source-tag">{changeLabels[file.status]}</span>
										<button type="button" className="cc-mini-btn" disabled={!canRestore} onClick={() => requestRestore(file.path)}>
											仅恢复此文件
										</button>
									</div>
									{file.diff ? <UnifiedDiffView diff={file.diff} /> : <p className="subtle-note">无可显示的文本差异</p>}
								</div>
							))}
							{diff && !diff.files.length && <p className="subtle-note">此检查点没有文件改动。</p>}
						</div>
					</div>
				</div>
			</div>
		</Modal>
	);
}
