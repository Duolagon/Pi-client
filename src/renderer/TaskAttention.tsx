import { useId } from "react";
import { ChevronRight, Clock3, ShieldAlert } from "lucide-react";
import { SmoothCollapse } from "./SmoothCollapse.tsx";

export interface AttentionItem {
	id: string;
	title: string;
	detail: string;
	state: "approval" | "running" | "done";
	open: () => void;
}

function AttentionRows({ items }: { items: AttentionItem[] }) {
	return items.slice(0, 4).map((item) => (
		<button type="button" className="cc-attention-row" key={item.id} onClick={item.open} title={item.title}>
			<span><strong>{item.title}</strong><small>{item.detail}</small></span>
			<ChevronRight size={13} className="cc-attention-row-arrow" aria-hidden="true" />
		</button>
	));
}

export function TaskAttention({ items, openAll, showFinished, toggleFinished }: {
	items: AttentionItem[];
	openAll: () => void;
	showFinished: boolean;
	toggleFinished: () => void;
}) {
	const finishedId = useId();
	if (!items.length) return null;
	const finished = items.filter((item) => item.state === "done");
	return (
		<section className="cl-group cc-task-attention" aria-label="任务动态">
			<div className="cc-attention-heading">
				<h2>任务动态</h2>
				<button type="button" className="cc-attention-all" onClick={openAll}>全部任务</button>
			</div>
			{([
				["approval", "待我处理", ShieldAlert],
				["running", "进行中", Clock3],
			] as const).map(([state, label, Icon]) => {
				const group = items.filter((item) => item.state === state);
				if (!group.length) return null;
				return (
					<div key={state} className="cc-attention-group" data-state={state}>
						<h3>
							<span className={`cc-attn-beacon is-${state}`} aria-hidden="true" />
							<Icon size={12} aria-hidden="true" />
							{label}
							<span className="cc-attention-count">{group.length}</span>
						</h3>
						<AttentionRows items={group} />
					</div>
				);
			})}
			{finished.length > 0 && (
				<div className="cc-attention-group cc-attention-finished">
					<button
						type="button"
						className="cc-attention-disclosure"
						aria-expanded={showFinished}
						aria-controls={finishedId}
						onClick={toggleFinished}
					>
						<ChevronRight size={12} className="cc-attention-disclosure-arrow" aria-hidden="true" />
						最近结束<span className="cc-attention-count">{finished.length}</span>
					</button>
					<div id={finishedId}>
						<SmoothCollapse open={showFinished}>
							<AttentionRows items={finished} />
						</SmoothCollapse>
					</div>
				</div>
			)}
		</section>
	);
}
