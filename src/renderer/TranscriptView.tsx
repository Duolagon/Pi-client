import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText } from "./clipboard.ts";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownToLine, Bot, Check, Circle, CircleAlert, ChevronRight, Copy, ExternalLink, Eye, FilePen, FileText, GitFork, Globe, ListChecks, LoaderCircle, RotateCcw, Search, Sparkles, Square, Terminal as TerminalIcon } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { AnimatedDetails, SmoothCollapse } from "./SmoothCollapse.tsx";
import { formatCompactDuration, formatCompactTokens, formatTaskProgressSummary } from "../delegation-format.ts";
import { formatRunningToolTimer } from "../task-eta.ts";
import type { DesktopTask, ExternalTask, Message, MonitorRecord, TaskProgress } from "../shared.ts";
import type { Transcript, ToolProgress } from "./messages.ts";
import { CodeLines, InlineEditDiff } from "./DiffView.tsx";
import { summarizeLineChanges, type LineChangeCounts } from "./diff-lines.ts";
import { highlightCode, inferLangFromPath } from "./highlight.tsx";
import { collectVerificationEvidence, scoreTurn, type QualityVerdict, type VerificationCheck } from "./quality-verdict.ts";
import type { WerewolfReview } from "../werewolf-types.ts";
import { WerewolfBadge, WerewolfCalloutStrip, WerewolfReportDialog, type ReplayWerewolfClaim } from "./WerewolfReport.tsx";
import { werewolfReviewForReply } from "./werewolf-view.ts";
import { OmenGlyph } from "./GrailIcons.tsx";
import { isDesktopWorkspaceContext } from "../file-references.ts";
import { toolOutputReference } from "../tool-output-types.ts";
import { ArchivedToolOutput } from "./ArchivedToolOutput.tsx";
import { AgentRows, type AgentCall } from "./AgentRows.tsx";
import { WorkflowTree } from "./WorkflowTree.tsx";
import type { WorkflowRecord } from "../workflow-types.ts";

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
	estimatedSeconds?: number;
	startedAt?: number;
	completedAt?: number;
}

type Assistant = Extract<Message, { role: "assistant" }>;
type AnyMessage = Transcript["messages"][number];
type ImagePreview = { src: string; alt: string };

function ImageThumbnail({
	src,
	alt,
	previewLabel,
	className,
	onZoom,
}: ImagePreview & { previewLabel: string; className?: string; onZoom?: (image: ImagePreview) => void }) {
	const image = <img className={className} src={src} alt={alt} />;
	if (!onZoom) return image;
	return (
		<button
			type="button"
			className="cc-zoomable-img"
			aria-label={`放大预览：${previewLabel}`}
			title="放大预览"
			onClick={(event) => {
				event.currentTarget.focus({ preventScroll: true });
				onZoom({ src, alt: previewLabel });
			}}
		>
			{image}
		</button>
	);
}

type Unit =
	| { kind: "user"; message: Extract<Message, { role: "user" } | { role: "custom" }> }
	| { kind: "bash"; message: Extract<Message, { role: "bashExecution" }> }
	| { kind: "summary"; message: Extract<Message, { role: "branchSummary" | "compactionSummary" }> }
	| { kind: "turn"; messages: Assistant[] };

/** Group consecutive assistant messages (toolResult/system messages stay hidden inside a turn)
    so one user turn renders as a single assistant block, like the native Claude Code client. */
function units(messages: AnyMessage[]): Unit[] {
	const result: Unit[] = [];
	let turn: Assistant[] = [];
	const flush = () => {
		if (turn.length) {
			result.push({ kind: "turn", messages: turn });
			turn = [];
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			turn.push(message);
			continue;
		}
		const hidden =
			message.role === "system" ||
			message.role === "toolResult" ||
			(message.role === "custom" && !message.display);
		if (hidden) continue;
		flush();
		if (message.role === "user" || message.role === "custom") result.push({ kind: "user", message });
		else if (message.role === "bashExecution") result.push({ kind: "bash", message });
		else if (message.role === "branchSummary" || message.role === "compactionSummary") result.push({ kind: "summary", message });
	}
	flush();
	return result;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTokens(count: number): string {
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/** Line count that ignores a single trailing newline, so a 3-line file reads "3 lines". */
function countLines(text: string): number {
	return text.replace(/\r?\n$/, "").split("\n").length;
}

function linesLabel(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}


type CopyState = "idle" | "done" | "failed";
const copyLabel: Record<CopyState, string> = { idle: "复制", done: "已复制", failed: "复制失败" };

const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "console"]);

function CodeBlock({
	className,
	children,
	onRunInTerminal,
}: {
	className?: string;
	children?: ReactNode;
	onRunInTerminal?: (cmd: string) => void;
}) {
	const [copied, setCopied] = useState<CopyState>("idle");
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const match = /language-([^\s]+)/.exec(className || "");
	const lang = (match?.[1] || "text").toLowerCase();
	const raw = String(children ?? "").replace(/\n$/, "");
	const lineCount = countLines(raw);
	const collapsible = lineCount > 45;
	const canRun = Boolean(onRunInTerminal && SHELL_LANGS.has(lang) && raw.trim());

	const copy = () => {
		void copyText(raw).then((ok) => {
			setCopied(ok ? "done" : "failed");
			setTimeout(() => setCopied("idle"), 1500);
		});
	};

	return (
		<div className={`cc-codeblock ${wrapped ? "is-wrapped" : ""} ${collapsible && !expanded ? "is-collapsed" : ""}`.trim()}>
			<div className="cc-codeblock-head">
				<span className="cc-codeblock-lang">{lang}{lineCount > 6 ? ` · ${lineCount} 行` : ""}</span>
				<div className="cc-codeblock-actions">
					{canRun && (
						<button
							type="button"
							className="cc-codeblock-copy"
							onClick={() => onRunInTerminal?.(raw.trim())}
							title="将此命令填入底部集成终端"
						>
							<TerminalIcon size={12} />
							<span>填入终端</span>
						</button>
					)}
					{raw.length > 80 && (
						<button
							type="button"
							className={`cc-codeblock-copy ${wrapped ? "active" : ""}`.trim()}
							onClick={() => setWrapped((v) => !v)}
							title="切换代码自动换行"
						>
							<span>{wrapped ? "取消换行" : "自动换行"}</span>
						</button>
					)}
					<button
						type="button"
						className={`cc-codeblock-copy ${copied === "done" ? "is-copied" : ""}`}
						onClick={copy}
						aria-label="复制代码"
					>
						{copied === "done" ? <Check size={12} /> : <Copy size={12} />}
						<span role={copied === "failed" ? "alert" : undefined}>{copyLabel[copied]}</span>
					</button>
				</div>
			</div>
			<pre>
				<code className={className}>{highlightCode(raw, lang)}</code>
			</pre>
			{collapsible && (
				<button type="button" className="cc-codeblock-expand" onClick={() => setExpanded((v) => !v)}>
					{expanded ? "收起代码" : `展开全部 ${lineCount} 行`}
				</button>
			)}
		</div>
	);
}

const REMARK_PLUGINS = [remarkGfm];

