import { useEffect, useState, type CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { UsageBucket, UsageStatsReport } from "../shared.ts";

function tokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function cost(value: number): string {
	return `$${value.toFixed(value >= 100 ? 2 : 4)}`;
}

function UsageTable({ rows, label, bar }: { rows: UsageBucket[]; label: string; bar?: boolean }) {
	// The bar shows cost when any row has a price, else total tokens.
	const byCost = rows.some((row) => row.cost > 0);
	const max = Math.max(1e-9, ...rows.map((row) => (byCost ? row.cost : row.tokens)));
	return (
		<table className="cc-usage-table">
			<thead>
				<tr>
					<th scope="col">{label}</th>
					<th scope="col">输入</th>
					<th scope="col">输出</th>
					<th scope="col">缓存读/写</th>
					<th scope="col">费用</th>
					{bar && <th scope="col" aria-label={byCost ? "费用占比" : "Token 占比"} />}
				</tr>
			</thead>
			<tbody>
				{rows.map((row, idx) => (
					<tr key={row.key} style={{ "--row-i": idx } as CSSProperties}>
						<th scope="row" className="cc-usage-key" title={`${row.key} · ${row.messages} 条回复`}>
							{row.key}
						</th>
						<td>{tokens(row.input)}</td>
						<td>{tokens(row.output)}</td>
						<td>
							{tokens(row.cacheRead)} / {tokens(row.cacheWrite)}
						</td>
						<td>{cost(row.cost)}</td>
						{bar && (
							<td className="cc-usage-bar-cell">
								<span
									className="cc-usage-bar"
									style={{ width: `${Math.max(2, ((byCost ? row.cost : row.tokens) / max) * 100)}%` }}
								/>
							</td>
						)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** /stats: token usage and cost by day and model across all local sessions. */
export function UsageStatsDialog({ close }: { close: () => void }) {
	const [report, setReport] = useState<UsageStatsReport | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const run = () => {
		setLoading(true);
		setError("");
		window.pi
			.usageStats({ days: 30 })
			.then(setReport)
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setLoading(false));
	};
	useEffect(run, []);
	const totals = report?.totals;
	return (
		<Modal title="用量统计" close={close} wide>
			<div className="simple-dialog cc-usage">
				<p className="subtle-note">
					统计本机全部会话（含子 Agent 会话）近 30 天的 Token 用量，只读取本地会话记录。费用取决于服务商定价，服务商未报价时记为 $0。
				</p>
				{loading && !report && <p className="subtle-note cc-shimmer-text">正在统计…</p>}
				{error && (
					<div className="live-error" role="alert">
						{error}
					</div>
				)}
				{report && totals && (
					<>
						<dl className="cc-usage-totals">
							<div>
								<dt>总 Token</dt>
								<dd>{tokens(totals.tokens)}</dd>
							</div>
							<div>
								<dt>输入 / 输出</dt>
								<dd>
									{tokens(totals.input)} / {tokens(totals.output)}
								</dd>
							</div>
							<div>
								<dt>缓存读 / 写</dt>
								<dd>
									{tokens(totals.cacheRead)} / {tokens(totals.cacheWrite)}
								</dd>
							</div>
							<div>
								<dt>费用</dt>
								<dd>{cost(totals.cost)}</dd>
							</div>
							<div>
								<dt>模型回复</dt>
								<dd>{totals.messages}</dd>
							</div>
						</dl>
						{report.skipped > 0 && <p className="subtle-note">有 {report.skipped} 个会话文件无法读取，已跳过。</p>}
						{report.days.length === 0 ? (
							<p className="subtle-note">近 30 天没有用量记录。</p>
						) : (
							<>
								<h3 className="cc-usage-heading">按日（自 {report.since} 起）</h3>
								<UsageTable rows={report.days} label="日期" bar />
								<h3 className="cc-usage-heading">按模型</h3>
								<UsageTable rows={report.models} label="模型" bar />
							</>
						)}
					</>
				)}
				<div className="dialog-actions">
					<button type="button" className="secondary-button" disabled={loading} onClick={run}>
						<RefreshCw size={14} className={loading ? "cc-spin" : undefined} aria-hidden="true" /> {loading ? "正在统计…" : "刷新"}
					</button>
					<span />
					<button type="button" className="primary-button" onClick={close}>
						关闭
					</button>
				</div>
			</div>
		</Modal>
	);
}
