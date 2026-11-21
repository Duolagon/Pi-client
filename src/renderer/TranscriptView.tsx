import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowDownToLine, Check, Circle, CircleAlert, ChevronRight, Copy, Eye, GitFork, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { formatCompactDuration, formatCompactTokens, formatTaskProgressSummary } from "../delegation-format.ts";
import type { DesktopTask, ExternalTask, Message, TaskProgress } from "../shared.ts";
import type { Transcript, ToolProgress } from "./messages.ts";
import { CodeLines, InlineEditDiff, computeLineDiff } from "./DiffView.tsx";
import { highlightCode } from "./highlight.tsx";
import { scoreTurn, type QualityVerdict } from "./quality-verdict.ts";
import { OmenGlyph } from "./GrailIcons.tsx";

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

type Assistant = Extract<Message, { role: "assistant" }>;
type AnyMessage = Transcript["messages"][number];
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

/** Copies text, falling back to a hidden textarea when the async clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
	try {
		if (!navigator.clipboard) throw new Error("no clipboard");
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		const previous = document.activeElement as HTMLElement | null;
		document.body.append(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		area.remove();
		previous?.focus?.();
		return ok;
	}
}

type CopyState = "idle" | "done" | "failed";
const copyLabel: Record<CopyState, string> = { idle: "复制", done: "已复制", failed: "复制失败" };

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
	const [copied, setCopied] = useState<CopyState>("idle");
	const match = /language-([^\s]+)/.exec(className || "");
	const lang = match?.[1] || "text";
	const raw = String(children ?? "").replace(/\n$/, "");

	const copy = () => {
		void copyText(raw).then((ok) => {
			setCopied(ok ? "done" : "failed");
			setTimeout(() => setCopied("idle"), 1500);
		});
	};

	return (
		<div className="cc-codeblock">
			<div className="cc-codeblock-head">
				<span className="cc-codeblock-lang">{lang}</span>
				<button type="button" className="cc-codeblock-copy" onClick={copy} aria-label="复制代码">
					{copied === "done" ? <Check size={12} /> : <Copy size={12} />}
					<span role={copied === "failed" ? "alert" : undefined}>{copyLabel[copied]}</span>
				</button>
			</div>
			<pre>
				<code className={className}>{highlightCode(raw)}</code>
			</pre>
		</div>
	);
}

function MarkdownContent({ text, onOpenPreview }: { text: string; onOpenPreview?: (url: string) => void }) {
	return (
		<div className="cl-markdown">
			<ReactMarkdown
				components={{
					pre({ children }) {
						return <>{children}</>;
					},
					a({ href, children, ...props }) {
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
							return <CodeBlock className={className}>{children}</CodeBlock>;
						}
						return (
							<code className={className} {...props}>
								{children}
							</code>
						);
					},
				}}
			>
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
			className="cc-meta-action"
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
		<details className="cl-tool done">
			<summary>
				<span className={`cc-dot ${status === "completed" ? "ok" : status === "failed" ? "err" : ""}`} />
				<span className="cc-tool-head">
					<span className="cc-tool-verb">子 Agent</span>
					<span className="cl-tool-name cl-tool-name-free">{description}</span>
					<span className={`cc-task-notice-status ${status}`}>{noticeStatusLabel[status] ?? status}</span>
				</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</summary>
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
		</details>
	);
}

export function TranscriptView({
	transcript: state,
	tasks = [],
	externalTasks = [],
	taskProgressMap = {},
	onOpenTask,
	onBackgroundTask,
	onStopTask,
	onRewindPrompt,
	onForkPrompt,
	onOpenPreview,
}: {
	transcript: Transcript;
	tasks?: DesktopTask[];
	externalTasks?: ExternalTask[];
	taskProgressMap?: Record<string, TaskProgress>;
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
	onRewindPrompt?: (text: string) => void;
	onForkPrompt?: (text: string) => void;
	onOpenPreview?: (url: string) => void;
}) {
	return (
		<div className="cl-transcript">
			{units(state.messages).map((unit, index) => {
				if (unit.kind === "user") {
					const message = unit.message;
					if (message.role === "custom" && message.customType === "desktop_task_notification") {
						return <TaskNotificationCard key={`tasknote-${message.timestamp}-${index}`} details={message.details} onOpenTask={onOpenTask} />;
					}
					const customCardMeta: Record<string, { verb: string; label: string }> = {
						desktop_task_result: { verb: "Subagent", label: "(后台任务结果回传)" },
						desktop_monitor_event: { verb: "Monitor", label: "(后台监听事件)" },
						desktop_cron_wakeup: { verb: "Schedule", label: "(定时唤醒提醒)" },
						desktop_team_message: { verb: "Team", label: "(团队协作消息)" },
						desktop_workflow_event: { verb: "Workflow", label: "(工作流事件)" },
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
							<details className="cl-tool done" key={`custom-${message.customType}-${message.timestamp}-${index}`}>
								<summary>
									<span className="cc-dot ok" />
									<span className="cc-tool-head">
										<span className="cc-tool-verb">{cardMeta.verb}</span>
										<span className="cl-tool-name cl-tool-name-free">{cardMeta.label}</span>
									</span>
									<ChevronRight size={13} className="cl-tool-chevron" />
								</summary>
								<div className="cl-tool-body">
									<div className="cc-summary-pad">
										<MarkdownContent text={text} />
									</div>
								</div>
							</details>
						);
					}
					const promptText =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((b) => b.type === "text")
									.map((b) => b.text)
									.join("\n");
					return (
						<div className="cl-msg cl-msg-user" key={`user-${message.timestamp}-${index}`}>
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
												<p key={part}>{block.text}</p>
											) : (
												<img key={part} alt="用户附件" src={`data:${block.mimeType};base64,${block.data}`} />
											),
										)
									)}
								</div>
								{(onRewindPrompt || onForkPrompt) && promptText.trim() && (
									<div className="cc-user-actions">
										{onForkPrompt && (
											<button type="button" title="从此处分叉对话" onClick={() => onForkPrompt(promptText)}>
												<GitFork size={12} />
											</button>
										)}
										{onRewindPrompt && (
											<button type="button" title="回滚到此检查点" onClick={() => onRewindPrompt(promptText)}>
												<RotateCcw size={12} />
											</button>
										)}
									</div>
								)}
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
						<details className="cl-tool done" key={`summary-${message.timestamp}-${index}`}>
							<summary>
								<span className="cc-dot ok" />
								<span className="cc-tool-verb">Compact</span>
								<span className="cl-tool-name cl-tool-name-free">上下文已压缩摘要</span>
								<ChevronRight size={13} className="cl-tool-chevron" />
							</summary>
							<div className="cl-tool-body">
								<div className="cc-summary-pad">
									<MarkdownContent text={message.summary} />
								</div>
							</div>
						</details>
					);
				}
				const last = unit.messages[unit.messages.length - 1];
				const firstIndex = state.messages.indexOf(unit.messages[0]);
				const lastIndex = state.messages.indexOf(last);
				const isStreaming = state.streamingIndex !== null && state.streamingIndex >= firstIndex && state.streamingIndex <= lastIndex;
				const errorMessage = [...unit.messages].reverse().find((message) => message.errorMessage)?.errorMessage;
				const aborted = unit.messages.some((message) => message.stopReason === "aborted");
				const usage = last.usage;
				// Score from the full turn slice (assistant messages + their interleaved toolResults).
				const verdict: QualityVerdict | null =
					isStreaming || firstIndex < 0 ? null : scoreTurn(state.messages.slice(firstIndex, lastIndex + 1));
				const turnText = unit.messages
					.flatMap((m) => m.content)
					.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n\n");
				return (
					<article className="cl-msg cl-msg-ai" key={`turn-${last.timestamp}-${index}`}>
						{unit.messages.map((message, part) => (
							<TurnBlocks
								key={`${message.timestamp}-${part}`}
								message={message}
								state={state}
								isStreaming={isStreaming && part === unit.messages.length - 1}
								isFirst={part === 0}
								tasks={tasks}
								externalTasks={externalTasks}
								taskProgressMap={taskProgressMap}
								onOpenTask={onOpenTask}
								onBackgroundTask={onBackgroundTask}
								onStopTask={onStopTask}
								onOpenPreview={onOpenPreview}
							/>
						))}
						{errorMessage && !aborted && (
							<div className="cl-msg-error" role="alert">
								<CircleAlert size={15} />
								<span>{errorMessage}</span>
							</div>
						)}
						{aborted && <p className="cl-stopped">本次回复已停止。</p>}
						{!isStreaming && last.model && (
							<footer className="cl-ai-meta">
								<span>{last.model}</span>
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
								<CopyTurnButton text={turnText} />
							</footer>
						)}
					</article>
				);
			})}
		</div>
	);
}

function TurnBlocks({
	message,
	state,
	isStreaming,
	isFirst,
	tasks,
	externalTasks,
	taskProgressMap,
	onOpenTask,
	onBackgroundTask,
	onStopTask,
	onOpenPreview,
}: {
	message: Assistant;
	state: Transcript;
	isStreaming: boolean;
	isFirst: boolean;
	tasks: DesktopTask[];
	externalTasks: ExternalTask[];
	taskProgressMap: Record<string, TaskProgress>;
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
	onOpenPreview?: (url: string) => void;
}) {
	return message.content.map((block, part) => {
		if (block.type === "text") {
			if (!block.text.trim()) return null;
			return (
				<div className="cc-ai-text" key={part}>
					<span className="cc-ai-bullet" aria-hidden="true" />
					<div className="cc-ai-text-inner">
						<MarkdownContent text={block.text} onOpenPreview={onOpenPreview} />
					</div>
				</div>
			);
		}
		if (block.type === "thinking") {
			if (!block.thinking) return null;
			const activeThink = isStreaming && part === message.content.length - 1;
			return (
				<details className={`cl-think ${activeThink ? "thinking-active" : ""}`} key={part}>
					<summary>
						<span className={`cc-think-glyph ${activeThink ? "pulse" : ""}`}>∴</span>
						<span>{activeThink ? "Thinking…" : "Thought"}</span>
						<ChevronRight size={12} className="cl-tool-chevron" />
					</summary>
					<div className="cl-markdown">
						<ReactMarkdown>{block.thinking}</ReactMarkdown>
					</div>
				</details>
			);
		}
		const result = state.messages.find(
			(item): item is Extract<Message, { role: "toolResult" }> => item.role === "toolResult" && item.toolCallId === block.id,
		);
		const progress = state.tools[block.id];
		const matchedTask =
			tasks.find((t) => t.parentToolCallId === block.id || t.turnCalls?.includes(block.id)) ??
			externalTasks.find((t) => t.parentToolCallId === block.id);
		return (
			<ToolCard
				key={block.id}
				name={block.name}
				args={block.arguments}
				progress={progress}
				result={result}
				matchedTask={matchedTask}
				taskProgress={matchedTask ? taskProgressMap[matchedTask.id] : undefined}
				onOpenTask={onOpenTask}
				onBackgroundTask={onBackgroundTask}
				onStopTask={onStopTask}
			/>
		);
	});
}

interface ToolPresentation {
	verb: string;
	target: string;
	badge?: string;
	treeSummary?: string;
	editPairs?: { oldText: string; newText: string }[];
	lineContent?: { content: string; startLine?: number };
	todos?: TodoItem[];
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

function presentTool(name: string, args: unknown, output: string | undefined, status: string): ToolPresentation {
	const a = asRecord(args);
	const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
	const lineCount = output ? countLines(output) : 0;

	if (name === "read") {
		const offset = typeof a.offset === "number" ? a.offset : 1;
		return {
			verb: "Read",
			target: path || "file",
			badge: status === "done" && output ? `${lineCount} lines` : undefined,
			treeSummary:
				status === "running"
					? "正在读取文件…"
					: status === "error"
						? output?.split("\n")[0] || "读取失败"
						: `Read ${lineCount} lines${offset > 1 ? ` (from line ${offset})` : ""}`,
			lineContent: output ? { content: output, startLine: offset } : undefined,
		};
	}

	if (name === "edit") {
		const editPairs = extractEditPairs(a);
		if (editPairs.length) {
			let additions = 0;
			let removals = 0;
			for (const pair of editPairs) {
				const d = computeLineDiff(pair.oldText, pair.newText);
				additions += d.additions;
				removals += d.removals;
			}
			return {
				verb: "Update",
				target: path || "file",
				badge: `+${additions} -${removals}`,
				treeSummary:
					status === "error"
						? output?.split("\n")[0] || "编辑失败"
						: `Updated ${path || "file"} with ${additions} addition${additions === 1 ? "" : "s"} and ${removals} removal${removals === 1 ? "" : "s"}`,
				editPairs,
			};
		}
		return {
			verb: "Edit",
			target: path || "file",
			treeSummary: output?.split("\n")[0] || (status === "running" ? "正在编辑…" : "已更新"),
		};
	}

	if (name === "write") {
		const content = typeof a.content === "string" ? a.content : "";
		const wroteLines = content ? countLines(content) : 0;
		return {
			verb: "Write",
			target: path || "file",
			badge: wroteLines && status !== "error" ? `${wroteLines} lines` : undefined,
			treeSummary:
				status === "running"
					? "正在写入文件…"
					: status === "error"
						? output?.split("\n")[0] || "写入失败"
						: `Wrote ${wroteLines} lines to ${path || "file"}`,
			lineContent: content ? { content, startLine: 1 } : undefined,
		};
	}

	if (name === "bash") {
		const cmd = typeof a.command === "string" ? a.command.split("\n")[0].slice(0, 120) : "command";
		const firstLine = output?.trim() ? output.trim().split("\n")[0].slice(0, 110) : status === "running" ? "正在执行…" : "(No output)";
		return {
			verb: "Bash",
			target: cmd,
			badge: status === "error" ? "error" : status === "done" ? "done" : undefined,
			treeSummary: firstLine,
		};
	}

	if (name === "grep" || name === "find" || name === "ls") {
		const verb = name === "grep" ? "Grep" : name === "find" ? "Glob" : "List";
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
			badge: status === "done" ? `${count} results` : undefined,
			treeSummary: status === "running" ? "正在搜索…" : `Found ${count} line${count === 1 ? "" : "s"}`,
		};
	}

	if (name === "TodoWrite") {
		const rawTodos = Array.isArray(a.todos) ? (a.todos as TodoItem[]) : [];
		const doneCount = rawTodos.filter((t) => t.status === "completed").length;
		const inProgress = rawTodos.find((t) => t.status === "in_progress");
		return {
			verb: "Todos",
			target: `${doneCount}/${rawTodos.length} completed`,
			badge: inProgress ? "active" : "updated",
			treeSummary: inProgress ? `正在进行：${inProgress.content}` : `已更新 ${rawTodos.length} 项任务清单`,
			todos: rawTodos,
		};
	}

	if (name === "WebFetch") {
		const rawUrl = typeof a.url === "string" ? a.url : "";
		return {
			verb: "Fetch",
			target: rawUrl,
			badge: status === "done" && output ? `${output.length} chars` : status,
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
				<span className={`cc-dot ${ok ? "ok" : "err"}`} />
				<span className="cc-tool-head">
					<span className="cc-tool-verb">Bash</span>
					<span className="cl-tool-name">({command})</span>
				</span>
				<span className={`cc-tool-badge ${ok ? "" : "err"}`}>exit {exitCode ?? "?"}</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<div className="cc-tree-summary">
				<span className="cc-tree-arm">⎿</span>
				<span className="cc-tree-text">{preview}</span>
			</div>
			{open && (
				<div className="cl-tool-body">
					<pre className="cc-bash-out">{`$ ${command}\n${output || "(No output)"}`}</pre>
					{truncated && <p className="cl-truncated">输出已截断，完整输出：{fullOutputPath}</p>}
				</div>
			)}
		</div>
	);
}

function formatMatchedTaskSummary(task: DesktopTask | ExternalTask, taskProgress?: TaskProgress): string {
	const active = task.status === "queued" || task.status === "running" || task.status === "waiting_for_input";
	if (active) {
		if (taskProgress) return formatTaskProgressSummary(taskProgress);
		return `${task.status === "waiting_for_input" ? "待审批" : task.status === "queued" ? "排队中" : "运行中"} · ${task.workingDirectory}`;
	}
	if ("executor" in task) {
		return `${task.executor} · ${task.status} · ${formatCompactDuration(Math.max(0, task.updatedAt - task.createdAt))}`;
	}
	const parts: string[] = [];
	const model = task.stats?.model?.id ?? task.model?.id;
	if (model) parts.push(model);
	if (task.stats?.tokens.total) parts.push(`${formatCompactTokens(task.stats.tokens.total)} tokens`);
	if (task.stats?.toolUses) parts.push(`${task.stats.toolUses} 次工具`);
	if (task.stats?.durationMs !== undefined) parts.push(formatCompactDuration(task.stats.durationMs));
	else parts.push(formatCompactDuration(Math.max(0, task.updatedAt - task.createdAt)));
	if (task.stopReason) parts.push(task.stopReason);
	return parts.length ? parts.join(" · ") : `${task.status} · ${task.workingDirectory}`;
}

function ToolCard({
	name,
	args,
	progress,
	result,
	matchedTask,
	taskProgress,
	onOpenTask,
	onBackgroundTask,
	onStopTask,
}: {
	name: string;
	args: unknown;
	progress?: ToolProgress;
	result?: Extract<Message, { role: "toolResult" }>;
	matchedTask?: DesktopTask | ExternalTask;
	taskProgress?: TaskProgress;
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
}) {
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
	const [open, setOpen] = useState(false);
	const isOpen = open || status === "running";
	const summaryLine = matchedTask
		? formatMatchedTaskSummary(matchedTask, taskProgress)
		: status === "running" && (name === "Agent" || name === "SendMessage") && progress?.output
			? progress.output
			: info.treeSummary;

	return (
		<div className={`cl-tool ${effectiveStatus} ${isOpen ? "is-open" : ""}`}>
			<button type="button" className="cc-tool-row" onClick={() => setOpen((v) => !v)} aria-expanded={isOpen}>
				<span className={`cc-dot ${dotClass}`} />
				<span className="cc-tool-head">
					<span className="cc-tool-verb">{info.verb}</span>
					{info.target && <span className="cl-tool-name">({info.target})</span>}
				</span>
				{matchedTask && (
					<span className="cc-tool-badge">
						{"executor" in matchedTask ? matchedTask.executor : "pi"} · {matchedTask.status}
					</span>
				)}
				{!matchedTask && info.badge && <span className={`cc-tool-badge ${status === "error" ? "err" : ""}`}>{info.badge}</span>}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
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
			{info.todos && info.todos.length > 0 && (
				<div className="cl-tool-body cc-inline-edit-body cc-todo-card">
					{info.todos.map((item) => (
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
			{info.editPairs && info.editPairs.length > 0 && (
				<div className="cl-tool-body cc-inline-edit-body">
					{info.editPairs.map((pair, idx) => (
						<div key={idx} className={idx > 0 ? "cc-edit-hunk-sep" : undefined}>
							<InlineEditDiff oldText={pair.oldText} newText={pair.newText} />
						</div>
					))}
				</div>
			)}
			{isOpen && (!info.editPairs || info.editPairs.length === 0) && !info.todos && (
				<div className="cl-tool-body">
					{images.map((img, idx) => (
						<img key={idx} className="cc-tool-image" alt="工具返回图片" src={`data:${img.mimeType};base64,${img.data}`} />
					))}
					{info.lineContent ? (
						<CodeLines content={info.lineContent.content} startLine={info.lineContent.startLine} />
					) : output ? (
						<pre className={name === "bash" ? "cc-bash-out" : ""}>{output}</pre>
					) : !images.length ? (
						<pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>
					) : null}
					{output && args != null && (
						<details className="cc-tool-args-details">
							<summary>参数</summary>
							<pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>
						</details>
					)}
				</div>
			)}
		</div>
	);
}