function MarkdownContent({
	text,
	onOpenPreview,
	onRunInTerminal,
}: {
	text: string;
	onOpenPreview?: (url: string) => void;
	onRunInTerminal?: (cmd: string) => void;
}) {
	const components = useMemo<Components>(
		() => ({
			pre({ children }) {
				return <>{children}</>;
			},
			table({ node: _node, ...props }) {
				return (
					<div className="cl-table-scroll">
						<table {...props} />
					</div>
				);
			},
			a({ href, children, node: _node, ...props }) {
				const isLocal = typeof href === "string" && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(href);
				if (isLocal && onOpenPreview && href) {
					return (
						<a
							href={href}
							onClick={(event) => {
								event.preventDefault();
								onOpenPreview(href);
							}}
							{...props}
						>
							{children}
						</a>
					);
				}
				return (
					<a href={href} target="_blank" rel="noreferrer" {...props}>
						{children}
					</a>
				);
			},
			code({ className, children, node: _node, ...props }) {
				const isBlock = Boolean(className) || String(children).includes("\n");
				if (isBlock) {
					return (
						<CodeBlock className={className} onRunInTerminal={onRunInTerminal}>
							{children}
						</CodeBlock>
					);
				}
				return (
					<code className={className} {...props}>
						{children}
					</code>
				);
			},
		}),
		[onOpenPreview, onRunInTerminal],
	);
	return (
		<div className="cl-markdown">
			<ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

function CopyTurnButton({ text }: { text: string }) {
	const [copied, setCopied] = useState<CopyState>("idle");
	if (!text.trim()) return null;
	return (
		<button
			type="button"
			className={`cc-meta-action ${copied === "done" ? "is-copied" : ""}`}
			onClick={() => {
				void copyText(text).then((ok) => {
					setCopied(ok ? "done" : "failed");
					setTimeout(() => setCopied("idle"), 1400);
				});
			}}
			title="复制回复 Markdown"
		>
			{copied === "done" ? <Check size={11} /> : <Copy size={11} />}
			<span role={copied === "failed" ? "alert" : undefined}>{copyLabel[copied]}</span>
		</button>
	);
}

const noticeStatusLabel: Record<string, string> = { completed: "已完成", failed: "失败", stopped: "已停止" };
const noticeStopLabel: Record<string, string> = { user_stop: "用户停止", restart: "应用重启" };
const checkStatusLabel: Record<VerificationCheck["status"], string> = {
	passed: "通过",
	failed: "未通过",
	pending: "未记录退出结果",
	stale: "早于后续改动",
	stopped: "已停止",
	timed_out: "已超时",
};

function CopyUserButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	if (!text.trim()) return null;
	return (
		<button
			type="button"
			className={copied ? "is-copied" : undefined}
			aria-label="复制提示词"
			title={copied ? "已复制" : "复制提示词"}
			onClick={() => {
				void copyText(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				});
			}}
		>
			{copied ? <Check size={12} /> : <Copy size={12} />}
		</button>
	);
}

