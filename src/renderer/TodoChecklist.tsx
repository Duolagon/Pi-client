import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { computeTodoTiming } from "../task-eta.ts";
import { SmoothCollapse } from "./SmoothCollapse.tsx";
import type { TodoItem } from "./TranscriptView.tsx";
import { todoLabel, visibleTodos } from "./todo-list.ts";

/**
 * A Claude Code style checklist: `☒` struck through when done, `☐` while pending, and the item
 * being worked on highlighted in its present-continuous form. Long lists keep the current item
 * in view and say how many rows are hidden.
 */
export function TodoChecklist({
	items,
	running,
	now,
	max = 8,
	showTiming = true,
}: {
	items: readonly TodoItem[];
	running: boolean;
	now: number;
	max?: number;
	showTiming?: boolean;
}) {
	const window = visibleTodos(items, max);
	return (
		<ul className="cc-todo-list" aria-label="任务清单">
			{window.hiddenBefore > 0 && (
				<li className="cc-todo-more">… {window.hiddenBeforeDone ? `已完成 ${window.hiddenBefore} 项` : `前面还有 ${window.hiddenBefore} 项`}</li>
			)}
			{window.rows.map((item) => {
				const timing = showTiming ? computeTodoTiming(item, now, running) : undefined;
				const active = item.status === "in_progress";
				return (
					<li
						key={item.id}
						className={`cc-todo-item ${item.status} ${active && running ? "is-live" : ""}`.trim()}
						aria-current={active ? "step" : undefined}
					>
						<span className="cc-todo-box" aria-hidden="true">{item.status === "completed" ? "☒" : "☐"}</span>
						<span className="cc-todo-text">{todoLabel(item)}</span>
						<span className="cc-visually-hidden">
							{item.status === "completed" ? "（已完成）" : active ? "（进行中）" : "（待办）"}
						</span>
						{timing?.label && (
							<span className={`cc-eta-pill ${timing.overdue ? "overdue" : ""}`}>{timing.label}</span>
						)}
					</li>
				);
			})}
			{window.hiddenAfter > 0 && <li className="cc-todo-more">… 还有 {window.hiddenAfter} 项</li>}
		</ul>
	);
}

/**
 * A TodoWrite call in the transcript: one line saying what changed (`完成「读文件」，开始「跑测试」 · 2/5`),
 * expandable to the list as it stood after that call. The pinned checklist shows the live state.
 */
export function TodoUpdateRow({
	todos,
	delta,
	state,
	forceOpen = false,
}: {
	todos: readonly TodoItem[];
	delta: string;
	/** `stopped`: the call never returned, so the list it carried was not applied. */
	state: "run" | "ok" | "stopped";
	/** Transcript search opens every row so its items can be found. */
	forceOpen?: boolean;
}) {
	const [userOpen, setOpen] = useState(false);
	const open = forceOpen || userOpen;
	return (
		<div className={`cc-todo-update ${state} ${open ? "is-open" : ""}`}>
			<button type="button" className="cc-todo-update-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className={`cc-dot ${state === "stopped" ? "err" : state}`} aria-hidden="true" />
				<span className="cc-todo-update-verb">更新任务清单</span>
				<ChevronRight size={13} className="cl-tool-chevron" />
			</button>
			<div className="cc-todo-update-line">
				<span className="cc-tree-arm" aria-hidden="true">⎿</span>
				<span className="cc-todo-update-text">{state === "stopped" ? `未执行 · ${delta}` : delta}</span>
			</div>
			<SmoothCollapse open={open}>
				<div className="cc-todo-update-body">
					<TodoChecklist items={todos} running={false} now={0} max={50} showTiming={false} />
				</div>
			</SmoothCollapse>
		</div>
	);
}
