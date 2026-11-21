import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
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
import { IconButton, Modal, PiMark, menuKeyNav } from "../prototype/ui.tsx";
import { useDesktop } from "./useDesktop.ts";
import { TranscriptView, type TodoItem } from "./TranscriptView.tsx";
import { LiveComposer, type BuiltinSlashAction } from "./LiveComposer.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { GrailEmblem, HolyGrailIcon, MagicCircleBackdrop, MagicCircleLoader, OmenGlyph, getServantInfo } from "./GrailIcons.tsx";
import { scoreTurn, type QualityVerdict } from "./quality-verdict.ts";
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
import { PreviewPanel } from "./PreviewPanel.tsx";
import { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
import { ProjectTrustDialog } from "./ProjectTrustDialog.tsx";
import { AgentsDialog } from "./AgentsDialog.tsx";
import { McpDialog } from "./McpDialog.tsx";
import "../prototype/style.css";
import "./style.css";
import "./grail-theme.css";

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function projectName(snapshot: Snapshot, path: string): string {
	const found = snapshot.projects.find((item) => item.path === path);
	return found?.name ?? path.split("/").filter(Boolean).pop() ?? path;
}

function clampInspector(width: number): number {
	const max = Math.max(320, Math.min(1000, window.innerWidth - 560));
	return Math.round(Math.min(max, Math.max(320, width)));
}

function Desktop({ api }: { api: DesktopAPI }) {
	const app = useDesktop(api);
	const { snapshot, history, running, changing, bashBusy } = app;
	const [sidebar, setSidebar] = useState(true);
	const [settings, setSettings] = useState(false);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [searchIndex, setSearchIndex] = useState(0);
	const [inspectorWidth, setInspectorWidth] = useState(() => {
		const stored = Number(localStorage.getItem("pi.inspectorWidth"));
		return Number.isFinite(stored) && stored >= 320 ? stored : 400;
	});
	const [pane, setPane] = useState<"changes" | "files" | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [deferredApproval, setDeferredApproval] = useState<string>();
	const [focusedTerminal, setFocusedTerminal] = useState<{ conversationId: string; terminalId: string }>();
	const [controlsTab, setControlsTab] = useState<ControlsTab | null>(null);
	const [checkpointsOpen, setCheckpointsOpen] = useState(false);
	const [omenReveal, setOmenReveal] = useState<QualityVerdict | null>(null);
	const [rewindQuery, setRewindQuery] = useState<string | undefined>(undefined);
	const [tasksOpen, setTasksOpen] = useState(false);
	const [taskInitialId, setTaskInitialId] = useState<string | undefined>(undefined);
	const [sessionsOpen, setSessionsOpen] = useState(false);
	const [memoryTab, setMemoryTab] = useState<"memory" | "context" | "status" | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [planState, setPlanState] = useState<PlanFileState | null>(null);
	const [planEditorOpen, setPlanEditorOpen] = useState(false);
	const [planDraft, setPlanDraft] = useState("");
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
	const [convMenu, setConvMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	/** Text the user sent while a run was active, per conversation; Pi only exposes a count. */
	const [queued, setQueued] = useState<Record<string, string[]>>({});
	const [showJump, setShowJump] = useState(false);
	const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
	const [sandboxOpen, setSandboxOpen] = useState(false);
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const moreMenuRef = useRef<HTMLDivElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const stickToEnd = useRef(true);
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
	useEffect(() => {
		stickToEnd.current = true;
		setShowJump(false);
		setDeferredApproval(undefined);
		setFocusedSubagentTaskId(null);
	}, [snapshot?.active?.id]);
	useEffect(() => {
		setTrustOpen(false);
	}, [snapshot?.active?.project]);
	useEffect(() => {
		const id = snapshot?.active?.id;
		if (!id || snapshot?.state?.pendingMessageCount) return;
		setQueued((prev) => (prev[id]?.length ? { ...prev, [id]: [] } : prev));
	}, [snapshot?.active?.id, snapshot?.state?.pendingMessageCount, queued]);
	const focusFirstMenuItem = useCallback((node: HTMLDivElement | null) => {
		node?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
	}, []);
	const sendPrompt: typeof app.send = async (value) => {
		const id = snapshot?.active?.id;
		const wasRunning = running;
		const result = await app.send(value);
		if (wasRunning && id && result?.disposition === "queued" && value.message.trim())
			setQueued((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), value.message.trim()] }));
		return result;
	};
	const withdrawQueued = async () => {
		const id = snapshot?.active?.id;
		if (!id) return;
		try {
			const result = (await api.command({ type: "clear_queue" }, id)) as { steering?: string[]; followUp?: string[] } | undefined;
			const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])].filter((text) => text.trim());
			const restored = texts.length ? texts : queued[id] ?? [];
			if (restored.length) app.prependDraft(id, restored.join("\n\n"));
			setQueued((prev) => ({ ...prev, [id]: [] }));
			await app.refresh();
			setFlash(restored.length ? "排队的指令已放回输入框" : "队列已清空");
			composerInputRef.current?.focus();
		} catch (error) {
			app.fail(error);
		}
	};

	useEffect(() => {
		if (stickToEnd.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
	}, [history, running]);
	// On turn settle (running true→false), reveal the just-finished turn's quality omen briefly.
	// The run is tied to the conversation it started in, so switching away from a running
	// conversation never reveals a verdict for a different one.
	const wasRunning = useRef(false);
	const runningConversation = useRef<string | undefined>(undefined);
	useEffect(() => {
		const conversation = snapshot?.active?.id;
		if (running && !wasRunning.current) runningConversation.current = conversation;
		if (wasRunning.current && !running && runningConversation.current === conversation) {
			const messages = history.messages;
			let start = messages.length;
			while (start > 0 && messages[start - 1].role !== "user" && messages[start - 1].role !== "custom") start--;
			const verdict = start < messages.length ? scoreTurn(messages.slice(start)) : null;
			if (verdict && verdict.omen !== "none") setOmenReveal(verdict);
		}
		wasRunning.current = running;
	}, [running, history.messages, snapshot?.active?.id]);
	// The timer depends only on the reveal itself, so transcript updates cannot cancel it.
	useEffect(() => {
		if (!omenReveal) return;
		const timer = setTimeout(() => setOmenReveal(null), 2500);
		return () => clearTimeout(timer);
	}, [omenReveal]);
	useEffect(() => {
		setOmenReveal(null);
	}, [snapshot?.active?.id]);
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
	const blocked = running || changing || bashBusy;
	const project = snapshot?.projects.find((item) => item.path === snapshot.active?.project);
	const taskList = [...Object.values(tasksMap), ...Object.values(externalTasksMap)];
	const activeTaskCount = taskList.filter((t) => t.status === "running" || t.status === "queued").length;
	const waitingTaskCount = taskList.filter((t) => t.status === "waiting_for_input").length;
	const switchTo = (operation: () => ReturnType<DesktopAPI["snapshot"]>) => {
		setSearching(false);
		setPane(null);
		void app.switchTo(operation);
	};
	const savePermission = async (permission: PermissionMode) => {
		if (!snapshot) return;
		if (permission !== "plan" && planMode) setPlanMode(false);
		if (permission === "plan" && !planMode) setPlanMode(true);
		await app.switchTo(() => api.saveSettings({ permission, theme: snapshot.settings.theme }));
		if (permission === "auto" && snapshot.settings.permission !== "auto")
			setFlash(snapshot.settings.sandbox ? "已切换为跳过确认，命令仍在 Seatbelt 沙箱中运行" : "已切换为跳过确认，Pi 将不经询问执行命令");
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
		if (snapshot?.active && !running && history.messages.length === 0 && !app.draft.trim()) {
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
			setPlanMode(false);
			setPlanEditorOpen(false);
			if (app.draft.trim() === PLAN_TEMPLATE.trim()) app.setDraft("");
			await savePermission("ask");
		} else {
			setPlanMode(true);
			if (snapshot.settings.permission !== "plan") await savePermission("plan");
			if (!app.draft.trim()) app.setDraft(PLAN_TEMPLATE);
		}
	};
	const approvePlanAndExecute = async (mode: PermissionMode) => {
		if (!snapshot) return;
		setPlanMode(false);
		setPlanEditorOpen(false);
		if (planDraft.trim() && planDraft !== planState?.content) {
			await api.writePlan(planDraft).catch(() => {});
		}
		await app.switchTo(() => api.saveSettings({ permission: mode, theme: snapshot.settings.theme }));
		const planRef = planState?.exists ? `（计划文件：${planState.relativePath}）` : "";
		await app.send({ type: "prompt", message: `计划已批准${planRef}。请严格按上述计划实施代码修改并运行相关测试验证。`, images: [] });
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
	const handleBuiltinSlash = (action: BuiltinSlashAction) => {
		if (action === "compact") {
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
			setRewindQuery(undefined);
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
			if (!mounted) return;
			setPlanState(res);
			setPlanDraft(res.content);
		}).catch(() => {});
		return () => { mounted = false; };
	}, [activeConvId, planMode, activePermMode, app.revision, running]);
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
	const latestTodos: TodoItem[] = sharedTodos.length > 0
		? sharedTodos.map((item) => ({
			id: item.id,
			content: (item.status === "in_progress" && item.activeForm ? item.activeForm : item.subject) +
				(item.owner ? ` (@${item.owner})` : "") +
				(item.blockedBy.length ? ` [阻塞于 #${item.blockedBy.join(", #")}]` : ""),
			status: item.status === "completed" ? "completed" : item.status === "in_progress" ? "in_progress" : "pending",
		}))
		: (() => {
			for (let i = history.messages.length - 1; i >= 0; i--) {
				const msg = history.messages[i];
				if (msg.role !== "assistant") continue;
				for (let j = msg.content.length - 1; j >= 0; j--) {
					const block = msg.content[j];
					if (block.type === "toolCall" && block.name === "TodoWrite" && block.arguments && typeof block.arguments === "object") {
						const todos = (block.arguments as { todos?: TodoItem[] }).todos;
						if (Array.isArray(todos)) return todos;
					}
				}
			}
			return [];
		})();
	const lastMessage = history.messages[history.messages.length - 1];
	const inPlanMode = planMode || snapshot.settings.permission === "plan";
	const showPlanApproval =
		inPlanMode &&
		!running &&
		!blocked &&
		Boolean(planState?.exists || (lastMessage && lastMessage.role === "assistant"));
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
		{ id: "rewind", label: "检查点与代码回滚 (/rewind)", keywords: "git checkpoint restore", disabled: !snapshot.active, run: () => { setRewindQuery(undefined); setCheckpointsOpen(true); } },
		{ id: "tasks", label: "后台任务、子 Agent 与 Worktree (/tasks)", keywords: "subagent external codex claude kimi", run: () => { setTaskInitialId(undefined); setTasksOpen(true); } },
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
		{ id: "changes", label: "查看 Git 修改与暂存提交", keywords: "git diff stage commit", run: () => { setPreviewUrl(null); setPane(pane === "changes" ? null : "changes"); } },
		{ id: "files", label: "浏览项目文件", keywords: "files explorer", run: () => { setPreviewUrl(null); setPane(pane === "files" ? null : "files"); } },
		{ id: "compact", label: "压缩会话上下文 (/compact)", keywords: "compact context", disabled: blocked || !history.messages.length, run: () => void app.command({ type: "compact" }) },
		{ id: "settings", label: "打开客户端与模型设置", keywords: "settings model api key theme", run: () => setSettings(true) },
	];
	const isGrail = snapshot.settings.theme === "grail";
	const servant = isGrail ? getServantInfo(snapshot.state?.model?.id) : null;
	return (
		<div
			className={`desktop-app live-app ${sidebar ? "" : "cl-side-hidden"} ${pane || previewUrl ? "has-inspector" : ""}`}
			style={{ "--inspector-w": `${inspectorWidth}px` } as CSSProperties}
		>
			{(pane || previewUrl) && (
				<div
					className="cc-inspector-resize"
					role="separator"
					aria-orientation="vertical"
					aria-label="调整右侧面板宽度"
					aria-valuemin={320}
					aria-valuemax={1000}
					aria-valuenow={inspectorWidth}
					tabIndex={0}
					onKeyDown={(event) => {
						if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
						event.preventDefault();
						const next = clampInspector(inspectorWidth + (event.key === "ArrowLeft" ? 32 : -32));
						setInspectorWidth(next);
						localStorage.setItem("pi.inspectorWidth", String(next));
					}}
					onDoubleClick={() => {
						setInspectorWidth(400);
						localStorage.setItem("pi.inspectorWidth", "400");
					}}
					onPointerDown={(event) => {
						event.preventDefault();
						const handle = event.currentTarget;
						handle.setPointerCapture(event.pointerId);
						document.body.classList.add("cc-resizing");
						let latest = inspectorWidth;
						const move = (e: PointerEvent) => {
							latest = clampInspector(window.innerWidth - e.clientX);
							setInspectorWidth(latest);
						};
						const up = () => {
							handle.removeEventListener("pointermove", move);
							handle.removeEventListener("pointerup", up);
							handle.removeEventListener("pointercancel", up);
							document.body.classList.remove("cc-resizing");
							localStorage.setItem("pi.inspectorWidth", String(latest));
						};
						handle.addEventListener("pointermove", move);
						handle.addEventListener("pointerup", up);
						handle.addEventListener("pointercancel", up);
					}}
					title="拖动调整宽度，双击恢复默认"
				/>
			)}
			{sidebar && (
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
															<span className="cl-conv-status run">运行中</span>
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
				<header className={`cl-top ${sidebar ? "" : "cl-top-collapsed"}`}>
					<div className="cl-top-title">
						{(!sidebar || pane || previewUrl) && (
							<>
								<IconButton
									icon={PanelLeftOpen}
									label="展开侧栏"
									className="cl-narrow-only"
									onClick={() => {
										if (sidebar) {
											// Narrow layout hid the sidebar for the side panel; close the panel to bring it back.
											setPane(null);
											setPreviewUrl(null);
										} else setSidebar(true);
										requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="收起侧栏"]')?.focus());
									}}
								/>
								<IconButton
									icon={SquarePen}
									label="新建会话"
									className="cl-narrow-only"
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
								onClick={() => { setPreviewUrl(null); setPane(pane === "changes" ? null : "changes"); }}
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
								onClick={() => { setPreviewUrl(null); setPane(pane === "files" ? null : "files"); }}
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
												setRewindQuery(undefined);
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
												void api
													.exportConversation()
													.then((path) => {
														if (path) app.setNotice(`会话已导出：${path}`);
													})
													.catch(app.fail);
											}}
										>
											<Download size={14} />
											<span>导出会话</span>
										</button>
										{(!sidebar || pane || previewUrl) && (
											<button
												type="button"
												role="menuitem"
												className="cc-more-item cl-narrow-only"
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
				{!snapshot.models.length && (
					<div className="cl-connect">
						<ShieldCheck size={17} />
						<span>尚未找到可用模型。可复用 Pi 的登录配置，或在设置中连接模型服务。</span>
						<button className="secondary-button" onClick={() => setSettings(true)}>
							模型连接设置
						</button>
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
											onRewindPrompt={(promptText) => {
												setRewindQuery(promptText);
												setCheckpointsOpen(true);
											}}
											onForkPrompt={(promptText) => {
												void api.sessions
													.forkMessages(snapshot.active?.id)
													.then(async ({ messages }) => {
														const match = messages.find((m) => m.text.trim() === promptText.trim() || promptText.includes(m.text.slice(0, 40)));
														if (match) {
															await api.sessions.fork({ conversationId: snapshot.active?.id, entryId: match.entryId, activate: true });
															await app.refresh();
														} else {
															setSessionsOpen(true);
														}
													})
													.catch(app.fail);
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
														: "今天想一起做什么？"
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
											{snapshot.active ? (
												<>
													<div className="cc-empty-workspace">
														<Folder size={14} />
														<span className="cc-empty-ws-path" title={snapshot.active.project}>
															<bdi>{snapshot.active.project}</bdi>
														</span>
														<button type="button" className="cc-empty-ws-btn" disabled={changing} onClick={openWorkspace}>
															切换目录
														</button>
													</div>
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
											<div className="cc-empty-hints">
												<span><kbd>⌘N</kbd> 新建会话</span>
												<span><kbd>⌘K</kbd> 搜索会话</span>
												<span><kbd>/</kbd> 斜杠命令</span>
												<span><kbd>@</kbd> 引用文件</span>
											</div>
										</div>
									)}
									{running && (
										<div className="cl-working" role="status">
											{isGrail ? <MagicCircleLoader size={16} /> : <span className="cl-spinner" />}
											{isGrail ? "从者正在咏唱与执行…" : "Pi 正在工作"}
										</div>
									)}
									{!!snapshot.state?.pendingMessageCount && (
										<div className="cc-queue" role="region" aria-label="排队的指令">
											<div className="cc-queue-head">
												<span>
													{running
														? `${snapshot.state.pendingMessageCount} 条指令排队中，当前步骤结束后发送`
														: `已停止，${snapshot.state.pendingMessageCount} 条指令还在排队，会和下一条消息一起发送`}
												</span>
												<button type="button" className="cc-mini-btn" onClick={() => void withdrawQueued()}>
													撤回到输入框
												</button>
											</div>
											{(queued[snapshot.active?.id ?? ""] ?? []).map((text, index) => (
												<p key={`${index}-${text.slice(0, 16)}`} className="cc-queue-item" title={text}>
													{text}
												</p>
											))}
										</div>
									)}
									{!running && isGrail && omenReveal && (
										<div className={`cl-working grail-omen-reveal omen-${omenReveal.omen}`} role="status">
											<OmenGlyph omen={omenReveal.omen} width={17} height={17} />
											<span>{omenReveal.label}</span>
										</div>
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
						{latestTodos.length > 0 && (
							<div className="cc-pinned-todos">
								<button type="button" className="cc-pinned-todos-head" onClick={() => setTodoExpanded((v) => !v)}>
									<span>
										任务进度 ({latestTodos.filter((t) => t.status === "completed").length}/{latestTodos.length})
										{latestTodos.find((t) => t.status === "in_progress")
											? ` · ${latestTodos.find((t) => t.status === "in_progress")!.content}`
											: ""}
									</span>
									<span>{todoExpanded ? "收起" : "展开"}</span>
								</button>
								{todoExpanded && (
									<div className="cc-pinned-todos-list">
										{latestTodos.map((item) => (
											<div key={item.id} className={`cc-todo-row ${item.status}`}>
												{item.status === "completed" ? (
													<Check size={12} className="ok" />
												) : item.status === "in_progress" ? (
													<LoaderCircle size={12} className="spin run" />
												) : (
													<Circle size={11} className="pending" />
												)}
												<span>{item.content}</span>
											</div>
										))}
									</div>
								)}
							</div>
						)}
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
							<div className="cc-plan-bar" role="region" aria-label="计划审批">
								<div className="cc-plan-bar-top">
									<span>
										Plan 模式调研已完成{planState?.exists ? `（已保存 ${planState.relativePath}）` : ""}，是否按计划开始实施？
									</span>
									<div className="cc-plan-bar-actions">
										<button
											type="button"
											className="cc-mini-btn"
											onClick={() => setPlanEditorOpen((v) => !v)}
										>
											{planEditorOpen ? "收起计划正文" : planState?.exists ? "查看/编辑计划" : "编写计划正文"}
										</button>
										<button
											type="button"
											className="primary-button"
											title="项目内文件编辑自动允许；命令仍按规则询问"
											onClick={() => void approvePlanAndExecute("acceptEdits")}
										>
											批准计划 · 接受编辑
										</button>
										<button type="button" className="secondary-button" onClick={() => void approvePlanAndExecute("ask")}>
											批准计划 · 逐项确认
										</button>
										<button
											type="button"
											className="cc-mini-btn"
											title="除规则外不再询问；命令以本机权限运行"
											onClick={() => void approvePlanAndExecute("auto")}
										>
											跳过确认（危险）
										</button>
										<button type="button" className="cc-mini-btn" onClick={() => void togglePlanMode()}>
											退出 Plan
										</button>
									</div>
								</div>
								{planEditorOpen && (
									<textarea
										className="cc-plan-editor"
										rows={6}
										aria-label="编辑计划内容"
										placeholder="可在此审查或补充计划正文，点击批准时自动写入 .pi/plans/…"
										value={planDraft}
										onChange={(e) => setPlanDraft(e.target.value)}
									/>
								)}
							</div>
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
						<LiveComposer
							key={snapshot.active?.id ?? "no-conversation"}
							snapshot={snapshot}
							activeProject={project}
							draft={app.draft}
							setDraft={app.setDraft}
							running={running}
							changing={changing || bashBusy}
							planMode={inPlanMode}
							onTogglePlanMode={() => void togglePlanMode()}
							send={sendPrompt}
							stop={() => void app.command({ type: "abort" })}
							command={app.command}
							setPermission={(permission) => void savePermission(permission)}
							onSelectProject={selectWorkspace}
							onOpenProject={openWorkspace}
							sandboxStatus={sandboxStatus}
							sandboxOpen={sandboxOpen}
							setSandboxOpen={setSandboxOpen}
							onUpdateSandbox={saveSandbox}
							openSettings={() => setSettings(true)}
							onBuiltinSlash={handleBuiltinSlash}
							onCompactInstructions={(customInstructions) => void app.command({ type: "compact", customInstructions })}
							onBtw={(q) => void runBtw(q)}
							onLoop={(args) => void runLoop(args)}
							onFocusSubagentPanel={() => subagentPanelRef.current?.focusFirst() ?? false}
							inputRef={composerInputRef}
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
							onRunBash={(cmd) => app.bash(cmd)}
							onAbortBash={() => void app.command({ type: "abort_bash" })}
							onClose={() => setTerminalOpen(false)}
							fail={app.fail}
						/>
					)}
				</div>
			</main>
			{pane && (
				<WorkspacePanel
					key={`${snapshot.active?.id}-${pane}`}
					pane={pane}
					conversationId={snapshot.active?.id}
					onReviewNote={(note) => app.setDraft([app.draft, note].filter(Boolean).join("\n\n"))}
					setPane={setPane}
					close={() => setPane(null)}
					revision={app.revision}
					project={snapshot.active?.project}
					readOnly={snapshot.settings.permission === "read" || snapshot.settings.permission === "plan"}
					onReferenceFile={(filePath) => {
						const ref = `@${/\s/.test(filePath) ? JSON.stringify(filePath) : filePath}`;
						const already = app.draft.split(/\s+/).includes(ref);
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
					initialUrl={previewUrl}
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
					close={() => setSettings(false)}
					onSaved={() => setFlash("设置已保存")}
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
								title={busyHere ? "会话正在运行或等待审批，暂不能移除" : undefined}
								onClick={() => {
									closeMenu(false);
									if (!window.confirm(`从列表中移除「${target.title}」？\n会话记录文件会保留在磁盘上。`)) return;
									void api
										.removeConversation(target.id)
										.then((next) => {
											app.apply(next);
											setFlash("会话已移除");
										})
										.catch(app.fail);
								}}
							>
								<Trash2 size={14} />
								<span>从列表移除</span>
							</button>
						</div>
					</div>
				);
			})()}
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
			{app.requests[0]?.id === deferredApproval && deferredApproval && (
				<button type="button" className="secondary-button cc-return-approval" onClick={() => setDeferredApproval(undefined)}>继续处理审批</button>
			)}
			{app.requests[0] && app.requests[0].id !== deferredApproval && (
				<PermissionDialog
					key={app.requests[0].id}
					request={app.requests[0]}
					conversationId={snapshot.active?.id}
					project={snapshot.active?.project}
					respond={app.respond}
					defer={() => setDeferredApproval(app.requests[0]?.id)}
					fail={app.fail}
				/>
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
					close={() => setControlsTab(null)}
					fail={app.fail}
				/>
			)}
			{checkpointsOpen && (
				<CheckpointsDialog
					conversationId={snapshot.active?.id}
					initialQuery={rewindQuery}
					close={() => setCheckpointsOpen(false)}
					onRestored={(msg) => {
						app.setNotice(msg);
						void app.refresh();
					}}
					fail={app.fail}
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
