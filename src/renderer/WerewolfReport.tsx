import { useState } from "react";
import { Hourglass, Search, UserRoundCheck } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { WerewolfClaim, WerewolfEvidence, WerewolfReview } from "../werewolf-types.ts";
import { werewolfMetrics } from "./werewolf-view.ts";
import "./werewolf.css";

const REVIEW_LABELS = { pending: "核验中", verified: "好人 · 局部核实", contradicted: "狼人 · 与证据矛盾", unverified: "待核验" } satisfies Record<WerewolfReview["status"], string>;
const CLAIM_LABELS = { verified: "已核实", contradicted: "与证据矛盾", unverified: "待核验" } satisfies Record<WerewolfClaim["status"], string>;
const REPLAY_LABELS = { verified: "断言通过", contradicted: "断言未通过", unverified: "结果待确认" } satisfies Record<WerewolfClaim["status"], string>;
const percentage = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
type ReplayResult = { status: WerewolfClaim["status"]; evidence: WerewolfEvidence };
export type ReplayWerewolfClaim = (reviewId: string, claimId: string) => Promise<ReplayResult>;

function ReviewIcon({ status }: { status: WerewolfReview["status"] }) {
	if (status === "contradicted") return <span aria-hidden="true">🐺</span>;
	if (status === "verified") return <UserRoundCheck size={13} aria-hidden="true" />;
	if (status === "pending") return <Hourglass size={13} aria-hidden="true" />;
	return <Search size={13} aria-hidden="true" />;
}

export function WerewolfBadge({ review, onOpen }: { review: WerewolfReview; onOpen: () => void }) {
	const metrics = werewolfMetrics(review.claims);
	return (
		<button type="button" className={`cc-werewolf-badge ${review.status}`} aria-haspopup="dialog" onClick={onOpen}>
			<ReviewIcon status={review.status} />
			{REVIEW_LABELS[review.status]}
			{metrics.acceptanceTotal > 0 && <small>验收 {metrics.acceptanceVerified}/{metrics.acceptanceTotal}</small>}
		</button>
	);
}

function ClaimEvidence({ claim: { evidence, quote, requirements } }: { claim: WerewolfClaim }) {
	return (
		<dl className="cc-werewolf-evidence">
			{requirements && <><dt>验收要求</dt><dd>{requirements}</dd></>}
			{quote && <><dt>回复原话</dt><dd><q>{quote}</q></dd></>}
			{evidence && <><dt>证据</dt><dd>{evidence.summary}</dd></>}
			{evidence?.expected && <><dt>预期</dt><dd>{evidence.expected}</dd></>}
			{evidence?.actual && <><dt>实际</dt><dd>{evidence.actual}</dd></>}
			{evidence?.source && <><dt>来源</dt><dd><code>{evidence.source}</code></dd></>}
			{evidence?.reproduction && <><dt>复现</dt><dd><pre tabIndex={0} aria-label="复现步骤">{evidence.reproduction}</pre></dd></>}
		</dl>
	);
}

function canReplay(claim: WerewolfClaim, review: WerewolfReview): boolean {
	if (!review.checkpointId || !claim.evidence?.reproduction) return false;
	try {
		const probe = JSON.parse(claim.evidence.reproduction) as { kind?: unknown } | null;
		return probe?.kind === "behavior";
	} catch {
		return false;
	}
}

function ReplayControl({ replay }: { replay: () => Promise<ReplayResult> }) {
	const [replaying, setReplaying] = useState(false);
	const [result, setResult] = useState<ReplayResult>();
	const [error, setError] = useState<string>();
	const run = async () => {
		setReplaying(true);
		setResult(undefined);
		setError(undefined);
		try { setResult(await replay()); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setReplaying(false); }
	};
	return (
		<div className="cc-werewolf-replay">
			<button type="button" className="secondary-button" disabled={replaying} onClick={() => void run()}>{replaying ? "重放中…" : "重放证据"}</button>
			{error && <p role="alert">{error}</p>}
			{result && <div role="status">
				<strong>重放结果 · {REPLAY_LABELS[result.status]}</strong>
				<p>{result.evidence.summary}</p>
				{result.evidence.actual && <pre tabIndex={0} aria-label="重放实际结果">{result.evidence.actual}</pre>}
			</div>}
		</div>
	);
}

export function WerewolfReportDialog({ review, close, onReplay }: { review: WerewolfReview; close: () => void; onReplay?: ReplayWerewolfClaim }) {
	const metrics = werewolfMetrics(review.claims);
	return (
		<Modal title="狼人核验" close={close} wide>
			<div className="simple-dialog cc-werewolf-report">
				<div className={`cc-werewolf-summary ${review.status}`} role="status">
					<ReviewIcon status={review.status} />
					<strong>{REVIEW_LABELS[review.status]}</strong>
					{review.revision && <code title={review.revision}>版本 {review.revision.slice(0, 12)}</code>}
					<small>{new Date(review.createdAt).toLocaleString("zh-CN")}</small>
				</div>
				{review.status === "pending" && <p className="subtle-note">正在核对本条回复与执行证据。</p>}
				{review.error && <p className="subtle-note">{review.error}</p>}
				{review.status !== "pending" && <dl className="cc-werewolf-metrics">
					<div><dt title="被反证的声明占有明确结论的声明比例">幻觉率</dt><dd>{metrics.hallucinationRate === undefined ? "样本不足" : `${percentage.format(metrics.hallucinationRate)}（${metrics.contradicted}/${metrics.checked}）`}</dd></div>
					<div><dt title="有明确结论的声明占已提取声明的比例">声明核验覆盖率</dt><dd>{metrics.coverage === undefined ? "样本不足" : `${percentage.format(metrics.coverage)}（${metrics.checked}/${metrics.total}）`}</dd></div>
					{metrics.acceptanceTotal > 0 && <div><dt>需求验收</dt><dd>{metrics.acceptanceVerified}/{metrics.acceptanceTotal}</dd></div>}
				</dl>}
				{review.status !== "pending" && metrics.total > 0 && <p className="subtle-note">回复声明中，{metrics.verified} 项已核实 · {metrics.contradicted} 项与证据矛盾 · {metrics.pending} 项待核验</p>}
				{review.claims.length > 0 && <ul className="cc-werewolf-claims">
					{[...review.claims].sort((first, second) => Number(second.status === "contradicted") - Number(first.status === "contradicted")).map((claim) => (
						<li key={claim.id}>
							<h3><span className={claim.status}>{CLAIM_LABELS[claim.status]}</span>{" · "}{claim.description}</h3>
							<ClaimEvidence claim={claim} />
							{onReplay && canReplay(claim, review) && <ReplayControl replay={() => onReplay(review.id, claim.id)} />}
						</li>
					))}
				</ul>}
			</div>
		</Modal>
	);
}
