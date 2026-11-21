import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Bot, Eye, Square } from "lucide-react";
import { formatCompactDuration, formatCompactTokens } from "../delegation-format.ts";
import type { DesktopTask, ExternalTask, TaskProgress } from "../shared.ts";
import { buildSubagentPanelState, isActiveTaskStatus, type SubagentPanelRow } from "./subagent-panel-state.ts";

export interface SubagentPanelHandle {
	focusFirst(): boolean;
	hasRows(): boolean;
}

function statusLabel(row: SubagentPanelRow): string {
	if (row.waitingForApproval || row.status === "waiting_for_input") return "待审批";
	if (row.status === "running") return "运行中";
	if (row.status === "queued") return "排队中";
	if (row.status === "failed") return "失败";
	if (row.status === "cancelled") return "已停止";
	if (row.status === "interrupted") return "已中断";
	return "已完成";
}

function statusDotClass(row: SubagentPanelRow): string {
	if (row.status === "failed" || row.status === "cancelled" || row.status === "interrupted") return "err";
	if (row.status === "completed") return "ok";
	return "run";
}

export const SubagentPanel = forwardRef<
	SubagentPanelHandle,
	{
		parentConversationId?: string;
		tasks: DesktopTask[];
		externalTasks: ExternalTask[];
		progressMap: Record<string, TaskProgress>;
		onOpenTask: (row: SubagentPanelRow) => void;
		onStopTask: (row: SubagentPanelRow) => void;
		onBackgroundTask: (taskId: string) => void;
		onOpenTasksDrawer: () => void;
		onReturnToComposer: () => void;
	}
