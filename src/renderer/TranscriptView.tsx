import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Check, CircleAlert, ChevronRight, Copy } from "lucide-react";
import type { Message } from "../shared.ts";
import type { Transcript, ToolProgress } from "./messages.ts";
import { CodeLines, InlineEditDiff, computeLineDiff } from "./DiffView.tsx";
import { highlightCode } from "./highlight.tsx";

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

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	const match = /language-([^\s]+)/.exec(className || "");
	const lang = match?.[1] || "text";
	const raw = String(children ?? "").replace(/\n$/, "");

	const copy = () => {
		void navigator.clipboard?.writeText(raw).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="cc-codeblock">
			<div className="cc-codeblock-head">
				<span className="cc-codeblock-lang">{lang}</span>
				<button type="button" className="cc-codeblock-copy" onClick={copy} aria-label="复制代码">
					{copied ? <Check size={12} /> : <Copy size={12} />}
					<span>{copied ? "已复制" : "复制"}</span>
				</button>
			</div>
			<pre>
				<code className={className}>{highlightCode(raw)}</code>
			</pre>
		</div>
	);
}

function MarkdownContent({ text }: { text: string }) {
	return (
		<div className="cl-markdown">
			<ReactMarkdown
				components={{
					pre({ children }) {
						return <>{children}</>;
					},
					code({ className, children, ...props }) {
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

export function TranscriptView({ transcript: state }: { transcript: Transcript }) {
	return (
		<div className="cl-transcript">
			{units(state.messages).map((unit, index) => {
				if (unit.kind === "user") {
					const message = unit.message;
					if (message.role === "custom" && message.customType === "desktop_task_result") {
						const text =
							typeof message.content === "string"
								? message.content
								: message.content
										.filter((b) => b.type === "text")
										.map((b) => b.text)
										.join("\n");
						return (
							<details className="cl-tool done" key={`taskres-${message.timestamp}-${index}`}>
								<summary>
									<span className="cc-dot ok" />
									<span className="cc-tool-head">
										<span className="cc-tool-verb">Subagent</span>
										<span className="cl-tool-name">(后台任务结果回传)</span>
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
								<span className="cl-tool-name">上下文已压缩摘要</span>
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
				return (
					<article className="cl-msg cl-msg-ai" key={`turn-${last.timestamp}-${index}`}>
						{unit.messages.map((message, part) => (
							<TurnBlocks
								key={`${message.timestamp}-${part}`}
								message={message}
								state={state}
								isStreaming={isStreaming && part === unit.messages.length - 1}
								isFirst={part === 0}
							/>
						))}
						{errorMessage && (
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
}: {
	message: Assistant;
	state: Transcript;
	isStreaming: boolean;
	isFirst: boolean;
}) {
	return message.content.map((block, part) => {
		if (block.type === "text") {
			if (!block.text.trim()) return null;
			return (
				<div className="cc-ai-text" key={part}>
					<span className="cc-ai-bullet" aria-hidden="true" />
					<div className="cc-ai-text-inner">
						<MarkdownContent text={block.text} />
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
		return <ToolCard key={block.id} name={block.name} args={block.arguments} progress={progress} result={result} />;
	});
}

interface ToolPresentation {
	verb: string;
	target: string;
	badge?: string;
	treeSummary?: string;
	editPairs?: { oldText: string; newText: string }[];
	lineContent?: { content: string; startLine?: number };
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
	const lineCount = output ? output.split("\n").length : 0;

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
		const wroteLines = content ? content.split("\n").length : 0;
		return {
			verb: "Write",
			target: path || "file",
			badge: wroteLines ? `${wroteLines} lines` : undefined,
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

	if (name === "Agent" || name === "AgentSend") {
		const subType = typeof a.subagent_type === "string" ? a.subagent_type : "general-purpose";
		const desc = typeof a.description === "string" ? a.description : typeof a.task_id === "string" ? a.task_id : "Subagent task";
		const executor = typeof a.executor === "string" ? a.executor : undefined;
		return {
			verb: name === "AgentSend" ? "AgentSend" : `Agent(${subType})`,
			target: desc,
			badge: executor ? `${executor} · ${status}` : status,
			treeSummary: summarizeDesktopJson(output, status === "running" ? "子任务执行中…" : "已完成"),
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

function ToolCard({
	name,
	args,
	progress,
	result,
}: {
	name: string;
	args: unknown;
	progress?: ToolProgress;
	result?: Extract<Message, { role: "toolResult" }>;
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
	const dotClass = status === "error" ? "err" : status === "done" ? "ok" : "run";
	const [open, setOpen] = useState(false);
	const isOpen = open || status === "running";

	return (
		<div className={`cl-tool ${status} ${isOpen ? "is-open" : ""}`}>
			<button type="button" className="cc-tool-row" onClick={() => setOpen((v) => !v)} aria-expanded={isOpen}>
				<span className={`cc-dot ${dotClass}`} />
				<span className="cc-tool-head">
					<span className="cc-tool-verb">{info.verb}</span>
					{info.target && <span className="cl-tool-name">({info.target})</span>}
				</span>
				{info.badge && <span className={`cc-tool-badge ${status === "error" ? "err" : ""}`}>{info.badge}</span>}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			{info.treeSummary && (
				<div className="cc-tree-summary">
					<span className="cc-tree-arm">⎿</span>
					<span className="cc-tree-text">{info.treeSummary}</span>
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
			{isOpen && (!info.editPairs || info.editPairs.length === 0) && (
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
