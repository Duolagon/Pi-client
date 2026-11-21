import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, Copy, RefreshCw } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { DoctorCheck, DoctorReport, DoctorStatus } from "../shared.ts";
import { copyText } from "./clipboard.ts";

const STATUS_LABEL: Record<DoctorStatus, string> = { ok: "正常", warn: "注意", error: "异常" };

/** Plain-text report for pasting into an issue; values are already free of secrets. */
export function doctorReportText(report: DoctorReport): string {
	const lines = [`Pi Desktop 环境诊断 · ${new Date(report.generatedAt).toLocaleString()}`];
	for (const check of report.checks) lines.push(`[${STATUS_LABEL[check.status]}] ${check.label}：${check.detail}`);
	return lines.join("\n");
}

function StatusIcon({ status }: { status: DoctorStatus }) {
	if (status === "ok") return <CircleCheck size={16} aria-hidden="true" />;
	if (status === "warn") return <CircleAlert size={16} aria-hidden="true" />;
	return <CircleX size={16} aria-hidden="true" />;
}

export function DoctorDialog({ close, onNotice }: { close: () => void; onNotice: (message: string) => void }) {
	const [report, setReport] = useState<DoctorReport | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	const run = () => {
		setLoading(true);
		setError("");
		window.pi
			.doctor()
			.then(setReport)
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setLoading(false));
	};
	useEffect(run, []);

	const counts = (report?.checks ?? []).reduce(
		(total, check: DoctorCheck) => ({ ...total, [check.status]: total[check.status] + 1 }),
		{ ok: 0, warn: 0, error: 0 } as Record<DoctorStatus, number>,
	);

	return (
		<Modal title="环境诊断" close={close} wide>
			<div className="simple-dialog cc-doctor">
				<p className="subtle-note">只检查本机配置，不发送网络或模型请求。结果不含密钥内容。</p>
				{loading && !report && <p className="subtle-note">正在检查…</p>}
				{error && (
					<div className="live-error" role="alert">
						{error}
					</div>
				)}
				{report && (
					<>
						<p className="cc-doctor-summary" role="status">
							正常 {counts.ok} · 注意 {counts.warn} · 异常 {counts.error}
						</p>
						<ul className="cc-doctor-list">
							{report.checks.map((check) => (
								<li key={check.id} className={`cc-doctor-row ${check.status}`}>
									<span className="cc-doctor-status" title={STATUS_LABEL[check.status]}>
										<StatusIcon status={check.status} />
										<span>{STATUS_LABEL[check.status]}</span>
									</span>
									<strong>{check.label}</strong>
									<span className="cc-doctor-detail">{check.detail}</span>
								</li>
							))}
						</ul>
					</>
				)}
				<div className="dialog-actions">
					<button type="button" className="secondary-button" disabled={loading} onClick={run}>
						<RefreshCw size={14} aria-hidden="true" /> {loading ? "正在检查…" : "重新检查"}
					</button>
					<button
						type="button"
						className="secondary-button"
						disabled={!report}
						onClick={() =>
							report &&
							void copyText(doctorReportText(report)).then((ok) => onNotice(ok ? "已复制诊断报告到剪贴板。" : "复制失败，请手动选择文字复制。"))
						}
					>
						<Copy size={14} aria-hidden="true" /> 复制报告
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
