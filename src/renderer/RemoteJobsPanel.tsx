import { useState, type FormEvent } from "react";
import { ArrowUpRight, Plus, RefreshCw, X } from "lucide-react";
import type { RemoteJobRecord } from "../remote-job-types.ts";
import { inspectKaggleMetadata } from "../kaggle-preflight.ts";

const statusLabels = {
	unknown: "尚未确认",
	queued: "排队中",
	running: "运行中",
	"awaiting-score": "待出分",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};
const queryErrors = {
	credentials: "缺少 Kaggle 凭据",
	access: "Kaggle 拒绝访问",
	"not-found": "找不到此版本或提交",
	unavailable: "无法连接 Kaggle",
	"invalid-response": "Kaggle 返回了无法识别的结果",
};

export function RemoteJobsPanel({ conversationId, jobs, fail }: {
	conversationId: string;
	jobs: RemoteJobRecord[];
	fail: (error: unknown) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [kind, setKind] = useState<"notebook" | "submission">("notebook");
	const [resource, setResource] = useState("");
	const [identifier, setIdentifier] = useState("");
	const [projectCredentials, setProjectCredentials] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [preflight, setPreflight] = useState<ReturnType<typeof inspectKaggleMetadata>>();
	const notebook = kind === "notebook";

	const change = async (operation: string, run: () => Promise<unknown>) => {
		setBusy(operation);
		try { await run(); }
		catch (error) { fail(error); }
		finally { setBusy(undefined); }
	};
	const track = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void change("track", async () => {
			await window.pi.remoteJobs.track(conversationId, notebook
				? { kind: "kaggle-notebook", notebook: resource.trim(), version: Number(identifier), useProjectCredentials: projectCredentials }
				: { kind: "kaggle-submission", competition: resource.trim(), submissionId: identifier.trim(), useProjectCredentials: projectCredentials });
			setAdding(false);
			setResource("");
			setIdentifier("");
			setProjectCredentials(false);
		});
	};
	const runPreflight = async (file: File) => {
		try {
			if (file.size > 1024 * 1024) throw new Error("Notebook 配置文件不能超过 1 MB。");
			setPreflight(inspectKaggleMetadata(await file.text()));
		} catch (error) {
			setPreflight(undefined);
			fail(error instanceof SyntaxError ? new Error("Notebook 配置文件不是有效的 JSON。") : error);
		}
	};

	return (
		<div className="cc-controls-body">
			<div className="cc-remote-jobs-heading">
				<p className="subtle-note">跟踪已启动的 Kaggle Notebook 版本或比赛提交。Pi 会在后台查询进度。</p>
				<div className="cc-tool-ctrl-actions">
					<label className="cc-mini-btn cc-preflight-upload">
						检查 Notebook 配置
						<input type="file" accept=".json,application/json" aria-label="检查 Notebook 配置" onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file) void runPreflight(file);
						}} />
					</label>
					{!adding && <button type="button" className="cc-mini-btn" onClick={() => setAdding(true)}><Plus size={13} /> 添加跟踪</button>}
				</div>
			</div>
			{preflight && (
				<div className="cc-tool-ctrl-row">
					<div className="cc-tool-ctrl-info">
						<div className="cc-tool-ctrl-name"><strong>Notebook 配置预检</strong></div>
						<p className="cc-tool-ctrl-desc">
							{preflight.accelerator ?? (preflight.gpu ? "GPU 型号未指定" : "加速器未指定")}
							{" · 网络"}{preflight.internet === undefined ? "配置无效" : preflight.internet ? "开启" : "关闭"}
							{` · 资源 ${Object.values(preflight.sources).reduce((total, refs) => total + refs.length, 0)} 项`}
						</p>
						{preflight.warnings.length > 0 ? (
							<ul className="cc-preflight-notes">
								{preflight.warnings.map((warning) => <li key={warning}>{warning}</li>)}
							</ul>
						) : <p className="cc-tool-ctrl-desc">配置字段通过检查。实际加速器、网络权限和依赖可用性由 Kaggle 运行环境决定。</p>}
					</div>
					<button type="button" className="cc-mini-btn" onClick={() => setPreflight(undefined)} aria-label="关闭预检结果"><X size={13} /></button>
				</div>
			)}
			{adding && (
				<form className="cc-remote-job-form" onSubmit={track}>
					<label>
						<span>跟踪类型</span>
						<select value={kind} onChange={(event) => {
							setKind(event.target.value === "submission" ? "submission" : "notebook");
							setResource("");
							setIdentifier("");
						}}>
							<option value="notebook">Notebook 运行</option>
							<option value="submission">比赛提交</option>
						</select>
					</label>
					<label>
						<span>{notebook ? "Notebook 标识" : "比赛标识"}</span>
						<input value={resource} onChange={(event) => setResource(event.target.value)}
							placeholder={notebook ? "owner/notebook-slug" : "competition-slug"} required maxLength={200} />
					</label>
					<label>
						<span>{notebook ? "版本号" : "提交编号"}</span>
						<input inputMode="numeric" value={identifier} onChange={(event) => setIdentifier(event.target.value)}
							pattern="[1-9][0-9]*" required maxLength={16} />
					</label>
					<label className="cc-remote-job-credentials">
						<input type="checkbox" checked={projectCredentials} onChange={(event) => setProjectCredentials(event.target.checked)} />
						<span>使用项目的 .secrets/kaggle_token</span>
					</label>
					<div className="cc-tool-ctrl-actions">
						<button type="button" className="cc-mini-btn" disabled={busy === "track"} onClick={() => setAdding(false)}>取消</button>
						<button type="submit" className="primary-button" disabled={Boolean(busy)}>开始跟踪</button>
					</div>
				</form>
			)}
			<div className="cc-list-scroll" aria-live="polite">
				{jobs.map((job) => {
					const target = job.kind === "kaggle-notebook" ? `${job.notebook} · v${job.version}` : `${job.competition} · 提交 #${job.submissionId}`;
					const tone = job.status === "failed" ? "deny" : job.status === "completed" ? "allow" : "ask";
					const artifacts = job.evidence?.artifactCount;
					const score = job.evidence?.publicScore;
					return (
						<div key={job.id} className="cc-tool-ctrl-row">
							<div className="cc-tool-ctrl-info">
								<div className="cc-tool-ctrl-name">
									<strong>{target}</strong>
									<span className={`cc-action-badge ${tone}`}>{statusLabels[job.status]}</span>
								</div>
								<p className="cc-tool-ctrl-desc">
									{job.checkedAt ? `更新于 ${new Date(job.checkedAt).toLocaleString()}` : "等待首次查询"}
									{artifacts !== undefined && ` · 输出文件 ${artifacts}${job.evidence?.artifactsMore ? "+" : ""}`}
									{score !== undefined && ` · 公开分数 ${score}`}
								</p>
								{job.queryError && (
									<p className="cc-tool-ctrl-desc" role="status">最近查询未成功（{queryErrors[job.queryError.code]}），上次状态保留。</p>
								)}
							</div>
							<div className="cc-tool-ctrl-actions">
								<a className="cc-mini-btn" href={job.url} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Kaggle</a>
								<button type="button" className="cc-mini-btn" disabled={Boolean(busy)}
									onClick={() => void change(job.id, () => window.pi.remoteJobs.refresh(conversationId, job.id))}><RefreshCw size={13} /> 刷新</button>
								<button type="button" className="cc-mini-btn" disabled={Boolean(busy)}
									onClick={() => void change(job.id, () => window.pi.remoteJobs.untrack(conversationId, job.id))}><X size={13} /> 移除跟踪</button>
							</div>
						</div>
					);
				})}
				{jobs.length === 0 && !adding && <p className="subtle-note">此会话暂无远端任务。</p>}
			</div>
		</div>
	);
}
