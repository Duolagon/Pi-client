import ReactMarkdown from "react-markdown";
import { Check, CircleAlert, FileCode2, Terminal, LoaderCircle, ChevronRight } from "lucide-react";
import type { Message } from "../shared.ts";
import type { Transcript, ToolProgress } from "./messages.ts";

type Assistant = Extract<Message, { role: "assistant" }>;
type AnyMessage = Transcript["messages"][number];
type Unit =
	| { kind: "user"; message: Extract<Message, { role: "user" } | { role: "custom" }> }
	| { kind: "bash"; message: Extract<Message, { role: "bashExecution" }> }
	| { kind: "summary"; message: Extract<Message, { role: "branchSummary" | "compactionSummary" }> }
	| { kind: "turn"; messages: Assistant[] };

/** Group consecutive assistant messages (toolResult/system messages stay hidden inside a turn)
    so one user turn renders as a single assistant block, like the native Claude client. */
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

export function TranscriptView({ transcript: state }: { transcript: Transcript }) {
	return (
		<div className="cl-transcript">
			{units(state.messages).map((unit, index) => {
				if (unit.kind === "user") {
					const message = unit.message;
					return (
						<div className="cl-msg cl-msg-user" key={`user-${message.timestamp}-${index}`}>
							<div className="cl-user-bubble">
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
					);
				}
				if (unit.kind === "bash") {
					const message = unit.message;
					return (
						<details className="cl-tool" key={`bash-${message.timestamp}-${index}`}>
							<summary>
								<span className={`cl-tool-state ${message.exitCode === 0 ? "ok" : "err"}`}>
									{message.exitCode === 0 ? <Check size={13} /> : <CircleAlert size={13} />}
								</span>
								<Terminal size={14} />
								<span className="cl-tool-name">{message.command}</span>
								<ChevronRight size={13} className="cl-tool-chevron" />
							</summary>
							<pre>{message.output}</pre>
							{message.truncated && <p className="cl-truncated">输出已截断，完整输出：{message.fullOutputPath}</p>}
						</details>
					);
				}
				if (unit.kind === "summary") {
					const message = unit.message;
					return (
						<details className="cl-tool" key={`summary-${message.timestamp}-${index}`}>
							<summary>
								<span className="cl-tool-state">
									<FileCode2 size={14} />
								</span>
								<span className="cl-tool-name">上下文摘要</span>
								<ChevronRight size={13} className="cl-tool-chevron" />
							</summary>
							<div className="cl-tool-body cl-markdown">
								<ReactMarkdown>{message.summary}</ReactMarkdown>
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
				return (
					<article className="cl-msg cl-msg-ai" key={`turn-${last.timestamp}-${index}`}>
						{unit.messages.map((message, part) => (
							<TurnBlocks key={`${message.timestamp}-${part}`} message={message} state={state} />
						))}
						{errorMessage && (
							<div className="cl-msg-error" role="alert">
								<CircleAlert size={15} />
								<span>{errorMessage}</span>
							</div>
						)}
						{aborted && <p className="cl-stopped">本次回复已停止。</p>}
						{(!isStreaming && last.model) && (
							<footer className="cl-ai-meta">
								<span>{last.model}</span>
								<span>{formatTime(last.timestamp)}</span>
							</footer>
						)}
					</article>
				);
			})}
		</div>
	);
}

function TurnBlocks({ message, state }: { message: Assistant; state: Transcript }) {
	return message.content.map((block, part) => {
		if (block.type === "text")
			return (
				<div className="cl-markdown" key={part}>
					<ReactMarkdown>{block.text}</ReactMarkdown>
				</div>
			);
		if (block.type === "thinking")
			return block.thinking ? (
				<details className="cl-think" key={part}>
					<summary>
						<ChevronRight size={13} className="cl-tool-chevron" />
						思考过程
					</summary>
					<div className="cl-markdown">
						<ReactMarkdown>{block.thinking}</ReactMarkdown>
					</div>
				</details>
			) : null;
		const result = state.messages.find(
			(item): item is Extract<Message, { role: "toolResult" }> => item.role === "toolResult" && item.toolCallId === block.id,
		);
		const progress = state.tools[block.id];
		return <ToolCard key={block.id} name={block.name} args={block.arguments} progress={progress} result={result} />;
	});
}

function toolSummary(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return name;
	const a = args as Record<string, unknown>;
	if (name === "bash" && typeof a.command === "string") return a.command.split("\n")[0].slice(0, 120);
	if (typeof a.path === "string") return a.path;
	if (typeof a.file_path === "string") return a.file_path;
	return name;
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
	const status = result ? (result.isError ? "error" : "done") : (progress?.status ?? "running");
	const summary = toolSummary(name, args);
	return (
		<details className={`cl-tool ${status}`} open={status === "running"}>
			<summary>
				<span className={`cl-tool-state ${status === "error" ? "err" : status === "done" ? "ok" : ""}`}>
					{status === "running" ? (
						<LoaderCircle size={13} className="spin" />
					) : status === "done" ? (
						<Check size={13} />
					) : (
						<CircleAlert size={13} />
					)}
				</span>
				{name === "bash" ? <Terminal size={14} /> : <FileCode2 size={14} />}
				<span className="cl-tool-name">{summary}</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</summary>
			<div className="cl-tool-body">
				{!output && <pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>}
				{output && <pre>{output}</pre>}
				{output && args != null && (
					<details style={{ borderTop: "1px solid var(--cl-line-soft)" }}>
						<summary style={{ padding: "6px 14px", fontSize: "11px", color: "var(--cl-3)", cursor: "pointer", listStyle: "none" }}>参数</summary>
						<pre className="cl-tool-args">{JSON.stringify(args, null, 2)}</pre>
					</details>
				)}
			</div>
		</details>
	);
}
