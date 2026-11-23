import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { copyText } from "./clipboard.ts";
import {
	FolderOpen,
	Plus,
	Search,
	Settings,
	Files,
	GitCompareArrows,
	Terminal as TerminalIcon,
	PanelLeftClose,
	PanelLeftOpen,
	Download,
	RefreshCw,
	X,
	ShieldCheck,
	ShieldAlert,
	SquarePen,
	ArrowDown,
	Trash2,
	Archive,
	History,
	ListTodo,
	SlidersHorizontal,
	GitFork,
	BookOpen,
	Bot,
	Plug,
	Globe,
	Command as CommandIcon,
	Check,
	Circle,
	LoaderCircle,
	MoreHorizontal,
	ChevronRight,
	Folder,
	Sparkles,
	WifiOff,
	Moon,
	Sun,
	Pin,
} from "lucide-react";
import type {
	Conversation,
	DesktopAPI,
	DesktopTask,
	ExternalTask,
	PermissionMode,
	PlanFileState,
	ProjectTrustDecision,
	SandboxStatus,
	Snapshot,
	TaskProgress,
	TodoRecord,
	WorkflowRecord,
} from "../shared.ts";
import type { GrailState } from "../shared.ts";
import { GrailBadge, GrailReportDialog, GrailReveal } from "./GrailReport.tsx";
import { grailWording, latestVerdict, revealDecision } from "./grail-view.ts";
import { IconButton, Modal, PiMark, menuKeyNav } from "../prototype/ui.tsx";
import { useDesktop } from "./useDesktop.ts";
import { TranscriptView, type TodoItem } from "./TranscriptView.tsx";
import { computeChecklistEta, computeTodoTiming, isChecklistStale } from "../task-eta.ts";
import { LiveComposer, type BuiltinSlashAction } from "./LiveComposer.tsx";
import { parseGoalCommand } from "../goal-mode.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { GrailEmblem, HolyGrailIcon, MagicCircleBackdrop, MagicCircleLoader, getServantInfo } from "./GrailIcons.tsx";
import { SubagentPanel, type SubagentPanelHandle } from "./SubagentPanel.tsx";
import { SubagentTranscriptView } from "./SubagentTranscriptView.tsx";
import { SubagentApprovals } from "./SubagentApprovals.tsx";
import { collectDescendantApprovals, groupSidebarConversations, isActiveTaskStatus } from "./subagent-panel-state.ts";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { WorkspacePanel } from "./WorkspacePanel.tsx";
import { ControlsDialog, type ControlsTab } from "./ControlsDialog.tsx";
import { CheckpointsDialog } from "./CheckpointsDialog.tsx";
import { TasksDrawer } from "./TasksDrawer.tsx";
import { SessionsDialog } from "./SessionsDialog.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { MemoryStatusDialog } from "./MemoryStatusDialog.tsx";
import { DoctorDialog } from "./DoctorDialog.tsx";
import { UsageStatsDialog } from "./UsageStatsDialog.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
import { ProjectTrustDialog } from "./ProjectTrustDialog.tsx";
import { AgentsDialog } from "./AgentsDialog.tsx";
import { McpDialog } from "./McpDialog.tsx";
import { resolveEditorPath } from "../editor-path.ts";
import "../prototype/style.css";
import "./style.css";
import "./grail-theme.css";
import "./task-flow.css";
import { checkpointByEntry, matchUserEntries, submittedPlan } from "./turn-state.ts";
import { runLabels } from "./run-status.ts";
import { TaskAttention, type AttentionItem } from "./TaskAttention.tsx";
import { fileReferences, formatFileReference } from "../file-references.ts";
import { useSessionWorkspace } from "./session-workspace.ts";
import type { GitCheckpoint } from "../git-types.ts";
import type { SessionEntriesResult } from "../session-types.ts";

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function projectName(snapshot: Snapshot, path: string): string {
	const found = snapshot.projects.find((item) => item.path === path);
	return found?.name ?? path.split("/").filter(Boolean).pop() ?? path;
}

function savedInspectorWidth(key: string, fallback: number): number {
	const stored = Number(localStorage.getItem(key));
	return Number.isFinite(stored) && stored >= 320 ? stored : fallback;
}

