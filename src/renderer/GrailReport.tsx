import { Modal } from "../prototype/ui.tsx";
import { GRAIL_CRITERIA, type GrailVerdict } from "../shared.ts";
import { betterApproach, citationText, comparisonText, formatCost, gradeTone, type GrailWording } from "./grail-view.ts";

const CHECK_LABEL = { test: "测试", check: "类型检查", lint: "Lint" } as const;

/** Badge for one verdict; clicking it opens the report. */
export function GrailBadge({ verdict, wording, onOpen }: { verdict: GrailVerdict; wording: GrailWording; onOpen: () => void }) {
	return (
		<button
			type="button"
			className={`cc-grail-badge tone-${gradeTone(verdict.grade)}`}
			title={`${wording.report}：${verdict.reasons[0] ?? wording.grades[verdict.grade]}`}
			onClick={onOpen}
		>
			{wording.grades[verdict.grade]}
		</button>
	);
}

export function GrailReportDialog({
	verdict,
	wording,
	busy,
	canRejudge,
	canSeal,
	onRejudge,
	onSeal,
	close,
}: {
	verdict: GrailVerdict;
	wording: GrailWording;
	busy: boolean;
	canRejudge: boolean;
	canSeal: boolean;
	onRejudge: () => void;
	onSeal: () => void;
	close: () => void;
}) {
	const { objective, distortion, blind, comparison } = verdict.steps;
	const previous = comparisonText(verdict, wording);
	const better = betterApproach(verdict);
	return (
		<Modal title={wording.report} close={close} wide>
			<div className="simple-dialog cc-grail-report">
				<div className="cc-grail-report-head">
					<span className={`cc-grail-grade tone-${gradeTone(verdict.grade)}`}>{wording.grades[verdict.grade]}</span>
					<small className="subtle-note">
						第 {verdict.wish + 1} 个需求 · {new Date(verdict.finishedAt).toLocaleString()}
						{verdict.model ? ` · 评审 ${verdict.model.provider}/${verdict.model.id}` : ""} · 花费 {formatCost(verdict.costUsd)}
					</small>
				</div>
				{previous && <p className="cc-grail-previous">{previous}</p>}
				{verdict.reasons.length > 0 && (
					<ul className="cc-grail-reasons">
						{verdict.reasons.map((reason, index) => (
							<li key={index}>{reason}</li>
						))}
					</ul>
				)}
				{better && (
					<section>
						<h4>评审指出的更好写法</h4>
						<p>{better}</p>
					</section>
				)}
				{comparison?.status === "ok" && (
					<section>
						<h4>逐条结论</h4>
						<ul className="cc-grail-findings">
							{comparison.findings.map((finding, index) => (
								<li key={index} className={finding.pass ? "pass" : "fail"}>
									<strong>
										{finding.pass ? "通过" : "未通过"} · {GRAIL_CRITERIA[finding.criterion] ?? finding.criterion}
									</strong>
									{finding.note && <p>{finding.note}</p>}
									<span className="cc-grail-cites">
										{finding.citations.map((cite, n) => (
											<code key={n}>{citationText(cite)}</code>
										))}
									</span>
								</li>
							))}
						</ul>
						{comparison.dropped > 0 && <small className="subtle-note">另有 {comparison.dropped} 条没有引用代码行的意见已丢弃。</small>}
					</section>
				)}
				{blind?.solution && (
					<section>
						<h4>盲解要点（评审只看需求和改动前的仓库）</h4>
						<dl className="cc-grail-blind">
							<dt>根因</dt>
							<dd>{blind.solution.rootCause}</dd>
							<dt>下刀点</dt>
							<dd>{blind.solution.cutPoint}</dd>
							<dt>规模</dt>
							<dd>
								{blind.solution.sizeEstimate}
								{blind.solution.files.length > 0 && <>（{blind.solution.files.join("、")}）</>}
							</dd>
							{blind.solution.hardSpots.length > 0 && (
								<>
									<dt>难点</dt>
									<dd>{blind.solution.hardSpots.join("；")}</dd>
								</>
							)}
							{blind.solution.tests.length > 0 && (
								<>
									<dt>需要的测试</dt>
									<dd>{blind.solution.tests.join("；")}</dd>
								</>
							)}
						</dl>
					</section>
				)}
				{distortion && distortion.hits.length > 0 && (
					<section>
						<h4>扭曲扫描命中</h4>
						<ul className="cc-grail-hits">
							{distortion.hits.map((hit, index) => (
								<li key={index}>
									<code>{citationText(hit)}</code> {hit.rule}{hit.review ? " · 待评审" : ""}
									<pre>{hit.text}</pre>
								</li>
							))}
						</ul>
					</section>
				)}
				{objective && (
					<section>
						<h4>客观检查</h4>
						{objective.reason && <p className="subtle-note">{objective.reason}</p>}
						<ul className="cc-grail-checks">
							{objective.runs.map((run) => (
								<li key={run.name} className={run.exitCode === 0 && !run.timedOut ? "pass" : "fail"}>
									<strong>
										{CHECK_LABEL[run.name]} · <code>{run.command}</code> ·{" "}
										{run.timedOut ? "超时" : `退出码 ${run.exitCode ?? "无"}`}
										{run.testCount !== undefined ? ` · ${run.testCount} 个测试` : ""}
									</strong>
									{(run.exitCode !== 0 || run.timedOut) && run.output && <pre>{run.output.slice(-4000)}</pre>}
								</li>
							))}
						</ul>
					</section>
				)}
				{verdict.files.length > 0 && (
					<details>
						<summary>涉及 {verdict.files.length} 个文件</summary>
						<ul className="cc-grail-files">
							{verdict.files.map((file) => (
								<li key={file.path}>
									<code>{file.path}</code> {file.status}
								</li>
							))}
						</ul>
					</details>
				)}
				<div className="dialog-actions">
					<button type="button" className="secondary-button" disabled={busy || !canRejudge} onClick={onRejudge}>
						重新鉴定
					</button>
					<button type="button" className="secondary-button" disabled={busy || !canSeal} onClick={onSeal} title="封存后的改动算下一个需求">
						{wording.seal}
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

/** Original rising-chalice reveal for 圣杯显灵. Decorative only: no pointer events, no focus. */
export function GrailReveal({ label }: { label: string }) {
	return (
		<div className="grail-reveal" aria-hidden="true">
			<div className="grail-reveal-light" />
			<svg className="grail-reveal-cup" viewBox="0 0 64 64" width="88" height="88" fill="none" stroke="currentColor" strokeWidth="2.2">
				<path d="M18 16C18 31 23 39 32 39C41 39 46 31 46 16Z" fill="currentColor" fillOpacity="0.18" strokeLinejoin="round" />
				<path d="M15 16H49" strokeLinecap="round" />
				<path d="M32 39V51M24 52H40" strokeLinecap="round" />
				<path className="grail-reveal-overflow" d="M22 16C26 11 38 11 42 16" strokeLinecap="round" />
			</svg>
			{[0, 1, 2, 3, 4, 5].map((n) => (
				<span key={n} className={`grail-reveal-spark s${n}`} />
			))}
			<span className="grail-reveal-label">{label}</span>
		</div>
	);
}
