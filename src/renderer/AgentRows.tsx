import { useEffect, useState } from "react";
import { ArrowDownToLine, ChevronRight, Eye, Square } from "lucide-react";
import type { DesktopTask, ExternalTask, Message, TaskProgress } from "../shared.ts";
import type { ToolProgress } from "./messages.ts";
import { SmoothCollapse } from "./SmoothCollapse.tsx";
import { ArchivedToolOutput } from "./ArchivedToolOutput.tsx";
import { toolOutputReference } from "../tool-output-types.ts";
import { agentGroupTitle, agentRowMetrics, agentRowStatusLine, isActiveTask, type AgentRowState } from "./agent-row.ts";

export interface AgentCall {
	id: string;
	args: unknown;
	progress?: ToolProgress;
	result?: Extract<Message, { role: "toolResult" }>;
	task?: DesktopTask | ExternalTask;
	taskProgress?: TaskProgress;
	/** The host is asking the user whether to allow this call. */
	waitingForApproval?: boolean;
	/** The call's message finished without a result, task or live progress (a cut-off turn). */
	orphaned?: boolean;
}

interface Handlers {
	onOpenTask?: (taskId: string) => void;
	onBackgroundTask?: (taskId: string) => void;
	onStopTask?: (taskId: string, kind: "pi" | "external") => void;
}

/** Re-render once a second while anything shown is still running, so elapsed time ticks. */
function useTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resultText(result: AgentCall["result"]): string {
	return result ? result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
}

type RowState = AgentRowState;

function rowState(call: AgentCall): RowState {
	if (call.task) {
		if (isActiveTask(call.task)) return "run";
		return call.task.status === "completed" ? "ok" : "err";
	}
	if (call.result) return call.result.isError ? "err" : "ok";
	if (call.orphaned) return "err";
	return call.progress?.status === "error" ? "err" : call.progress?.status === "done" ? "ok" : "run";
}

/** Status line for a call whose child task is not (or no longer) in the task list. */
function unmatchedStatus(call: AgentCall, state: RowState): string {
	const text = resultText(call.result).trim();
	if (call.orphaned) return "未完成 · 本轮在子 Agent 启动前结束";
	if (state === "run") return call.progress?.output?.trim().split("\n").at(-1)?.slice(0, 160) || "启动中…";
	if (state === "err") return `失败 · ${text.split("\n")[0].slice(0, 140) || "未能启动"}`;
	if (text.startsWith("Async agent launched")) return "已在后台启动，完成后结果自动回传";
	return text.split("\n")[0].slice(0, 140) || "完成";
}

