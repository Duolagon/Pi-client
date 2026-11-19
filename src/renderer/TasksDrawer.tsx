import { useEffect, useState } from "react";
import { ArrowDownToLine, Eye, GitBranch, GitMerge, Play, Send, Square, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { applyEvent, transcript, type Transcript } from "./messages.ts";
import { formatCompactDuration, formatCompactTokens, formatTaskProgressSummary } from "../delegation-format.ts";
import type { DesktopTask, ExternalTask, RpcExtensionUIRequest, TaskProgress, WorktreeInfo } from "../shared.ts";

export function TasksDrawer({
	project,
	conversationId,
	initialTaskId,
	close,
	onNotice,
	fail,
}: {
	project?: string;
	/** Active conversation; "停止全部后台子 Agent" acts only on its own children. */
	conversationId?: string;
	initialTaskId?: string;
	close: () => void;
	onNotice: (msg: string) => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"tasks" | "worktrees">("tasks");
	const [tasks, setTasks] = useState<DesktopTask[]>([]);
	const [externalTasks, setExternalTasks] = useState<ExternalTask[]>([]);
	const [progressMap, setProgressMap] = useState<Record<string, TaskProgress>>({});
	const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
	const [detailTranscript, setDetailTranscript] = useState<Transcript | null>(null);
	const [detailPendingUI, setDetailPendingUI] = useState<RpcExtensionUIRequest[]>([]);
	const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});
	const [detailSeq, setDetailSeq] = useState(0);
	const [detailTask, setDetailTask] = useState<DesktopTask | null>(null);
	const [extDetail, setExtDetail] = useState<ExternalTask | null>(null);
	const [extFollowUp, setExtFollowUp] = useState("");
	const [piFollowUp, setPiFollowUp] = useState("");
	const [notifyParent, setNotifyParent] = useState(false);
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
			const sortedTasks = [...taskList].sort((a, b) => b.updatedAt - a.updatedAt);
			const sortedExt = [...extList].sort((a, b) => b.updatedAt - a.updatedAt);
			setTasks(sortedTasks);
			setExternalTasks(sortedExt);
			setWorktrees(wtList);
			if (initialTaskId && !detailTask && !extDetail) {
				const piMatch = sortedTasks.find((t) => t.id === initialTaskId);
				if (piMatch) void openDetail(piMatch);
				else {
					const extMatch = sortedExt.find((t) => t.id === initialTaskId);
					if (extMatch) void openExternalDetail(extMatch);
				}
			}
		} catch (error) {
			fail(error);
		}
	};

	useEffect(() => {
		void refresh();
		const unsubTasks = window.pi.tasks.onEvent((event) => {
			if (event.type === "task_progress") {
				setProgressMap((prev) => ({ ...prev, [event.taskId]: event.progress }));
				return;
			}
			if (event.type === "task_updated") {
				setTasks((prev) => {
					const filtered = prev.filter((t) => t.id !== event.task.id);
					return [event.task, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
				});
				setDetailTask((prev) => (prev?.id === event.task.id ? event.task : prev));
				if (!["queued", "running", "waiting_for_input"].includes(event.task.status)) {
					setProgressMap((prev) => {
						if (!(event.task.id in prev)) return prev;
						const next = { ...prev };
						delete next[event.task.id];
						return next;
					});
				}
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

	// A shown child conversation keeps its process; the host may stop idle finished ones otherwise.
	const viewedConversationId = detailTask?.conversationId;
	useEffect(() => {
		if (!viewedConversationId) return;
		void window.pi.tasks.viewing(viewedConversationId, true).catch(() => {});
		return () => {
			void window.pi.tasks.viewing(viewedConversationId, false).catch(() => {});
		};
	}, [viewedConversationId]);

	// Keep the opened Pi task detail live instead of a one-shot snapshot.
	const detailTaskId = detailTask?.id;
	useEffect(() => {
		if (!viewedConversationId || !detailTaskId) return;
		let applied = detailSeq;
		const unsub = window.pi.onEvent((packet) => {
			if (packet.conversationId !== viewedConversationId) return;
			if (packet.sequence !== undefined) {
				if (packet.sequence <= applied) return;
				applied = packet.sequence;
			}
			const event = packet.event;
			if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
				setDetailPendingUI((prev) => (prev.some((item) => item.id === event.id) ? prev : [...prev, event]));
				return;
			}
			if (event.type === "agent_settled") {
				setDetailPendingUI([]);
				void window.pi.tasks
					.snapshot(detailTaskId)
					.then((snap) => {
						applied = snap.eventSequence ?? applied;
						setDetailSeq(applied);
						setDetailTranscript(transcript(snap.messages, snap.liveTranscript));
						setDetailPendingUI(snap.pendingUI.filter((r) => ["confirm", "select", "input", "editor"].includes(r.method)));
					})
					.catch(() => {});
			}
			setDetailTranscript((prev) => (prev ? applyEvent(prev, event) : prev));
		});
		return unsub;
	}, [viewedConversationId, detailTaskId, detailSeq]);

	const openDetail = async (task: DesktopTask) => {
		try {
			const snap = await window.pi.tasks.snapshot(task.id);
			setExtDetail(null);
			setDetailTask(task);
			setDetailSeq(snap.eventSequence ?? 0);
			setDetailTranscript(transcript(snap.messages, snap.liveTranscript));
			setDetailPendingUI(snap.pendingUI.filter((r) => ["confirm", "select", "input", "editor"].includes(r.method)));
		} catch (error) {
			fail(error);
		}
	};

	const openExternalDetail = async (task: ExternalTask) => {
		try {
			const fresh = await window.pi.externalAgents.snapshot(task.id);
			setDetailTranscript(null);
			setDetailPendingUI([]);
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

	const sendPiFollowUp = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!detailTask || !piFollowUp.trim()) return;
		setBusy(true);
		try {
			const sent = await window.pi.tasks.send({
				taskId: detailTask.id,
				message: piFollowUp.trim(),
				...(detailTask.parentConversationId ? { notifyParent } : {}),
			});
			setPiFollowUp("");
			onNotice(sent.status === "delivered_to_running_agent" ? "消息已送达运行中的子 Agent。" : "已继续对话，任务正在执行。");
			await openDetail(sent.task);
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
	const isActive = (status: string) => status === "running" || status === "queued" || status === "waiting_for_input";
	const backgroundChildren = conversationId
		? tasks.filter((task) => task.parentConversationId === conversationId && task.runInBackground && isActive(task.status)).length +
			externalTasks.filter((task) => task.parentConversationId === conversationId && isActive(task.status)).length
		: 0;
	const stopAllBackground = async () => {
		if (!conversationId || !backgroundChildren) return;
		if (!window.confirm(`停止当前会话的全部 ${backgroundChildren} 个后台子 Agent？已完成的修改会保留，主会话会收到“已停止”的结果。`)) return;
		setBusy(true);
		try {
			const { stopped } = await window.pi.tasks.stopAll(conversationId);
			onNotice(stopped ? `已停止 ${stopped} 个后台子 Agent。` : "当前会话没有运行中的后台子 Agent。");
			await refresh();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

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
						{backgroundChildren > 0 && !detailTranscript && !extDetail && (
							<div className="cc-task-stop-all">
								<span>当前会话有 {backgroundChildren} 个运行中的子 Agent。按 Esc 只会中断前台调用，后台子 Agent 会继续运行。</span>
								<button
									type="button"
									className="cc-mini-btn danger"
									title="停止全部后台子 Agent（Ctrl+X Ctrl+K）"
									disabled={busy}
									onClick={() => void stopAllBackground()}
								>
									<Square size={12} /> 停止全部后台子 Agent
								</button>
							</div>
						)}
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

						{detailTranscript && detailTask ? (
							<div className="cc-task-detail">
								<div className="cc-rewind-head">
									<div>
										<strong>{detailTask.name || detailTask.title || detailTask.subagentType || "子任务"}</strong>
										{detailTask.subagentType && <span className="cc-source-tag">{detailTask.subagentType}</span>}
										<span className="cc-source-tag">{detailTask.status}</span>
										{detailTask.stopReason && <span className="cc-source-tag muted">{detailTask.stopReason}</span>}
										{isActive(detailTask.status) && progressMap[detailTask.id] && (
											<span className="cc-source-tag muted">{formatTaskProgressSummary(progressMap[detailTask.id])}</span>
										)}
									</div>
									<div className="cc-tool-ctrl-actions">
										{isActive(detailTask.status) && !detailTask.runInBackground && (detailTask.readOnly || detailTask.worktreeId) && (
											<button
												type="button"
												className="cc-mini-btn"
												onClick={() => void window.pi.tasks.background(detailTask.id).then(() => onNotice("已转到后台运行。")).catch(fail)}
											>
												<ArrowDownToLine size={12} /> 转后台
											</button>
										)}
										<button type="button" className="secondary-button" onClick={() => { setDetailTranscript(null); setDetailPendingUI([]); setDetailTask(null); }}>
											返回列表
										</button>
									</div>
								</div>
								{detailPendingUI.map((req) => (
									<div key={req.id} className="cc-task-approval">
										<span>
											待审批 ({req.method})：{"title" in req ? req.title : "需要你的输入"}
											{"message" in req && req.message ? ` — ${req.message.slice(0, 160)}` : ""}
										</span>
										<div>
											{req.method === "confirm" && (
												<>
													<button
														type="button"
														className="secondary-button"
														onClick={() =>
															void window.pi.tasks
																.respond(detailTask.id, { type: "extension_ui_response", id: req.id, confirmed: false })
																.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
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
																.respond(detailTask.id, { type: "extension_ui_response", id: req.id, confirmed: true })
																.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
																.catch(fail)
														}
													>
														允许
													</button>
												</>
											)}
											{req.method === "select" && (
												<>
													{req.options.map((opt) => (
														<button
															key={opt}
															type="button"
															className="secondary-button"
															onClick={() =>
																void window.pi.tasks
																	.respond(detailTask.id, { type: "extension_ui_response", id: req.id, value: opt })
																	.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
																	.catch(fail)
															}
														>
															{opt}
														</button>
													))}
													<button
														type="button"
														className="secondary-button"
														onClick={() =>
															void window.pi.tasks
																.respond(detailTask.id, { type: "extension_ui_response", id: req.id, cancelled: true })
																.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
																.catch(fail)
														}
													>
														取消
													</button>
												</>
											)}
											{(req.method === "input" || req.method === "editor") && (
												<>
													<input
														placeholder={"placeholder" in req ? req.placeholder : "输入回复…"}
														value={approvalInputs[req.id] ?? ("prefill" in req && req.prefill ? req.prefill : "")}
														onChange={(e) => setApprovalInputs((prev) => ({ ...prev, [req.id]: e.target.value }))}
													/>
													<button
														type="button"
														className="secondary-button"
														onClick={() =>
															void window.pi.tasks
																.respond(detailTask.id, { type: "extension_ui_response", id: req.id, cancelled: true })
																.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
																.catch(fail)
														}
													>
														取消
													</button>
													<button
														type="button"
														className="primary-button"
														onClick={() =>
															void window.pi.tasks
																.respond(detailTask.id, {
																	type: "extension_ui_response",
																	id: req.id,
																	value: approvalInputs[req.id] ?? ("prefill" in req && req.prefill ? req.prefill : ""),
																})
																.then(() => setDetailPendingUI((prev) => prev.filter((item) => item.id !== req.id)))
																.catch(fail)
														}
													>
														提交
													</button>
												</>
											)}
										</div>
									</div>
								))}
								<div className="cc-task-transcript">
									<TranscriptView transcript={detailTranscript} />
								</div>
								{!detailTask.quarantined && detailTask.status !== "queued" && (
									<form className="cc-task-start" onSubmit={(e) => void sendPiFollowUp(e)}>
										<input
											placeholder={isActive(detailTask.status) ? "向运行中的子 Agent 补充说明…" : "继续对话（保留之前的上下文）…"}
											value={piFollowUp}
											onChange={(e) => setPiFollowUp(e.target.value)}
											disabled={busy}
										/>
										{detailTask.parentConversationId && !isActive(detailTask.status) && (
											<label className="cc-task-notify" title="本轮完成后，把结果作为子 Agent 通知交付给发起它的会话">
												<input type="checkbox" checked={notifyParent} onChange={(e) => setNotifyParent(e.target.checked)} disabled={busy} />
												完成后通知父会话
											</label>
										)}
										<button type="submit" className="primary-button" disabled={busy || !piFollowUp.trim()}>
											<Send size={13} /> {isActive(detailTask.status) ? "发送" : "继续对话"}
										</button>
									</form>
								)}
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
								{tasks.map((task) => {
									const active = isActive(task.status);
									const prog = progressMap[task.id];
									const modelId = task.stats?.model?.id ?? task.model?.id;
									const totalTokens = active ? prog?.tokens.total : task.stats?.tokens.total;
									const durationMs = active ? prog?.durationMs : task.stats?.durationMs;
									const metaParts = [
										modelId,
										task.thinkingLevel ? `effort:${task.thinkingLevel}` : undefined,
										totalTokens ? `${formatCompactTokens(totalTokens)} tokens` : undefined,
										active && prog?.toolUses ? `${prog.toolUses} 次工具${prog.lastToolName ? ` (${prog.lastToolName})` : ""}` : task.stats?.toolUses ? `${task.stats.toolUses} 次工具` : undefined,
										durationMs !== undefined ? formatCompactDuration(durationMs) : undefined,
										task.stopReason ? `stop:${task.stopReason}` : undefined,
									].filter(Boolean);
									return (
										<div key={task.id} className="cc-tool-ctrl-row">
											<div className="cc-tool-ctrl-info">
												<div className="cc-tool-ctrl-name">
													<strong>{task.name ? `${task.name} · ${task.title || task.prompt.slice(0, 60)}` : task.title || task.prompt.slice(0, 60)}</strong>
													{task.subagentType && <span className="cc-source-tag">{task.subagentType}</span>}
													<span className={`cc-action-badge ${task.status === "completed" ? "allow" : task.status === "failed" || task.status === "cancelled" || task.status === "interrupted" ? "deny" : "ask"}`}>
														{task.status}
													</span>
												</div>
												<p className="cc-tool-ctrl-desc">
													{metaParts.length ? `${metaParts.join(" · ")} · ` : ""}{task.workingDirectory}
												</p>
											</div>
											<div className="cc-tool-ctrl-actions">
												{active && !task.runInBackground && (task.readOnly || task.worktreeId) && (
													<button
														type="button"
														className="cc-mini-btn"
														onClick={() => void window.pi.tasks.background(task.id).then(refresh).catch(fail)}
													>
														<ArrowDownToLine size={12} /> 转后台
													</button>
												)}
												<button type="button" className="cc-mini-btn" onClick={() => void openDetail(task)}>
													<Eye size={13} /> 详情
												</button>
												{active && (
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
									);
								})}
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