>(function SubagentPanel(
	{
		parentConversationId,
		tasks,
		externalTasks,
		progressMap,
		onOpenTask,
		onStopTask,
		onBackgroundTask,
		onOpenTasksDrawer,
		onReturnToComposer,
	},
	ref,
) {
	const [now, setNow] = useState(() => Date.now());
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	const state = useMemo(
		() => buildSubagentPanelState(tasks, externalTasks, progressMap, parentConversationId, now),
		[tasks, externalTasks, progressMap, parentConversationId, now],
	);

	const hasActive = state.rows.some((row) => isActiveTaskStatus(row.status));

	// Tick every 1s while any sub-agent is active so elapsed durations stay fresh;
	// otherwise schedule one wakeup for the soonest 30s expiry.
	useEffect(() => {
		if (hasActive) {
			const timer = setInterval(() => setNow(Date.now()), 1000);
			return () => clearInterval(timer);
		}
		if (state.nextExpiryAt !== undefined) {
			const delay = Math.max(50, state.nextExpiryAt - Date.now() + 20);
			const timer = setTimeout(() => setNow(Date.now()), delay);
			return () => clearTimeout(timer);
		}
	}, [hasActive, state.nextExpiryAt]);

	useEffect(() => {
		if (!state.rows.length) setSelectedIndex(0);
		else if (selectedIndex >= state.rows.length) setSelectedIndex(state.rows.length - 1);
	}, [state.rows.length, selectedIndex]);

	useImperativeHandle(
		ref,
		() => ({
			hasRows: () => state.rows.length > 0,
			focusFirst: () => {
				if (!state.rows.length) return false;
				setSelectedIndex(state.rows.length - 1);
				listRef.current?.focus();
				return true;
			},
		}),
		[state.rows.length],
	);

	if (!state.rows.length && state.completedHintCount === 0) return null;

	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!state.rows.length) return;
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			if (selectedIndex >= state.rows.length - 1) {
				onReturnToComposer();
			} else {
				setSelectedIndex((prev) => Math.min(state.rows.length - 1, prev + 1));
			}
		} else if (event.key === "Enter") {
			event.preventDefault();
			const row = state.rows[selectedIndex];
			if (row) onOpenTask(row);
		} else if (event.key === "x" || event.key === "X") {
			const row = state.rows[selectedIndex];
			if (row && isActiveTaskStatus(row.status)) {
				event.preventDefault();
				onStopTask(row);
			}
		} else if (event.key === "Escape") {
			event.preventDefault();
			onReturnToComposer();
		}
	};

	return (
		<div className="cc-subagent-panel" role="region" aria-label="子 Agent 面板">
			{state.rows.length > 0 && (
				<div
					ref={listRef}
					className="cc-subagent-list"
					tabIndex={0}
					role="listbox"
					aria-label="当前会话的子 Agent"
					aria-activedescendant={state.rows[selectedIndex] ? `cc-subagent-opt-${state.rows[selectedIndex].id}` : undefined}
					onKeyDown={handleKeyDown}
				>
					<div className="cc-subagent-panel-head">
						<span className="cc-subagent-panel-title">
							<Bot size={12} /> 子 Agent ({state.rows.length})
						</span>
						<span className="cc-subagent-panel-hint">↑↓ 选择 · Enter 打开 · x 停止 · Esc 返回</span>
					</div>
					{state.rows.map((row, index) => {
						const active = isActiveTaskStatus(row.status);
						const selected = index === selectedIndex;
						return (
							<div
								key={row.id}
								id={`cc-subagent-opt-${row.id}`}
								role="option"
								aria-selected={selected}
								className={`cc-subagent-row ${selected ? "selected" : ""} ${active ? "active" : "ended"}`}
								style={row.depth > 1 ? { paddingLeft: `${6 + (row.depth - 1) * 16}px` } : undefined}
								onClick={() => {
									setSelectedIndex(index);
									onOpenTask(row);
								}}
							>
								<span className={`cc-dot ${statusDotClass(row)}`} />
								{row.depth > 1 && <span className="cc-subagent-branch" aria-hidden="true">└</span>}
								<span className="cc-subagent-name" title={row.label}>
									{row.label}
								</span>
								{row.descendantCount > 0 && <span className="cc-source-tag">(+{row.descendantCount})</span>}
								<span className="cc-source-tag">{row.subagentType}</span>
								{row.model && <span className="cc-subagent-meta">{row.model}</span>}
								{row.toolUses !== undefined && row.toolUses > 0 && (
									<span className="cc-subagent-meta">
										{row.toolUses} 次工具{row.lastToolName ? ` · ${row.lastToolName}` : ""}
									</span>
								)}
								{row.tokens !== undefined && row.tokens > 0 && (
									<span className="cc-subagent-meta">{formatCompactTokens(row.tokens)} tokens</span>
								)}
								{row.durationMs !== undefined && (
									<span className="cc-subagent-meta">{formatCompactDuration(row.durationMs)}</span>
								)}
								<span className={`cc-subagent-status ${row.waitingForApproval ? "warn" : ""}`}>{statusLabel(row)}</span>
								<span className="cc-subagent-actions" onClick={(e) => e.stopPropagation()}>
									{row.canBackground && (
										<button
											type="button"
											className="cc-mini-btn"
											title="转到后台运行 (Ctrl+B)"
											onClick={() => onBackgroundTask(row.id)}
										>
											<ArrowDownToLine size={11} /> 转后台
										</button>
									)}
									<button
										type="button"
										className="cc-mini-btn"
										title="打开子 Agent 对话"
										onClick={() => onOpenTask(row)}
									>
										<Eye size={11} /> 打开
									</button>
									{active && (
										<button
											type="button"
											className="cc-mini-btn danger"
											title="停止子 Agent (x)"
											onClick={() => onStopTask(row)}
										>
											<Square size={10} /> 停止
										</button>
									)}
								</span>
							</div>
						);
					})}
				</div>
			)}
			{state.completedHintCount > 0 && (
				<div className="cc-subagent-completed-hint" role="status">
					<span>{state.completedHintCount} 个子 Agent 已完成，输入 /tasks 查看详情</span>
					<button type="button" className="cc-mini-btn" onClick={onOpenTasksDrawer}>
						打开 /tasks
					</button>
				</div>
			)}
		</div>
	);
});
