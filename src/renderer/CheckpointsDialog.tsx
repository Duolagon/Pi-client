import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { UnifiedDiffView } from "./DiffView.tsx";
import type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "../shared.ts";

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function CheckpointsDialog({
	conversationId,
	initialQuery,
	close,
	onRestored,
	fail,
}: {
	conversationId?: string;
	initialQuery?: string;
	close: () => void;
	onRestored: (message: string) => void;
	fail: (error: unknown) => void;
}) {
	const [checkpoints, setCheckpoints] = useState<GitCheckpoint[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [diff, setDiff] = useState<GitCheckpointDiff | null>(null);
	const [loading, setLoading] = useState(true);
	const [restoring, setRestoring] = useState(false);

	const loadList = async () => {
		setLoading(true);
		try {
			const list = await window.pi.git.list(conversationId);
			const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
			setCheckpoints(sorted);
			if (sorted.length && !selected) {
				const matched = initialQuery
					? sorted.find((c) => c.label.includes(initialQuery.slice(0, 40)))
					: undefined;
				const withChanges = sorted.find((c) => c.changes.length > 0);
				setSelected((matched ?? withChanges ?? sorted[0]).id);
			}
		} catch (error) {
			fail(error);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void loadList();
	}, [conversationId]);

	useEffect(() => {
		if (!selected) {
			setDiff(null);
			return;
		}
		let active = true;
		void window.pi.git
			.diff({ checkpointId: selected, conversationId })
			.then((res) => {
				if (active) setDiff(res);
			})
			.catch((err) => {
				if (active) fail(err);
			});
		return () => {
			active = false;
		};
	}, [selected, conversationId]);

	const restore = async (checkpointId: string, paths?: string[]) => {
		setRestoring(true);
		try {
			const res: GitRestoreResult = await window.pi.git.restore({ checkpointId, conversationId, paths });
			await loadList();
			if (res.conflicts.length) {
				fail(new Error(`恢复存在冲突：${res.conflicts.map((c) => `${c.path} (${c.reason})`).join("；")}`));
			} else {
				onRestored(`已恢复 ${res.restored.length} 个文件（状态：${res.status}）`);
			}
		} catch (error) {
			fail(error);
		} finally {
			setRestoring(false);
		}
	};

	const activeCp = checkpoints.find((c) => c.id === selected);

	return (
		<Modal title="检查点与代码回滚 (/rewind)" close={close} wide>
			<div className="simple-dialog">
			<div className="cc-rewind-layout">
				<div className="cc-rewind-list">
					{loading && <p className="subtle-note">正在读取检查点…</p>}
					{!loading && !checkpoints.length && (
						<p className="subtle-note">当前会话暂无 Git 检查点。发送任务或执行命令后会自动捕获。</p>
					)}
					{checkpoints.map((cp) => (
						<button
							type="button"
							key={cp.id}
							className={`cc-rewind-item ${cp.id === selected ? "active" : ""}`}
							onClick={() => setSelected(cp.id)}
						>
							<div className="cc-rewind-title">
								<History size={13} />
								<span>{cp.label || "自动检查点"}</span>
							</div>
							<div className="cc-rewind-meta">
								<span>{formatTime(cp.createdAt)}</span>
								<span>{cp.changes.length} 处改动</span>
								<span className="cc-source-tag">{cp.status}</span>
							</div>
						</button>
					))}
				</div>

				<div className="cc-rewind-detail">
					{!loading && !checkpoints.length && (
						<div className="cc-empty-state">
							<History size={22} aria-hidden="true" />
							<strong>还没有检查点</strong>
							<p>Pi 每次修改文件或执行命令前，会自动记录一个 Git 检查点。之后可以在这里查看改动，并把文件恢复到当时的状态。</p>
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
							<button
								type="button"
								className="primary-button"
								disabled={restoring || !activeCp.changes.length}
								onClick={() => void restore(activeCp.id)}
							>
								<RotateCcw size={13} /> 全部恢复到此检查点
							</button>
						</div>
					)}
					<div className="cc-rewind-files">
						{diff?.files.map((file) => (
							<div key={file.path} className="cc-rewind-file">
								<div className="cc-rewind-file-bar">
									<code>{file.path}</code>
									<span className="cc-source-tag">{file.status}</span>
									<button
										type="button"
										className="cc-mini-btn"
										disabled={restoring}
										onClick={() => void restore(activeCp!.id, [file.path])}
									>
										仅恢复此文件
									</button>
								</div>
								{file.diff ? <UnifiedDiffView diff={file.diff} /> : <p className="subtle-note">无可显示的文本差异</p>}
							</div>
						))}
						{activeCp && !activeCp.changes.length && <p className="subtle-note">此检查点没有文件改动。</p>}
					</div>
				</div>
			</div>
			</div>
		</Modal>
	);
}
