import { useEffect, useState } from "react";
import { Eye, GitBranch, GitMerge, Play, Send, Square, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { transcript } from "./messages.ts";
import type { DesktopTask, ExternalTask, Snapshot, WorktreeInfo } from "../shared.ts";

export function TasksDrawer({
	project,
	close,
	onNotice,
	fail,
}: {
	project?: string;
	close: () => void;
	onNotice: (msg: string) => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"tasks" | "worktrees">("tasks");
	const [tasks, setTasks] = useState<DesktopTask[]>([]);
	const [externalTasks, setExternalTasks] = useState<ExternalTask[]>([]);
	const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
	const [detail, setDetail] = useState<Snapshot | null>(null);
	const [detailTask, setDetailTask] = useState<DesktopTask | null>(null);
	const [extDetail, setExtDetail] = useState<ExternalTask | null>(null);
	const [extFollowUp, setExtFollowUp] = useState("");
	const [newPrompt, setNewPrompt] = useState("");
	const [isolation, setIsolation] = useState<"worktree" | "shared">("worktree");
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		try {
			const [taskList, extList, wtList] = await Promise.all([
				window.pi.tasks.list(),
				window.pi.externalAgents.list(),
				window.pi.worktrees.list(project),
			]);
			setTasks([...taskList].sort((a, b) => b.updatedAt - a.updatedAt));
			setExternalTasks([...extList].sort((a, b) => b.updatedAt - a.updatedAt));
			setWorktrees(wtList);
		} catch (error) {
			fail(error);
		}
	};

	useEffect(() => {
		void refresh();
		const unsubTasks = window.pi.tasks.onEvent((event) => {
			if (event.type === "task_updated") {
				setTasks((prev) => {
					const filtered = prev.filter((t) => t.id !== event.task.id);
					return [event.task, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
				});
			}
		});
		const unsubExternal = window.pi.externalAgents.onEvent((packet) => {
			if (packet.event.type === "task_updated") {
				const updated = packet.event.task;
				setExternalTasks((prev) => {
					const filtered = prev.filter((t) => t.id !== updated.id);
					return [updated, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
				});
				setExtDetail((prev) => (prev?.id === updated.id ? updated : prev));
			}
		});
		return () => {
			unsubTasks();
			unsubExternal();
		};
	}, [project]);

	const openDetail = async (task: DesktopTask) => {
		try {
			const snap = await window.pi.tasks.snapshot(task.id);
			setExtDetail(null);
			setDetailTask(task);
			setDetail(snap);
		} catch (error) {
			fail(error);
		}
	};

	const openExternalDetail = async (task: ExternalTask) => {
		try {
			const fresh = await window.pi.externalAgents.snapshot(task.id);
			setDetail(null);
			setDetailTask(null);
			setExtDetail(fresh);
		} catch (error) {
			fail(error);
		}
	};

	const startTask = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newPrompt.trim()) return;
		setBusy(true);
		try {
			await window.pi.tasks.start({ project, message: newPrompt.trim(), isolation });
			setNewPrompt("");
			await refresh();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const sendExternalFollowUp = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!extDetail || !extFollowUp.trim()) return;
		setBusy(true);
		try {
			const updated = await window.pi.externalAgents.send({
				taskId: extDetail.id,
				message: extFollowUp.trim(),
				runInBackground: true,
			});
			setExtDetail(updated);
			setExtFollowUp("");
			await refresh();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const mergeWorktree = async (id: string) => {
		setBusy(true);
		try {
			const res = await window.pi.worktrees.merge(id);
			if (res.status === "blocked") fail(new Error(`合并受阻：${res.reason}`));
			else {
				onNotice(`Worktree 已合并 (${res.status})：${res.head.slice(0, 8)}`);
				await refresh();
			}
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const removeWorktree = async (id: string) => {
		setBusy(true);
		try {
			await window.pi.worktrees.remove(id);
			onNotice("已清理 Worktree。");
			await refresh();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const totalTasks = tasks.length + externalTasks.length;

	return (
		<Modal title="后台任务、子 Agent 与 Worktree (/tasks)" close={close} wide>
			<div className="simple-dialog">
				<div className="cc-modal-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
						任务与子 Agent ({totalTasks})
					</button>
					<button type="button" role="tab" aria-selected={tab === "worktrees"} onClick={() => setTab("worktrees")}>
						<GitBranch size={13} /> Worktrees ({worktrees.length})
					</button>
				</div>

				{tab === "tasks" && (
					<div className="cc-controls-body">
						<form className="cc-task-start" onSubmit={(e) => void startTask(e)}>
							<input
								placeholder="新建后台任务指令…"
								value={newPrompt}
								onChange={(e) => setNewPrompt(e.target.value)}
								disabled={busy || !project}
							/>
							<select aria-label="隔离模式" value={isolation} onChange={(e) => setIsolation(e.target.value as "worktree" | "shared")}>
								<option value="worktree">Worktree 隔离</option>
								<option value="shared">共享目录</option>
							</select>
							<button type="submit" className="primary-button" disabled={busy || !newPrompt.trim() || !project}>
								<Play size={13} /> 启动
							</button>
						</form>

						{detail && detailTask ? (
							<div className="cc-task-detail">
								<div className="cc-rewind-head">
									<div>
										<strong>{detailTask.title || detailTask.subagentType || "子任务"}</strong>
										<span className="cc-source-tag">{detailTask.status}</span>
									</div>
									<button type="button" className="secondary-button" onClick={() => { setDetail(null); setDetailTask(null); }}>
										返回列表
									</button>
								</div>
								{detail.pendingUI[0] && detail.pendingUI[0].method === "confirm" && (
									<div className="cc-task-approval">
										<span>待审批：{detail.pendingUI[0].title}</span>
										<div>
											<button
												type="button"
												className="secondary-button"
												onClick={() =>
													void window.pi.tasks
														.respond(detailTask.id, { type: "extension_ui_response", id: detail.pendingUI[0].id, confirmed: false })
														.then(() => openDetail(detailTask))
														.catch(fail)
												}
											>
												拒绝
											</button>
											<button
												type="button"
												className="primary-button"
												onClick={() =>
													void window.pi.tasks
														.respond(detailTask.id, { type: "extension_ui_response", id: detail.pendingUI[0].id, confirmed: true })
														.then(() => openDetail(detailTask))
														.catch(fail)
												}
											>
												允许
											</button>
										</div>
									</div>
								)}
								<div className="cc-task-transcript">
									<TranscriptView transcript={transcript(detail.messages)} />
								</div>
							</div>
						) : extDetail ? (
							<div className="cc-task-detail">
								<div className="cc-rewind-head">
									<div>
										<strong>{extDetail.title}</strong>
										<span className="cc-source-tag">{extDetail.executor}</span>
										<span className="cc-source-tag">turn {extDetail.turn}</span>
										<span className="cc-source-tag">{extDetail.status}</span>
									</div>
									<button type="button" className="secondary-button" onClick={() => setExtDetail(null)}>
										返回列表
									</button>
								</div>
								{extDetail.pendingApprovals.map((req) => (
									<div key={req.id} className="cc-task-approval">
										<span>
											待审批 ({req.toolName})：{req.description || JSON.stringify(req.input)}
										</span>
										<div>
											<button
												type="button"
												className="secondary-button"
												onClick={() =>
													void window.pi.externalAgents
														.respond(extDetail.id, req.id, { decision: "deny" })
														.then(() => openExternalDetail(extDetail))
														.catch(fail)
												}
											>
												拒绝
											</button>
											{req.options?.length ? (
												req.options.map((opt) => (
													<button
														key={opt.id}
														type="button"
														className="primary-button"
														onClick={() =>
															void window.pi.externalAgents
																.respond(extDetail.id, req.id, { decision: "allow", optionId: opt.id })
																.then(() => openExternalDetail(extDetail))
																.catch(fail)
														}
													>
														{opt.label}
													</button>
												))
											) : (
												<button
													type="button"
													className="primary-button"
													onClick={() =>
														void window.pi.externalAgents
															.respond(extDetail.id, req.id, { decision: "allow" })
															.then(() => openExternalDetail(extDetail))
															.catch(fail)
													}
												>
													允许
												</button>
											)}
										</div>
									</div>
								))}
								<div className="cc-task-transcript">
									<pre className="cc-bash-out">{extDetail.output || extDetail.error || "(暂无输出)"}</pre>
								</div>
								{!["running", "queued", "waiting_for_input"].includes(extDetail.status) && (
									<form className="cc-task-start" onSubmit={(e) => void sendExternalFollowUp(e)}>
										<input
											placeholder={`向 ${extDetail.executor} 原生会话继续发送指令…`}
											value={extFollowUp}
											onChange={(e) => setExtFollowUp(e.target.value)}
											disabled={busy}
										/>
										<button type="submit" className="primary-button" disabled={busy || !extFollowUp.trim()}>
											<Send size={13} /> 继续协作
										</button>
									</form>
								)}
							</div>
						) : (
							<div className="cc-list-scroll">
								{externalTasks.map((task) => (
									<div key={task.id} className="cc-tool-ctrl-row">
										<div className="cc-tool-ctrl-info">
											<div className="cc-tool-ctrl-name">
												<strong>{task.title}</strong>
												<span className="cc-source-tag">{task.executor}</span>
												<span className="cc-source-tag muted">{task.subagentType}</span>
												<span className={`cc-action-badge ${task.status === "completed" ? "allow" : task.status === "failed" || task.status === "cancelled" ? "deny" : "ask"}`}>
													{task.status}
												</span>
											</div>
											<p className="cc-tool-ctrl-desc">{task.workingDirectory}</p>
										</div>
										<div className="cc-tool-ctrl-actions">
											<button type="button" className="cc-mini-btn" onClick={() => void openExternalDetail(task)}>
												<Eye size={13} /> 详情
											</button>
											{(task.status === "running" || task.status === "queued" || task.status === "waiting_for_input") && (
												<button
													type="button"
													className="cc-mini-btn danger"
													onClick={() => void window.pi.externalAgents.cancel(task.id).then(refresh).catch(fail)}
												>
													<Square size={12} /> 停止
												</button>
											)}
										</div>
									</div>
								))}
								{tasks.map((task) => (
									<div key={task.id} className="cc-tool-ctrl-row">
										<div className="cc-tool-ctrl-info">
											<div className="cc-tool-ctrl-name">
												<strong>{task.title || task.prompt.slice(0, 60)}</strong>
												{task.subagentType && <span className="cc-source-tag">{task.subagentType}</span>}
												<span className={`cc-action-badge ${task.status === "completed" ? "allow" : task.status === "failed" || task.status === "cancelled" ? "deny" : "ask"}`}>
													{task.status}
												</span>
											</div>
											<p className="cc-tool-ctrl-desc">{task.workingDirectory}</p>
										</div>
										<div className="cc-tool-ctrl-actions">
											<button type="button" className="cc-mini-btn" onClick={() => void openDetail(task)}>
												<Eye size={13} /> 详情
											</button>
											{(task.status === "running" || task.status === "queued" || task.status === "waiting_for_input") && (
												<button
													type="button"
													className="cc-mini-btn danger"
													onClick={() => void window.pi.tasks.cancel(task.id).then(refresh).catch(fail)}
												>
													<Square size={12} /> 停止
												</button>
											)}
										</div>
									</div>
								))}
								{!totalTasks && <p className="subtle-note">暂无后台任务或模型子 Agent。</p>}
							</div>
						)}
					</div>
				)}

				{tab === "worktrees" && (
					<div className="cc-controls-body">
						<div className="cc-list-scroll">
							{worktrees.map((wt) => (
								<div key={wt.id} className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>{wt.branch}</strong>
											<span className="cc-source-tag">{wt.status}</span>
										</div>
										<p className="cc-tool-ctrl-desc">{wt.path}</p>
									</div>
									<div className="cc-tool-ctrl-actions">
										<button type="button" className="cc-mini-btn" disabled={busy || wt.status !== "ready"} onClick={() => void mergeWorktree(wt.id)}>
											<GitMerge size={13} /> 合并
										</button>
										<button type="button" className="cc-mini-btn danger" disabled={busy} onClick={() => void removeWorktree(wt.id)}>
											<Trash2 size={13} /> 清理
										</button>
									</div>
								</div>
							))}
							{!worktrees.length && <p className="subtle-note">当前项目没有受管 Worktree。</p>}
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
}