function AgentRow({ call, now, branch, handlers }: { call: AgentCall; now: number; branch?: "mid" | "last"; handlers: Handlers }) {
	const [open, setOpen] = useState(false);
	const args = record(call.args);
	const description = typeof args.description === "string" && args.description.trim() ? args.description.trim() : "子 Agent 任务";
	const subagentType = typeof args.subagent_type === "string" && args.subagent_type !== "general-purpose" ? args.subagent_type : undefined;
	const executor = call.task && "executor" in call.task ? call.task.executor : typeof args.executor === "string" ? args.executor : undefined;
	const state = rowState(call);
	const task = call.task;
	const background = Boolean(task && "runInBackground" in task && task.runInBackground) || args.run_in_background === true;
	const metrics = task && !call.waitingForApproval ? agentRowMetrics(task, call.taskProgress, now) : undefined;
	const status = call.waitingForApproval && !task
		? "等待你确认是否允许启动…"
		: task ? agentRowStatusLine(task, call.taskProgress) : unmatchedStatus(call, state);
	const archived = toolOutputReference(call.result?.details);
	const kind: "pi" | "external" = task && "executor" in task ? "external" : "pi";
	const active = Boolean(task && isActiveTask(task));
	const canBackground = Boolean(task && active && kind === "pi" && !(task as DesktopTask).runInBackground &&
		((task as DesktopTask).readOnly || (task as DesktopTask).worktreeId));
	const prompt = typeof args.prompt === "string" ? args.prompt : "";
	const raw = task && "result" in task && task.result?.text
		? task.result.text
		: task && "executor" in task && task.output
			? task.output
			: resultText(call.result);
	// The archive notice is replaced by the archive viewer below.
	const output = archived ? raw.replace(/\n?\n?\[Tool output (?:archived|was shortened)[^\]]*\]\s*$/, "") : raw;
	const tag = [executor, subagentType].filter(Boolean).join(" · ");
	return (
		<div className={`cc-subagent-run-row ${state} ${branch ? `in-group ${branch}` : ""} ${open ? "is-open" : ""}`.trim()}>
			<button type="button" className="cc-subagent-run-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				{branch ? (
					<span className="cc-subagent-run-branch" aria-hidden="true">{branch === "last" ? "└" : "├"}</span>
				) : (
					<span className={`cc-dot ${state}`} aria-hidden="true" />
				)}
				{!branch && <span className="cc-subagent-run-verb">Agent</span>}
				<span className="cc-subagent-run-desc">{description}</span>
				{tag && <span className="cc-subagent-run-tag">{tag}</span>}
				{background && active && <span className="cc-subagent-run-tag bg">后台</span>}
				{call.waitingForApproval && <span className="cc-tool-badge cc-tool-awaiting">待确认</span>}
				{metrics && <span className="cc-subagent-run-metrics">{metrics}</span>}
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<div className="cc-subagent-run-status">
				<span className="cc-subagent-run-rail" aria-hidden="true">{branch === "mid" ? "│" : " "}</span>
				<span className="cc-tree-arm" aria-hidden="true">⎿</span>
				<span className={`cc-subagent-run-status-text ${state === "run" && !call.waitingForApproval ? "cc-shimmer-text" : ""} ${state}`}>{status}</span>
				{canBackground && handlers.onBackgroundTask && (
					<button type="button" className="cc-inline-task-btn" title="转到后台运行 (Ctrl+B)" onClick={() => handlers.onBackgroundTask!(task!.id)}>
						<ArrowDownToLine size={11} /> 后台
					</button>
				)}
				{active && task && handlers.onStopTask && (
					<button type="button" className="cc-inline-task-btn danger" onClick={() => handlers.onStopTask!(task.id, kind)}>
						<Square size={10} /> 停止
					</button>
				)}
				{task && handlers.onOpenTask && (
					<button type="button" className="cc-inline-task-btn" title="打开子 Agent 的完整对话" onClick={() => handlers.onOpenTask!(task.id)}>
						<Eye size={11} /> 打开
					</button>
				)}
			</div>
			<SmoothCollapse open={open}>
				<div className="cl-tool-body cc-subagent-run-body">
					{prompt && (
						<section>
							<h4>任务说明</h4>
							<pre>{prompt}</pre>
						</section>
					)}
					{output.trim() && (
						<section>
							<h4>{active ? "当前输出" : "结果"}</h4>
							<pre>{output}</pre>
						</section>
					)}
					{archived && <ArchivedToolOutput key={archived.id} reference={archived} />}
				</div>
			</SmoothCollapse>
		</div>
	);
}

/**
 * Agent calls from one assistant message. One call is a single row; several calls launched together
 * render as one block with tree branches, the way Claude Code shows a parallel fan-out.
 */
export function AgentRows({ calls, ...handlers }: { calls: AgentCall[] } & Handlers) {
	const states = calls.map(rowState);
	const anyRunning = states.includes("run");
	const now = useTick(anyRunning);
	const grouped = calls.length > 1;
	const state: RowState = anyRunning ? "run" : states.includes("err") ? "err" : "ok";
	// One wrapper for both shapes, so the first row keeps its state when a second call streams in.
	return (
		<div className={grouped ? `cc-subagent-run-group ${state}` : "cc-subagent-run-single"}>
			{grouped && (
				<div className="cc-subagent-run-group-head">
					<span className={`cc-dot ${state}`} aria-hidden="true" />
					<span className="cc-subagent-run-verb">Agent</span>
					<span className="cc-subagent-run-desc">{agentGroupTitle(states)}</span>
				</div>
			)}
			{calls.map((call, index) => (
				<AgentRow
					key={call.id}
					call={call}
					now={now}
					branch={grouped ? (index === calls.length - 1 ? "last" : "mid") : undefined}
					handlers={handlers}
				/>
			))}
		</div>
	);
}