function Desktop({ api }: { api: DesktopAPI }) {
	const app = useDesktop(api);
	const { snapshot, history, running, changing, bashBusy } = app;
	const [sidebar, setSidebar] = useState(true);
	const [settings, setSettings] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [searchIndex, setSearchIndex] = useState(0);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [inspectorWidth, setInspectorWidth] = useState(() => savedInspectorWidth("pi.inspectorWidth", 400));
	const [reviewWidth, setReviewWidth] = useState(() => savedInspectorWidth("pi.reviewInspectorWidth", 500));
	const { pane, setPane, previewUrl, setPreviewUrl, terminalOpen, setTerminalOpen, focusReview, toggleReviewFocus } = useSessionWorkspace(snapshot?.active?.id);
	useEffect(() => {
		const resize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	const [rerun, setRerun] = useState<{ conversationId: string; command: string; requestId: number }>();
	const [turnData, setTurnData] = useState<{ conversationId: string; entries: SessionEntriesResult; checkpoints: GitCheckpoint[] }>();
	const [deferredApproval, setDeferredApproval] = useState<string>();
	const [focusedTerminal, setFocusedTerminal] = useState<{ conversationId: string; terminalId: string }>();
	const [controlsTab, setControlsTab] = useState<ControlsTab | null>(null);
	const [checkpointsOpen, setCheckpointsOpen] = useState(false);
	const [rewindTarget, setRewindTarget] = useState<{ checkpointId: string; path?: string }>();
	const [tasksOpen, setTasksOpen] = useState(false);
	const [taskInitialId, setTaskInitialId] = useState<string | undefined>(undefined);
	const [sessionsOpen, setSessionsOpen] = useState(false);
	const [memoryTab, setMemoryTab] = useState<"memory" | "context" | "status" | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [planState, setPlanState] = useState<PlanFileState | null>(null);
	const [planEditorOpen, setPlanEditorOpen] = useState(false);
	const [planDraft, setPlanDraft] = useState("");
	const [planError, setPlanError] = useState("");
	const [planApplying, setPlanApplying] = useState(false);
	const planApplyingRef = useRef(false);
	const [manualPlan, setManualPlan] = useState(false);
	const planDraftEdited = useRef(false);
	const [btwState, setBtwState] = useState<{ loading: boolean; question: string; answer?: string; error?: string; model?: string } | null>(null);
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findIndex, setFindIndex] = useState(0);
	const [trustOpen, setTrustOpen] = useState(false);
	// Projects whose trust prompt the user postponed in this session; the topbar shield keeps a dot.
	const [trustLater, setTrustLater] = useState<Record<string, true>>({});
	// Short confirmations that should not stay on screen.
	const [flash, setFlash] = useState("");
	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(""), 3200);
		return () => clearTimeout(timer);
	}, [flash]);
	const [trustBusy, setTrustBusy] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const [mcpOpen, setMcpOpen] = useState(false);
	const [todoExpanded, setTodoExpanded] = useState(false);
	const [dismissedTodoSig, setDismissedTodoSig] = useState<Record<string, string>>({});
	const [sharedTodos, setSharedTodos] = useState<TodoRecord[]>([]);
	const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
	const [tasksMap, setTasksMap] = useState<Record<string, DesktopTask>>({});
	const [taskProgressMap, setTaskProgressMap] = useState<Record<string, TaskProgress>>({});
	const [focusedSubagentTaskId, setFocusedSubagentTaskId] = useState<string | null>(null);
	const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});
	const subagentPanelRef = useRef<SubagentPanelHandle>(null);
	const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
	/** Held background results per parent conversation ("N 条子 Agent 结果待交付"). */
	const [heldResults, setHeldResults] = useState<Record<string, number>>({});
	const [delivering, setDelivering] = useState(false);
	/** Ctrl+X Ctrl+K arms "stop all background sub-agents"; a second chord within 3 s confirms. */
	const stopChord = useRef<{ x?: number; armed?: number }>({});
	const [externalTasksMap, setExternalTasksMap] = useState<Record<string, ExternalTask>>({});
	const [gitSummary, setGitSummary] = useState<{ branch: string; count: number; isGit: boolean } | null>(null);
	const [rename, setRename] = useState<string | null>(null);
	const [renameId, setRenameId] = useState<string | undefined>();
	const [groupEdit, setGroupEdit] = useState<{ id: string; value: string } | null>(null);
	const [archivedOpen, setArchivedOpen] = useState(false);
	const [convMenu, setConvMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	const [queueActionId, setQueueActionId] = useState<string>();
	const queueAction = useRef<string | undefined>(undefined);
	const [showJump, setShowJump] = useState(false);
	const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
	const [sandboxOpen, setSandboxOpen] = useState(false);
	const [doctorOpen, setDoctorOpen] = useState(false);
	const [usageOpen, setUsageOpen] = useState(false);
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const moreMenuRef = useRef<HTMLDivElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const stickToEnd = useRef(true);
	const savedScroll = useRef(new Map<string, { top: number; stick: boolean }>());
	useEffect(() => {
		let mounted = true;
		void api.sandboxStatus().then((status) => {
			if (mounted) setSandboxStatus(status);
		}).catch(() => {});
		return () => {
			mounted = false;
		};
	}, [api, snapshot?.settings.sandbox, snapshot?.settings.sandboxOffline]);
	useEffect(() => {
		if (!moreMenuOpen) return;
		const onMouseDown = (event: MouseEvent) => {
			if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) setMoreMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMoreMenuOpen(false);
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [moreMenuOpen]);
	useLayoutEffect(() => {
		const id = snapshot?.active?.id;
		const position = id ? savedScroll.current.get(id) : undefined;
		stickToEnd.current = position?.stick ?? true;
		if (position && scroll.current) scroll.current.scrollTop = position.top;
		setShowJump(Boolean(position && !position.stick));
		setDeferredApproval(undefined);
		setFocusedSubagentTaskId(null);
		setPlanEditorOpen(false);
		setManualPlan(false);
		setPlanError("");
		setPlanState(null);
		setPlanDraft("");
		planDraftEdited.current = false;
	}, [snapshot?.active?.id]);
	useEffect(() => {
		const id = snapshot?.active?.id;
		if (!id || running || changing) return;
		let disposed = false;
		void Promise.all([api.sessions.entries({ conversationId: id }), api.git.list(id)]).then(([entries, checkpoints]) => {
			if (!disposed) setTurnData({ conversationId: id, entries, checkpoints });
		}).catch(() => {
			if (!disposed) setTurnData(undefined);
		});
		return () => { disposed = true; };
	}, [api, snapshot?.active?.id, running, changing, app.revision]);
	useEffect(() => {
		setTrustOpen(false);
	}, [snapshot?.active?.project]);
	const focusFirstMenuItem = useCallback((node: HTMLDivElement | null) => {
		node?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
	}, []);
	const actOnQueue = async (action: "withdraw" | "send") => {
		const id = snapshot?.active?.id;
		if (!id || queueAction.current) return;
		queueAction.current = id;
		setQueueActionId(id);
		try {
			const { drafts, error } = await api.actOnQueue(id, action);
			if (drafts.length) {
				await app.prependDrafts(id, drafts);
				setFlash("排队的指令已放回输入框");
				composerInputRef.current?.focus();
			}
			if (error) app.fail(new Error(error));
			await app.refresh();
		} catch (error) {
			app.fail(error);
		} finally {
			queueAction.current = undefined;
			setQueueActionId(undefined);
		}
	};

	useEffect(() => {
		if (stickToEnd.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
	}, [history, running]);
	// User-initiated judgement of the current wish. Verdicts live outside the Pi session.
	const [grail, setGrail] = useState<GrailState | null>(null);
	const [grailReportId, setGrailReportId] = useState<string | null>(null);
	const [grailReveal, setGrailReveal] = useState(false);
	const pendingReveal = useRef<string | undefined>(undefined);
	const activeConversationId = snapshot?.active?.id;
	const activeConversationRef = useRef(activeConversationId);
	activeConversationRef.current = activeConversationId;
	const loadGrail = useCallback(
		(id: string | undefined) => {
			if (!id) return setGrail(null);
			void api.grail
				.state(id)
				.then((state) => {
					if (activeConversationRef.current === id) setGrail(state);
				})
				.catch(() => {});
		},
		[api],
	);
	useEffect(() => {
		// Switching conversations never replays a reveal.
		pendingReveal.current = undefined;
		setGrailReveal(false);
		setGrailReportId(null);
		setGrail(null);
		loadGrail(activeConversationId);
	}, [activeConversationId, loadGrail]);
	// A finished turn may have created the wish's first checkpoint, which enables the button.
	useEffect(() => {
		if (!running) loadGrail(activeConversationRef.current);
	}, [running, loadGrail]);
	useEffect(() => {
		const visible = () => document.visibilityState === "visible" && document.hasFocus();
		const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		const off = api.grail.onEvent((event) => {
			if (event.conversationId !== activeConversationRef.current) return;
			if (event.type === "grail_progress")
				setGrail((prev) => prev && { ...prev, running: { id: event.id, step: event.step, startedAt: prev.running?.id === event.id ? prev.running.startedAt : Date.now() } });
			else if (event.type === "grail_failed") {
				setGrail((prev) => (prev && prev.running?.id === event.id ? { ...prev, running: undefined } : prev));
				if (!event.cancelled) app.fail(new Error(`鉴定失败：${event.error}`));
			} else if (event.type === "grail_verdict") {
				setGrail((prev) => prev && { ...prev, running: undefined, verdicts: [...prev.verdicts, event.verdict] });
				const decision = revealDecision({
					grade: event.verdict.grade,
					verdictConversation: event.conversationId,
					activeConversation: activeConversationRef.current,
					visible: visible(),
					reducedMotion: reducedMotion(),
				});
				if (decision === "play") setGrailReveal(true);
				else if (decision === "defer") pendingReveal.current = event.conversationId;
				loadGrail(event.conversationId);
			} else if (event.type === "grail_sealed") loadGrail(event.conversationId);
		});
		const resume = () => {
			if (!pendingReveal.current || !visible()) return;
			if (pendingReveal.current === activeConversationRef.current) setGrailReveal(true);
			pendingReveal.current = undefined;
		};
		window.addEventListener("focus", resume);
		document.addEventListener("visibilitychange", resume);
		return () => {
			off();
			window.removeEventListener("focus", resume);
			document.removeEventListener("visibilitychange", resume);
		};
	}, [api, app.fail, loadGrail]);
	useEffect(() => {
		if (!grailReveal) return;
		const timer = setTimeout(() => setGrailReveal(false), 1800);
		return () => clearTimeout(timer);
	}, [grailReveal]);
	const startGrail = () => {
		const id = activeConversationRef.current;
		if (!id) return;
		setGrailReportId(null);
		void api.grail
			.start(id)
			.then((run) => setGrail((prev) => prev && { ...prev, running: { id: run.id, step: "diff", startedAt: Date.now() } }))
			.catch(app.fail);
	};
	const cancelGrail = () => {
		const id = activeConversationRef.current;
		if (id) void api.grail.cancel(id).catch(app.fail);
	};
	const sealGrail = () => {
		const id = activeConversationRef.current;
		if (!id) return;
		void api.grail
			.seal(id)
			.then((state) => {
				setGrail(state);
				setGrailReportId(null);
				app.setNotice("已封存，之后的改动算作下一个需求。");
			})
			.catch(app.fail);
	};
	useEffect(() => {
		let active = true;
		void api.tasks.list().then((list) => {
			if (!active) return;
			const next: Record<string, DesktopTask> = {};
			for (const t of list) next[t.id] = t;
			setTasksMap(next);
		}).catch(() => {});
		void api.externalAgents.list().then((list) => {
			if (!active) return;
			const next: Record<string, ExternalTask> = {};
			for (const t of list) next[t.id] = t;
			setExternalTasksMap(next);
		}).catch(() => {});
		const unsub = api.tasks.onEvent((event) => {
			if (event.type === "task_notifications") {
				setHeldResults((prev) => ({ ...prev, [event.conversationId]: event.pending }));
				return;
			}
			if (event.type === "task_progress") {
				setTaskProgressMap((prev) => ({ ...prev, [event.taskId]: event.progress }));
				return;
			}
			if (event.type === "task_updated") {
				setTasksMap((prev) => {
					const current = prev[event.task.id];
					if (current && current.revision >= event.task.revision) return prev;
					return { ...prev, [event.task.id]: event.task };
				});
				if (!isActiveTaskStatus(event.task.status)) {
					setTaskProgressMap((prev) => {
						if (!(event.task.id in prev)) return prev;
						const next = { ...prev };
						delete next[event.task.id];
						return next;
					});
				}
			}
		});
		const unsubExt = api.externalAgents.onEvent((packet) => {
			if (packet.event.type === "task_updated") {
				const t = packet.event.task;
				setExternalTasksMap((prev) => {
					const current = prev[t.id];
					if (current && current.revision >= t.revision) return prev;
					return { ...prev, [t.id]: t };
				});
			}
		});
		return () => {
			active = false;
			unsub();
			unsubExt();
		};
	}, [api]);
	useEffect(() => {
		const activeId = snapshot?.active?.id;
		if (!activeId || !api.todos?.list) {
			setSharedTodos([]);
			return;
		}
		let mounted = true;
		const loadTodos = () => {
			void api.todos
				.list(activeId)
				.then((list) => {
					if (mounted) setSharedTodos(list);
				})
				.catch(() => {});
		};
		loadTodos();
		const unsubTodos = api.todos?.onEvent?.(() => {
			loadTodos();
		});
		return () => {
			mounted = false;
			unsubTodos?.();
		};
	}, [api, snapshot?.active?.id]);
	useEffect(() => {
		const activeId = snapshot?.active?.id;
		if (!activeId || !api.workflow?.list) {
			setWorkflows([]);
			return;
		}
		let mounted = true;
		const loadWorkflows = () => {
			void api.workflow
				.list(activeId)
				.then((list) => {
					if (mounted) setWorkflows(list);
				})
				.catch(() => {});
		};
		loadWorkflows();
		const unsubWf = api.workflow?.onEvent?.(() => {
			loadWorkflows();
		});
		return () => {
			mounted = false;
			unsubWf?.();
		};
	}, [api, snapshot?.active?.id]);
	useEffect(() => {
		if (!snapshot?.active?.project) {
			setGitSummary(null);
			return;
		}
		let active = true;
		void api
			.workspace()
			.then((ws) => {
				if (active) setGitSummary({ branch: ws.branch, count: ws.changes.length, isGit: ws.isGit });
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [snapshot?.active?.project, app.revision]);
	const activeHeldId = snapshot?.active?.id;
	const activeHeldCount = snapshot?.pendingTaskNotifications;
	useEffect(() => {
		if (activeHeldId) setHeldResults((prev) => ({ ...prev, [activeHeldId]: activeHeldCount ?? 0 }));
	}, [activeHeldId, activeHeldCount]);
	const heldCount = activeHeldId ? heldResults[activeHeldId] ?? 0 : 0;
	const deliverHeldResults = async () => {
		if (!activeHeldId || delivering) return;
		setDelivering(true);
		try {
			const { pending } = await api.tasks.deliverNow(activeHeldId);
			setHeldResults((prev) => ({ ...prev, [activeHeldId]: pending }));
			app.setNotice(pending ? `仍有 ${pending} 条子 Agent 结果未能交付，请稍后重试。` : "已交付子 Agent 结果，主会话开始处理。");
		} catch (error) {
			app.fail(error);
		} finally {
			setDelivering(false);
		}
	};
	const stopAllBackground = async () => {
		if (!snapshot?.active) return;
		try {
			const { stopped } = await api.tasks.stopAll(snapshot.active.id);
			app.setNotice(stopped ? `已停止 ${stopped} 个后台子 Agent。` : "当前会话没有运行中的后台子 Agent。");
		} catch (error) {
			app.fail(error);
		}
	};
	const backgroundSubagent = async (taskId: string) => {
		try {
			await api.tasks.background(taskId);
			app.setNotice("已将子 Agent 转到后台运行，完成后结果自动回传。");
		} catch (error) {
			app.fail(error);
		}
	};
	const backgroundForegroundSubagents = async () => {
		const activeId = snapshot?.active?.id;
		if (!activeId) return false;
		const targets = Object.values(tasksMap).filter(
			(t) =>
				t.parentConversationId === activeId &&
				!t.runInBackground &&
				isActiveTaskStatus(t.status) &&
				Boolean(t.readOnly || t.worktreeId),
		);
		if (!targets.length) return false;
		try {
			for (const target of targets) await api.tasks.background(target.id);
			app.setNotice(
				targets.length === 1
					? "已将前台子 Agent 转到后台运行，完成后结果自动回传。"
					: `已将 ${targets.length} 个前台子 Agent 转到后台运行。`,
			);
			return true;
		} catch (error) {
			app.fail(error);
			return true;
		}
	};
	const stopSubagent = async (taskId: string, kind: "pi" | "external") => {
		try {
			if (kind === "external") await api.externalAgents.cancel(taskId);
			else await api.tasks.cancel(taskId);
			app.setNotice("已停止子 Agent。");
		} catch (error) {
			app.fail(error);
		}
	};
	const openSubagent = (taskId: string) => {
		if (tasksMap[taskId]) {
			setFocusedSubagentTaskId(taskId);
			return;
		}
		setTaskInitialId(taskId);
		setTasksOpen(true);
	};
	const blocked = running || changing || bashBusy || planApplying;
	const project = snapshot?.projects.find((item) => item.path === snapshot.active?.project);
	const taskList = [...Object.values(tasksMap), ...Object.values(externalTasksMap)];
	const activeTaskCount = taskList.filter((t) => t.status === "running" || t.status === "queued").length;
	const waitingTaskCount = taskList.filter((t) => t.status === "waiting_for_input").length;
	const switchTo = (operation: () => ReturnType<DesktopAPI["snapshot"]>) => {
		if (planApplyingRef.current) return;
		setSearching(false);
		void app.switchTo(operation);
	};
	const savePermission = async (permission: PermissionMode) => {
		if (!snapshot) return;
		if (permission === "auto" && snapshot.settings.permission !== "auto" &&
			!window.confirm("为客户端启用「全部放行」？模型工具将按规则执行，常规操作不再逐项询问。")) return;
		let saved = false;
		await app.switchTo(async () => {
			const next = await api.saveSettings({ permission, theme: snapshot.settings.theme });
			saved = next.settings.permission === permission && next.engineStatus === "ready";
			return next;
		});
		if (saved) {
			setPlanMode(permission === "plan");
			if (permission === "plan") setPlanError("");
			if (permission === "auto") setFlash("已切换为全部放行");
		}
		return saved;
	};
	const saveSandbox = async (next: { sandbox: boolean; sandboxOffline: boolean }) => {
		if (!snapshot) return;
		await app.switchTo(() =>
			api.saveSettings({
				permission: snapshot.settings.permission,
				theme: snapshot.settings.theme,
				sandbox: next.sandbox,
				sandboxOffline: next.sandbox && next.sandboxOffline,
			}),
		);
		const status = await api.sandboxStatus().catch(() => null);
		if (status) setSandboxStatus(status);
		app.setNotice(
			next.sandbox
				? next.sandboxOffline
					? "已开启 macOS Seatbelt 离线命令沙箱。"
					: "已开启 macOS Seatbelt 命令沙箱。"
				: "已关闭 OS 命令沙箱。",
		);
	};
	const selectWorkspace = (path: string) => {
		setMoreMenuOpen(false);
		switchTo(() => api.selectProject(path));
	};
	const openWorkspace = () => {
		setMoreMenuOpen(false);
		void app.switchTo(() => api.openProject());
	};
	const cycleTheme = async () => {
		if (!snapshot || blocked) return;
		const order: Array<"light" | "dark" | "grail"> = ["light", "dark", "grail"];
		const current = snapshot.settings.theme === "system" ? "light" : snapshot.settings.theme;
		const next = order[(order.indexOf(current) + 1) % order.length];
		await app.switchTo(() => api.saveSettings({ permission: snapshot.settings.permission, theme: next }));
	};
	const decideTrust = async (decision: ProjectTrustDecision) => {
		if (!snapshot?.trust || trustBusy) return;
		setTrustBusy(true);
		try {
			app.apply(await api.setProjectTrust({ project: snapshot.trust.project, decision }));
			setFlash(decision === "trusted" ? "项目配置已加载" : "项目配置保持禁用");
			setTrustOpen(false);
		} catch (error) {
			app.fail(error);
		} finally {
			setTrustBusy(false);
		}
	};
	/** Reuses the current session when it is still empty, instead of stacking blank "新会话" rows. */
	const startNewConversation = () => {
		if (snapshot?.active && !running && history.messages.length === 0 && !app.draft.trim() && !app.attachments.length && !app.draftLoading) {
			composerInputRef.current?.focus();
			return;
		}
		switchTo(() => api.newConversation());
	};
	const PLAN_TEMPLATE = "请先调研相关代码并将实施计划写入 .pi/plans/，完成后调用 ExitPlanMode 提交审批：\n";
	const togglePlanMode = async () => {
		if (!snapshot) return;
		const inPlan = planMode || snapshot.settings.permission === "plan";
		if (inPlan) {
			if (!await savePermission("ask")) return;
			setPlanEditorOpen(false);
			setManualPlan(false);
			if (app.draft.trim() === PLAN_TEMPLATE.trim()) app.setDraft("");
		} else {
			if (!await savePermission("plan")) return;
			if (!app.draft.trim()) app.setDraft(PLAN_TEMPLATE);
		}
	};
	const approvePlanAndExecute = async (mode: "ask" | "acceptEdits") => {
		const id = snapshot?.active?.id;
		if (!id || planApplyingRef.current || !planDraft.trim() || !planState) return;
		planApplyingRef.current = true;
		setPlanApplying(true);
		setPlanError("");
		let modeChanged = false;
		try {
			const current = await api.readPlan(id);
			if (current.exists !== planState.exists || current.content !== planState.content)
				throw new Error("计划文件在编辑期间发生了变化。请重新读取，再确认要执行的版本。");
			const saved = current.content === planDraft && current.exists ? current : await api.writePlan(planDraft, id);
			if (!saved.exists || saved.content !== planDraft) throw new Error("计划保存结果不完整，请重试。");
			setPlanState(saved);
			const updated = await api.saveSettings({ permission: mode, theme: snapshot.settings.theme });
			modeChanged = updated.settings.permission === mode;
			if (!modeChanged || updated.active?.id !== id || updated.engineStatus !== "ready")
				throw new Error("执行模式尚未就绪。请返回计划后重试。");
			const approved = await api.readPlan(id);
			if (!approved.exists || approved.content !== saved.content)
				throw new Error("审批期间计划文件已更新。请重新读取，再确认要执行的版本。");
			await api.command({
				type: "prompt",
				message: `计划已批准（存档：${saved.relativePath}）。请按以下已批准的正文实施并运行相关检查。\n\n${saved.content}`,
			}, id);
			modeChanged = false;
			setPlanMode(false);
			setManualPlan(false);
			planDraftEdited.current = false;
			setPlanEditorOpen(false);
			await app.refresh();
		} catch (error) {
			if (modeChanged) await api.saveSettings({ permission: "plan", theme: snapshot.settings.theme }).then(app.apply).catch(app.fail);
			setPlanError(error instanceof Error ? error.message : String(error));
		} finally {
			planApplyingRef.current = false;
			setPlanApplying(false);
		}
	};
	const sendInitPrompt = () => {
		app.setDraft("请分析当前项目结构、构建脚本、测试命令和代码规范，创建或更新根目录的 AGENTS.md 项目指南文件。");
	};
	const runBtw = async (question: string) => {
		const q = question.trim();
		if (!q) return;
		setBtwState({ loading: true, question: q });
		try {
			const res = await api.btw(q);
			setBtwState({ loading: false, question: q, answer: res.answer, model: res.model });
		} catch (error) {
			setBtwState({ loading: false, question: q, error: error instanceof Error ? error.message : String(error) });
		}
	};
	const runLoop = async (args: string) => {
		const activeId = snapshot?.active?.id;
		if (!activeId) return;
		try {
			const job = await api.cron.loop(activeId, args);
			const nextStr = new Date(job.nextRunAt).toLocaleTimeString();
			app.setNotice(`已创建定时任务 ${job.id}（下次触发 ${nextStr}，注意：空闲时会自动运行并消耗额度）。`);
		} catch (error) {
			app.fail(error);
		}
	};
	const exportActive = () =>
		void api
			.exportConversation()
			.then((path) => {
				if (path) app.setNotice(`会话已导出：${path}`);
			})
			.catch(app.fail);
	const openInEditor = (filePath: string, line?: number) => {
		const target = resolveEditorPath(snapshot?.active?.project, filePath);
		if (!target) {
			app.fail(new Error("无法定位此文件路径。"));
			return;
		}
		void api.openInEditor({ path: target, ...(line ? { line } : {}) }).catch(app.fail);
	};
	const handleBuiltinSlash = (action: BuiltinSlashAction, argument = "") => {
		if (action === "output-style") {
			if (!snapshot) return;
			const wanted = argument.trim();
			if (!wanted) {
				setSettings(true);
				void api
					.outputStyles()
					.then((styles) =>
						app.setNotice(`当前输出风格：${snapshot.settings.outputStyle ?? "default"}。可选：${styles.map((style) => style.name).join("、")}；用 /output-style <名称> 切换，或在设置中选择。`),
					)
					.catch(app.fail);
				return;
			}
			if (blocked) return;
			void app.switchTo(async () => {
				const next = await api.saveSettings({ permission: snapshot.settings.permission, theme: snapshot.settings.theme, outputStyle: wanted });
				app.setNotice(`已切换输出风格为 ${next.settings.outputStyle ?? "default"}，下一轮对话生效。`);
				return next;
			});
			return;
		}
		if (action === "verify") {
			if (!snapshot?.active || blocked) return;
			const target = argument.trim();
			const prompt = target
				? `请使用 PreviewCheck 工具验证本地网页（${target}）：如有需要可先读取 .claude/launch.json 并启动开发服务器，加载页面后检查控制台与网络报错、读取关键 DOM、执行必要的点击交互并截图确认，最后总结验证结果。`
				: "请使用 PreviewCheck 工具验证当前项目的本地网页：先调用 PreviewCheck(action=\"list_configs\") 查看 .claude/launch.json 配置，如有需要启动开发服务器并等待就绪，随后检查页面渲染、控制台/网络报错、关键 DOM 与交互并截图，最后汇报验证结果。";
			void app.send({ type: "prompt", message: prompt, images: [] });
			return;
		}
		if (action === "goal") {
			const id = snapshot?.active?.id;
			if (!id || !snapshot) return;
			try {
				const parsed = parseGoalCommand(argument);
				if (parsed.action === "status") {
					const g = snapshot.active?.goal;
					app.setNotice(
						g
							? `目标模式（${g.active ? "进行中" : g.status} · ${g.turnsUsed}/${g.maxTurns} 轮${g.maxCostUsd ? ` · 上限 $${g.maxCostUsd}` : ""}）：${g.objective}${g.stopReason ? `（${g.stopReason}）` : ""}`
							: "用法：/goal [--max-turns 8] [--max-cost 2] <目标描述>；用 /goal stop 停止。",
					);
					return;
				}
				if (parsed.action === "stop") {
					void app.switchTo(async () => {
						const next = await api.stopGoal(id);
						app.setNotice("已停止目标模式。");
						return next;
					});
					return;
				}
				if (blocked) return;
				void app.switchTo(async () => {
					const next = await api.startGoal(id, {
						objective: parsed.objective,
						maxTurns: parsed.maxTurns,
						maxCostUsd: parsed.maxCostUsd,
					});
					app.setNotice(`目标模式已启动（最多 ${parsed.maxTurns} 轮${parsed.maxCostUsd ? `，上限 $${parsed.maxCostUsd}` : ""}）。`);
					return next;
				});
			} catch (cause) {
				app.fail(cause);
			}
			return;
		}
		if (action === "add-dir") {
			const id = snapshot?.active?.id;
			if (!id || !snapshot) return;
			const trimmed = argument.trim();
			if (!trimmed) {
				const dirs = snapshot.active?.additionalDirs ?? [];
				app.setNotice(
					dirs.length > 0
						? `当前已附加目录：${dirs.join("、")}（用 /add-dir <目录> 添加，/add-dir rm <目录> 移除）`
						: "当前未附加其他目录。用法：/add-dir <目录路径>",
				);
				return;
			}
			const rmMatch = /^(?:rm|remove)\s+(.+)$/i.exec(trimmed);
			if (rmMatch) {
				const targetPath = rmMatch[1].trim();
				void app.switchTo(async () => {
					const next = await api.removeDir(id, targetPath);
					app.setNotice(`已移除附加目录：${targetPath}`);
					return next;
				});
				return;
			}
			void app.switchTo(async () => {
				const { snapshot: next, added } = await api.addDir(id, trimmed);
				app.setNotice(`已附加目录（读写与沙箱已同步放行）：${added}`);
				return next;
			});
			return;
		}
		if (action === "theme") {
			const wanted = argument.toLowerCase();
			if (!wanted) void cycleTheme();
			else if (wanted === "light" || wanted === "dark" || wanted === "grail" || wanted === "system") {
				if (snapshot && !blocked)
					void app.switchTo(() => api.saveSettings({ permission: snapshot.settings.permission, theme: wanted }));
			} else app.fail(new Error("可选主题：light、dark、grail、system。"));
		} else if (action === "rename") {
			const id = snapshot?.active?.id;
			if (!id) return;
			if (argument) void app.switchTo(() => api.renameConversation(id, argument.slice(0, 200)));
			else {
				setRenameId(undefined);
				setRename(snapshot.active?.title ?? "");
			}
		} else if (action === "copy") {
			const nth = argument ? Number(argument) : 1;
			if (!Number.isSafeInteger(nth) || nth < 1) {
				app.fail(new Error("用法：/copy 复制最后一条回复，/copy 2 复制倒数第 2 条。"));
				return;
			}
			const replies = history.messages
				.filter((m) => m.role === "assistant")
				.map((m) =>
					m.content
						.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
						.map((b) => b.text)
						.join("\n\n")
						.trim(),
				)
				.filter(Boolean);
			const text = replies[replies.length - nth];
			if (!text) {
				app.setNotice(nth === 1 ? "还没有可复制的回复。" : `只有 ${replies.length} 条回复。`);
				return;
			}
			void copyText(text).then((ok) => app.setNotice(ok ? "已复制回复到剪贴板。" : "复制失败，请手动选择文字复制。"));
		} else if (action === "export") {
			if (snapshot?.active && !blocked) exportActive();
		} else if (action === "fork") {
			const id = snapshot?.active?.id;
			if (!id || blocked || changing) return;
			void app.switchTo(async () => {
				const result = await api.sessions.clone({ conversationId: id, activate: true });
				if (!result.cancelled && argument && result.conversation)
					return api.renameConversation(result.conversation.id, argument.slice(0, 200));
				return result.snapshot;
			});
		} else if (action === "compact") {
			if (!blocked && history.messages.length) void app.command({ type: "compact" });
		} else if (action === "context") {
			setMemoryTab("context");
		} else if (action === "hooks") {
			setControlsTab("hooks");
		} else if (action === "skills") {
			setControlsTab("skills");
		} else if (action === "btw") {
			app.setDraft("/btw ");
		} else if (action === "loop") {
			app.setDraft("/loop 5m ");
		} else if (action === "batch") {
			app.setDraft("/batch ");
		} else if (action === "sandbox") {
			setSandboxOpen(true);
		} else if (action === "new") {
			if (!changing && snapshot?.active) startNewConversation();
		} else if (action === "permissions") {
			setControlsTab("permissions");
		} else if (action === "mcp") {
			setMcpOpen(true);
		} else if (action === "rewind") {
			setRewindTarget(undefined);
			setCheckpointsOpen(true);
		} else if (action === "tasks") {
			setTaskInitialId(undefined);
			setTasksOpen(true);
		} else if (action === "agents") {
			setAgentsOpen(true);
		} else if (action === "sessions") {
			setSessionsOpen(true);
		} else if (action === "memory") {
			setMemoryTab("memory");
		} else if (action === "status") {
			setMemoryTab("status");
		} else if (action === "init") {
			sendInitPrompt();
		} else if (action === "preview") {
			setPane(null);
			setPreviewUrl((prev) => prev ?? "http://localhost:3000");
		} else if (action === "cost") {
			const s = snapshot?.stats;
			if (s) {
				app.setNotice(
					`会话统计：输入 ${s.tokens.input} · 输出 ${s.tokens.output} · 总计 ${s.tokens.total} tokens · 费用 $${s.cost.toFixed(4)}`,
				);
			} else {
				app.setNotice("当前会话暂无 Token 统计。");
			}
		} else if (action === "plan") {
			void togglePlanMode();
		} else if (action === "doctor") {
			setDoctorOpen(true);
		} else if (action === "stats") {
			setUsageOpen(true);
		} else if (action === "grail") {
			if (blocked) app.setNotice("请等待当前任务结束后再发起鉴定。");
			else if (!grail?.hasDiff) app.setNotice("这个需求还没有代码改动（或不是 Git 项目），暂时无法鉴定。");
			else startGrail();
		}
	};
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const lower = event.key.toLowerCase();
			// Ctrl+X Ctrl+K: stop all background sub-agents of this conversation (press twice to confirm).
			if (event.ctrlKey && !event.metaKey && lower === "x") {
				stopChord.current.x = Date.now();
				return;
			}
			if (event.ctrlKey && !event.metaKey && lower === "k" && stopChord.current.x && Date.now() - stopChord.current.x < 1500) {
				event.preventDefault();
				stopChord.current.x = undefined;
				if (stopChord.current.armed && Date.now() - stopChord.current.armed < 3000) {
					stopChord.current.armed = undefined;
					void stopAllBackground();
				} else {
					stopChord.current.armed = Date.now();
					app.setNotice("再按一次 Ctrl+X Ctrl+K 停止当前会话的全部后台子 Agent。");
				}
				return;
			}
			if (event.ctrlKey && !event.metaKey && !event.shiftKey && lower === "b") {
				const activeId = snapshot?.active?.id;
				const hasForeground = Boolean(
					activeId &&
						Object.values(tasksMap).some(
							(t) =>
								t.parentConversationId === activeId &&
								!t.runInBackground &&
								isActiveTaskStatus(t.status) &&
								Boolean(t.readOnly || t.worktreeId),
						),
				);
				if (hasForeground) {
					event.preventDefault();
					void backgroundForegroundSubagents();
					return;
				}
			}
			if (lower === "k") {
				event.preventDefault();
				setQuery("");
				setSearchIndex(0);
				setSearching(true);
			}
			if (lower === "p") {
				event.preventDefault();
				setPaletteOpen((open) => !open);
			}
			if (lower === "f" && snapshot?.active) {
				event.preventDefault();
				setFindOpen((open) => !open);
			}
			if (lower === "n" && snapshot?.active && !changing) {
				event.preventDefault();
				startNewConversation();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
	const activeConvId = snapshot?.active?.id;
	const activePermMode = snapshot?.settings.permission;
	useEffect(() => {
		if (!activeConvId || !(planMode || activePermMode === "plan")) {
			setPlanState(null);
			return;
		}
		let mounted = true;
		void api.readPlan(activeConvId).then((res) => {
			if (!mounted || planDraftEdited.current) return;
			setPlanState(res);
			setPlanDraft(res.content);
		}).catch((error) => {
			if (mounted) setPlanError(error instanceof Error ? error.message : String(error));
		});
		return () => { mounted = false; };
	}, [api, activeConvId, planMode, activePermMode, app.revision, running]);
	const pinnedTodoState = (() => {
		const startedById = new Map<string, number>();
		const completedById = new Map<string, number>();
		let latestWrite: TodoItem[] = [];
		let latestWriteTs = 0;
		let latestWriteMsgIndex = -1;
		for (let i = 0; i < history.messages.length; i++) {
			const msg = history.messages[i];
			if (msg.role !== "assistant") continue;
			const ts = typeof msg.timestamp === "number" && msg.timestamp > 0 ? msg.timestamp : i + 1;
			for (let j = 0; j < msg.content.length; j++) {
				const block = msg.content[j];
				if (block.type === "toolCall" && block.name === "TodoWrite" && block.arguments && typeof block.arguments === "object") {
					const todos = (block.arguments as { todos?: TodoItem[] }).todos;
					if (Array.isArray(todos)) {
						for (const item of todos) {
							if (item.status === "in_progress" && !startedById.has(item.id)) startedById.set(item.id, ts);
							if (item.status === "completed" && !completedById.has(item.id)) completedById.set(item.id, ts);
						}
						latestWrite = todos;
						latestWriteTs = Math.max(latestWriteTs, ts);
						latestWriteMsgIndex = i;
					}
				}
			}
		}
		let hasLiveWriteTool = false;
		for (const activeTool of Object.values(history.tools ?? {})) {
			if (activeTool.name === "TodoWrite" && activeTool.args && typeof activeTool.args === "object") {
				const todos = (activeTool.args as { todos?: TodoItem[] }).todos;
				if (Array.isArray(todos)) {
					const ts = activeTool.startedAt ?? Date.now();
					for (const item of todos) {
						if (item.status === "in_progress" && !startedById.has(item.id)) startedById.set(item.id, ts);
						if (item.status === "completed" && !completedById.has(item.id)) completedById.set(item.id, ts);
					}
					latestWrite = todos;
					latestWriteTs = Math.max(latestWriteTs, ts);
					hasLiveWriteTool = true;
				}
			}
		}
		const latestSharedTs = sharedTodos.reduce((max, item) => Math.max(max, item.updatedAt || item.createdAt || 0), 0);
		const useShared = sharedTodos.length > 0 && latestSharedTs >= latestWriteTs;
		const items: TodoItem[] = useShared
			? sharedTodos.map((item) => ({
				id: item.id,
				content:
					(item.status === "in_progress" && item.activeForm ? item.activeForm : item.subject) +
					(item.owner ? ` (@${item.owner})` : "") +
					(item.blockedBy.length ? ` [阻塞于 #${item.blockedBy.join(", #")}]` : ""),
				status: item.status === "completed" ? "completed" : item.status === "in_progress" ? "in_progress" : "pending",
				estimatedSeconds: item.estimatedSeconds,
				startedAt: item.startedAt,
				completedAt: item.completedAt,
			}))
			: latestWrite.map((item) => ({
				...item,
				startedAt: item.startedAt ?? startedById.get(item.id),
				completedAt: item.completedAt ?? completedById.get(item.id),
			}));
		let userTurnsAfter = 0;
		if (!hasLiveWriteTool) {
			if (useShared && latestSharedTs > 0) {
				for (const msg of history.messages) {
					if (msg.role === "user" && typeof msg.timestamp === "number" && msg.timestamp > latestSharedTs) userTurnsAfter += 1;
				}
			} else if (!useShared && latestWriteMsgIndex >= 0) {
				for (let i = latestWriteMsgIndex + 1; i < history.messages.length; i++) {
					if (history.messages[i].role === "user") userTurnsAfter += 1;
				}
			}
		}
		// While a turn is running, the latest user message is still in flight; all earlier ones have completed.
		const completedUserTurnsAfter = running ? Math.max(0, userTurnsAfter - 1) : userTurnsAfter;
		const lastUpdateTs = useShared ? latestSharedTs : latestWriteTs;
		const staleAgeMs = lastUpdateTs > 1_000_000_000_000 ? Math.max(0, Date.now() - lastUpdateTs) : undefined;

		const sig = `${useShared ? "shared" : "write"}:${lastUpdateTs}:${items.map((t) => `${t.id}=${t.status}`).join(",")}`;
		const activeConvKey = snapshot?.active?.id ?? "__none__";
		const dismissed = dismissedTodoSig[activeConvKey] === sig;
		const allCompleted = items.length === 0 || items.every((t) => t.status === "completed");
		const hidden =
			dismissed ||
			isChecklistStale({
				isRunning: running,
				completedUserTurnsAfterLastUpdate: completedUserTurnsAfter,
				userTurnsAfterLastUpdate: userTurnsAfter,
				allCompleted,
				staleAgeMs,
			});
		return { items: hidden ? [] : items, useShared, sig };
	})();
	const latestTodos = pinnedTodoState.items;
	const hasActiveTodo = running && latestTodos.some((t) => t.status === "in_progress");
	const [todoClock, setTodoClock] = useState(() => Date.now());
	useEffect(() => {
		if (!hasActiveTodo) return;
		setTodoClock(Date.now());
		const timer = setInterval(() => setTodoClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasActiveTodo]);
	const checklistEta = latestTodos.length > 0 ? computeChecklistEta(latestTodos, todoClock, running) : undefined;
	const completeAndDismissTodos = () => {
		const convId = snapshot?.active?.id;
		if (!convId) return;
		if (pinnedTodoState.useShared && api.todos?.update) {
			const openShared = sharedTodos.filter((item) => item.status !== "completed" && item.status !== "deleted");
			void Promise.all(openShared.map((item) => api.todos.update(convId, { id: item.id, status: "completed" })))
				.then(() => api.todos.list(convId).then(setSharedTodos))
				.catch(() => {});
		}
		setDismissedTodoSig((prev) => ({ ...prev, [convId]: pinnedTodoState.sig }));
		setTodoExpanded(false);
	};
	const currentTurnData = turnData?.conversationId === snapshot?.active?.id ? turnData : undefined;
	const entryIds = useMemo(() => currentTurnData ? matchUserEntries(history.messages, currentTurnData.entries) : {}, [history.messages, currentTurnData]);
	const checkpointsByEntry = useMemo(() => checkpointByEntry(currentTurnData?.checkpoints ?? []), [currentTurnData]);
	const checkpointIds = useMemo(() => Object.fromEntries(Array.from(checkpointsByEntry, ([entry, point]) => [entry, point.id])), [checkpointsByEntry]);
	const lastUserIndex = history.messages.findLastIndex((message) => message.role === "user");
	const lastCheckpoint = checkpointsByEntry.get(entryIds[lastUserIndex]);
	const currentEntryId = entryIds[lastUserIndex];
	const planSubmission = useMemo(() => submittedPlan(history.messages), [history.messages]);
	if (!snapshot)
		return (
			<div className="cl-start">
				<PiMark />
				<h1>Pi Desktop</h1>
				<p>{app.error || "正在连接本地 Pi…"}</p>
				{app.error && (
					<button className="primary-button" onClick={() => void app.refresh()}>
						重试连接
					</button>
				)}
			</div>
		);
	const ready = snapshot.engineStatus === "ready";
	const sidebarGroups = groupSidebarConversations(snapshot.conversations);
	const groups = sidebarGroups.groups;
	const focusedSubagentTask = focusedSubagentTaskId ? tasksMap[focusedSubagentTaskId] : undefined;
	const liveChildApprovals = collectDescendantApprovals(Object.values(tasksMap), snapshot.active?.id);
	const childApprovals = liveChildApprovals.length > 0 ? liveChildApprovals : (snapshot.childApprovals ?? []);
	const inPlanMode = planMode || snapshot.settings.permission === "plan";
	const showPlanApproval = inPlanMode && !running && !changing;
	const planReady = Boolean(planState && planDraft.trim() &&
		(manualPlan || (planSubmission && planState.exists && planState.content === planSubmission.content)));
	const activePhase = snapshot.active && app.runPhases[snapshot.active.id];
	const waitingForInput = app.requests.length > 0;
	const activeRequest = app.requests[0];
	const approvalExpanded = Boolean(activeRequest && activeRequest.id !== deferredApproval);
	const approvalTool = approvalExpanded && activeRequest?.method === "confirm"
		? /^允许执行\s+([^\s？?]+)[？?]?$/.exec(activeRequest.title)?.[1] : undefined;
	const openCheckpoint = (checkpointId?: string, path?: string) => {
		setRewindTarget(checkpointId ? { checkpointId, path } : undefined);
		setCheckpointsOpen(true);
	};

	const jumpFindMatch = (nextIdx: number) => {
		const container = scroll.current;
		const term = findQuery.trim().toLowerCase();
		if (!container || !term) return;
		const nodes = Array.from(container.querySelectorAll(".cl-msg")) as HTMLElement[];
		const hits = nodes.filter((el) => (el.textContent ?? "").toLowerCase().includes(term));
		if (!hits.length) return;
		const clamped = ((nextIdx % hits.length) + hits.length) % hits.length;
		setFindIndex(clamped);
		hits[clamped].scrollIntoView({ behavior: "smooth", block: "center" });
	};
	const paletteActions: PaletteAction[] = [
		{ id: "new", label: "新建会话", shortcut: "⌘N", keywords: "new session clear", disabled: changing || !snapshot.active, run: () => startNewConversation() },
		{ id: "search", label: "搜索历史会话", shortcut: "⌘K", keywords: "search find", run: () => { setQuery(""); setSearchIndex(0); setSearching(true); } },
		{ id: "find", label: "会话内关键词搜索", shortcut: "⌘F", keywords: "find in transcript", disabled: !snapshot.active, run: () => setFindOpen(true) },
		{ id: "open", label: "打开项目文件夹", keywords: "open project folder", disabled: changing, run: () => openWorkspace() },
		{ id: "sandbox", label: "命令沙箱设置 (/sandbox)", keywords: "sandbox seatbelt offline isolation", run: () => setSandboxOpen(true) },
		{ id: "theme", label: "切换外观主题（浅色 / 深色 / 圣杯二次元）", keywords: "theme light dark grail anime 圣杯 二次元", disabled: blocked, run: () => void cycleTheme() },
		{ id: "plan", label: inPlanMode ? "退出 Plan 计划模式" : "进入 Plan 计划模式", keywords: "plan mode readonly", disabled: blocked, run: () => void togglePlanMode() },
		{ id: "rewind", label: "检查点与代码回滚 (/rewind)", keywords: "git checkpoint restore", disabled: !snapshot.active, run: () => { openCheckpoint(); } },
		{ id: "tasks", label: "后台任务、子 Agent 与 Worktree (/tasks)", keywords: "subagent external codex claude kimi antigravity agy", run: () => { setTaskInitialId(undefined); setTasksOpen(true); } },
		{ id: "agents", label: "Agents 与子 Agent (/agents)", keywords: "agents subagent custom reviewer", run: () => setAgentsOpen(true) },
		{ id: "mcp", label: "MCP 服务器管理 (/mcp)", keywords: "mcp servers oauth", run: () => setMcpOpen(true) },
		{ id: "hooks", label: "生命周期 Hooks 管理 (/hooks)", keywords: "hooks pretooluse posttooluse", run: () => setControlsTab("hooks") },
		{ id: "skills", label: "Skills 技能查看与创建 (/skills)", keywords: "skills commands prompt", run: () => setControlsTab("skills") },
		{ id: "tools", label: "工具与 MCP 开关", keywords: "tools mcp enable", run: () => setControlsTab("tools") },
		{ id: "perms", label: "细粒度权限规则 (/permissions)", keywords: "allow ask deny rules", run: () => setControlsTab("permissions") },
		{ id: "sessions", label: "会话分支树与 CLI 历史导入 (/sessions)", keywords: "tree fork clone cli", disabled: !snapshot.active, run: () => setSessionsOpen(true) },
		{ id: "memory", label: "项目记忆与规则 (/memory)", keywords: "memory rules agents.md claude.md instructions", disabled: !snapshot.active, run: () => setMemoryTab("memory") },
		{ id: "context", label: "上下文占用与压缩控制 (/context)", keywords: "context tokens autocompact", disabled: !snapshot.active, run: () => setMemoryTab("context") },
		{ id: "status", label: "运行与上下文状态 (/status)", keywords: "status tokens cost model", run: () => setMemoryTab("status") },
		{ id: "init", label: "/init 生成项目 AGENTS.md 指南", keywords: "init onboard agents.md", disabled: !snapshot.active, run: () => sendInitPrompt() },
		{ id: "preview", label: previewUrl ? "关闭本地网页预览" : "打开本地网页预览 (/preview)", keywords: "web preview localhost", run: () => { setPane(null); setPreviewUrl((v) => (v ? null : "http://localhost:3000")); } },
		{ id: "terminal", label: terminalOpen ? "关闭终端面板" : "打开终端 / PTY 面板", keywords: "terminal bash pty", run: () => setTerminalOpen((v) => !v) },
		{ id: "changes", label: "查看 Git 修改与暂存提交", keywords: "git diff stage commit", run: () => { setPane(pane === "changes" ? null : "changes"); } },
		{ id: "files", label: "浏览项目文件", keywords: "files explorer", run: () => { setPane(pane === "files" ? null : "files"); } },
		{ id: "compact", label: "压缩会话上下文 (/compact)", keywords: "compact context", disabled: blocked || !history.messages.length, run: () => void app.command({ type: "compact" }) },
		{ id: "settings", label: "打开客户端与模型设置", keywords: "settings model api key theme", run: () => setSettings(true) },
	];
	const openTaskManager = () => { setTaskInitialId(undefined); setTasksOpen(true); };
	const attention: AttentionItem[] = snapshot.conversations
		.filter((conversation) => !conversation.archived && !conversation.parentConversationId && (app.activity[conversation.id] || app.runPhases[conversation.id]))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((conversation) => {
			const activity = app.activity[conversation.id];
			const phase = activity === "approval" ? "approval" : app.runPhases[conversation.id] ?? "running";
			return {
				id: conversation.id, title: conversation.title, detail: `${projectName(snapshot, conversation.project)} · ${runLabels[phase]}`,
				state: activity === "approval" ? "approval" : activity ? "running" : "done",
				open: () => {
					if (snapshot.active?.id === conversation.id) {
						setDeferredApproval(undefined);
						requestAnimationFrame(() => document.querySelector<HTMLElement>(".cc-inline-approval")?.focus());
					} else switchTo(() => api.selectConversation(conversation.id));
				},
			};
		});
	for (const task of taskList) {
		if (task.status !== "waiting_for_input" && task.status !== "running" && task.status !== "queued") continue;
		if (attention.some((item) => item.id === task.id)) continue;
		attention.push({
			id: task.id, title: task.title,
			detail: task.status === "waiting_for_input" ? "子任务待确认" : task.status === "queued" ? "子任务排队中" : "子任务运行中",
			state: task.status === "waiting_for_input" ? "approval" : "running",
			open: () => openSubagent(task.id),
		});
	}
	const isGrail = snapshot.settings.theme === "grail";
	const grailText = grailWording(isGrail);
	const latestGrailVerdict = latestVerdict(grail);
	// The latest 圣杯显灵 keeps a persistent gold badge even after later verdicts.
	const grailBest = grail?.verdicts.filter((verdict) => verdict.grade === "grail").at(-1);
	const grailReportVerdict = grailReportId ? grail?.verdicts.find((verdict) => verdict.id === grailReportId) : undefined;
	const servant = isGrail ? getServantInfo(snapshot.state?.model?.id) : null;
	const inspectorOpen = Boolean(pane || previewUrl);
	const reviewing = pane === "changes";
	const fullReview = reviewing && (focusReview || viewportWidth <= 860);
	const compactInspector = inspectorOpen && !fullReview && viewportWidth <= (reviewing ? 1179 : 1000);
	const sidebarVisible = sidebar && !compactInspector && !fullReview;
	const sidebarWidth = sidebarVisible ? (viewportWidth <= 1180 ? 224 : 256) : 0;
	const maxInspectorWidth = Math.max(320, Math.min(1000, viewportWidth - sidebarWidth - 430));
	const clampInspector = (width: number) => Math.round(Math.min(maxInspectorWidth, Math.max(320, width)));
	const dockedWidth = clampInspector(reviewing ? reviewWidth : inspectorWidth);
	const changeInspectorWidth = reviewing ? setReviewWidth : setInspectorWidth;
	const inspectorWidthKey = reviewing ? "pi.reviewInspectorWidth" : "pi.inspectorWidth";
	const saveInspectorWidth = (width: number) => localStorage.setItem(inspectorWidthKey, String(width));
	return (
		<div
			className={`desktop-app live-app ${sidebarVisible ? "" : "cl-side-hidden"} ${inspectorOpen ? "has-inspector" : ""} ${compactInspector ? "has-compact-inspector" : ""} ${reviewing ? "is-review-pane" : ""} ${fullReview ? "is-full-review" : ""}`}
			style={{ "--inspector-w": `${dockedWidth}px` } as CSSProperties}
		>
			{inspectorOpen && !compactInspector && !fullReview && (
				<div
					className="cc-inspector-resize"
					role="separator"
					aria-orientation="vertical"
					aria-label="调整右侧面板宽度"
					aria-valuemin={320}
					aria-valuemax={maxInspectorWidth}
					aria-valuenow={dockedWidth}
					tabIndex={0}
					onKeyDown={(event) => {
						if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
						event.preventDefault();
						const next = clampInspector(dockedWidth + (event.key === "ArrowLeft" ? 32 : -32));
						changeInspectorWidth(next);
						saveInspectorWidth(next);
					}}
					onDoubleClick={() => {
						const fallback = reviewing ? 500 : 400;
						changeInspectorWidth(fallback);
						saveInspectorWidth(fallback);
					}}
					onPointerDown={(event) => {
						event.preventDefault();
						const handle = event.currentTarget;
						handle.setPointerCapture(event.pointerId);
						document.body.classList.add("cc-resizing");
						const start = event.clientX;
						let latest = dockedWidth;
						const move = (e: PointerEvent) => {
							latest = clampInspector(dockedWidth + start - e.clientX);
							changeInspectorWidth(latest);
						};
						const up = () => {
							handle.removeEventListener("pointermove", move);
							handle.removeEventListener("pointerup", up);
							handle.removeEventListener("pointercancel", up);
							document.body.classList.remove("cc-resizing");
							saveInspectorWidth(latest);
						};
						handle.addEventListener("pointermove", move);
						handle.addEventListener("pointerup", up);
						handle.addEventListener("pointercancel", up);
					}}
					title="拖动调整宽度，双击恢复默认"
				/>
			)}
			{sidebarVisible && (
				<aside className="cl-side" aria-label="项目与会话">
					<div className="cl-side-head">
						<span className="cl-side-brand">
							{isGrail ? <HolyGrailIcon width={18} height={18} /> : <PiMark />}
							<span className="cl-side-title">{isGrail ? "Pi Grail" : "Pi Code"}</span>
						</span>
						<IconButton
							icon={PanelLeftClose}
							label="收起侧栏"
							onClick={() => {
								setSidebar(false);
								requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="展开侧栏"]')?.focus());
							}}
						/>
					</div>
					<div className="cl-side-actions">
						<button
							type="button"
							className="cl-side-new"
							aria-label="新建会话"
							disabled={changing || !snapshot.active}
							onClick={() => startNewConversation()}
						>
							<Plus size={15} />
							<span>{isGrail ? "召唤新会话" : "新建会话"}</span>
							<kbd aria-hidden="true">⌘N</kbd>
						</button>
						<div className="cl-side-action-row">
							<button
								type="button"
								className="cl-side-action"
								aria-label="搜索会话"
								onClick={() => {
									setQuery("");
									setSearchIndex(0);
									setSearching(true);
								}}
							>
								<Search size={14} />
								<span>搜索</span>
								<kbd aria-hidden="true">⌘K</kbd>
							</button>
							<button
								type="button"
								className="cl-side-action"
								aria-label="打开项目"
								disabled={changing}
								onClick={openWorkspace}
							>
								<FolderOpen size={14} />
								<span>打开目录</span>
							</button>
						</div>
					</div>
					<div className="cl-side-scroll">
						<TaskAttention items={attention} openAll={openTaskManager} />
						{snapshot.projects.length > 0 && (
							<section className="cl-group cl-side-workspaces" aria-label="工作目录">
								<div className="cl-group-label">工作目录</div>
								<div className="cl-ws-chips">
									{snapshot.projects.map((item) => {
										const isCurrent = item.path === project?.path;
										return (
											<button
												key={item.path}
												type="button"
												className={`cl-ws-chip ${isCurrent ? "active" : ""}`}
												title={item.path}
												disabled={changing}
												onClick={() => {
													if (!isCurrent) selectWorkspace(item.path);
												}}
											>
												<Folder size={13} />
												<span>{item.name}</span>
											</button>
										);
									})}
								</div>
							</section>
						)}
						{groups.map((group) => (
							<section className="cl-group" key={group.label}>
								<div className="cl-group-label">{group.label}</div>
								{group.items.map((session) => {
									const children = sidebarGroups.childrenByParent.get(session.id) ?? [];
									const childActive = children.some((c) => c.id === snapshot.active?.id);
									const childWaiting = children.filter((c) => app.activity[c.id] === "approval").length;
									const expanded = Boolean(expandedParents[session.id]) || childActive;
									return (
										<div key={session.id} className="cl-conv-wrap">
											<div className={`cl-conv-row ${session.id === snapshot.active?.id ? "selected" : ""}`}>
												<button
													data-conv-id={session.id}
													className={`cl-conv ${session.id === snapshot.active?.id ? "selected" : ""}`}
													disabled={changing}
													onClick={() => switchTo(() => api.selectConversation(session.id))}
													onContextMenu={(event) => {
														event.preventDefault();
														const box = event.currentTarget.getBoundingClientRect();
														const keyboard = event.clientX === 0 && event.clientY === 0;
														setConvMenu({ id: session.id, x: keyboard ? box.left + 24 : event.clientX, y: keyboard ? box.bottom : event.clientY });
													}}
													aria-current={session.id === snapshot.active?.id ? "page" : undefined}
												>
													<span className="cl-conv-line">
														<span className="cl-conv-title">{session.title}</span>
														{app.activity[session.id] === "approval" ? (
															<span className="cl-conv-status warn">待确认</span>
														) : childWaiting > 0 ? (
															<span className="cl-conv-status warn" title={`${childWaiting} 个子 Agent 待确认`}>
																待确认 {childWaiting}
															</span>
														) : app.activity[session.id] === "running" ? (
															<span className="cl-conv-status run">{runLabels[app.runPhases[session.id] ?? "running"]}</span>
														) : null}
													</span>
													<span className="cl-conv-sub">
														{projectName(snapshot, session.project)} · {formatTime(session.updatedAt)}
													</span>
												</button>
												{children.length > 0 && (
													<button
														type="button"
														className="cl-conv-fold"
														title={expanded ? "收起子 Agent 会话" : `展开 ${children.length} 个子 Agent 会话`}
														aria-label={expanded ? "收起子 Agent 会话" : `展开 ${children.length} 个子 Agent 会话`}
														aria-expanded={expanded}
														onClick={(event) => {
															event.stopPropagation();
															setExpandedParents((prev) => ({ ...prev, [session.id]: !expanded }));
														}}
													>
														<ChevronRight size={12} className={`cl-conv-fold-icon ${expanded ? "open" : ""}`} aria-hidden="true" />
														{children.length}
													</button>
												)}
											</div>
											{expanded && children.length > 0 && (
												<div className="cl-conv-children">
													{children.map((child) => (
														<button
															key={child.id}
															className={`cl-conv cl-conv-child ${child.id === snapshot.active?.id ? "selected" : ""}`}
															disabled={changing}
															onClick={() => switchTo(() => api.selectConversation(child.id))}
															aria-current={child.id === snapshot.active?.id ? "page" : undefined}
														>
															<span className="cl-conv-line">
																<span className="cl-conv-title">{child.title}</span>
																{app.activity[child.id] === "approval" ? (
																	<span className="cl-conv-status warn">待确认</span>
																) : app.activity[child.id] === "running" ? (
																	<span className="cl-conv-status run">运行中</span>
																) : null}
															</span>
															<span className="cl-conv-sub">子 Agent · {formatTime(child.updatedAt)}</span>
														</button>
													))}
												</div>
											)}
										</div>
									);
								})}
							</section>
						))}
						{sidebarGroups.archived.length > 0 && (
							<section className="cl-group cl-group-archived">
								<button
									type="button"
									className="cl-group-label"
									style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", width: "100%", textAlign: "left" }}
									aria-expanded={archivedOpen}
									onClick={() => setArchivedOpen((v) => !v)}
								>
									<ChevronRight size={11} className={`cl-conv-fold-icon ${archivedOpen ? "open" : ""}`} aria-hidden="true" />
									<span>已归档 ({sidebarGroups.archived.length})</span>
								</button>
								{archivedOpen && sidebarGroups.archived.map((session) => (
									<div key={session.id} className="cl-conv-wrap">
										<div className={`cl-conv-row ${session.id === snapshot.active?.id ? "selected" : ""}`}>
											<button
												data-conv-id={session.id}
												className={`cl-conv ${session.id === snapshot.active?.id ? "selected" : ""}`}
												disabled={changing}
												onClick={() => switchTo(() => api.selectConversation(session.id))}
												onContextMenu={(event) => {
													event.preventDefault();
													const box = event.currentTarget.getBoundingClientRect();
													const keyboard = event.clientX === 0 && event.clientY === 0;
													setConvMenu({ id: session.id, x: keyboard ? box.left + 24 : event.clientX, y: keyboard ? box.bottom : event.clientY });
												}}
												aria-current={session.id === snapshot.active?.id ? "page" : undefined}
											>
												<span className="cl-conv-line">
													<span className="cl-conv-title">{session.title}</span>
												</span>
												<span className="cl-conv-sub">
													{projectName(snapshot, session.project)} · {formatTime(session.updatedAt)}
												</span>
											</button>
										</div>
									</div>
								))}
							</section>
						)}
						{!snapshot.conversations.length && <p className="cl-side-empty">还没有会话。选择一个工作目录开始编码。</p>}
					</div>
					<div className="cl-side-foot">
						<div className="cl-side-foot-status">
							<span className={`cl-engine ${ready ? "ok" : ""}`}>
								<i />
								{ready ? "Pi 引擎就绪" : "引擎未就绪"}
							</span>
							<button
								type="button"
								className={`cl-foot-sandbox ${snapshot.settings.sandbox ? "on" : "off"}`}
								onClick={() => setSandboxOpen(true)}
								title="点击管理命令沙箱"
							>
								{snapshot.settings.sandbox ? (
									snapshot.settings.sandboxOffline ? (
										<>
											<WifiOff size={11} />
											<span>离线沙箱</span>
										</>
									) : (
										<>
											<ShieldCheck size={11} />
											<span>沙箱保护</span>
										</>
									)
								) : (
									<>
										<ShieldAlert size={11} />
										<span>无沙箱</span>
									</>
								)}
							</button>
						</div>
						<button
							type="button"
							className={`cl-foot-settings ${settings ? "active" : ""}`}
							aria-label="设置"
							onClick={() => setSettings(true)}
						>
							<Settings size={14} />
							<span>设置</span>
						</button>
					</div>
				</aside>
			)}
			<main className="cl-main">
				{flash && (
					<div className="cc-flash" role="status" aria-live="polite">
						<Check size={14} />
						<span>{flash}</span>
					</div>
				)}
				{isGrail && <MagicCircleBackdrop />}
				<header className={`cl-top ${sidebarVisible ? "" : "cl-top-collapsed"}`}>
					<div className="cl-top-title">
						{!sidebarVisible && (
							<>
								<IconButton
									icon={PanelLeftOpen}
									label="展开侧栏"
									onClick={() => {
										if (compactInspector) {
											setPane(null);
											setPreviewUrl(null);
										}
										setSidebar(true);
										requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="收起侧栏"]')?.focus());
									}}
								/>
								<IconButton
									icon={SquarePen}
									label="新建会话"
									disabled={changing || !snapshot.active}
									onClick={() => startNewConversation()}
								/>
							</>
						)}
						<WorkspacePicker
							variant="topbar"
							projects={snapshot.projects}
							activeProject={project}
							gitBranch={gitSummary?.isGit ? gitSummary.branch : undefined}
							disabled={changing}
							onSelectProject={selectWorkspace}
							onOpenProject={openWorkspace}
						/>
						{snapshot.active && (
							<>
								<span className="cl-top-sep" aria-hidden="true">/</span>
								<button
									className="cl-title-button"
									disabled={blocked}
									onClick={() => { setRenameId(undefined); setRename(snapshot.active?.title ?? ""); }}
									title="点击重命名会话"
								>
									{snapshot.active.title}
								</button>
							</>
						)}
					</div>
					<div className="cl-top-tools">
						{snapshot.trust && (
							<IconButton
								icon={ShieldCheck}
								label={
									snapshot.trust.decision === "trusted"
										? "项目配置：已信任"
										: snapshot.trust.decision === "untrusted"
											? "项目配置：已禁用"
											: "项目配置：待决定"
								}
								active={trustOpen}
								className={snapshot.trust.required && !snapshot.trust.decision ? "cc-attn" : ""}
								onClick={() => setTrustOpen(true)}
							/>
						)}
						<div className="cc-top-seg" role="toolbar" aria-label="工作区工具">
							<button
								type="button"
								className={`cc-top-btn ${pane === "changes" ? "active" : ""}`}
								aria-label="代码修改"
								title="代码修改与 Git Diff"
								onClick={() => { setPane(pane === "changes" ? null : "changes"); }}
							>
								<GitCompareArrows size={14} />
								<span>差异</span>
								{gitSummary && gitSummary.count > 0 && <em className="cc-top-count">{gitSummary.count}</em>}
							</button>
							<button
								type="button"
								className={`cc-top-btn ${pane === "files" ? "active" : ""}`}
								aria-label="项目文件"
								title="浏览项目文件"
								onClick={() => { setPane(pane === "files" ? null : "files"); }}
							>
								<Files size={14} />
								<span>文件</span>
							</button>
							<button
								type="button"
								className={`cc-top-btn ${terminalOpen ? "active" : ""}`}
								aria-label="终端"
								title="打开终端 / 交互 PTY"
								onClick={() => setTerminalOpen(!terminalOpen)}
							>
								<TerminalIcon size={14} />
								<span>终端</span>
							</button>
							<button
								type="button"
								className={`cc-top-btn ${tasksOpen ? "active" : ""}`}
								aria-label="后台任务与 Worktree"
								title="后台任务、子 Agent、工作流与 Worktree"
								onClick={() => { setTaskInitialId(undefined); setTasksOpen(true); }}
							>
								<ListTodo size={14} />
								<span>任务</span>
								{(activeTaskCount > 0 || waitingTaskCount > 0) && (
									<em className={`cc-top-count ${waitingTaskCount > 0 ? "warn" : ""}`}>
										{waitingTaskCount > 0 ? `!${waitingTaskCount}` : activeTaskCount}
									</em>
								)}
							</button>
						</div>
						<button
							type="button"
							className={`cc-theme-pill ${isGrail ? "grail" : ""}`}
							aria-label="切换主题"
							disabled={blocked}
							title="一键切换外观主题：浅色 / 深色 / 圣杯（二次元）"
							onClick={() => void cycleTheme()}
						>
							{isGrail ? (
								<>
									<HolyGrailIcon width={14} height={14} />
									<span>圣杯</span>
								</>
							) : snapshot.settings.theme === "dark" ? (
								<>
									<Moon size={13} />
									<span>深色</span>
								</>
							) : (
								<>
									<Sun size={13} />
									<span>浅色</span>
								</>
							)}
						</button>
						<div className="cc-more-wrap" ref={moreMenuRef} onKeyDown={menuKeyNav}>
							<button
								type="button"
								className={`cc-top-btn cc-more-btn ${moreMenuOpen ? "active" : ""}`}
								aria-label="更多工具"
								aria-haspopup="menu"
								aria-expanded={moreMenuOpen}
								title="更多工具与会话操作"
								onClick={() => setMoreMenuOpen((prev) => !prev)}
							>
								<MoreHorizontal size={15} />
							</button>
							{moreMenuOpen && (
								<div className="cc-more-menu" role="menu" aria-label="更多工具菜单">
									<div className="cc-more-group">
										<div className="cc-more-label">工作区与会话</div>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											onClick={() => {
												setMoreMenuOpen(false);
												setPane(null);
												setPreviewUrl((v) => (v ? null : "http://localhost:3000"));
											}}
										>
											<Globe size={14} />
											<span>本地网页预览</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={!snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												setRewindTarget(undefined);
												setCheckpointsOpen(true);
											}}
										>
											<History size={14} />
											<span>检查点与回滚</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={!snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												setSessionsOpen(true);
											}}
										>
											<GitFork size={14} />
											<span>会话分支树</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={!snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												setMemoryTab("memory");
											}}
										>
											<BookOpen size={14} />
											<span>项目记忆与状态</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											onClick={() => {
												setMoreMenuOpen(false);
												setPaletteOpen(true);
											}}
										>
											<CommandIcon size={14} />
											<span>命令面板</span>
											<kbd aria-hidden="true">⌘P</kbd>
										</button>
									</div>
									<div className="cc-more-divider" />
									<div className="cc-more-group">
										<div className="cc-more-label">能力与控制</div>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={!snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												setAgentsOpen(true);
											}}
										>
											<Bot size={14} />
											<span>Agents 与子 Agent</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={!snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												setMcpOpen(true);
											}}
										>
											<Plug size={14} />
											<span>MCP 服务器</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											onClick={() => {
												setMoreMenuOpen(false);
												setControlsTab("tools");
											}}
										>
											<SlidersHorizontal size={14} />
											<span>工具与权限</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={blocked}
											onClick={() => {
												setMoreMenuOpen(false);
												void app.refresh().then(() => setFlash("会话已刷新"));
											}}
										>
											<RefreshCw size={14} />
											<span>刷新会话</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={blocked || !history.messages.length}
											onClick={() => {
												setMoreMenuOpen(false);
												void app.command({ type: "compact" });
											}}
										>
											<Archive size={14} />
											<span>压缩上下文</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className="cc-more-item"
											disabled={blocked || !snapshot.active}
											onClick={() => {
												setMoreMenuOpen(false);
												exportActive();
											}}
										>
											<Download size={14} />
											<span>导出会话</span>
										</button>
										{!sidebarVisible && (
											<button
												type="button"
												role="menuitem"
												className="cc-more-item"
												onClick={() => {
													setMoreMenuOpen(false);
													setSettings(true);
												}}
											>
												<Settings size={14} />
												<span>设置</span>
											</button>
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				</header>
				{(app.error || snapshot.engineError) && (
					<div className="cl-banner cl-banner-error" role="alert">
						<span>{app.error || snapshot.engineError}</span>
						<button
							onClick={() => {
								app.setError("");
								if (snapshot.engineError) void app.refresh();
							}}
							aria-label="关闭错误提示"
						>
							<X size={14} />
						</button>
					</div>
				)}
				{app.notice && (
					<div className="cl-banner" role="status">
						<span>{app.notice}</span>
						<button aria-label="关闭状态提示" onClick={() => app.setNotice("")}>
							<X size={14} />
						</button>
					</div>
				)}
				{snapshot.trust?.required && !snapshot.trust.decision && !trustLater[snapshot.trust.project] && (
					<div className="cl-trust-banner" role="region" aria-label="项目配置">
						<ShieldCheck size={15} />
						<div className="cl-trust-text" title={`检测到 ${snapshot.trust.resources.join("、")}`}>
							<strong>此项目带有自己的 MCP、Skills 与设置</strong>
							<span>信任后才会加载</span>
						</div>
						<button
							type="button"
							className="secondary-button"
							disabled={trustBusy || blocked}
							onClick={() => void decideTrust("trusted")}
						>
							信任并加载
						</button>
						<button
							type="button"
							className="cc-mini-btn"
							disabled={trustBusy || blocked}
							onClick={() => void decideTrust("untrusted")}
						>
							保持禁用
						</button>
						<button
							type="button"
							className="cl-trust-close"
							aria-label="稍后决定"
							title="稍后决定（可从顶栏盾牌图标再次打开）"
							onClick={() => snapshot.trust && setTrustLater((prev) => ({ ...prev, [snapshot.trust!.project]: true }))}
						>
							<X size={14} />
						</button>
					</div>
				)}

				{history.messages.length > 0 && !snapshot.models.length && (
					<div className="cl-connect"><span>连接模型后即可继续此会话。</span>
						<button type="button" className="primary-button" onClick={() => { setConnecting(true); setSettings(true); }}>连接模型</button>
					</div>
				)}
				<div className="cl-body">
					<div className="cl-conversation">
						{focusedSubagentTask ? (
							<SubagentTranscriptView
								api={api}
								task={focusedSubagentTask}
								progress={taskProgressMap[focusedSubagentTask.id]}
								onBack={() => setFocusedSubagentTaskId(null)}
								onMainCompact={(customInstructions) => {
									setFocusedSubagentTaskId(null);
									void app.command({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
								}}
								onMainClear={() => {
									setFocusedSubagentTaskId(null);
									if (!changing && snapshot.active) startNewConversation();
								}}
								onNotice={(msg) => app.setNotice(msg)}
								fail={app.fail}
							/>
						) : (
							<>
								{findOpen && (
									<div className="cc-find-bar" role="search" aria-label="会话内查找">
										<Search size={14} />
										<input
											autoFocus data-autofocus
											aria-label="查找会话内容"
											placeholder="输入关键词按回车定位…"
											value={findQuery}
											onChange={(e) => {
												setFindQuery(e.target.value);
												setFindIndex(0);
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													jumpFindMatch(findIndex + (e.shiftKey ? -1 : 1));
												} else if (e.key === "Escape") {
													setFindOpen(false);
												}
											}}
										/>
										<button type="button" className="cc-mini-btn" onClick={() => jumpFindMatch(findIndex - 1)}>上一个</button>
										<button type="button" className="cc-mini-btn" onClick={() => jumpFindMatch(findIndex + 1)}>下一个</button>
										<button type="button" className="cc-mini-btn" aria-label="关闭会话查找" onClick={() => setFindOpen(false)}>关闭</button>
									</div>
								)}
								<div
									className="cl-scroll"
									ref={scroll}
									onScroll={(event) => {
										const element = event.currentTarget;
										stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
										const far = element.scrollHeight - element.scrollTop - element.clientHeight > 240;
										if (far !== showJump) setShowJump(far);
											const id = snapshot.active?.id;
											if (id) savedScroll.current.set(id, { top: element.scrollTop, stick: stickToEnd.current });
									}}
								>
									{history.messages.length ? (
										<TranscriptView
											transcript={history}
											tasks={Object.values(tasksMap)}
											externalTasks={Object.values(externalTasksMap)}
											taskProgressMap={taskProgressMap}
											onOpenTask={openSubagent}
											onBackgroundTask={(id) => void backgroundSubagent(id)}
											onStopTask={(id, kind) => void stopSubagent(id, kind)}
											onOpenFile={openInEditor}
											entryIds={entryIds}
											checkpointIds={checkpointIds}
											approvalTool={approvalTool}
											onRewindPrompt={(checkpointId) => openCheckpoint(checkpointId)}
											onForkPrompt={(entryId) => {
												const conversationId = snapshot.active?.id;
												if (conversationId) switchTo(async () => (await api.sessions.fork({ conversationId, entryId, activate: true })).snapshot);
											}}
											onRerunCheck={(command) => {
												const conversationId = snapshot.active?.id;
												if (!conversationId) return;
												setRerun({ conversationId, command, requestId: Date.now() });
												setTerminalOpen(true);
											}}
											onOpenPreview={(url) => {
												setPane(null);
												setPreviewUrl(url);
											}}
										/>
									) : (
										<div className="cl-empty">
											{isGrail ? (
												<GrailEmblem />
											) : (
												<div className="cl-empty-emblem">
													<PiMark />
												</div>
											)}
											<h1>
												{snapshot.active
													? isGrail
														? "向圣杯许下你的编程愿望"
														: snapshot.models.length ? "今天想一起做什么？" : "连接模型，开始第一个任务"
													: isGrail
														? "选择召唤结界（工作目录）"
														: "选择工作目录开始"}
											</h1>
											{isGrail && servant && (
												<div className="grail-servant-badge">
													<span className="grail-servant-rarity">{servant.rarity}</span>
													<span className="grail-servant-class" style={{ color: servant.accent }}>
														{servant.className}
													</span>
													<span>· {servant.title}</span>
													{snapshot.state?.model?.id && <span>({snapshot.state.model.name || snapshot.state.model.id})</span>}
												</div>
											)}
											{snapshot.active && snapshot.models.length ? (
												<>
													<div className="cc-starter-chips">
														<button
															type="button"
															className="cc-starter-chip"
															onClick={() => {
																app.setDraft("请先梳理当前项目的目录结构、核心模块与运行方式。");
																composerInputRef.current?.focus();
															}}
														>
															<Sparkles size={13} />
															<span>梳理项目结构</span>
														</button>
														<button
															type="button"
															className="cc-starter-chip"
															onClick={() => {
																app.setDraft("请检查当前工作区的 Git 改动并总结潜在风险。");
																composerInputRef.current?.focus();
															}}
														>
															<GitCompareArrows size={13} />
															<span>检查代码变更</span>
														</button>
														<button
															type="button"
															className="cc-starter-chip"
															onClick={() => {
																app.setDraft("请运行当前项目的测试或类型检查并汇报结果。");
																composerInputRef.current?.focus();
															}}
														>
															<TerminalIcon size={13} />
															<span>运行测试检查</span>
														</button>
													</div>
												</>
											) : (
												<>
													<p>选择一个本地项目文件夹，Pi 会在该目录中读取代码、安全编辑并在沙箱内执行命令。</p>
													<button className="primary-button cc-empty-cta" onClick={openWorkspace}>
														<FolderOpen size={15} />
														<span>打开项目文件夹</span>
													</button>
												</>
											)}
											{snapshot.active && !snapshot.models.length ? <button type="button" className="primary-button cc-connect-first" onClick={() => { setConnecting(true); setSettings(true); }}>连接模型</button> : <div className="cc-empty-hints">
												<span><kbd>⌘N</kbd> 新建会话</span>
												<span><kbd>⌘K</kbd> 搜索会话</span>
												<span><kbd>/</kbd> 斜杠命令</span>
												<span><kbd>@</kbd> 引用文件</span>
											</div>}
										</div>
									)}
									{app.requests[0] && (
									<div className="cc-active-request">
										{app.requests[0].id === deferredApproval ? (
											<button type="button" className="secondary-button" onClick={() => setDeferredApproval(undefined)}>继续处理审批</button>
										) : (
											<PermissionDialog inline key={app.requests[0].id} request={app.requests[0]}
												conversationId={snapshot.active?.id} project={snapshot.active?.project}
												respond={app.respond} defer={() => setDeferredApproval(app.requests[0]?.id)} fail={app.fail} />
										)}
									</div>
								)}
								{running && !approvalExpanded && (
										<div className="cl-working" role="status">
											{waitingForInput ? <ShieldCheck size={15} /> : isGrail ? <MagicCircleLoader size={16} /> : <span className="cl-spinner" />}
											{waitingForInput ? "等待你处理审批" : activePhase && activePhase !== "completed" ? runLabels[activePhase] : "正在处理任务"}
										</div>
									)}
									{!!snapshot.state?.pendingMessageCount && (
										<div className="cc-queue" role="region" aria-label="排队的指令">
											<div className="cc-queue-head">
												<span>
													{running
														? `${snapshot.state.pendingMessageCount} 条待发送指令`
														: `已停止，${snapshot.state.pendingMessageCount} 条指令还在排队，会和下一条消息一起发送`}
												</span>
												<span className="cc-queue-actions">
													<button type="button" className="cc-mini-btn" disabled={Boolean(queueActionId)} onClick={() => void actOnQueue("withdraw")}>
														撤回到输入框
													</button>
													{running && (
														<button type="button" className="cc-mini-btn primary" title="中止现在的任务并发送所有排队指令" disabled={Boolean(queueActionId)} onClick={() => void actOnQueue("send")}>
															停止并发送队列
														</button>
													)}
												</span>
											</div>
											{([
											["下一工具步骤", snapshot.queuedPromptGroups?.steering ?? snapshot.queuedMessages ?? []],
											["本轮结束后", snapshot.queuedPromptGroups?.followUp ?? []],
										] as const).map(([label, messages]) => messages.length > 0 && (
											<div className="cc-queue-group" key={label}>
												<span>{label}</span>
												{messages.map((value, index) => <p className="cc-queue-item" key={index}>{value}</p>)}
											</div>
										))}
									</div>
								)}
									{!running && currentEntryId && lastCheckpoint && lastCheckpoint.changes.length > 0 && (
										<section className="cc-completion-card" aria-label="本轮结果">
											<div><strong>{activePhase === "failed" ? "任务失败，已有改动可检查" : activePhase === "stopped" ? "任务已停止，已有改动可检查" : "本轮改动可审查"}</strong>
												<small>{lastCheckpoint.changes.filter((file) => file.afterKind !== "directory" && file.beforeKind !== "directory").length} 个文件 · {lastCheckpoint.excludedFiles ? `${lastCheckpoint.excludedFiles} 个文件超出快照容量` : "已记录检查点"}</small></div>
											<div className="cc-completion-actions">
												<button type="button" className="secondary-button" onClick={() => openCheckpoint(lastCheckpoint.id)}>查看回滚选项</button>
												<button type="button" className="primary-button" onClick={() => setPane("changes")}>审查本轮改动</button>
											</div>
										</section>
									)}
									{showJump && (
										<button
											type="button"
											className="cc-jump-latest"
											onClick={() => {
												stickToEnd.current = true;
												setShowJump(false);
												scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
											}}
										>
											<ArrowDown size={14} aria-hidden="true" />
											{running ? "有新输出 · 跳到最新" : "跳到最新"}
										</button>
									)}
								</div>
						{latestTodos.length > 0 && !latestTodos.every((t) => t.status === "completed") && (() => {
							const doneCount = latestTodos.filter((t) => t.status === "completed").length;
							const activeTodo = latestTodos.find((t) => t.status === "in_progress");
							const activeTiming = activeTodo ? computeTodoTiming(activeTodo, todoClock, running) : undefined;
							const pct = Math.min(100, Math.max(0, Math.round((doneCount / latestTodos.length) * 100)));
							return (
							<div className="cc-pinned-todos">
								<div className="cc-pinned-todos-progress" aria-hidden="true">
									<div className="cc-pinned-todos-progress-fill" style={{ width: `${pct}%` }} />
								</div>
								<div className="cc-pinned-todos-bar">
									<button type="button" className="cc-pinned-todos-head" onClick={() => setTodoExpanded((v) => !v)}>
										<span className="cc-pinned-todos-title">
											<span>
												任务进度 ({doneCount}/{latestTodos.length})
												{activeTodo ? ` · ${activeTodo.content}` : ""}
											</span>
											{activeTiming?.label && (
												<span className={`cc-eta-pill ${activeTiming.overdue ? "overdue" : ""}`}>
													{activeTiming.label}
												</span>
											)}
											{checklistEta?.summaryLabel && checklistEta.summaryLabel !== activeTiming?.label && (
												<span className={`cc-eta-pill ${checklistEta.anyOverdue ? "overdue" : ""}`}>
													{checklistEta.summaryLabel}
												</span>
											)}
										</span>
										<span className="cc-pinned-todos-toggle">{todoExpanded ? "收起" : "展开"}</span>
									</button>
									{!running && (
										<button
											type="button"
											className="cc-pinned-todos-dismiss"
											title="标记为全部完成并收起，等待新任务"
											onClick={completeAndDismissTodos}
										>
											完成并收起
										</button>
									)}
								</div>
								{todoExpanded && (
									<div className="cc-pinned-todos-list">
										{latestTodos.map((item) => {
											const timing = computeTodoTiming(item, todoClock, running);
											return (
												<div key={item.id} className={`cc-todo-row ${item.status}`}>
													{item.status === "completed" ? (
														<Check size={12} className="ok" />
													) : item.status === "in_progress" ? (
														<LoaderCircle size={12} className={running ? "spin run" : "pending"} />
													) : (
														<Circle size={11} className="pending" />
													)}
													<span className="cc-todo-row-text">{item.content}</span>
													{timing.label && (
														<span className={`cc-eta-pill ${timing.overdue ? "overdue" : ""}`}>
															{timing.label}
														</span>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>
							);
						})()}
						{btwState && (
							<div className="cc-btw-card" role="region" aria-label="侧问结果">
								<div className="cc-btw-head">
									<strong>/btw {btwState.question}</strong>
									<button type="button" className="cc-mini-btn" onClick={() => setBtwState(null)}>关闭</button>
								</div>
								{btwState.loading ? (
									<p className="subtle-note">正在独立思考（不写入当前会话历史）…</p>
								) : btwState.error ? (
									<p className="live-error">{btwState.error}</p>
								) : (
									<div className="cc-btw-body">
										<p>{btwState.answer}</p>
										{btwState.model && <small className="subtle-note">模型：{btwState.model} · 未写入主会话</small>}
									</div>
								)}
							</div>
						)}
						{showPlanApproval && (
							<section className="cc-plan-bar" role="region" aria-label="计划审批">
								<div className="cc-plan-bar-top">
									<strong>{planReady ? "计划待批准" : "计划草稿"}</strong>
									<div className="cc-plan-bar-actions">
										<button type="button" className="cc-mini-btn" disabled={planApplying} onClick={() => setPlanEditorOpen((previous) => !previous)}>
											{planEditorOpen ? "收起计划正文" : planState?.exists ? "查看/编辑计划" : "编写计划正文"}
										</button>
										{planReady ? <>
											<button type="button" className="primary-button" disabled={planApplying} onClick={() => void approvePlanAndExecute("acceptEdits")}>
												{planApplying ? "正在准备执行…" : "批准计划 · 接受编辑"}
											</button>
											<button type="button" className="secondary-button" disabled={planApplying} onClick={() => void approvePlanAndExecute("ask")}>批准计划 · 逐项确认</button>
										</> : planEditorOpen && planDraft.trim() && (
											<button type="button" className="secondary-button" onClick={() => setManualPlan(true)}>使用这份计划</button>
										)}
										<button type="button" className="cc-mini-btn" disabled={planApplying} onClick={() => void togglePlanMode()}>退出 Plan</button>
									</div>
								</div>
								{planEditorOpen && <textarea className="cc-plan-editor" rows={6} aria-label="编辑计划内容"
									placeholder="审查或补充实施步骤" value={planDraft} disabled={planApplying || !planState}
									onChange={(event) => { planDraftEdited.current = true; setPlanDraft(event.target.value); }} />}
								{planError && <div role="alert" className="cc-plan-error">
									{planError}
									<button type="button" className="cc-mini-btn" onClick={() => {
										if (planDraftEdited.current && !window.confirm("重新读取会替换当前计划草稿，继续吗？")) return;
										void api.readPlan(snapshot.active?.id).then((current) => {
											planDraftEdited.current = false;
											setPlanState(current);
											setPlanDraft(current.content);
											setManualPlan(false);
											setPlanError("");
										}).catch((error) => setPlanError(String(error)));
									}}>重新读取计划</button>
								</div>}
							</section>
						)}
						{heldCount > 0 && (
							<div className="cc-plan-bar cc-held-results" role="region" aria-label="待交付的子 Agent 结果">
								<div className="cc-plan-bar-top">
									<span>{heldCount} 条子 Agent 结果待交付：主会话未运行时完成的结果会随下一条消息一起交给 Pi。</span>
									<div className="cc-plan-bar-actions">
										<button type="button" className="primary-button" disabled={delivering} onClick={() => void deliverHeldResults()}>
											立即交付
										</button>
									</div>
								</div>
							</div>
						)}
						{workflows
							.filter((wf) => wf.pendingApproval)
							.map((wf) => {
								const req = wf.pendingApproval!;
								return (
									<div key={req.id} className="cc-plan-bar" role="region" aria-label="工作流执行审批">
										<div className="cc-plan-bar-row">
											<span>
												<strong>{req.title}</strong> · {req.detail.slice(0, 140)}
											</span>
											<div className="cc-plan-bar-actions">
												<button
													type="button"
													className="primary-button"
													onClick={() => void api.workflow.respond(wf.id, req.id, "once").catch(app.fail)}
												>
													允许一次 (Once)
												</button>
												<button
													type="button"
													className="secondary-button"
													onClick={() => void api.workflow.respond(wf.id, req.id, "always").catch(app.fail)}
												>
													始终允许 (Always)
												</button>
												<button
													type="button"
													className="cc-mini-btn danger"
													onClick={() => void api.workflow.respond(wf.id, req.id, "deny").catch(app.fail)}
												>
													拒绝 (Deny)
												</button>
											</div>
										</div>
									</div>
								);
							})}
						<SubagentPanel
							ref={subagentPanelRef}
							parentConversationId={snapshot.active?.id}
							tasks={Object.values(tasksMap)}
							externalTasks={Object.values(externalTasksMap)}
							progressMap={taskProgressMap}
							onOpenTask={(row) => {
								if (row.kind === "pi") setFocusedSubagentTaskId(row.id);
								else {
									setTaskInitialId(row.id);
									setTasksOpen(true);
								}
							}}
							onStopTask={(row) => void stopSubagent(row.id, row.kind)}
							onBackgroundTask={(id) => void backgroundSubagent(id)}
							onOpenTasksDrawer={() => {
								setTaskInitialId(undefined);
								setTasksOpen(true);
							}}
							onReturnToComposer={() => composerInputRef.current?.focus()}
						/>
						{snapshot.active?.goal?.active && (
							<div className="cc-goal-banner" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "6px 12px", margin: "0 16px 6px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--bg-elevated, var(--surface))", fontSize: "12px" }}>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									<strong>目标模式</strong>（{snapshot.active.goal.turnsUsed}/{snapshot.active.goal.maxTurns} 轮
									{snapshot.active.goal.maxCostUsd ? ` · 上限 $${snapshot.active.goal.maxCostUsd}` : ""}）：
									{snapshot.active.goal.objective}
								</span>
								<button
									type="button"
									className="cc-mini-btn"
									onClick={() => {
										if (!snapshot.active) return;
										void app.switchTo(async () => {
											const next = await api.stopGoal(snapshot.active!.id);
											app.setNotice("已停止目标模式。");
											return next;
										});
									}}
								>
									停止目标
								</button>
							</div>
						)}
						{snapshot.active && Boolean(grail?.hasDiff || grail?.running || grail?.verdicts.length) && (
							<div className="cc-grail-bar" role="region" aria-label={grailText.report}>
								{grail?.running ? (
									<span className="cc-grail-running" role="status">
										{isGrail ? <MagicCircleLoader size={14} /> : <span className="cl-spinner" />}
										{grailText.running} · {grailText.steps[grail.running.step]}
									</span>
								) : (
									<button
										type="button"
										className="cc-mini-btn cc-grail-start"
										disabled={!grail?.hasDiff || blocked}
										title={grail?.hasDiff ? "鉴定本次需求的全部改动，结果不会发给 Agent" : "这个需求还没有代码改动"}
										onClick={startGrail}
									>
										{grailText.start}
									</button>
								)}
								{grail?.running && (
									<button type="button" className="cc-mini-btn" onClick={cancelGrail}>
										取消
									</button>
								)}
								<span className="cc-grail-badges">
									{latestGrailVerdict && latestGrailVerdict.grade === "grail" ? null : grailBest && (
										<GrailBadge verdict={grailBest} wording={grailText} onOpen={() => setGrailReportId(grailBest.id)} />
									)}
									{latestGrailVerdict && (
										<GrailBadge verdict={latestGrailVerdict} wording={grailText} onOpen={() => setGrailReportId(latestGrailVerdict.id)} />
									)}
								</span>
							</div>
						)}
						<LiveComposer
							key={snapshot.active?.id ?? "no-conversation"}
							snapshot={snapshot}
							activeProject={project}
							draft={app.draft}
							attachments={app.attachments}
							updateAttachments={(update) => { if (snapshot.active) app.updateAttachments(snapshot.active.id, update); }}
							setDraft={app.setDraft}
							running={running}
							changing={changing || bashBusy || planApplying || app.draftLoading || queueActionId === snapshot.active?.id && queueActionId !== undefined}
							planMode={inPlanMode}
							onTogglePlanMode={() => void togglePlanMode()}
							send={app.send}
							stop={() => void app.command({ type: "abort" })}
							command={app.command}
							setPermission={(permission) => void savePermission(permission)}
							onSelectProject={selectWorkspace}
							onOpenProject={openWorkspace}
							sandboxStatus={sandboxStatus}
							sandboxOpen={sandboxOpen}
							setSandboxOpen={setSandboxOpen}
							onUpdateSandbox={saveSandbox}
							openSettings={() => { setConnecting(!snapshot.models.length); setSettings(true); }}
							onBuiltinSlash={handleBuiltinSlash}
							onCompactInstructions={(customInstructions) => void app.command({ type: "compact", customInstructions })}
							onBtw={(q) => void runBtw(q)}
							onLoop={(args) => void runLoop(args)}
							onFocusSubagentPanel={() => subagentPanelRef.current?.focusFirst() ?? false}
							inputRef={composerInputRef}
							gitBranch={gitSummary?.isGit && gitSummary.branch ? gitSummary.branch : undefined}
							fail={app.fail}
						/>
							</>
						)}
					</div>
					{terminalOpen && (
						<TerminalPanel
							key={snapshot.active?.id}
							focusId={focusedTerminal?.conversationId === snapshot.active?.id ? focusedTerminal?.terminalId : undefined}
							conversationId={snapshot.active?.id}
							project={snapshot.active?.project}
							ready={ready}
							blocked={blocked}
							readOnly={snapshot.settings.permission === "read" || snapshot.settings.permission === "plan"}
							bashBusy={bashBusy}
							bashOutput={app.terminal}
							prefill={rerun?.conversationId === snapshot.active?.id ? rerun : undefined}
							onRunBash={(cmd) => app.bash(cmd)}
							onAbortBash={() => void app.command({ type: "abort_bash" })}
							onClose={() => { setRerun(undefined); setTerminalOpen(false); }}
							fail={app.fail}
						/>
					)}
				</div>
			</main>
			{pane && (
				<WorkspacePanel
					key={snapshot.active?.id}
					pane={pane}
					conversationId={snapshot.active?.id}
					checkpointId={lastCheckpoint?.id}
					focusReview={focusReview}
					onToggleReviewFocus={toggleReviewFocus}
					onOpenCheckpoint={openCheckpoint}
					onSendReview={async (message) => {
						const id = snapshot.active?.id;
						if (!id) throw new Error("请先打开会话。");
						await api.command({ type: "prompt", message, ...(running ? { streamingBehavior: "followUp" as const } : {}) }, id);
						await app.refresh();
					}}
					setPane={setPane}
					close={() => setPane(null)}
					revision={app.revision}
					project={snapshot.active?.project}
					readOnly={snapshot.settings.permission === "read" || snapshot.settings.permission === "plan"}
					onOpenInEditor={openInEditor}
					onReferenceFile={(filePath) => {
						const ref = formatFileReference(filePath);
						const already = fileReferences(app.draft).some((reference) => reference.path === filePath);
						if (!already) {
							const prefix = app.draft && !app.draft.endsWith(" ") && !app.draft.endsWith("\n") ? `${app.draft} ` : app.draft;
							app.setDraft(`${prefix}${ref} `);
						}
						requestAnimationFrame(() => {
							const input = composerInputRef.current;
							if (!input) return;
							input.focus();
							input.setSelectionRange(input.value.length, input.value.length);
						});
					}}
					onWorkspaceMutated={() => void app.refresh()}
					onNotice={(msg) => app.setNotice(msg)}
				/>
			)}
			{!pane && previewUrl && (
				<PreviewPanel
					key={snapshot.active?.id}
					url={previewUrl}
					onNavigate={setPreviewUrl}
					onReport={(report) => app.setDraft([app.draft, report].filter(Boolean).join("\n\n"))}
					close={() => setPreviewUrl(null)}
				/>
			)}
			{trustOpen && snapshot.trust && (
				<ProjectTrustDialog
					trust={snapshot.trust}
					busy={trustBusy || blocked}
					close={() => setTrustOpen(false)}
					decide={(decision) => void decideTrust(decision)}
				/>
			)}
			{agentsOpen && (
				<AgentsDialog
					project={snapshot.active?.project}
					close={() => setAgentsOpen(false)}
					onNotice={(message) => app.setNotice(message)}
					fail={app.fail}
				/>
			)}
			{mcpOpen && (
				<McpDialog
					onOAuth={snapshot.active && snapshot.settings.permission !== "read" && snapshot.settings.permission !== "plan" ? async (name) => {
						const id = snapshot.active!.id;
						const terminal = await api.terminals.mcpOAuth(id, name);
						setFocusedTerminal({ conversationId: id, terminalId: terminal.id });
						setMcpOpen(false);
						setTerminalOpen(true);
					} : undefined}
					project={snapshot.active?.project}
					close={() => setMcpOpen(false)}
					onNotice={(message) => app.setNotice(message)}
					onChanged={() => void app.refresh()}
					fail={app.fail}
				/>
			)}
			{settings && (
				<SettingsDialog
					settings={snapshot.settings}
					presets={snapshot.providerPresets}
					models={snapshot.models}
					busy={blocked}
					connectionOnly={connecting}
					close={() => { setSettings(false); setConnecting(false); }}
					onSaved={() => {
						setFlash(connecting ? "模型已连接" : "设置已保存");
						if (connecting) requestAnimationFrame(() => composerInputRef.current?.focus());
					}}
					apply={app.apply}
					fail={app.fail}
				/>
			)}
			{searching && (() => {
				const needle = query.trim().toLowerCase();
				const results = snapshot.conversations.filter((session) =>
					`${session.title} ${projectName(snapshot, session.project)}`.toLowerCase().includes(needle),
				);
				const current = Math.min(searchIndex, Math.max(results.length - 1, 0));
				const open = (id: string) => switchTo(() => api.selectConversation(id));
				return (
					<Modal title="搜索会话" close={() => setSearching(false)}>
						<div className="search-dialog-input">
							<Search size={17} />
							<input
								autoFocus data-autofocus
								role="combobox"
								aria-expanded="true"
								aria-controls="cc-search-results"
								aria-activedescendant={results[current] ? `cc-search-${results[current].id}` : undefined}
								aria-label="搜索会话标题或项目"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setSearchIndex(0);
								}}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										event.preventDefault();
										if (!results.length) return;
										const next = (current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
										setSearchIndex(next);
										document.getElementById(`cc-search-${results[next].id}`)?.scrollIntoView({ block: "nearest" });
									} else if (event.key === "Enter" && results[current] && !changing) {
										event.preventDefault();
										open(results[current].id);
									}
								}}
								placeholder="搜索标题或项目…"
							/>
						</div>
						<div className="search-results" id="cc-search-results" role="listbox" aria-label="搜索结果">
							{results.length === 0 && <p className="cc-search-empty">没有匹配的会话</p>}
							{results.map((session, index) => (
								<button
									id={`cc-search-${session.id}`}
									role="option"
									aria-selected={index === current}
									aria-current={session.id === snapshot.active?.id ? "true" : undefined}
									className={index === current ? "active" : undefined}
									disabled={changing}
									key={session.id}
									tabIndex={-1}
									onMouseEnter={() => setSearchIndex(index)}
									onClick={() => open(session.id)}
								>
									<div>
										<strong>{session.title}</strong>
										<span title={session.project}>{projectName(snapshot, session.project)}</span>
									</div>
									{session.id === snapshot.active?.id && <em className="cc-search-current">当前</em>}
								</button>
							))}
						</div>
					</Modal>
				);
			})()}
			{convMenu && (() => {
				const target = snapshot.conversations.find((item) => item.id === convMenu.id);
				if (!target) return null;
				const closeMenu = (focusRow = true) => {
					setConvMenu(null);
					if (focusRow) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-conv-id="${target.id}"]`)?.focus());
				};
				const busyHere = app.activity[target.id] === "running" || app.activity[target.id] === "approval";
				return (
					<div
						className="cc-conv-menu-layer"
						onMouseDown={(event) => {
							if (event.target === event.currentTarget) closeMenu(false);
						}}
						onContextMenu={(event) => {
							event.preventDefault();
							closeMenu(false);
						}}
					>
						<div
							className="cc-conv-menu"
							role="menu"
							aria-label={`会话「${target.title}」操作`}
							style={{ left: Math.min(convMenu.x, window.innerWidth - 188), top: Math.min(convMenu.y, window.innerHeight - 96) }}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									closeMenu();
									return;
								}
								menuKeyNav(event);
							}}
							ref={focusFirstMenuItem}
						>
							<button
								type="button"
								role="menuitem"
								className="cc-more-item"
								disabled={blocked}
								onClick={() => {
									closeMenu(false);
									void api
										.updateConversationMeta(target.id, { pinned: !target.pinned })
										.then((next) => {
											app.apply(next);
											setFlash(target.pinned ? "已取消置顶" : "已置顶会话");
										})
										.catch(app.fail);
								}}
							>
								<Pin size={14} />
								<span>{target.pinned ? "取消置顶" : "置顶"}</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="cc-more-item"
								disabled={blocked}
								onClick={() => {
									closeMenu(false);
									setGroupEdit({ id: target.id, value: target.group ?? "" });
								}}
							>
								<Folder size={14} />
								<span>{target.group ? `分组：${target.group}` : "设置分组…"}</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="cc-more-item"
								disabled={blocked}
								onClick={() => {
									closeMenu(false);
									void api
										.updateConversationMeta(target.id, { archived: !target.archived })
										.then((next) => {
											app.apply(next);
											setFlash(target.archived ? "已取消归档" : "会话已归档");
										})
										.catch(app.fail);
								}}
							>
								<Archive size={14} />
								<span>{target.archived ? "取消归档" : "归档"}</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="cc-more-item"
								disabled={blocked}
								onClick={() => {
									closeMenu(false);
									setRenameId(target.id);
									setRename(target.title);
								}}
							>
								<SquarePen size={14} />
								<span>重命名</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="cc-more-item danger"
								disabled={changing || busyHere}
								title={busyHere ? "会话正在运行或等待审批，暂不能删除" : undefined}
								onClick={() => {
									closeMenu(false);
									if (!window.confirm(`删除「${target.title}」？\n会话记录文件将移到废纸篓。`)) return;
									void api
										.removeConversation(target.id)
										.then((next) => {
											app.forgetDraft(target.id);
											app.apply(next);
											setFlash("会话已移到废纸篓");
										})
										.catch(app.fail);
								}}
							>
								<Trash2 size={14} />
								<span>删除（移到废纸篓）</span>
							</button>
						</div>
					</div>
				);
			})()}
			{groupEdit !== null && (
				<Modal title="设置会话分组" close={() => setGroupEdit(null)}>
					<form
						className="simple-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							const nextGroup = groupEdit.value.trim();
							void api
								.updateConversationMeta(groupEdit.id, { group: nextGroup || null })
								.then((next) => {
									app.apply(next);
									setFlash(nextGroup ? `已分组到「${nextGroup}」` : "已清除分组");
								})
								.catch(app.fail);
							setGroupEdit(null);
						}}
					>
						<label className="field-label">
							分组名称（留空则移回时间分组）
							<input
								autoFocus data-autofocus
								aria-label="分组名称"
								maxLength={60}
								placeholder="例如：后端重构、Bug 排查"
								value={groupEdit.value}
								onChange={(event) => setGroupEdit({ ...groupEdit, value: event.target.value })}
							/>
						</label>
						<div className="dialog-actions">
							<button type="button" className="btn-secondary" onClick={() => setGroupEdit(null)}>取消</button>
							<button type="submit" className="btn-primary">保存</button>
						</div>
					</form>
				</Modal>
			)}
			{rename !== null && (
				<Modal title="重命名会话" close={() => { setRename(null); setRenameId(undefined); }}>
					<form
						className="simple-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							const target = renameId ?? snapshot.active?.id;
							if (target && rename.trim()) {
								void app.switchTo(() => api.renameConversation(target, rename.trim()));
								setRename(null);
								setRenameId(undefined);
							}
						}}
					>
						<label className="field-label">
							会话名称
							<input
								autoFocus data-autofocus
								aria-label="会话名称"
								value={rename}
								onChange={(event) => setRename(event.target.value)}
							/>
						</label>
						<div className="dialog-actions">
							<button className="primary-button" disabled={!rename.trim()}>
								保存名称
							</button>
						</div>
					</form>
				</Modal>
			)}

			{(!app.requests[0] || app.requests[0].id === deferredApproval) && snapshot.active && childApprovals.length > 0 && (
				<SubagentApprovals
					approvals={childApprovals}
					rootConversationId={snapshot.active.id}
					project={snapshot.active.project}
					onRespond={async (taskId, response) => {
						await api.tasks.respond(taskId, response);
						setTasksMap((prev) => {
							const target = prev[taskId];
							if (!target?.pendingApprovals) return prev;
							const remaining = target.pendingApprovals.filter((r) => r.id !== response.id);
							return {
								...prev,
								[taskId]: {
									...target,
									...(remaining.length ? { pendingApprovals: remaining } : { pendingApprovals: undefined }),
								},
							};
						});
					}}
					fail={app.fail}
				/>
			)}
			{controlsTab && (
				<ControlsDialog
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					initialTab={controlsTab}
					onNotice={(msg) => app.setNotice(msg)}
					hooksDisabled={snapshot.settings.disableAllHooks === true}
					close={() => setControlsTab(null)}
					fail={app.fail}
				/>
			)}
			{checkpointsOpen && (
				<CheckpointsDialog
					conversationId={snapshot.active?.id}
					initialCheckpointId={rewindTarget?.checkpointId}
					initialPath={rewindTarget?.path}
					close={() => setCheckpointsOpen(false)}
					onRestored={(msg) => {
						app.setNotice(msg);
						void app.refresh();
					}}
					readOnly={snapshot.settings.permission === "read" || snapshot.settings.permission === "plan"}
				/>
			)}
			{tasksOpen && (
				<TasksDrawer
					project={snapshot.active?.project}
					conversationId={snapshot.active?.id}
					agentTeams={snapshot.settings.agentTeams === true}
					initialTaskId={taskInitialId}
					close={() => setTasksOpen(false)}
					onNotice={(msg) => app.setNotice(msg)}
					fail={app.fail}
				/>
			)}
			{sessionsOpen && (
				<SessionsDialog
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					orphanedSubagents={sidebarGroups.orphanedSubagents}
					allSubagents={sidebarGroups.allSubagents}
					onSelectConversation={(id) => switchTo(() => api.selectConversation(id))}
					onSnapshot={() => void app.refresh()}
					onEditorText={(text) => app.setDraft(text)}
					close={() => setSessionsOpen(false)}
					fail={app.fail}
				/>
			)}
			{memoryTab && (
				<MemoryStatusDialog
					key={snapshot.active?.id}
					initialTab={memoryTab}
					snapshot={snapshot}
					gitBranch={gitSummary?.branch}
					onInitPrompt={sendInitPrompt}
					onCompact={async (customInstructions) => {
						await app.command({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
						await app.refresh();
					}}
					onToggleAutoCompaction={async (enabled) => {
						await app.command({ type: "set_auto_compaction", enabled });
						await app.refresh();
					}}
					onToggleAutoRetry={async (enabled) => {
						await app.command({ type: "set_auto_retry", enabled });
						await app.refresh();
					}}
					onNotice={(msg) => app.setNotice(msg)}
					close={() => setMemoryTab(null)}
					fail={app.fail}
				/>
			)}
			{usageOpen && <UsageStatsDialog close={() => setUsageOpen(false)} />}
			{grailReportVerdict && grail && (
				<GrailReportDialog
					verdict={grailReportVerdict}
					wording={grailText}
					busy={Boolean(grail.running)}
					canRejudge={grailReportVerdict.wish === grail.wish && grail.hasDiff && !blocked}
					canSeal={grailReportVerdict.wish === grail.wish}
					onRejudge={startGrail}
					onSeal={sealGrail}
					close={() => setGrailReportId(null)}
				/>
			)}
			{grailReveal && <GrailReveal label={grailText.grades.grail} />}
			{doctorOpen && <DoctorDialog close={() => setDoctorOpen(false)} onNotice={(msg) => app.setNotice(msg)} />}
			{paletteOpen && (
				<CommandPalette
					actions={paletteActions}
					close={() => setPaletteOpen(false)}
				/>
			)}
		</div>
	);
}
// Preload presence is a host boundary: browser-only previews have no privileged bridge.
createRoot(document.getElementById("root")!).render(
	window.pi ? (
		<Desktop api={window.pi} />
	) : (
		<div className="cl-start">
			<PiMark />
			<h1>请在 Pi Desktop 桌面应用中打开</h1>
			<p>真实项目访问和 Pi 引擎通过桌面进程连接，此页面没有模拟后端。</p>
		</div>
	),
);
