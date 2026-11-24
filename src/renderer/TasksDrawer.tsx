import { useEffect, useState } from "react";
import { ArrowDownToLine, Check, Circle, Clock, Eye, GitBranch, GitMerge, ListTodo, LoaderCircle, Play, Send, Square, Trash2, Users, Workflow } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { useConfirmation } from "./ConfirmationDialog.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { ExternalApprovalCard } from "./ExternalApprovalCard.tsx";
import { CheckpointsDialog } from "./CheckpointsDialog.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import { SelectPopover } from "./SelectPopover.tsx";
import { SurfacePresence } from "./Presence.tsx";
import { applyEvent, transcript, type Transcript } from "./messages.ts";
import { formatCompactDuration, formatCompactTokens, formatTaskProgressSummary } from "../delegation-format.ts";
import { computeChecklistEta, computeMonitorTiming, computeTodoTiming } from "../task-eta.ts";
import type { CronJobRecord, DesktopTask, ExternalTask, MonitorRecord, RpcExtensionUIRequest, TaskProgress, TeamRecord, TodoRecord, WorkflowRecord, WorktreeInfo } from "../shared.ts";

export function TasksDrawer({
	project,
	conversationId,
	agentTeams = false,
	initialTaskId,
	close,
	onNotice,
	fail,
}: {
	project?: string;
	/** Active conversation; the stop-all action is scoped to its background work. */
	conversationId?: string;
	agentTeams?: boolean;
	initialTaskId?: string;
	close: () => void;
	onNotice: (msg: string) => void;
	fail: (error: unknown) => void;
}) {
	const { confirm, confirmation } = useConfirmation();
	const [tab, setTab] = useState<"tasks" | "todos" | "cron" | "workflows" | "teams" | "worktrees">("tasks");
	const [tasks, setTasks] = useState<DesktopTask[]>([]);
	const [externalTasks, setExternalTasks] = useState<ExternalTask[]>([]);
	const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
	const [todos, setTodos] = useState<TodoRecord[]>([]);
	const [cronJobs, setCronJobs] = useState<CronJobRecord[]>([]);
	const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
	const [team, setTeam] = useState<TeamRecord | null>(null);
	const [progressMap, setProgressMap] = useState<Record<string, TaskProgress>>({});
	const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
	const [confirmWorktreeCleanup, setConfirmWorktreeCleanup] = useState<string>();
	const [retainedWorktreePath, setRetainedWorktreePath] = useState<string>();
	const [detailTranscript, setDetailTranscript] = useState<Transcript | null>(null);
	const [detailPendingUI, setDetailPendingUI] = useState<RpcExtensionUIRequest[]>([]);
	const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});
	const [detailSeq, setDetailSeq] = useState(0);
	const [clockNow, setClockNow] = useState(() => Date.now());
	const hasActiveItems =
		monitors.some((m) => m.status === "running") ||
		todos.some((t) => t.status === "in_progress") ||
		tasks.some((t) => t.status === "running" || t.status === "queued" || t.status === "waiting_for_input") ||
		externalTasks.some((t) => t.status === "running" || t.status === "queued" || t.status === "waiting_for_input");
	useEffect(() => {
		if (!hasActiveItems) return;
		setClockNow(Date.now());
		const timer = setInterval(() => setClockNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasActiveItems]);
	const [detailTask, setDetailTask] = useState<DesktopTask | null>(null);
	const [extDetail, setExtDetail] = useState<ExternalTask | null>(null);
	const [checkpointTask, setCheckpointTask] = useState<string>();
	const [extFollowUp, setExtFollowUp] = useState("");
	const [piFollowUp, setPiFollowUp] = useState("");
	const [notifyParent, setNotifyParent] = useState(false);
	const [newPrompt, setNewPrompt] = useState("");
	const [isolation, setIsolation] = useState<"worktree" | "shared">("worktree");
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		try {
			const [taskList, extList, wtList, todoList, monList, cronList, wfList, teamData] = await Promise.all([
				window.pi.tasks.list(),
				window.pi.externalAgents.list(),
				window.pi.worktrees.list(project),
				conversationId && window.pi.todos?.list ? window.pi.todos.list(conversationId) : Promise.resolve([]),
				window.pi.monitors?.list ? window.pi.monitors.list(conversationId) : Promise.resolve([]),
				window.pi.cron?.list ? window.pi.cron.list(conversationId) : Promise.resolve([]),
				window.pi.workflow?.list ? window.pi.workflow.list(conversationId) : Promise.resolve([]),
				agentTeams && conversationId && window.pi.teams?.get ? window.pi.teams.get(conversationId) : Promise.resolve(null),
			]);
			const sortedTasks = [...taskList].sort((a, b) => b.updatedAt - a.updatedAt);
			const sortedExt = [...extList].sort((a, b) => b.updatedAt - a.updatedAt);
			setTasks(sortedTasks);
			setExternalTasks(sortedExt);
			setWorktrees(wtList);
			setTodos(todoList);
			setMonitors(monList);
			setCronJobs(cronList);
			setWorkflows(wfList);
			setTeam(teamData);
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
		const unsubTodos = window.pi.todos?.onEvent?.(() => {
			if (conversationId && window.pi.todos?.list) {
				void window.pi.todos.list(conversationId).then(setTodos).catch(() => {});
			}
		});
		const unsubMonitors = window.pi.monitors?.onEvent?.(() => {
			if (window.pi.monitors?.list) {
				void window.pi.monitors.list(conversationId).then(setMonitors).catch(() => {});
			}
		});
		const unsubCron = window.pi.cron?.onEvent?.(() => {
			if (window.pi.cron?.list) {
				void window.pi.cron.list(conversationId).then(setCronJobs).catch(() => {});
			}
		});
		const unsubWorkflows = window.pi.workflow?.onEvent?.(() => {
			if (window.pi.workflow?.list) {
				void window.pi.workflow.list(conversationId).then(setWorkflows).catch(() => {});
			}
		});
		const unsubTeams = window.pi.teams?.onEvent?.(() => {
			if (agentTeams && conversationId && window.pi.teams?.get) {
				void window.pi.teams.get(conversationId).then(setTeam).catch(() => {});
			}
		});
		return () => {
			unsubTasks();
			unsubExternal();
			unsubTodos?.();
			unsubMonitors?.();
			unsubCron?.();
			unsubWorkflows?.();
			unsubTeams?.();
		};
	}, [project, conversationId, agentTeams]);

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
			const result = await window.pi.worktrees.remove(id, { preserveIgnored: true });
			setConfirmWorktreeCleanup(undefined);
			setRetainedWorktreePath(result.retainedIgnoredPath);
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
	const backgroundMonitors = conversationId ? monitors.filter((monitor) => monitor.status === "running" &&
		(monitor.conversationId === conversationId || monitor.rootConversationId === conversationId)).length : 0;
	const backgroundCount = backgroundChildren + backgroundMonitors;
	const stopAllBackground = async () => {
		if (!conversationId || !backgroundCount) return;
		if (!await confirm({
			title: `停止 ${backgroundCount} 项后台任务`,
			message: "这会停止当前会话所有回合中的子 Agent、后台命令和监听。已完成的修改会保留。",
			confirmLabel: "停止全部",
			destructive: true,
		})) return;
		setBusy(true);
		try {
			const { stopped } = await window.pi.tasks.stopAll(conversationId);
			onNotice(stopped ? `已停止 ${stopped} 项后台任务。` : "当前会话没有运行中的后台任务。");
			await refresh();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	if (checkpointTask) return (
		<CheckpointsDialog conversationId={checkpointTask} close={() => setCheckpointTask(undefined)} onRestored={onNotice} />
	);
	return (
		<Modal title="后台任务、子 Agent 与 Worktree (/tasks)" close={close} wide>
			<div className="simple-dialog">
				<SlidingTabList className="cc-modal-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
						任务与子 Agent ({totalTasks})
					</button>
					<button type="button" role="tab" aria-selected={tab === "todos"} onClick={() => setTab("todos")}>
						<ListTodo size={13} /> 任务清单 ({todos.length})
					</button>
					<button type="button" role="tab" aria-selected={tab === "cron"} onClick={() => setTab("cron")}>
						<Clock size={13} /> 定时唤醒 ({cronJobs.length})
					</button>
					<button type="button" role="tab" aria-selected={tab === "workflows"} onClick={() => setTab("workflows")}>
						<Workflow size={13} /> 工作流 ({workflows.length})
					</button>
					{agentTeams && (
						<button type="button" role="tab" aria-selected={tab === "teams"} onClick={() => setTab("teams")}>
							<Users size={13} /> 团队 ({team ? team.members.length : 0})
						</button>
					)}
					<button type="button" role="tab" aria-selected={tab === "worktrees"} onClick={() => setTab("worktrees")}>
						<GitBranch size={13} /> Worktrees ({worktrees.length})
					</button>
				</SlidingTabList>

				<div key={tab} className="cc-tab-panel">
				{tab === "tasks" && (
					<div className="cc-controls-body">
						{backgroundCount > 0 && !detailTranscript && !extDetail && (
							<div className="cc-task-stop-all">
								<span>当前会话有 {backgroundCount} 项活跃后台任务。</span>
								<button
									type="button"
									className="cc-mini-btn danger"
									title="停止当前会话的全部后台任务（Ctrl+X Ctrl+K）"
									disabled={busy}
									onClick={() => void stopAllBackground()}
								>
									<Square size={12} /> 停止全部后台任务
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
							<SelectPopover
								ariaLabel="隔离模式"
								direction="down"
								align="right"
								value={isolation}
								disabled={busy || !project}
								options={[
									{ value: "worktree", label: "Worktree 隔离" },
									{ value: "shared", label: "共享目录" },
								]}
								onChange={(val) => setIsolation(val as "worktree" | "shared")}
							/>
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
											<label className="live-setting-toggle cc-task-notify" title="本轮完成后，把结果作为子 Agent 通知交付给发起它的会话">
												<input type="checkbox" checked={notifyParent} onChange={(e) => setNotifyParent(e.target.checked)} disabled={busy} />
												<span>完成后通知父会话</span>
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
									<div className="cc-tool-ctrl-actions">
										{!extDetail.readOnly && (
											<button type="button" className="secondary-button" onClick={() => setCheckpointTask(extDetail.id)}>查看检查点</button>
										)}
										<button type="button" className="secondary-button" onClick={() => setExtDetail(null)}>返回列表</button>
									</div>
								</div>
								{extDetail.pendingApprovals.map((req) => (
									<ExternalApprovalCard key={req.id} task={extDetail} request={req}
										onRespond={(response) => window.pi.externalAgents.respond(extDetail.id, req.id, response)} fail={fail} />
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
								{monitors.map((mon) => {
									const monTiming = computeMonitorTiming(mon, clockNow);
									return (
										<div key={mon.id} className="cc-tool-ctrl-row">
											<div className="cc-tool-ctrl-info">
												<div className="cc-tool-ctrl-name">
													<strong>{mon.kind === "shell" ? "[后台 Bash]" : `[Monitor:${mon.kind}]`} {mon.description}</strong>
													<span className={`cc-action-badge ${mon.status === "running" ? "ask" : mon.status === "exited" || mon.status === "stopped" ? "allow" : "deny"}`}>
														{mon.status}
													</span>
													<span className="cc-eta-pill">{monTiming.elapsedLabel}</span>
													{monTiming.activityLabel && (
														<span className={`cc-eta-pill ${monTiming.stale ? "stale" : ""}`}>
															{monTiming.activityLabel}
														</span>
													)}
													{monTiming.timeoutLabel && <span className="cc-eta-pill">{monTiming.timeoutLabel}</span>}
												</div>
												<p className="cc-tool-ctrl-desc">
													id={mon.id} · {mon.kind === "shell" ? `输出行数=${mon.eventCount}${mon.status !== "running" && mon.exitCode !== undefined ? ` · 退出码=${mon.exitCode ?? "无"}` : ""}` : `事件数=${mon.eventCount}`} · {mon.target}
												</p>
											</div>
											<div className="cc-tool-ctrl-actions">
												{mon.status === "running" && (
													<button
														type="button"
														className="cc-mini-btn danger"
														onClick={() => void window.pi.monitors.stop(mon.id).then(refresh).catch(fail)}
													>
														<Square size={12} /> {mon.kind === "shell" ? "停止命令" : "停止监听"}
													</button>
												)}
											</div>
										</div>
									);
								})}
								{!totalTasks && !monitors.length && <p className="subtle-note">暂无后台任务、Monitor 或模型子 Agent。</p>}
							</div>
						)}
					</div>
				)}

				{tab === "todos" && (() => {
					const drawerEta = todos.length > 0 ? computeChecklistEta(todos, clockNow) : undefined;
					return (
					<div className="cc-controls-body">
						{drawerEta?.summaryLabel && (
							<div className="cc-eta-summary-bar">
								<span>清单进度：{todos.filter((t) => t.status === "completed").length}/{todos.length}</span>
								<span className={`cc-eta-pill ${drawerEta.anyOverdue ? "overdue" : ""}`}>{drawerEta.summaryLabel}</span>
							</div>
						)}
						<div className="cc-list-scroll">
							{todos.map((item) => {
								const timing = computeTodoTiming(item, clockNow);
								return (
								<div key={item.id} className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											{item.status === "completed" ? (
												<Check size={13} className="ok" />
											) : item.status === "in_progress" ? (
												<LoaderCircle size={13} className="spin run" />
											) : (
												<Circle size={12} className="pending" />
											)}
											<strong>#{item.id} {item.subject}</strong>
											<span className={`cc-action-badge ${item.status === "completed" ? "allow" : item.status === "in_progress" ? "ask" : ""}`}>
												{item.status}
											</span>
											{timing.label && (
												<span className={`cc-eta-pill ${timing.overdue ? "overdue" : ""}`}>
													{timing.label}
												</span>
											)}
											{item.owner && <span className="cc-source-tag">@{item.owner}</span>}
										</div>
										<p className="cc-tool-ctrl-desc">
											{item.status === "in_progress" && item.activeForm ? `${item.activeForm} · ` : ""}
											{item.description}
											{item.blockedBy.length > 0 ? ` · 阻塞于: #${item.blockedBy.join(", #")}` : ""}
											{item.blocks.length > 0 ? ` · 阻塞: #${item.blocks.join(", #")}` : ""}
										</p>
									</div>
									{conversationId && (
										<div className="cc-tool-ctrl-actions">
											<button
												type="button"
												className="cc-mini-btn"
												disabled={busy}
												onClick={() =>
													void window.pi.todos
														.update(conversationId, {
															id: item.id,
															status: item.status === "completed" ? "pending" : "completed",
														})
														.then(refresh)
														.catch(fail)
												}
											>
												{item.status === "completed" ? "重开" : "完成"}
											</button>
										</div>
									)}
								</div>
								);
							})}
							{!todos.length && <p className="subtle-note">当前会话暂无持久化任务条目（模型可使用 TodoCreate / TodoUpdate 创建与更新）。</p>}
						</div>
					</div>
					);
				})()}

				{tab === "cron" && (
					<div className="cc-controls-body">
						<p className="subtle-note" role="note">
							注意：定时唤醒与 `/loop` 仅在父会话空闲时触发，<strong>会自动消耗额度</strong>；任务 7 天后自动失效，可在设置中全局关闭。
						</p>
						<div className="cc-list-scroll">
							{cronJobs.map((job) => (
								<div key={job.id} className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>[{job.source}] {job.cron ? `cron: ${job.cron}` : `every ${Math.round((job.intervalMs ?? 0) / 1000)}s`}</strong>
											<span className="cc-source-tag">{job.durable ? "持久" : "临时"}</span>
											<span className="cc-action-badge allow">已触发 {job.runCount} 次</span>
										</div>
										<p className="cc-tool-ctrl-desc">
											{job.prompt} · 下次：{new Date(job.nextRunAt).toLocaleString()} · 过期：{new Date(job.expiresAt).toLocaleDateString()}
										</p>
									</div>
									<div className="cc-tool-ctrl-actions">
										<button
											type="button"
											className="cc-mini-btn danger"
											disabled={busy}
											onClick={() => void window.pi.cron.delete(job.id, conversationId).then(refresh).catch(fail)}
										>
											<Trash2 size={12} /> 删除
										</button>
									</div>
								</div>
							))}
							{!cronJobs.length && <p className="subtle-note">当前会话暂无活跃的定时唤醒任务（可通过 `/loop 5m 检查状态` 创建）。</p>}
						</div>
					</div>
				)}

				{tab === "workflows" && (
					<div className="cc-controls-body">
						<div className="cc-list-scroll">
							{workflows.map((wf) => (
								<div key={wf.id} className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>{wf.title}</strong>
											<span className="cc-source-tag">{wf.id}</span>
											<span className={`cc-action-badge ${wf.status === "completed" ? "allow" : wf.status === "failed" || wf.status === "cancelled" ? "deny" : "ask"}`}>
												{wf.status}
											</span>
										</div>
										<p className="cc-tool-ctrl-desc">
											阶段 {wf.phases.length} · Journal 步骤 {Object.keys(wf.journal).length} · 费用 ${wf.budget.spentCost.toFixed(4)}
											{wf.error ? ` · ${wf.error}` : ""}
										</p>
									</div>
									<div className="cc-tool-ctrl-actions">
										{(wf.status === "running" || wf.status === "waiting_for_approval") && (
											<button
												type="button"
												className="cc-mini-btn danger"
												disabled={busy}
												onClick={() => void window.pi.workflow.stop(wf.id).then(refresh).catch(fail)}
											>
												<Square size={12} /> 停止
											</button>
										)}
										{(wf.status === "failed" || wf.status === "cancelled") && (
											<button
												type="button"
												className="cc-mini-btn"
												disabled={busy}
												onClick={() => void window.pi.workflow.resume(wf.id).then(refresh).catch(fail)}
											>
												<Play size={12} /> 恢复运行
											</button>
										)}
									</div>
								</div>
							))}
							{!workflows.length && <p className="subtle-note">当前会话暂无 Workflow 运行记录。</p>}
						</div>
					</div>
				)}

				{agentTeams && tab === "teams" && (
					<div className="cc-controls-body">
						{team ? (
							<div className="cc-list-scroll">
								<div className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>团队：{team.name}</strong>
											<span className="cc-source-tag">{team.members.length} 名成员</span>
										</div>
										{team.description && <p className="cc-tool-ctrl-desc">{team.description}</p>}
									</div>
									{conversationId && (
										<div className="cc-tool-ctrl-actions">
											<button
												type="button"
												className="cc-mini-btn danger"
												disabled={busy}
												onClick={() => void window.pi.teams.delete(conversationId, team.name).then(refresh).catch(fail)}
											>
												<Trash2 size={12} /> 解散团队
											</button>
										</div>
									)}
								</div>
								{team.members.map((member) => (
									<div key={member.name} className="cc-tool-ctrl-row">
										<div className="cc-tool-ctrl-info">
											<div className="cc-tool-ctrl-name">
												<strong>@{member.name}</strong>
												{member.subagentType && <span className="cc-source-tag">{member.subagentType}</span>}
												<span className={`cc-action-badge ${member.status === "active" ? "ask" : member.status === "idle" ? "allow" : "deny"}`}>
													{member.status}
												</span>
											</div>
											<p className="cc-tool-ctrl-desc">
												{member.agentId ? `task=${member.agentId}` : "team leader"}
											</p>
										</div>
									</div>
								))}
							</div>
						) : (
							<p className="subtle-note">当前会话尚未创建 Team（模型可使用 TeamCreate 建立团队并分配 Todo* 清单）。</p>
						)}
					</div>
				)}

				{tab === "worktrees" && (
					<div className="cc-controls-body">
						{retainedWorktreePath && <p className="subtle-note" role="status">忽略文件已保留在 <code>{retainedWorktreePath}</code></p>}
						<div className="cc-list-scroll">
							{worktrees.map((wt) => (
								<div key={wt.id}>
								<div className="cc-tool-ctrl-row">
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
										<button type="button" className="cc-mini-btn danger" disabled={busy || wt.status !== "ready"} onClick={() => setConfirmWorktreeCleanup(wt.id)}>
											<Trash2 size={13} /> 清理
										</button>
									</div>
								</div>
								<SurfacePresence show={confirmWorktreeCleanup === wt.id} direction="banner" group={`wt-${wt.id}`}>
									{(wtConfirmRef) => (
										<div ref={wtConfirmRef} className="cc-task-approval" role="group" aria-label="确认清理 Worktree">
											<span>忽略文件会移到保留目录。请先提交或移出其他改动。</span>
											<div>
												<button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmWorktreeCleanup(undefined)}>取消</button>
												<button type="button" className="primary-button" disabled={busy} onClick={() => void removeWorktree(wt.id)}>确认清理</button>
											</div>
										</div>
									)}
								</SurfacePresence>
								</div>
							))}
							{!worktrees.length && <p className="subtle-note">当前项目没有受管 Worktree。</p>}
						</div>
					</div>
				)}
				</div>
			</div>
			{confirmation}
		</Modal>
	);
}
