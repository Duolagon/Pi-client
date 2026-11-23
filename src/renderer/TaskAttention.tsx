import { ArrowRight, CircleCheck, Clock3, ShieldCheck } from "lucide-react";

export interface AttentionItem {
	id: string;
	title: string;
	detail: string;
	state: "approval" | "running" | "done";
	open: () => void;
}

export function TaskAttention({ items, openAll }: { items: AttentionItem[]; openAll: () => void }) {
	if (!items.length) return null;
	return (
		<section className="cl-group cc-task-attention" aria-label="任务动态">
			<div className="cc-attention-heading">
				<h2>任务动态</h2>
				<button type="button" className="cc-mini-btn" onClick={openAll}>全部任务</button>
			</div>
			{([
				["approval", "待我处理", ShieldCheck],
				["running", "进行中", Clock3],
				["done", "最近结束", CircleCheck],
			] as const).map(([state, label, Icon]) => {
				const group = items.filter((item) => item.state === state);
				if (!group.length) return null;
				return <div key={state} className="cc-attention-group">
					<h3><Icon size={13} aria-hidden="true" />{label} <span>{group.length}</span></h3>
					{group.slice(0, 4).map((item) => (
						<button type="button" className="cc-attention-row" key={item.id} onClick={item.open} title={item.title}>
							<span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={13} aria-hidden="true" />
						</button>
					))}
				</div>;
			})}
		</section>
	);
}
