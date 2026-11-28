import { useEffect, useState } from "react";
import { ChevronRight, Eye, Play, Square } from "lucide-react";
import type { WorkflowRecord } from "../workflow-types.ts";
import { SmoothCollapse } from "./SmoothCollapse.tsx";
import { stepMetrics, stepState, workflowResultText, workflowState, workflowSummary, workflowTree } from "./workflow-tree.ts";

const MAX_LOG_LINES = 6;

/**
 * The live progress tree of a WorkflowRun: narrator lines from log(), phases as groups, one row
 * per agent step with its status and metrics, collapsing to a one-line summary when the run ends.
 */
export function WorkflowTree({
	record,
	defaultOpen,
	onOpenTask,
	onStop,
	onResume,
}: {
	record: WorkflowRecord;
	defaultOpen?: boolean;
	onOpenTask?: (taskId: string) => void;
	onStop?: (workflowId: string) => void;
	onResume?: (workflowId: string) => void;
}) {
	const state = workflowState(record);
	const running = state === "run";
	const [open, setOpen] = useState<boolean>();
	const isOpen = open ?? (defaultOpen ?? running);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	const groups = workflowTree(record);
	const logs = record.logs.slice(-MAX_LOG_LINES);
	const resultText = workflowResultText(record);
	return (
		<div className={`cc-wf-tree ${state} ${isOpen ? "is-open" : ""}`}>
			<button type="button" className="cc-wf-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
				<span className={`cc-dot ${state}`} aria-hidden="true" />
				<span className="cc-wf-verb">工作流</span>
				<span className="cc-wf-title">{record.title}</span>
				<span className="cc-wf-metrics">{workflowSummary(record, now)}</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<SmoothCollapse open={isOpen}>
				<div className="cc-wf-body">
					{logs.map((entry, index) => (
						<p key={`${entry.ts}-${index}`} className="cc-wf-log">{entry.message}</p>
					))}
					{groups.map((group, index) => (
						<div key={group.name ?? `loose-${index}`} className={`cc-wf-group ${group.state}`}>
							{group.name && (
								<div className="cc-wf-group-head">
									<span className={`cc-dot ${group.state}`} aria-hidden="true" />
									<span className="cc-wf-group-name">{group.name}</span>
									<span className="cc-wf-group-count">{group.steps.length} 步</span>
								</div>
							)}
							{group.error && <p className="cc-wf-step-error cc-wf-group-error">{group.error}</p>}
							{group.steps.map((step, position) => {
								const rowState = stepState(step);
								return (
									<div key={step.stepKey} className={`cc-wf-step ${rowState}`}>
										<span className="cc-wf-branch" aria-hidden="true">{position === group.steps.length - 1 ? "└" : "├"}</span>
										<span className={`cc-wf-step-label ${rowState === "run" ? "cc-shimmer-text" : ""}`}>{step.label}</span>
										{step.status === "failed" && step.error && <span className="cc-wf-step-error">{step.error}</span>}
										<span className="cc-wf-step-metrics">{stepMetrics(step, now)}</span>
										{step.taskId && onOpenTask && (
											<button type="button" className="cc-inline-task-btn" title="打开这一步的子 Agent" onClick={() => onOpenTask(step.taskId!)}>
												<Eye size={11} /> 打开
											</button>
										)}
									</div>
								);
							})}
							{group.pending && <div className="cc-wf-step run"><span className="cc-wf-branch" aria-hidden="true">└</span><span className="cc-wf-step-label cc-shimmer-text">准备中…</span></div>}
						</div>
					))}
					{!groups.length && <p className="cc-wf-log">{running ? "尚未启动任何步骤。" : "没有运行任何步骤。"}</p>}
					{state === "err" && record.error && (
						<details className="cc-wf-output">
							<summary>错误详情</summary>
							<pre>{record.error}</pre>
						</details>
					)}
					{resultText && (
						<details className="cc-wf-output">
							<summary>脚本返回值</summary>
							<pre>{resultText}</pre>
						</details>
					)}
					<div className="cc-wf-actions">
						{running && onStop && (
							<button type="button" className="cc-inline-task-btn danger" onClick={() => onStop(record.id)}>
								<Square size={10} /> 停止工作流
							</button>
						)}
						{(record.status === "failed" || record.status === "cancelled") && onResume && (
							<button type="button" className="cc-inline-task-btn" title="从 Journal 继续，已完成的步骤会被复用" onClick={() => onResume(record.id)}>
								<Play size={11} /> 恢复运行
							</button>
						)}
					</div>
				</div>
			</SmoothCollapse>
		</div>
	);
}
