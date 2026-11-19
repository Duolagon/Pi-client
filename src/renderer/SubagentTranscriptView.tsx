import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, Bot, Send, Square } from "lucide-react";
import { formatCompactDuration, formatCompactTokens, formatTaskProgressSummary } from "../delegation-format.ts";
import type { DesktopAPI, DesktopTask, RpcExtensionUIRequest, TaskProgress } from "../shared.ts";
import { applyEvent, transcript, type Transcript } from "./messages.ts";
import { TranscriptView } from "./TranscriptView.tsx";
import { classifySubagentViewSlash, isActiveTaskStatus } from "./subagent-panel-state.ts";

/**
 * Focused view of a single Pi sub-agent's live transcript inside the main area.
 * Reuses TranscriptView and live conversation events; messages go through `pi:task:send`
 * so the host keeps turn numbers and state transitions consistent.
 */
export function SubagentTranscriptView({
	api,
	task,
	progress,
	onBack,
	onMainCompact,
	onMainClear,
	onNotice,
	fail,
}: {
	api: DesktopAPI;
	task: DesktopTask;
	progress?: TaskProgress;
	onBack: () => void;
	onMainCompact: (customInstructions?: string) => void;
	onMainClear: () => void;
	onNotice: (message: string) => void;
	fail: (error: unknown) => void;
}) {
	const [history, setHistory] = useState<Transcript>(() => transcript([]));
	const [pendingUI, setPendingUI] = useState<RpcExtensionUIRequest[]>([]);
	const [loading, setLoading] = useState(true);
	const [input, setInput] = useState("");
	const [notifyParent, setNotifyParent] = useState(false);
	const [sending, setSending] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToEnd = useRef(true);

	const active = isActiveTaskStatus(task.status);
	const canBackground = active && !task.runInBackground && Boolean(task.readOnly || task.worktreeId);

	useEffect(() => {
		void api.tasks.viewing(task.conversationId, true).catch(() => {});
		return () => {
			void api.tasks.viewing(task.conversationId, false).catch(() => {});
		};
	}, [api, task.conversationId]);

	useEffect(() => {
		let mounted = true;
		let appliedSeq = 0;
		const loadSnapshot = async () => {
			try {
				const snap = await api.tasks.snapshot(task.id);
				if (!mounted) return;
				appliedSeq = snap.eventSequence ?? 0;
				setHistory(transcript(snap.messages, snap.liveTranscript));
				setPendingUI(snap.pendingUI.filter((r) => ["confirm", "select", "input", "editor"].includes(r.method)));
			} catch (error) {
				if (mounted) fail(error);
			} finally {
				if (mounted) setLoading(false);
			}
		};
		void loadSnapshot();
		const unsub = api.onEvent((packet) => {
			if (packet.conversationId !== task.conversationId) return;
			if (packet.sequence !== undefined) {
				if (packet.sequence <= appliedSeq) return;
				appliedSeq = packet.sequence;
			}
			const event = packet.event;
			if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
				setPendingUI((prev) => (prev.some((item) => item.id === event.id) ? prev : [...prev, event]));
				return;
			}
			if (event.type === "agent_settled") {
				setPendingUI([]);
				void loadSnapshot();
			}
			setHistory((prev) => applyEvent(prev, event));
		});
		return () => {
			mounted = false;
			unsub();
		};
	}, [api, task.id, task.conversationId]);

	useEffect(() => {
		if (stickToEnd.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [history]);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = input.trim();
		if (!trimmed || sending) return;
		const decision = classifySubagentViewSlash(trimmed);
		if (decision.action === "blocked") {
			fail(new Error(decision.reason));
			return;
		}
		if (decision.action === "confirm_main") {
			const label = decision.command === "compact" ? "压缩主会话上下文 (/compact)" : "清空并新建主会话 (/clear)";
			if (!window.confirm(`当前处于子 Agent 视图，是否确认对主会话执行：${label}？`)) return;
			setInput("");
			if (decision.command === "compact") onMainCompact(decision.args);
			else onMainClear();
			return;
		}
		setSending(true);
		try {
			const sent = await api.tasks.send({
				taskId: task.id,
				message: trimmed,
				...(task.parentConversationId ? { notifyParent } : {}),
			});
			setInput("");
			onNotice(sent.status === "delivered_to_running_agent" ? "消息已送达运行中的子 Agent。" : "已向子 Agent 发送新消息。");
		} catch (error) {
			fail(error);
		} finally {
			setSending(false);
		}
	};

	const statsSummary = (() => {
		if (active && progress) return formatTaskProgressSummary(progress);
		const parts: string[] = [];
		const model = task.stats?.model?.id ?? task.model?.id;
		if (model) parts.push(model);
		if (task.stats?.tokens.total) parts.push(`${formatCompactTokens(task.stats.tokens.total)} tokens`);
		if (task.stats?.toolUses) parts.push(`${task.stats.toolUses} 次工具`);
		if (task.stats?.durationMs !== undefined) parts.push(formatCompactDuration(task.stats.durationMs));
		if (task.stopReason) parts.push(task.stopReason);
		return parts.join(" · ");
	})();

	return (
		<div className="cc-subagent-view">
			<div className="cc-subagent-view-head">
				<button type="button" className="secondary-button" onClick={onBack}>
					<ArrowLeft size={13} /> 返回主会话
				</button>
				<div className="cc-subagent-view-title">
					<Bot size={14} />
					<strong>{task.name || task.title || task.subagentType || "子 Agent"}</strong>
					{task.subagentType && <span className="cc-source-tag">{task.subagentType}</span>}
					<span className="cc-source-tag">{task.status}</span>
					<span className="cc-source-tag muted">turn {task.turn ?? 1}</span>
				</div>
				<div className="cc-subagent-view-actions">
					{statsSummary && <span className="cc-subagent-meta">{statsSummary}</span>}
					{canBackground && (
						<button
							type="button"
							className="cc-mini-btn"
							onClick={() => void api.tasks.background(task.id).then(() => onNotice("已转到后台运行。")).catch(fail)}
						>
							<ArrowDownToLine size={12} /> 转到后台
						</button>
					)}
					{active && (
						<button
							type="button"
							className="cc-mini-btn danger"
							onClick={() => void api.tasks.cancel(task.id).catch(fail)}
						>
							<Square size={11} /> 停止
						</button>
					)}
				</div>
			</div>

			{pendingUI.length > 0 && pendingUI[0].method === "confirm" && (
				<div className="cc-task-approval cc-subagent-view-approval">
					<span>待审批：{pendingUI[0].title}</span>
					<div>
						<button
							type="button"
							className="secondary-button"
							onClick={() =>
								void api.tasks
									.respond(task.id, { type: "extension_ui_response", id: pendingUI[0].id, confirmed: false })
									.then(() => setPendingUI((prev) => prev.slice(1)))
									.catch(fail)
							}
						>
							拒绝
						</button>
						<button
							type="button"
							className="primary-button"
							onClick={() =>
								void api.tasks
									.respond(task.id, { type: "extension_ui_response", id: pendingUI[0].id, confirmed: true })
									.then(() => setPendingUI((prev) => prev.slice(1)))
									.catch(fail)
							}
						>
							允许
						</button>
					</div>
				</div>
			)}

			<div
				className="cl-scroll"
				ref={scrollRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{loading ? (
					<div className="cl-working" role="status">
						<span className="cl-spinner" /> 正在加载子 Agent 记录…
					</div>
				) : history.messages.length ? (
					<TranscriptView transcript={history} />
				) : (
					<p className="subtle-note cc-subagent-view-empty">子 Agent 尚无输出。</p>
				)}
				{active && (
					<div className="cl-working" role="status">
						<span className="cl-spinner" /> {progress ? formatTaskProgressSummary(progress) : "子 Agent 正在运行…"}
					</div>
				)}
			</div>

			{!task.quarantined && task.status !== "queued" && (
				<form className="cc-subagent-view-composer" onSubmit={(e) => void handleSubmit(e)}>
					<input
						aria-label="向子 Agent 发送消息"
						placeholder={active ? "向运行中的子 Agent 补充说明（下一轮生效）…" : "向子 Agent 继续对话（保留上下文）…"}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						disabled={sending}
					/>
					{task.parentConversationId && !active && (
						<label className="cc-task-notify" title="本轮完成后，把结果作为子 Agent 通知交付给主会话">
							<input type="checkbox" checked={notifyParent} onChange={(e) => setNotifyParent(e.target.checked)} disabled={sending} />
							完成后通知主会话
						</label>
					)}
					<button type="submit" className="primary-button" disabled={sending || !input.trim()}>
						<Send size={13} /> {active ? "发送" : "继续对话"}
					</button>
				</form>
			)}
		</div>
	);
}