function ThinkingBlock({ thinking, active }: { thinking: string; active: boolean }) {
	const [elapsedSec, setElapsedSec] = useState(0);
	useEffect(() => {
		if (!active) return;
		const start = Date.now();
		setElapsedSec(0);
		const timer = window.setInterval(() => {
			setElapsedSec(Math.max(1, Math.floor((Date.now() - start) / 1000)));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [active]);

	const lineCount = countLines(thinking);
	const latestPreview = useMemo(() => {
		if (!active) return "";
		const lines = thinking
			.split("\n")
			.map((line) => line.replace(/^[#>*`\-\s]+/, "").trim())
			.filter(Boolean);
		return (lines[lines.length - 1] ?? "").slice(0, 72);
	}, [active, thinking]);

	return (
		<AnimatedDetails
			className={`cl-think ${active ? "thinking-active" : ""}`}
			summary={
				<>
					<span className={`cc-think-glyph ${active ? "pulse" : ""}`}>∴</span>
					<span className="cc-think-label">
						{active ? `正在思考${elapsedSec > 0 ? ` ${elapsedSec}s` : ""}…` : `思考过程 · ${lineCount} 行`}
					</span>
					{active && latestPreview && <span className="cc-think-preview">{latestPreview}</span>}
					<ChevronRight size={12} className="cl-tool-chevron" />
				</>
			}
		>
			<div className="cl-markdown cc-think-body">
				<ReactMarkdown>{thinking}</ReactMarkdown>
			</div>
		</AnimatedDetails>
	);
}

/** Background sub-agent result delivered into this conversation; the report is untrusted Markdown. */
function TaskNotificationCard({ details, onOpenTask }: { details: unknown; onOpenTask?: (taskId: string) => void }) {
	const info = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
	const str = (value: unknown) => (typeof value === "string" ? value : undefined);
	const status = str(info.status) ?? "completed";
	const taskId = str(info.task_id);
	const description = str(info.description) ?? taskId ?? "子 Agent";
	const kind = str(info.executor) ?? str(info.subagent_type);
	const result = str(info.result) ?? "";
	const error = str(info.error);
	const duration = typeof info.duration_ms === "number" && Number.isFinite(info.duration_ms) ? info.duration_ms : undefined;
	const stopReason = str(info.stop_reason);
	const meta = [
		kind,
		duration !== undefined ? `耗时 ${duration >= 60000 ? `${Math.round(duration / 60000)} 分钟` : `${Math.max(1, Math.round(duration / 1000))} 秒`}` : undefined,
		info.partial === true ? "达到轮次上限，结果不完整" : undefined,
		info.truncated === true ? "结果已截断" : undefined,
		stopReason && noticeStopLabel[stopReason] ? noticeStopLabel[stopReason] : undefined,
		Array.isArray(info.flagged) && info.flagged.length ? "含疑似指令内容，已作为数据处理" : undefined,
	].filter(Boolean);
	return (
		<AnimatedDetails
			className="cl-tool done"
			summary={
				<>
					<span className={`cc-dot ${status === "completed" ? "ok" : status === "failed" ? "err" : ""}`} />
					<span className="cc-tool-head">
						<span className="cc-tool-verb">子 Agent</span>
						<span className="cl-tool-name cl-tool-name-free">{description}</span>
						<span className={`cc-task-notice-status ${status}`}>{noticeStatusLabel[status] ?? status}</span>
					</span>
					<ChevronRight size={13} className="cl-tool-chevron" />
				</>
			}
		>
			<div className="cl-tool-body">
				<div className="cc-summary-pad">
					{meta.length > 0 && <p className="cc-task-notice-meta">{meta.join(" · ")}</p>}
					{error && <p className="live-error">{error}</p>}
					{result ? <MarkdownContent text={result} /> : <p className="subtle-note">子 Agent 没有返回文本结果。</p>}
					{taskId && onOpenTask && (
						<button type="button" className="cc-mini-btn" onClick={() => onOpenTask(taskId)}>
							查看任务
						</button>
					)}
				</div>
			</div>
		</AnimatedDetails>
	);
}

export function TranscriptView({
	transcript: state,
	tasks = [],
	externalTasks = [],
	taskProgressMap = {},
	workflows = [],
	onOpenTask,
	onBackgroundTask,
	onStopTask,
	onStopWorkflow,
	onResumeWorkflow,
	onRewindPrompt,
	onForkPrompt,
	onEditPrompt,
	entryIds,
	assistantEntryIds,
	werewolfReviews,
	onReplayWerewolf,
	onConfrontWerewolf,
	openWerewolfId,
	onOpenWerewolfChange,
	checkpointIds,
	backgroundMonitors,
	approvalTool,
	onRerunCheck,
	onOpenPreview,
	onOpenFile,
	forceExpandAll = false,
	findAnchorKey,
}: {
	transcript: Transcript;
	tasks?: DesktopTask[];
	externalTasks?: ExternalTask[];
	taskProgressMap?: Record<string, TaskProgress>;
	/** Workflow runs of this conversation; a run is rendered at its WorkflowRun tool call. */
	workflows?: WorkflowRecord[];
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
	onStopWorkflow?: (workflowId: string) => void;
	onResumeWorkflow?: (workflowId: string) => void;
	onRewindPrompt?: (checkpointId: string) => void;
	onForkPrompt?: (entryId: string) => void;
	onEditPrompt?: (entryId: string) => void;
	entryIds?: Record<number, string>;
	assistantEntryIds?: Record<number, string>;
	werewolfReviews?: readonly WerewolfReview[];
	onReplayWerewolf?: ReplayWerewolfClaim;
	onConfrontWerewolf?: (prompt: string) => void;
	openWerewolfId?: string;
	onOpenWerewolfChange?: (id?: string) => void;
	checkpointIds?: Record<string, string>;
	backgroundMonitors?: readonly MonitorRecord[];
	approvalTool?: string;
	onRerunCheck?: (command: string) => void;
	onOpenPreview?: (url: string) => void;
	/** Opens a tool's file path in the configured external editor. */
	onOpenFile?: OpenFileHandler;
	forceExpandAll?: boolean;
	findAnchorKey?: string;
}) {
	const [lightbox, setLightbox] = useState<ImagePreview | null>(null);
	const [internalWerewolfId, setInternalWerewolfId] = useState<string>();
	const werewolfReportId = openWerewolfId !== undefined ? openWerewolfId : internalWerewolfId;
	const setWerewolfReportId = (next?: string) => {
		setInternalWerewolfId(next);
		onOpenWerewolfChange?.(next);
	};
	const werewolfReport = werewolfReviews?.find((review) => review.id === werewolfReportId);
	const [unitWindowLimit, setUnitWindowLimit] = useState(64);
	const scrollAnchorRef = useRef<{ el: HTMLElement; prevHeight: number; prevTop: number } | null>(null);
	useLayoutEffect(() => {
		const anchor = scrollAnchorRef.current;
		if (!anchor) return;
		scrollAnchorRef.current = null;
		const delta = anchor.el.scrollHeight - anchor.prevHeight;
		if (delta > 0) anchor.el.scrollTop = anchor.prevTop + delta;
	}, [unitWindowLimit]);
	const verificationEvidence = useMemo(() => collectVerificationEvidence(state.messages, backgroundMonitors), [state.messages, backgroundMonitors]);
	const messageIndices = new Map(state.messages.map((message, index) => [message, index]));
	const approvals = approvalTool ? Object.entries(state.tools)
		.filter(([, tool]) => tool.name === approvalTool && tool.status === "running") : [];
	const waitingToolId = approvals.length === 1 ? approvals[0][0] : undefined;
	const allUnits = useMemo(() => units(state.messages), [state.messages]);
	const unitKey = (unit: (typeof allUnits)[number], index: number) => {
		const message = unit.kind === "turn" ? unit.messages[0] : unit.message;
		return entryIds?.[messageIndices.get(message) ?? -1] ?? `${unit.kind}-${message.timestamp}-${index}`;
	};
	const anchorIndex = findAnchorKey ? allUnits.findIndex((unit, index) => unitKey(unit, index) === findAnchorKey) : -1;
	const defaultHiddenCount = Math.max(0, allUnits.length - unitWindowLimit);
	const hiddenCount = forceExpandAll ? 0 : anchorIndex < 0 ? defaultHiddenCount : Math.min(defaultHiddenCount, anchorIndex);
	const visibleUnits = hiddenCount > 0 ? allUnits.slice(hiddenCount) : allUnits;
	return (
		<div className="cl-transcript">
			{hiddenCount > 0 && (
				<div className="cc-older-turns-wrap">
					<button
						type="button"
						className="cc-mini-btn"
						onClick={(event) => {
							const scroller = event.currentTarget.closest<HTMLElement>(".cl-scroll");
							if (scroller) {
								scrollAnchorRef.current = {
									el: scroller,
									prevHeight: scroller.scrollHeight,
									prevTop: scroller.scrollTop,
								};
							}
							setUnitWindowLimit((prev) => prev + 64);
						}}
					>
						显示更早的 {hiddenCount} 条对话记录
					</button>
				</div>
			)}
			{visibleUnits.map((unit, relIdx) => {
				const index = hiddenCount + relIdx;
				if (unit.kind === "user") {
					const message = unit.message;
					if (message.role === "custom" && message.customType === "desktop_task_notification") {
						return <TaskNotificationCard key={`tasknote-${message.timestamp}-${index}`} details={message.details} onOpenTask={onOpenTask} />;
					}
					const customCardMeta: Record<string, { verb: string; label: string }> = {
						desktop_task_result: { verb: "Subagent", label: "(后台任务结果回传)" },
						desktop_monitor_event: { verb: "Monitor", label: "(后台监听事件)" },
						desktop_shell_event: { verb: "Bash", label: "(后台命令结束)" },
						desktop_cron_wakeup: { verb: "Schedule", label: "(定时唤醒提醒)" },
						desktop_team_message: { verb: "Team", label: "(团队协作消息)" },
						desktop_workflow_event: { verb: "Workflow", label: "(工作流事件)" },
						desktop_model_fallback: { verb: "Model", label: "(已切换到备用模型)" },
						desktop_model_escalation: { verb: "Escalate", label: "(验证受阻，已临时升档强模型诊断)" },
					};
					const cardMeta = message.role === "custom" ? customCardMeta[message.customType] : undefined;
					if (message.role === "custom" && cardMeta) {
						const text =
							typeof message.content === "string"
								? message.content
								: message.content
										.filter((b) => b.type === "text")
										.map((b) => b.text)
										.join("\n");
						return (
							<AnimatedDetails
								className="cl-tool done"
								key={`custom-${message.customType}-${message.timestamp}-${index}`}
								summary={
									<>
										<span className="cc-dot ok" />
										<span className="cc-tool-head">
											<span className="cc-tool-verb">{cardMeta.verb}</span>
											<span className="cl-tool-name cl-tool-name-free">{cardMeta.label}</span>
										</span>
										<ChevronRight size={13} className="cl-tool-chevron" />
									</>
								}
							>
								<div className="cl-tool-body">
									<div className="cc-summary-pad">
										<MarkdownContent text={text} />
									</div>
								</div>
							</AnimatedDetails>
						);
					}
					const entryId = entryIds?.[messageIndices.get(message) ?? -1];
					const checkpointId = entryId ? checkpointIds?.[entryId] : undefined;
					const plainUserText =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
									.filter((block, part) => !(message.role === "user" && part > 0 && isDesktopWorkspaceContext(block.text)))
									.map((block) => block.text)
									.join("\n");
					const editEntryId = message.role === "user" && onEditPrompt ? entryId : undefined;
					const hasUserActions = Boolean(plainUserText.trim() || editEntryId || (entryId && onForkPrompt) || (entryId && onRewindPrompt && checkpointId));
					return (
						<div className="cl-msg cl-msg-user" key={`user-${message.timestamp}-${index}`} data-transcript-unit={unitKey(unit, index)}>
							{hasUserActions && (
								<div className="cc-user-actions">
									<CopyUserButton text={plainUserText} />
									{editEntryId && (
										<button
											type="button"
											title="编辑并重新发送"
											aria-label="编辑并重新发送"
											onClick={() => onEditPrompt?.(editEntryId)}
										>
											<FilePen size={12} />
										</button>
									)}
									{entryId && onForkPrompt && (
										<button type="button" title="从此处分叉对话" aria-label="从此处分叉对话" onClick={() => onForkPrompt(entryId)}>
											<GitFork size={12} />
										</button>
									)}
									{entryId && onRewindPrompt && checkpointId && (
										<button type="button" title="回滚到此检查点" aria-label="回滚到此检查点" onClick={() => onRewindPrompt(checkpointId)}>
											<RotateCcw size={12} />
										</button>
									)}
								</div>
							)}
							<div className="cl-user-bubble">
								<span className="cc-prompt-chevron" aria-hidden="true">
									&gt;
								</span>
								<div className="cc-prompt-body">
									{typeof message.content === "string" ? (
										<p>{message.content}</p>
									) : (
										message.content.map((block, part) =>
											block.type === "text" ? (
												message.role === "user" && part > 0 && isDesktopWorkspaceContext(block.text) ? null : <p key={part}>{block.text}</p>
											) : (
												<ImageThumbnail
													key={part}
													alt="用户附件"
													previewLabel="用户附件预览"
													src={`data:${block.mimeType};base64,${block.data}`}
													onZoom={setLightbox}
												/>
											),
										)
									)}
								</div>
							</div>
						</div>
					);
				}
				if (unit.kind === "bash") {
					const message = unit.message;
					const ok = message.exitCode === 0;
					const lines = message.output ? message.output.trimEnd().split("\n") : [];
					const preview = lines[0]?.slice(0, 100) || "(No output)";
					return <InlineBashBlock key={`bash-${message.timestamp}-${index}`} command={message.command} output={message.output} exitCode={message.exitCode} truncated={message.truncated} fullOutputPath={message.fullOutputPath} ok={ok} preview={preview} />;
				}
				if (unit.kind === "summary") {
					const message = unit.message;
					return (
						<AnimatedDetails
							className="cl-tool done"
							key={`summary-${message.timestamp}-${index}`}
							summary={
								<>
									<span className="cc-dot ok" />
									{message.role === "compactionSummary" ? (
										<>
											<span className="cc-tool-verb">压缩</span>
											<span className="cl-tool-name cl-tool-name-free">上下文摘要 · 压缩前 {message.tokensBefore.toLocaleString()} tokens</span>
										</>
									) : (
										<span className="cl-tool-name cl-tool-name-free">分支摘要</span>
									)}
									<ChevronRight size={13} className="cl-tool-chevron" />
								</>
							}
						>
							<div className="cl-tool-body">
								<div className="cc-summary-pad">
									<MarkdownContent text={message.summary} />
								</div>
							</div>
						</AnimatedDetails>
					);
				}
				const last = unit.messages[unit.messages.length - 1];
				const firstIndex = messageIndices.get(unit.messages[0]) ?? -1;
				const lastIndex = messageIndices.get(last) ?? -1;
				const isStreaming = state.streamingIndex !== null && state.streamingIndex >= firstIndex && state.streamingIndex <= lastIndex;
				const werewolfReview = !isStreaming && werewolfReviews?.length
					? werewolfReviewForReply(werewolfReviews, last.timestamp, assistantEntryIds?.[lastIndex]) : undefined;
				const errorMessage = [...unit.messages].reverse().find((message) => message.errorMessage)?.errorMessage;
				const aborted = unit.messages.some((message) => message.stopReason === "aborted");
				const usage = last.usage;
				let end = lastIndex + 1;
				for (; end < state.messages.length; end++) {
					const message = state.messages[end];
					if (message.role === "assistant" || message.role === "user" || message.role === "branchSummary" ||
						message.role === "compactionSummary" || (message.role === "custom" && message.display)) break;
				}
				const verdict: QualityVerdict | null = isStreaming || firstIndex < 0 || last.stopReason === "toolUse"
					? null : scoreTurn(state.messages.slice(firstIndex, end), verificationEvidence);
				const turnText = unit.messages
					.flatMap((m) => m.content)
					.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n\n");
				const isLatestTurn = index === allUnits.findLastIndex((u) => u.kind === "turn");
				return (
					<article
						className="cl-msg cl-msg-ai"
						key={`turn-${last.timestamp}-${index}`}
						data-transcript-unit={unitKey(unit, index)}
						data-werewolf-review-id={werewolfReview?.id}
					>
						{groupTurnItems(
							unit.messages.flatMap((message, part) =>
								turnItems({
									message,
									state,
									isStreaming: isStreaming && part === unit.messages.length - 1,
									waitingToolId,
									tasks,
									externalTasks,
									taskProgressMap,
									workflows,
									onOpenTask,
									onBackgroundTask,
									onStopTask,
									onStopWorkflow,
									onResumeWorkflow,
									onOpenPreview,
									onRerunCheck,
									onOpenFile,
									onZoomImage: setLightbox,
								}),
							),
							state,
							isLatestTurn,
						)}
						{errorMessage && !aborted && (
							<div className="cl-msg-error" role="alert">
								<CircleAlert size={15} />
								<span>{errorMessage}</span>
							</div>
						)}
						{aborted && <p className="cl-stopped">本次回复已停止。</p>}
						{Boolean(verdict?.checks.length) && (
							<AnimatedDetails
								className="cc-turn-checks"
								summary={
									<>
										<span>{verdict!.checks.length} 项检查</span>
										<ChevronRight size={12} className="cl-tool-chevron" />
									</>
								}
							>
								<ul>
									{verdict!.checks.map((check) => (
										<li key={check.id}>
											<code>{check.command}</code>
											<span>{check.shellId && check.status === "pending" ? "等待后台退出结果" : checkStatusLabel[check.status]}{check.exitCode !== undefined ? ` · 退出码 ${check.exitCode}` : ""}</span>
											{onRerunCheck && <button type="button" className="cc-mini-btn" onClick={() => onRerunCheck(check.command)}>在终端重跑</button>}
										</li>
									))}
								</ul>
							</AnimatedDetails>
						)}
						{!isStreaming && werewolfReview?.status === "contradicted" && (
							<WerewolfCalloutStrip
								review={werewolfReview}
								onOpenReport={() => setWerewolfReportId(werewolfReview.id)}
								onConfront={onConfrontWerewolf}
							/>
						)}
						{!isStreaming && (last.model || werewolfReview) && (
							<footer className="cl-ai-meta">
								{last.model && <span>{last.model}</span>}
								{usage && (usage.input > 0 || usage.output > 0) && (
									<span>
										{formatTokens(usage.input)} in · {formatTokens(usage.output)} out
										{usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : ""}
									</span>
								)}
								<span>{formatTime(last.timestamp)}</span>
								{verdict && verdict.omen !== "none" && (
									<span className={`cc-omen cc-omen-${verdict.omen}`} title={`${verdict.label}：${verdict.reason}`} tabIndex={0} role="img" aria-label={`${verdict.label}：${verdict.reason}`}>
										<OmenGlyph omen={verdict.omen} width={13} height={13} />
										<span className="cc-omen-label">{verdict.label}</span>
									</span>
								)}
								{werewolfReview && <WerewolfBadge review={werewolfReview} onOpen={() => setWerewolfReportId(werewolfReview.id)} />}
								<CopyTurnButton text={turnText} />
							</footer>
						)}
					</article>
				);
			})}
			{werewolfReport && (
				<WerewolfReportDialog
					key={werewolfReport.id}
					review={werewolfReport}
					onReplay={onReplayWerewolf}
					onConfront={onConfrontWerewolf}
					onOpenCheckpoint={onRewindPrompt}
					onOpenFile={onOpenFile}
					close={() => setWerewolfReportId(undefined)}
				/>
			)}
			{lightbox && (
				<Modal title={lightbox.alt} className="cc-image-preview-modal" close={() => setLightbox(null)}>
					<div className="cc-image-preview-stage">
						<img src={lightbox.src} alt={lightbox.alt} />
					</div>
				</Modal>
			)}
		</div>
	);
}

type TurnBlock = Assistant["content"][number];
type TurnItem = { key: string; block: TurnBlock; node: ReactNode; live?: boolean };

/** Builds one renderable item per content block of an assistant message; grouping happens per turn. */
function turnItems({
	message,
	state,
	isStreaming,
	waitingToolId,
	tasks,
	externalTasks,
	taskProgressMap,
	workflows,
	onOpenTask,
	onBackgroundTask,
	onStopTask,
	onStopWorkflow,
	onResumeWorkflow,
	onOpenPreview,
	onRerunCheck,
	onOpenFile,
	onZoomImage,
}: {
	message: Assistant;
	state: Transcript;
	isStreaming: boolean;
	waitingToolId?: string;
	tasks: DesktopTask[];
	externalTasks: ExternalTask[];
	taskProgressMap: Record<string, TaskProgress>;
	workflows: WorkflowRecord[];
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
	onStopWorkflow?: (workflowId: string) => void;
	onResumeWorkflow?: (workflowId: string) => void;
	onOpenPreview?: (url: string) => void;
	onRerunCheck?: (command: string) => void;
	onOpenFile?: OpenFileHandler;
	onZoomImage?: (image: ImagePreview) => void;
}): TurnItem[] {
	const items: TurnItem[] = [];
	// Consecutive Agent calls of one message render as one block, like a parallel fan-out in Claude Code.
	let agentBlock: { item: TurnItem; calls: AgentCall[] } | undefined;
	const renderAgentBlock = (calls: AgentCall[]) => (
		<AgentRows key={calls[0].id} calls={calls} onOpenTask={onOpenTask} onBackgroundTask={onBackgroundTask} onStopTask={onStopTask} />
	);
	message.content.forEach((block, part) => {
		const key = `${message.timestamp}-${part}`;
		if (block.type === "toolCall" && block.name === "Agent") {
			const result = state.messages.find(
				(item): item is Extract<Message, { role: "toolResult" }> => item.role === "toolResult" && item.toolCallId === block.id,
			);
			const task =
				tasks.find((t) => t.parentToolCallId === block.id || t.turnCalls?.includes(block.id)) ??
				externalTasks.find((t) => t.parentToolCallId === block.id);
			const call: AgentCall = {
				id: block.id,
				args: block.arguments,
				progress: state.tools[block.id],
				result,
				task,
				taskProgress: task ? taskProgressMap[task.id] : undefined,
				waitingForApproval: block.id === waitingToolId,
				// A call from a finished message with no result, task or live progress was cut off.
				orphaned: !isStreaming && !result && !task && !state.tools[block.id],
			};
			if (agentBlock) {
				agentBlock.calls.push(call);
				agentBlock.item.node = renderAgentBlock(agentBlock.calls);
			} else {
				agentBlock = { item: { key: block.id, block, node: renderAgentBlock([call]) }, calls: [call] };
				items.push(agentBlock.item);
			}
			return;
		}
		if (block.type === "toolCall" && block.name === "WorkflowRun") {
			const match = workflows.find((wf) => wf.toolCallId === block.id);
			if (match) {
				agentBlock = undefined;
				items.push({
					key: block.id,
					block,
					node: (
						<WorkflowTree
							key={block.id}
							record={match}
							onOpenTask={onOpenTask}
							onStop={onStopWorkflow}
							onResume={onResumeWorkflow}
						/>
					),
				});
				return;
			}
		}
		// Text or thinking between two Agent calls still ends the block; empty text does not.
		const invisible = (block.type === "text" && !block.text.trim()) || (block.type === "thinking" && !block.thinking);
		if (!invisible) agentBlock = undefined;
		if (block.type === "text") {
			if (!block.text.trim()) return;
			const activeStreamText = isStreaming && part === message.content.length - 1;
			items.push({
				key,
				block,
				node: (
					<div className={`cc-ai-text ${activeStreamText ? "is-streaming" : ""}`.trim()} key={key}>
						<span className="cc-ai-bullet" aria-hidden="true" />
						<div className="cc-ai-text-inner">
							<MarkdownContent text={block.text} onOpenPreview={onOpenPreview} onRunInTerminal={onRerunCheck} />
						</div>
					</div>
				),
			});
			return;
		}
		if (block.type === "thinking") {
			if (!block.thinking) return;
			const activeThink = isStreaming && part === message.content.length - 1;
			items.push({
				key,
				block,
				live: activeThink,
				node: <ThinkingBlock key={key} thinking={block.thinking} active={activeThink} />,
			});
			return;
		}
		if (block.type !== "toolCall") return;
		const result = state.messages.find(
			(item): item is Extract<Message, { role: "toolResult" }> => item.role === "toolResult" && item.toolCallId === block.id,
		);
		const progress = state.tools[block.id];
		const matchedTask =
			tasks.find((t) => t.parentToolCallId === block.id || t.turnCalls?.includes(block.id)) ??
			externalTasks.find((t) => t.parentToolCallId === block.id);
		items.push({
			key: block.id,
			block,
			node: (
				<ToolCard
					key={block.id}
					name={block.name}
					args={block.arguments}
					progress={progress}
					waitingForApproval={block.id === waitingToolId}
					result={result}
					matchedTask={matchedTask}
					taskProgress={matchedTask ? taskProgressMap[matchedTask.id] : undefined}
					onOpenTask={onOpenTask}
					onBackgroundTask={onBackgroundTask}
					onStopTask={onStopTask}
					onOpenFile={onOpenFile}
					onZoomImage={onZoomImage}
				/>
			),
		});
	});
	return items;
}

/** Tools whose calls fold into a summary row instead of listing raw commands, like Claude. */
const GROUP_KIND: Record<string, "bash" | "read" | "search" | "edit" | "web"> = {
	bash: "bash",
	read: "read",
	grep: "search",
	find: "search",
	ls: "search",
	write: "edit",
	edit: "edit",
	NotebookEdit: "edit",
	WebFetch: "web",
	WebSearch: "web",
};

type EditSpotlight = {
	id: string;
	target: string;
} & (
	| { kind: "edit"; diffStat?: LineChangeCounts; editPairs: { oldText: string; newText: string }[] }
	| { kind: "write"; content: string; writtenLines: number }
);

/** Folds every run of work steps (tool calls plus the thinking between them) in a turn into one ToolGroup. */
function groupTurnItems(items: TurnItem[], state: Transcript, isLatestTurn = false): ReactNode[] {
	const entries: Array<
		| { kind: "node"; node: ReactNode }
		| {
				kind: "group";
				key: string;
				summary: string;
				running: boolean;
				failed: boolean;
				live: ReactNode[];
				editSpotlights: EditSpotlight[];
				children: ReactNode[];
		  }
	> = [];
	let run: TurnItem[] = [];
	const flush = () => {
		const tools = run.filter((item) => item.block.type === "toolCall");
		if (!tools.length) {
			for (const item of run) entries.push({ kind: "node", node: item.node });
			run = [];
			return;
		}
		const counts = { bash: 0, read: 0, search: 0, edit: 0, web: 0 };
		let running = false;
		let failed = false;
		const live: ReactNode[] = [];
		const editSpotlights: EditSpotlight[] = [];
		for (const item of run) {
			const b = item.block;
			if (b.type !== "toolCall") {
				if (item.live) live.push(item.node);
				continue;
			}
			counts[GROUP_KIND[b.name]]++;
			const res = state.messages.find(
				(m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult" && m.toolCallId === b.id,
			);
			const isRunning = !res && (state.tools[b.id]?.status ?? "running") === "running";
			if (res) {
				if (res.isError) failed = true;
			} else if (isRunning) {
				running = true;
				live.push(item.node);
			}
			const succeeded = res ? !res.isError : state.tools[b.id]?.status === "done";
			if (succeeded && (b.name === "edit" || b.name === "write")) {
				const a = asRecord(b.arguments);
				const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "文件";
				if (b.name === "edit") {
					const editPairs = extractEditPairs(a);
					if (editPairs.length) {
						editSpotlights.push({
							kind: "edit",
							id: b.id,
							target: path,
							diffStat: summarizeLineChanges(editPairs),
							editPairs,
						});
					}
				} else if (typeof a.content === "string") {
					editSpotlights.push({
						kind: "write",
						id: b.id,
						target: path,
						content: a.content,
						writtenLines: a.content ? countLines(a.content) : 0,
					});
				}
			}
		}
		const only = tools.length === 1 ? tools[0].block : undefined;
		const description =
			only?.type === "toolCall" && only.name === "bash" ? asRecord(only.arguments).description : undefined;
		const parts: string[] = [];
		if (counts.bash) parts.push(`运行 ${counts.bash} 条命令`);
		if (counts.read) parts.push(`读取 ${counts.read} 个文件`);
		if (counts.search) parts.push(`搜索 ${counts.search} 次`);
		if (counts.edit) parts.push(`编辑 ${counts.edit} 个文件`);
		if (counts.web) parts.push(`查阅 ${counts.web} 个网页`);
		const summary = typeof description === "string" && description.trim() ? description.trim() : parts.join("，");
		entries.push({
			kind: "group",
			key: `group-${run[0].key}`,
			summary,
			running,
			failed,
			live,
			editSpotlights,
			children: run.map((item) => item.node),
		});
		run = [];
	};
	for (const item of items) {
		const b = item.block;
		if (b.type === "thinking" || (b.type === "toolCall" && GROUP_KIND[b.name] !== undefined)) {
			run.push(item);
		} else {
			flush();
			entries.push({ kind: "node", node: item.node });
		}
	}
	flush();
	const lastEditGroupIdx = isLatestTurn
		? entries.findLastIndex((e) => e.kind === "group" && e.editSpotlights.length > 0)
		: -1;
	return entries.map((entry, idx) =>
		entry.kind === "node" ? (
			entry.node
		) : (
			<ToolGroup
				key={entry.key}
				summary={entry.summary}
				running={entry.running}
				failed={entry.failed}
				live={entry.live}
				editSpotlights={entry.editSpotlights}
				autoExpandLastEdit={idx === lastEditGroupIdx}
			>
				{entry.children}
			</ToolGroup>
		),
	);
}

function EditSpotlightRow({ item, defaultOpen = false }: { item: EditSpotlight; defaultOpen?: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const baseName = item.target.split("/").pop() || item.target;
	const dirPrefix = item.target.includes("/") ? item.target.slice(0, item.target.lastIndexOf("/") + 1) : "";
	return (
		<div className={`cc-edit-spotlight ${open ? "is-open" : ""}`}>
			<button type="button" className="cc-edit-spotlight-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
				<span className="cc-edit-spotlight-icon" aria-hidden="true">
					<FilePen size={11.5} />
				</span>
				<span className="cc-edit-spotlight-verb">{item.kind === "write" ? "已写入" : "已更新"}</span>
				<span className="cc-edit-spotlight-path" title={item.target}>
					{dirPrefix && <em className="cc-file-dir">{dirPrefix}</em>}
					<strong>{baseName}</strong>
				</span>
				{item.kind === "write" ? (
					<span className="cc-tool-badge">{item.writtenLines} 行</span>
				) : item.diffStat ? (
					<span className="cc-tool-diff-stat" aria-label={`新增 ${item.diffStat.additions} 行，移除 ${item.diffStat.removals} 行`}>
						{item.diffStat.additions > 0 && <span className="add">+{item.diffStat.additions}</span>}
						{item.diffStat.removals > 0 && <span className="del">-{item.diffStat.removals}</span>}
					</span>
				) : (
					<span className="cc-tool-badge">差异预览</span>
				)}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<SmoothCollapse open={open}>
				<div className="cc-edit-spotlight-diff">
					{item.kind === "edit" ? (
						item.editPairs.map((pair, idx) => (
							<div key={idx} className={idx > 0 ? "cc-edit-hunk-sep" : undefined}>
								<InlineEditDiff oldText={pair.oldText} newText={pair.newText} filePath={item.target} />
							</div>
						))
					) : item.content ? (
						<CodeLines content={item.content.split("\n").slice(0, 40).join("\n")} lang={inferLangFromPath(item.target)} />
					) : (
						<span className="cc-tool-badge">空文件</span>
					)}
				</div>
			</SmoothCollapse>
		</div>
	);
}

/** One summary row for a run of work steps. Collapsed by default; live steps and file-edit spotlights surface cleanly underneath. */
function ToolGroup({
	summary,
	running,
	failed,
	live,
	editSpotlights,
	autoExpandLastEdit = false,
	children,
}: {
	summary: string;
	running: boolean;
	failed: boolean;
	live: ReactNode[];
	editSpotlights: EditSpotlight[];
	autoExpandLastEdit?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const completeCounts = editSpotlights.every((item) => item.kind === "edit" && item.diffStat !== undefined);
	const totalAdd = editSpotlights.reduce((sum, item) => sum + (item.kind === "edit" ? item.diffStat?.additions ?? 0 : 0), 0);
	const totalDel = editSpotlights.reduce((sum, item) => sum + (item.kind === "edit" ? item.diffStat?.removals ?? 0 : 0), 0);
	return (
		<div className={`cl-tool-group ${running ? "running" : failed ? "error" : "done"} ${open ? "is-open" : ""}`}>
			<button type="button" className="cc-tool-row cc-tool-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
				<span className={`cc-dot ${running ? "run" : failed ? "err" : "ok"}`} />
				<span className="cc-tool-head">
					<span className="cc-tool-verb cc-tool-group-summary">{summary}{failed && <span className="cc-tool-error-label"> · 有失败步骤</span>}</span>
				</span>
				{!open && completeCounts && (totalAdd > 0 || totalDel > 0) && (
					<span className="cc-tool-diff-stat">
						{totalAdd > 0 && <span className="add">+{totalAdd}</span>}
						{totalDel > 0 && <span className="del">-{totalDel}</span>}
					</span>
				)}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<SmoothCollapse open={open}>
				<div className="cc-tool-group-body">{children}</div>
			</SmoothCollapse>
			{!open && (live.length > 0 || editSpotlights.length > 0) && (
				<div className="cc-tool-group-body">
					{editSpotlights.map((item, idx) => (
						<EditSpotlightRow
							key={item.id}
							item={item}
							defaultOpen={autoExpandLastEdit && idx === editSpotlights.length - 1}
						/>
					))}
					{live}
				</div>
			)}
		</div>
	);
}

interface ToolPresentation {
	verb: string;
	target: string;
	badge?: string;
	diffStat?: { additions: number; removals: number };
	treeSummary?: string;
	editPairs?: { oldText: string; newText: string }[];
	lineContent?: { content: string; startLine?: number };
	todos?: TodoItem[];
}

function toolGlyph(name: string): ReactNode {
	if (name === "read") return <FileText size={11.5} />;
	if (name === "edit" || name === "write" || name === "NotebookEdit") return <FilePen size={11.5} />;
	if (name === "bash") return <TerminalIcon size={11.5} />;
	if (name === "grep" || name === "find" || name === "ls") return <Search size={11.5} />;
	if (name === "WebFetch" || name === "WebSearch") return <Globe size={11.5} />;
	if (name === "TodoWrite" || name.startsWith("Todo")) return <ListChecks size={11.5} />;
	if (name === "Agent" || name === "AgentSend" || name === "SendMessage") return <Bot size={11.5} />;
	return <Sparkles size={11.5} />;
}

function asRecord(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractEditPairs(a: Record<string, unknown>): { oldText: string; newText: string }[] {
	if (Array.isArray(a.edits)) {
		const pairs: { oldText: string; newText: string }[] = [];
		for (const item of a.edits) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			const oldText = typeof rec.oldText === "string" ? rec.oldText : typeof rec.old_string === "string" ? rec.old_string : undefined;
			const newText = typeof rec.newText === "string" ? rec.newText : typeof rec.new_string === "string" ? rec.new_string : undefined;
			if (oldText !== undefined && newText !== undefined) pairs.push({ oldText, newText });
		}
		if (pairs.length) return pairs;
	}
	const oldText = typeof a.oldText === "string" ? a.oldText : typeof a.old_string === "string" ? a.old_string : undefined;
	const newText = typeof a.newText === "string" ? a.newText : typeof a.new_string === "string" ? a.new_string : undefined;
	if (oldText !== undefined && newText !== undefined) return [{ oldText, newText }];
	return [];
}

function summarizeDesktopJson(output: string | undefined, fallback: string): string {
	if (!output?.trim()) return fallback;
	try {
		const data = JSON.parse(output) as Record<string, unknown>;
		if (data && typeof data === "object") {
			if (typeof data.output === "string" && data.output.trim()) {
				return `${data.status ? `${String(data.status)} · ` : ""}${data.output.trim().split("\n")[0].slice(0, 90)}`;
			}
			if (typeof data.status === "string") {
				const extra = typeof data.worktree_id === "string" ? ` (${data.worktree_id})` : "";
				return `${data.status}${extra}`;
			}
			if (Array.isArray(data.tasks)) return `${data.tasks.length} tasks`;
			if (Array.isArray(data.worktrees)) return `${data.worktrees.length} worktrees`;
		}
	} catch {
		/* non-JSON text output */
	}
	return output.trim().split("\n")[0].slice(0, 110);
}

export type OpenFileHandler = (path: string, line?: number) => void;

/** File path (and starting line, when the input carries one) of read/edit/write tool calls. */
export function toolFileTarget(name: string, args: unknown): { path: string; line?: number } | undefined {
	if (name !== "read" && name !== "edit" && name !== "write") return undefined;
	const a = asRecord(args);
	const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
	if (!path.trim()) return undefined;
	const raw = name === "read" ? (a.offset ?? a.line) : a.line;
	const line = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
	return { path: path.trim(), ...(line ? { line } : {}) };
}

function presentTool(name: string, args: unknown, output: string | undefined, status: string): ToolPresentation {
	const a = asRecord(args);
	const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
	const lineCount = output ? countLines(output) : 0;

	if (name === "read") {
		const offset = typeof a.offset === "number" ? a.offset : 1;
		return {
			verb: "读取",
			target: path || "文件",
			badge: status === "done" && output ? `${lineCount} 行` : undefined,
			treeSummary:
				status === "running"
					? "正在读取文件…"
					: status === "error"
						? output?.split("\n")[0] || "读取失败"
						: `已读取 ${lineCount} 行${offset > 1 ? `（第 ${offset} 行起）` : ""}`,
			lineContent: output ? { content: output, startLine: offset } : undefined,
		};
	}

	if (name === "edit") {
		const editPairs = extractEditPairs(a);
		if (editPairs.length) {
			const diffStat = status === "done" ? summarizeLineChanges(editPairs) : undefined;
			const pathLabel = path || "文件";
			return {
				verb: "更新",
				target: pathLabel,
				diffStat,
				treeSummary:
					status === "error"
						? output?.split("\n")[0] || "编辑失败"
						: status === "running"
							? "正在编辑…"
							: diffStat
								? `已更新 ${pathLabel}（新增 ${diffStat.additions} 行，移除 ${diffStat.removals} 行）`
								: `已更新 ${pathLabel}`,
				editPairs,
			};
		}
		return {
			verb: "更新",
			target: path || "文件",
			treeSummary: output?.split("\n")[0] || (status === "running" ? "正在编辑…" : "已更新"),
		};
	}

	if (name === "write") {
		const content = typeof a.content === "string" ? a.content : "";
		const wroteLines = content ? countLines(content) : 0;
		return {
			verb: "写入",
			target: path || "文件",
			badge: wroteLines && status !== "error" ? `${wroteLines} 行` : undefined,
			treeSummary:
				status === "running"
					? "正在写入文件…"
					: status === "error"
						? output?.split("\n")[0] || "写入失败"
						: `已写入 ${wroteLines} 行至 ${path || "文件"}`,
			lineContent: content ? { content, startLine: 1 } : undefined,
		};
	}

	if (name === "bash") {
		const cmd = typeof a.command === "string" ? a.command.split("\n")[0].slice(0, 120) : "命令";
		const firstLine = output?.trim() ? output.trim().split("\n")[0].slice(0, 110) : status === "running" ? "正在执行…" : "无输出";
		return {
			verb: "命令",
			target: cmd,
			badge: status === "error" ? "失败" : status === "done" ? (a.run_in_background === true ? "后台运行" : "完成") : undefined,
			treeSummary: firstLine,
		};
	}

	if (name === "grep" || name === "find" || name === "ls") {
		const verb = name === "grep" ? "搜索内容" : name === "find" ? "查找文件" : "列出目录";
		const target =
			typeof a.pattern === "string"
				? a.pattern
				: typeof a.query === "string"
					? a.query
					: path || ".";
		const count = output?.trim() ? output.trim().split("\n").length : 0;
		return {
			verb,
			target,
			badge: status === "done" ? `${count} 项` : undefined,
			treeSummary: status === "running" ? "正在检索…" : `匹配到 ${count} 条结果`,
		};
	}

	if (name === "TodoWrite") {
		const rawTodos = Array.isArray(a.todos) ? (a.todos as TodoItem[]) : [];
		const doneCount = rawTodos.filter((t) => t.status === "completed").length;
		const inProgress = rawTodos.find((t) => t.status === "in_progress");
		return {
			verb: "任务清单",
			target: `已完成 ${doneCount}/${rawTodos.length}`,
			badge: inProgress ? "进行中" : "已更新",
			treeSummary: inProgress ? `正在进行：${inProgress.content}` : `已更新 ${rawTodos.length} 项任务清单`,
			todos: rawTodos,
		};
	}

	if (name === "WebFetch") {
		const rawUrl = typeof a.url === "string" ? a.url : "";
		return {
			verb: "网页抓取",
			target: rawUrl,
			badge: status === "done" && output ? `${output.length} 字符` : status,
			treeSummary: status === "running" ? "正在抓取网页内容…" : output?.trim().split("\n")[0].slice(0, 110) || "已读取",
		};
	}

	if (name === "AskUserQuestion") {
		const qs = Array.isArray(a.questions) ? (a.questions as Array<{ header?: string; question?: string }>) : [];
		return {
			verb: "AskUser",
			target: qs[0]?.header || qs[0]?.question || "结构化确认提问",
			badge: `${qs.length || 1} 题`,
			treeSummary: summarizeDesktopJson(output, status === "running" ? "等待用户选择…" : "已提交回答"),
		};
	}

	if (name === "ExitPlanMode") {
		return {
			verb: "ExitPlan",
			target: typeof a.title === "string" && a.title ? a.title : ".pi/plans/",
			badge: status === "done" ? "plan ready" : status,
			treeSummary: summarizeDesktopJson(output, "已保存计划文件，等待批准实施"),
		};
	}

	if (name === "NotebookEdit") {
		const nbPath = typeof a.notebook_path === "string" ? a.notebook_path : "notebook.ipynb";
		return {
			verb: "Notebook",
			target: nbPath,
			badge: typeof a.edit_mode === "string" ? a.edit_mode : "replace",
			treeSummary: output?.trim().split("\n")[0].slice(0, 110) || "已更新 Notebook 单元格",
		};
	}

	if (name === "SendMessage" || (name === "AgentSend" && typeof a.task_id === "string")) {
		const to = typeof a.to === "string" ? a.to : typeof a.task_id === "string" ? a.task_id : "";
		const summary = typeof a.summary === "string" && a.summary ? a.summary : undefined;
		return {
			verb: "SendMessage",
			target: summary ? `${to} · ${summary}` : to,
			badge: status,
			treeSummary: output?.startsWith("Message delivered to the running agent")
				? "消息已送达运行中的子 Agent"
				: output?.startsWith("Agent resumed in the background")
					? "子 Agent 已在后台继续，完成后结果自动回传"
					: summarizeDesktopJson(output, status === "running" ? "子 Agent 继续执行中…" : "已完成"),
		};
	}

	if (name === "Agent" || name === "AgentSend") {
		const subType = typeof a.subagent_type === "string" ? a.subagent_type : "general-purpose";
		const desc = typeof a.description === "string" ? a.description : typeof a.task_id === "string" ? a.task_id : "Subagent task";
		const executor = typeof a.executor === "string" ? a.executor : undefined;
		return {
			verb: name === "AgentSend" ? "AgentSend" : `Agent(${subType})`,
			target: desc,
			badge: executor ? `${executor} · ${status}` : status,
			treeSummary: output?.startsWith("Async agent launched")
				? "已在后台启动，完成后结果自动回传"
				: summarizeDesktopJson(output, status === "running" ? "子任务执行中…" : "已完成"),
		};
	}

	if (name.startsWith("Task") || name.startsWith("Worktree") || name === "AgentExecutors") {
		return {
			verb: name,
			target: typeof a.task_id === "string" ? a.task_id : typeof a.worktree_id === "string" ? a.worktree_id : "",
			badge: status === "done" ? "done" : status,
			treeSummary: summarizeDesktopJson(output, status === "running" ? "执行中…" : "已完成"),
		};
	}

	// MCP or other tools
	const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
	if (mcpMatch) {
		return {
			verb: mcpMatch[1],
			target: mcpMatch[2],
			treeSummary: output?.trim() ? output.trim().split("\n")[0].slice(0, 110) : undefined,
		};
	}

	return {
		verb: name,
		target: path || (typeof a.task_id === "string" ? a.task_id : ""),
		treeSummary: output?.trim() ? output.trim().split("\n")[0].slice(0, 110) : undefined,
	};
}

function InlineBashBlock({
	command,
	output,
	exitCode,
	truncated,
	fullOutputPath,
	ok,
	preview,
}: {
	command: string;
	output: string;
	exitCode?: number | null;
	truncated?: boolean;
	fullOutputPath?: string;
	ok: boolean;
	preview: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`cl-tool ${ok ? "done" : "error"} ${open ? "is-open" : ""}`}>
			<button type="button" className="cc-tool-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
				<span className="cc-tool-icon" aria-hidden="true"><TerminalIcon size={11.5} /></span>
				<span className="cc-tool-head">
					<span className="cc-tool-verb">命令</span>
					<span className="cl-tool-name">{command}</span>
				</span>
				<span className={`cc-tool-badge ${ok ? "" : "err"}`}>退出码 {exitCode ?? "?"}</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<div className="cc-tree-summary">
				<span className="cc-tree-arm">⎿</span>
				<span className="cc-tree-text">{preview}</span>
			</div>
			<SmoothCollapse open={open}>
				<div className="cl-tool-body">
					<pre className="cc-bash-out">{`$ ${command}\n${output || "(无输出)"}`}</pre>
					{truncated && <p className="cl-truncated">输出已截断，完整输出：{fullOutputPath}</p>}
				</div>
			</SmoothCollapse>
		</div>
	);
}

function formatTaskStatusBadge(status: DesktopTask["status"]): string {
	switch (status) {
		case "queued":
			return "排队中";
		case "running":
			return "运行中";
		case "waiting_for_input":
			return "待确认";
		case "completed":
			return "已完成";
		case "failed":
			return "失败";
		case "cancelled":
			return "已取消";
		case "interrupted":
			return "已中断";
	}
}

function formatMatchedTaskSummary(task: DesktopTask | ExternalTask, taskProgress?: TaskProgress): string {
	const active = task.status === "queued" || task.status === "running" || task.status === "waiting_for_input";
	if (active) {
		if (taskProgress) return formatTaskProgressSummary(taskProgress);
		return `${formatTaskStatusBadge(task.status)} · ${task.workingDirectory}`;
	}
	if ("executor" in task) {
		return `${task.executor} · ${formatTaskStatusBadge(task.status)} · ${formatCompactDuration(Math.max(0, task.updatedAt - task.createdAt))}`;
	}
	const parts: string[] = [];
	const model = task.stats?.model?.id ?? task.model?.id;
	if (model) parts.push(model);
	if (task.stats?.tokens.total) parts.push(`${formatCompactTokens(task.stats.tokens.total)} tokens`);
	if (task.stats?.toolUses) parts.push(`${task.stats.toolUses} 次工具`);
	if (task.stats?.durationMs !== undefined) parts.push(formatCompactDuration(task.stats.durationMs));
	else parts.push(formatCompactDuration(Math.max(0, task.updatedAt - task.createdAt)));
	if (task.stopReason && task.stopReason !== "model_stop") {
		const stopMap: Record<Exclude<NonNullable<DesktopTask["stopReason"]>, "model_stop">, string> = {
			max_turns: "达轮次上限",
			user_stop: "已手动停止",
			parent_abort: "主会话中止",
			restart: "重启中断",
			error: "执行出错",
		};
		parts.push(stopMap[task.stopReason]);
	}
	return parts.length ? parts.join(" · ") : `${formatTaskStatusBadge(task.status)} · ${task.workingDirectory}`;
}

function ToolCard({
	name,
	args,
	progress,
	waitingForApproval,
	result,
	matchedTask,
	taskProgress,
	onOpenTask,
	onBackgroundTask,
	onStopTask,
	onOpenFile,
	onZoomImage,
}: {
	name: string;
	args: unknown;
	progress?: ToolProgress;
	waitingForApproval?: boolean;
	result?: Extract<Message, { role: "toolResult" }>;
	matchedTask?: DesktopTask | ExternalTask;
	taskProgress?: TaskProgress;
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
	onOpenFile?: OpenFileHandler;
	onZoomImage?: (image: ImagePreview) => void;
}) {
	const archivedOutput = toolOutputReference(result?.details);
	const output = result
		? result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		: progress?.output;
	const images = result
		? result.content.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image")
		: [];
	const status = result ? (result.isError ? "error" : "done") : (progress?.status ?? "running");
	const info = presentTool(name, args, output, status);
	const matchedActive = matchedTask ? ["queued", "running", "waiting_for_input"].includes(matchedTask.status) : false;
	const matchedKind: "pi" | "external" = matchedTask && "executor" in matchedTask ? "external" : "pi";
	const canBackground =
		Boolean(matchedTask) &&
		matchedActive &&
		matchedKind === "pi" &&
		!(matchedTask as DesktopTask).runInBackground &&
		Boolean((matchedTask as DesktopTask).readOnly || (matchedTask as DesktopTask).worktreeId);
	const effectiveStatus = matchedTask
		? matchedTask.status === "failed" || matchedTask.status === "cancelled" || matchedTask.status === "interrupted"
			? "error"
			: matchedTask.status === "completed"
				? "done"
				: "running"
		: status;
	const dotClass = effectiveStatus === "error" ? "err" : effectiveStatus === "done" ? "ok" : "run";
	const [open, setOpen] = useState<boolean>();
	const hasInlineBody = Boolean((info.editPairs && info.editPairs.length > 0) || (info.todos && info.todos.length > 0));
	const isOpen = open ?? ((status === "running" && !waitingForApproval) || (!waitingForApproval && hasInlineBody));
	const showLiveTimer = effectiveStatus === "running" && !waitingForApproval && !matchedTask && typeof progress?.startedAt === "number";
	const [tickNow, setTickNow] = useState(() => Date.now());
	useEffect(() => {
		if (!showLiveTimer) return;
		setTickNow(Date.now());
		const timer = setInterval(() => setTickNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [showLiveTimer]);
	const timeoutSeconds =
		args && typeof args === "object" && typeof (args as { timeout?: unknown }).timeout === "number"
			? (args as { timeout: number }).timeout
			: undefined;
	const liveTimerLabel = showLiveTimer ? formatRunningToolTimer(progress?.startedAt, timeoutSeconds, tickNow) : undefined;
	const fileTarget = onOpenFile ? toolFileTarget(name, args) : undefined;
	const summaryLine = waitingForApproval ? undefined : matchedTask
		? formatMatchedTaskSummary(matchedTask, taskProgress)
		: status === "running" && (name === "Agent" || name === "SendMessage") && progress?.output
			? progress.output
			: info.treeSummary;

	return (
		<div className={`cl-tool ${effectiveStatus} ${isOpen ? "is-open" : ""} ${fileTarget && onOpenFile ? "has-open-editor" : ""}`}>
			<button type="button" className="cc-tool-row" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
				{effectiveStatus === "running" ? (
					<span className={`cc-dot ${dotClass}`} />
				) : (
					<span className="cc-tool-icon" aria-hidden="true">{toolGlyph(name)}</span>
				)}
				<span className="cc-tool-head">
					<span className="cc-tool-verb">{info.verb}</span>
					{info.target && <span className="cl-tool-name">{info.target}</span>}
				</span>
				{matchedTask && (
					<span className="cc-tool-badge">
						{"executor" in matchedTask ? matchedTask.executor : "子任务"} · {formatTaskStatusBadge(matchedTask.status)}
					</span>
				)}
				{liveTimerLabel && <span className="cc-tool-badge cc-eta-pill">{liveTimerLabel}</span>}
				{waitingForApproval && <span className="cc-tool-badge cc-tool-awaiting">待确认</span>}
				{!waitingForApproval && !matchedTask && !liveTimerLabel && info.diffStat && (
					<span className="cc-tool-diff-stat">
						<span className="add">+{info.diffStat.additions}</span>
						<span className="del">−{info.diffStat.removals}</span>
					</span>
				)}
				{!waitingForApproval && !matchedTask && !liveTimerLabel && !info.diffStat && info.badge && (
					<span className={`cc-tool-badge ${status === "error" ? "err" : ""}`}>{info.badge}</span>
				)}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			{fileTarget && onOpenFile && (
				<button
					type="button"
					className="cc-open-editor-btn cc-tool-open-editor"
					title={`在编辑器中打开${fileTarget.line ? `（第 ${fileTarget.line} 行）` : ""}`}
					aria-label={`在编辑器中打开 ${fileTarget.path}`}
					onClick={() => onOpenFile(fileTarget.path, fileTarget.line)}
				>
					<ExternalLink size={12} />
				</button>
			)}
			{summaryLine && (
				<div className="cc-tree-summary">
					<span className="cc-tree-arm">⎿</span>
					<span className="cc-tree-text">{summaryLine}</span>
					{canBackground && matchedTask && onBackgroundTask && (
						<button type="button" className="cc-inline-task-btn" title="转到后台运行 (Ctrl+B)" onClick={() => onBackgroundTask(matchedTask.id)}>
							<ArrowDownToLine size={11} /> 转到后台
						</button>
					)}
					{matchedActive && matchedTask && onStopTask && (
						<button type="button" className="cc-inline-task-btn danger" onClick={() => onStopTask(matchedTask.id, matchedKind)}>
							<Square size={10} /> 停止
						</button>
					)}
					{matchedTask && onOpenTask && (
						<button type="button" className="cc-inline-task-btn" onClick={() => onOpenTask(matchedTask.id)}>
							<Eye size={11} /> 打开子 Agent
						</button>
					)}
				</div>
			)}
			<SmoothCollapse open={Boolean(isOpen && info.todos && info.todos.length > 0)}>
				<div className="cl-tool-body cc-inline-edit-body cc-todo-card">
					{(info.todos ?? []).map((item) => (
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
			</SmoothCollapse>
			<SmoothCollapse open={Boolean(isOpen && (!waitingForApproval || open) && info.editPairs && info.editPairs.length > 0)}>
				<div className="cl-tool-body cc-inline-edit-body">
					{(info.editPairs ?? []).map((pair, idx) => (
						<div key={idx} className={idx > 0 ? "cc-edit-hunk-sep" : undefined}>
							<InlineEditDiff oldText={pair.oldText} newText={pair.newText} filePath={fileTarget?.path ?? info.target} />
						</div>
					))}
				</div>
			</SmoothCollapse>
			<SmoothCollapse open={isOpen && (!info.editPairs || info.editPairs.length === 0) && !info.todos}>
				<div className="cl-tool-body">
					{images.map((img, idx) => {
						const src = `data:${img.mimeType};base64,${img.data}`;
						return (
							<ImageThumbnail
								key={idx}
								className="cc-tool-image"
								alt="工具返回图片"
								previewLabel={`${info.verb} ${info.target || "图片"}`}
								src={src}
								onZoom={onZoomImage}
							/>
						);
					})}
					{(() => {
						const displayOutput = output
							? output.replace(
									/\n?\n?\[Tool output (?:archived: [0-9a-f]+\. Use ReadToolOutput with id to read (?:retained|complete) text\.|was shortened to fit the round budget\.[^\]]*)\]\s*$/,
									"",
								)
							: output;
						return info.lineContent ? (
							<CodeLines content={info.lineContent.content} startLine={info.lineContent.startLine} lang={inferLangFromPath(fileTarget?.path ?? info.target)} />
						) : displayOutput ? (
							<pre className={name === "bash" ? "cc-bash-out" : ""}>{displayOutput}</pre>
						) : !images.length && !archivedOutput && status !== "running" ? (
							<pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>
						) : null;
					})()}
					{output && args != null && (
						<AnimatedDetails className="cc-tool-args-details" summary="参数">
							<pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>
						</AnimatedDetails>
					)}
					{archivedOutput && <ArchivedToolOutput key={archivedOutput.id} reference={archivedOutput} />}
				</div>
			</SmoothCollapse>
			{archivedOutput && Boolean((info.editPairs && info.editPairs.length > 0) || info.todos) && (
				<SmoothCollapse open={isOpen}>
					<div className="cl-tool-body">
						<ArchivedToolOutput key={archivedOutput.id} reference={archivedOutput} />
					</div>
				</SmoothCollapse>
			)}
		</div>
	);
}
