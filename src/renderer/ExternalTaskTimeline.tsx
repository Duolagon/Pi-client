import { useEffect, useMemo, useState } from "react";
import { formatCompactTokens } from "../delegation-format.ts";
import type { ExternalTask } from "../external-types.ts";
import { externalTimelineTurns, mergeExternalTimeline, timelineEvent, type ExternalTimelineEvent, type ExternalTimelineTurn } from "./external-timeline.ts";
import "./external-tasks.css";

interface PlayedTimeline { events: ExternalTimelineEvent[]; loading: boolean; truncated: boolean; failed: boolean }
const empty: PlayedTimeline = { events: [], loading: true, truncated: false, failed: false };
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const stepLabels = { pending: "待开始", in_progress: "进行中", completed: "已完成" };
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function ExternalTaskTimeline({ task }: { task: ExternalTask }) {
	const [played, setPlayed] = useState(empty);
	const [replayVersion, setReplayVersion] = useState(0);
	useEffect(() => {
		let mounted = true;
		setPlayed(empty);
		const unsubscribe = window.pi.externalAgents.onEvent((packet) => {
			if (packet.taskId !== task.id) return;
			const event = timelineEvent(packet);
			if (event) setPlayed((previous) => ({ ...previous, events: mergeExternalTimeline(previous.events, [event]) }));
		});
		void window.pi.externalAgents.replay(task.id).then((history) => {
			if (!mounted) return;
			const events = history.events.flatMap((packet) => {
				if (packet.taskId !== task.id) return [];
				const event = timelineEvent(packet);
				return event ? [event] : [];
			});
			setPlayed((previous) => ({ events: mergeExternalTimeline(previous.events, events), loading: false, truncated: history.truncated, failed: false }));
		}).catch(() => {
			if (mounted) setPlayed((previous) => ({ ...previous, loading: false, failed: true }));
		});
		return () => { mounted = false; unsubscribe(); };
	}, [task.id, replayVersion]);
	const turns = useMemo(() => {
		const result = externalTimelineTurns(played.events);
		if (task.usage) {
			const current = result.find((entry) => entry.turn === task.turn);
			if (current) current.usage = { ...current.usage, ...task.usage, type: "usage" };
			else result.unshift({ turn: task.turn, items: [], usage: { type: "usage", ...task.usage } });
		}
		return result;
	}, [played.events, task.turn, task.usage]);
	const active = task.status === "running" || task.status === "waiting_for_input";
	return (
		<section className="cc-external-timeline" aria-label="执行时间线">
			<h3>执行时间线</h3>
			<p className="subtle-note">{[task.executor, task.model ?? "CLI 默认模型", task.effort ?? "默认强度"].join(" · ")}</p>
			{played.loading && <p className="subtle-note" role="status">正在读取执行记录…</p>}
			{played.failed && <div className="cc-external-timeline-notice"><span>历史执行记录读取失败。</span><button type="button" className="cc-mini-btn" onClick={() => setReplayVersion((value) => value + 1)}>重试</button></div>}
			{played.truncated && <p className="subtle-note">较早的执行记录已截断。</p>}
			{!played.loading && !played.failed && !turns.length && <p className="subtle-note">暂无工具、计划或用量记录。</p>}
			{turns.map(({ turn, items, usage }) => (
				<div className="cc-external-turn" key={turn}>
					<div className="cc-external-turn-head"><h4>第 {turn} 轮</h4>{usage && <TurnUsage usage={usage} />}</div>
					{items.length > 0 && <ol className="cc-external-timeline-items">
						{items.map((item) => (
							<li key={item.sequence}>
								<time>{time.format(item.timestamp)}</time>
								<div className="cc-external-timeline-item">
									{item.kind === "tool" && <>
										<strong>{item.name || "工具调用"}</strong>
										<span className="cc-source-tag">{item.isError === true ? "失败" : item.isError === false ? "已完成" : active && turn === task.turn ? "运行中" : "未记录结果"}</span>
										{item.output && <details><summary>工具输出</summary><pre className="cc-bash-out">{item.output}{item.partialOutput ? "\n… 输出已截断" : ""}</pre></details>}
									</>}
									{item.kind === "plan" && <>
										<strong>计划步骤</strong>
										{item.plan.explanation && <p>{item.plan.explanation}</p>}
										{item.plan.steps.length > 0 && <ul className="cc-external-plan-steps">{item.plan.steps.map((step, index) => <li key={index}><span className="cc-source-tag">{stepLabels[step.status]}</span><span>{step.text}</span></li>)}</ul>}
									</>}
									{item.kind === "diagnostic" && <p className="subtle-note">{item.message}</p>}
								</div>
							</li>
						))}
					</ol>}
				</div>
			))}
		</section>
	);
}

function TurnUsage({ usage }: { usage: NonNullable<ExternalTimelineTurn["usage"]> }) {
	const parts = [];
	if (count(usage.inputTokens)) parts.push(`输入 ${formatCompactTokens(usage.inputTokens)} tokens`);
	if (count(usage.outputTokens)) parts.push(`输出 ${formatCompactTokens(usage.outputTokens)} tokens`);
	if (count(usage.cachedInputTokens)) parts.push(`缓存读取 ${formatCompactTokens(usage.cachedInputTokens)} tokens`);
	if (count(usage.cacheWriteTokens)) parts.push(`缓存写入 ${formatCompactTokens(usage.cacheWriteTokens)} tokens`);
	if (count(usage.costUsd)) parts.push(`本轮费用 ${money.format(usage.costUsd)}`);
	else if (count(usage.sessionCostUsd)) parts.push(`原生会话累计费用 ${money.format(usage.sessionCostUsd)}`);
	return parts.length ? <p className="subtle-note">{parts.join(" · ")}</p> : null;
}
