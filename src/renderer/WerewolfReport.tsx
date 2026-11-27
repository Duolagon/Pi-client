import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowUpRight, Check, Crosshair, ExternalLink, GitCommitHorizontal, LoaderCircle, MessageSquareWarning, Play, RotateCcw } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { SurfacePresence } from "./Presence.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import { MetricRingGauge, MoonWatchIcon, SeerEyeEmblem, VillagerSealEmblem, WolfFangEmblem } from "./WerewolfIcons.tsx";
import type { WerewolfClaim, WerewolfEvidence, WerewolfReview, WerewolfState } from "../werewolf-types.ts";
import {
	buildWerewolfConfrontPrompt,
	classifyWerewolfClaim,
	parseProbeSignature,
	summarizeWerewolfSession,
	werewolfMetrics,
	type WerewolfClaimCategory,
} from "./werewolf-view.ts";
import "./werewolf.css";

const REVIEW_LABELS = {
	pending: "核验中",
	verified: "好人 · 局部核实",
	contradicted: "狼人 · 与证据矛盾",
	unverified: "待核验",
} satisfies Record<WerewolfReview["status"], string>;

const HERO_SUBTITLES = {
	pending: "预言家正在隔离快照中比对承诺原话、回执与可执行探针…",
	verified: "所有已检验的客观承诺均与实测快照及命令回执吻合，未发现伪造结论。",
	contradicted: "独立沙箱探针或宿主回执推翻了回复中的事实声明，请审阅下方破绽证据。",
	unverified: "部分声明暂缺可直接绑定的确定性探针，或属于待补充的验收项。",
} satisfies Record<WerewolfReview["status"], string>;

const TAROT_ROLE = {
	pending: { en: "SEER", stamp: "夜查中" },
	verified: { en: "VILLAGER", stamp: "金水" },
	contradicted: { en: "WEREWOLF", stamp: "破绽" },
	unverified: { en: "SHROUDED", stamp: "迷雾" },
} satisfies Record<WerewolfReview["status"], { en: string; stamp: string }>;

const CLAIM_LABELS = {
	verified: "已核实",
	contradicted: "与证据矛盾",
	unverified: "待核验",
} satisfies Record<WerewolfClaim["status"], string>;

const REPLAY_LABELS = {
	verified: "断言通过",
	contradicted: "断言未通过",
	unverified: "结果待确认",
} satisfies Record<WerewolfClaim["status"], string>;

const percentage = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
type ReplayResult = { status: WerewolfClaim["status"]; evidence: WerewolfEvidence };
export type ReplayWerewolfClaim = (reviewId: string, claimId: string) => Promise<ReplayResult>;

function ReviewIcon({ status, size = 13 }: { status: WerewolfReview["status"]; size?: number }) {
	if (status === "contradicted") return <WolfFangEmblem size={size} />;
	if (status === "verified") return <VillagerSealEmblem size={size} />;
	if (status === "pending") return <SeerEyeEmblem size={size} animated />;
	return <SeerEyeEmblem size={size} />;
}

export function WerewolfBadge({ review, onOpen }: { review: WerewolfReview; onOpen: () => void }) {
	const metrics = werewolfMetrics(review.claims);
	if (review.status === "pending") {
		return (
			<button type="button" className="cc-werewolf-badge pending" aria-haspopup="dialog" onClick={onOpen}>
				<ReviewIcon status="pending" size={13} />
				<span>核验中</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			className={`cc-werewolf-badge ${review.status}`}
			aria-haspopup="dialog"
			title={`${REVIEW_LABELS[review.status]} · 点击打开独立证据审判庭`}
			onClick={onOpen}
		>
			<ReviewIcon status={review.status} size={13} />
			<span>{REVIEW_LABELS[review.status]}</span>
			{review.status === "contradicted" && metrics.contradicted > 0 ? (
				<small>破绽 {metrics.contradicted}</small>
			) : (
				metrics.acceptanceTotal > 0 && <small>验收 {metrics.acceptanceVerified}/{metrics.acceptanceTotal}</small>
			)}
		</button>
	);
}

/** Inline alert strip rendered on turns where Werewolf caught an explicit factual contradiction. */
export function WerewolfCalloutStrip({
	review,
	onOpenReport,
	onConfront,
}: {
	review: WerewolfReview;
	onOpenReport: () => void;
	onConfront?: (prompt: string) => void;
}) {
	if (review.status !== "contradicted") return null;
	const contradictedClaims = review.claims.filter((c) => c.status === "contradicted");
	const first = contradictedClaims[0];
	const confrontPrompt = useMemo(() => buildWerewolfConfrontPrompt(review), [review]);
	return (
		<div className="cc-werewolf-callout" role="region" aria-label="独立证据警示">
			<div className="cc-werewolf-callout-icon" aria-hidden="true">
				<WolfFangEmblem size={16} />
			</div>
			<div className="cc-werewolf-callout-body">
				<strong>
					识破 {contradictedClaims.length || 1} 处事实矛盾
					{first?.evidence?.actual !== undefined ? ` · 实测返回 ${first.evidence.actual.slice(0, 48)}` : ""}
				</strong>
				{first && <p>{first.quote ? `原话「${first.quote.slice(0, 88)}」与沙箱实测结果相悖` : first.description}</p>}
			</div>
			<div className="cc-werewolf-callout-actions">
				<button type="button" className="cc-mini-btn" onClick={onOpenReport}>
					审阅证词
				</button>
				{onConfront && confrontPrompt && (
					<button type="button" className="cc-mini-btn cc-ww-confront-btn" onClick={() => onConfront(confrontPrompt)}>
						追责修复
					</button>
				)}
			</div>
		</div>
	);
}

/** Topbar Night-Watch radar pill & interactive session dossier popover. */
export function WerewolfRadarControl({
	state,
	toggling,
	disabled = false,
	onToggle,
	onJumpToReview,
	onOpenReview,
}: {
	state?: WerewolfState;
	toggling: boolean;
	disabled?: boolean;
	onToggle: () => void;
	onJumpToReview: (review: WerewolfReview) => void;
	onOpenReview: (review: WerewolfReview) => void;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const summary = useMemo(() => summarizeWerewolfSession(state?.reviews ?? []), [state?.reviews]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!state) return null;
	const tone = !state.enabled
		? "off"
		: summary.pendingCount > 0
			? "pending"
			: summary.wolfTurns > 0
				? "contradicted"
				: summary.villagerTurns > 0
					? "verified"
					: "idle";

	const orderedReviews = [...state.reviews].reverse();

	return (
		<div className="cc-werewolf-radar-wrap" ref={wrapRef}>
			<button
				type="button"
				className={`cc-top-btn cc-werewolf-radar-btn tone-${tone} ${open ? "active" : ""}`.trim()}
				aria-label="预言家守夜台"
				aria-expanded={open}
				aria-haspopup="dialog"
				disabled={disabled}
				title={
					!state.enabled
						? "独立证据核验已停用（点击打开守夜台）"
						: summary.pendingCount > 0
							? `正在后台核验 ${summary.pendingCount} 条回复…`
							: summary.wolfTurns > 0
								? `本会话揪出 ${summary.wolfTurns} 轮矛盾破绽 · 点击查看守夜台`
								: "预言家守夜开启中 · 自动查验每轮代码承诺"
				}
				onClick={() => setOpen((v) => !v)}
			>
				{tone === "pending" ? (
					<SeerEyeEmblem size={14} animated />
				) : tone === "contradicted" ? (
					<WolfFangEmblem size={14} />
				) : tone === "verified" ? (
					<VillagerSealEmblem size={14} />
				) : (
					<MoonWatchIcon size={14} />
				)}
				<span className="cc-ww-radar-label">
					{!state.enabled ? "未守夜" : tone === "pending" ? "夜查中" : "守夜"}
				</span>
				{state.enabled && (summary.wolfTurns > 0 || summary.villagerTurns > 0 || summary.pendingCount > 0) && (
					<em className={`cc-top-count ${summary.wolfTurns > 0 ? "danger" : summary.pendingCount > 0 ? "warn" : "ok"}`.trim()}>
						{summary.wolfTurns > 0 ? summary.wolfTurns : summary.pendingCount > 0 ? summary.pendingCount : summary.villagerTurns}
					</em>
				)}
			</button>
			<SurfacePresence show={open} direction="down">
				{(popRef) => (
					<div ref={popRef} className="cc-werewolf-popover" role="dialog" aria-label="预言家守夜台面板">
						<div className="cc-ww-pop-head">
							<div className="cc-ww-pop-title">
								<MoonWatchIcon size={15} />
								<div>
									<strong>预言家守夜台</strong>
									<small>{state.enabled ? "自动在检查点回复后独立取证" : "当前会话已暂停自动取证"}</small>
								</div>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={state.enabled}
								aria-label="切换自动核验开关"
								className={`cc-ww-switch ${state.enabled ? "on" : ""}`}
								disabled={toggling}
								onClick={onToggle}
							>
								<span className="cc-ww-switch-thumb" />
							</button>
						</div>

						<div className="cc-ww-pop-stats">
							<div className="cc-ww-stat-box crimson">
								<span>识破破绽</span>
								<strong>{summary.wolfTurns} 轮</strong>
							</div>
							<div className="cc-ww-stat-box emerald">
								<span>金水通过</span>
								<strong>{summary.villagerTurns} 轮</strong>
							</div>
							<div className="cc-ww-stat-box indigo">
								<span>总幻觉率</span>
								<strong>
									{summary.hallucinationRate === undefined ? "—" : percentage.format(summary.hallucinationRate)}
								</strong>
							</div>
						</div>

						{orderedReviews.length > 0 ? (
							<div className="cc-ww-pop-list" role="list" aria-label="本会话查验记录">
								{orderedReviews.slice(0, 12).map((rev, i) => {
									const m = werewolfMetrics(rev.claims);
									return (
										<div key={rev.id} className={`cc-ww-pop-row ${rev.status}`} role="listitem">
											<span className="cc-ww-pop-icon">
												<ReviewIcon status={rev.status} size={14} />
											</span>
											<div className="cc-ww-pop-info">
												<strong>
													#{state.reviews.length - i} · {REVIEW_LABELS[rev.status]}
												</strong>
												<small>
													{new Date(rev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
													{rev.status !== "pending" && ` · ${m.verified} 核实 / ${m.contradicted} 矛盾`}
												</small>
											</div>
											<div className="cc-ww-pop-actions">
												<button
													type="button"
													className="cc-mini-btn"
													title="滚动定位到该轮回复"
													onClick={() => {
														setOpen(false);
														onJumpToReview(rev);
													}}
												>
													<Crosshair size={11} />
												</button>
												<button
													type="button"
													className="cc-mini-btn"
													onClick={() => {
														setOpen(false);
														onOpenReview(rev);
													}}
												>
													卷宗
												</button>
											</div>
										</div>
									);
								})}
							</div>
						) : (
							<p className="cc-ww-pop-empty">
								{state.enabled
									? "尚无查验记录。当模型产生带代码检查点的回复后，预言家将自动在隔离快照中取证核实。"
									: "开启右上角开关后，预言家将在每轮代码修改后独立抽检事实承诺。"}
							</p>
						)}
					</div>
				)}
			</SurfacePresence>
		</div>
	);
}

function isLikelyFilePath(source?: string): boolean {
	if (!source) return false;
	const clean = source.split(":")[0];
	return clean.includes("/") || /\.[a-z0-9]{1,6}$/i.test(clean);
}

function ClaimEvidence({
	claim: { status, evidence, quote, requirements },
	onOpenFile,
}: {
	claim: WerewolfClaim;
	onOpenFile?: (path: string, line?: number) => void;
}) {
	const parsedSource = useMemo(() => {
		if (!evidence?.source || !isLikelyFilePath(evidence.source)) return undefined;
		const match = /^([^:]+?)(?::(\d+))?$/.exec(evidence.source.trim());
		if (!match) return undefined;
		return { path: match[1], line: match[2] ? Number(match[2]) : undefined };
	}, [evidence?.source]);

	return (
		<dl className="cc-werewolf-evidence">
			{requirements && (
				<>
					<dt>验收要求</dt>
					<dd className="cc-ww-req-val">{requirements}</dd>
				</>
			)}
			{quote && (
				<>
					<dt>回复原话</dt>
					<dd className="cc-ww-quote-val">
						<q>{quote}</q>
					</dd>
				</>
			)}
			{evidence && (
				<>
					<dt>证据</dt>
					<dd>{evidence.summary}</dd>
				</>
			)}
			{evidence?.expected !== undefined && (
				<>
					<dt>预期</dt>
					<dd className="cc-ww-expected-val">{evidence.expected}</dd>
				</>
			)}
			{evidence?.actual !== undefined && (
				<>
					<dt>实际</dt>
					<dd className={`cc-ww-actual-val ${status === "contradicted" ? "is-mismatch" : status === "verified" ? "is-match" : ""}`.trim()}>
						{evidence.actual}
					</dd>
				</>
			)}
			{evidence?.source && (
				<>
					<dt>来源</dt>
					<dd>
						{parsedSource && onOpenFile ? (
							<button
								type="button"
								className="cc-ww-source-link"
								title="在编辑器中打开源码位置"
								onClick={() => onOpenFile(parsedSource.path, parsedSource.line)}
							>
								<code>{evidence.source}</code>
								<ExternalLink size={11} aria-hidden="true" />
							</button>
						) : (
							<code>{evidence.source}</code>
						)}
					</dd>
				</>
			)}
			{evidence?.reproduction && (
				<>
					<dt>复现</dt>
					<dd>
						<pre tabIndex={0} aria-label="复现步骤">{evidence.reproduction}</pre>
					</dd>
				</>
			)}
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

function ReplayControl({
	replay,
	externalTrigger = 0,
}: {
	replay: () => Promise<ReplayResult>;
	externalTrigger?: number;
}) {
	const [replaying, setReplaying] = useState(false);
	const [result, setResult] = useState<ReplayResult>();
	const [error, setError] = useState<string>();
	const lastTrigger = useRef(0);

	const run = async () => {
		if (replaying) return;
		setReplaying(true);
		setResult(undefined);
		setError(undefined);
		try {
			setResult(await replay());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setReplaying(false);
		}
	};

	useEffect(() => {
		if (externalTrigger > lastTrigger.current) {
			lastTrigger.current = externalTrigger;
			void run();
		}
	}, [externalTrigger]);

	return (
		<div className="cc-werewolf-replay">
			<button type="button" className="secondary-button cc-ww-replay-btn" disabled={replaying} onClick={() => void run()}>
				{replaying ? <LoaderCircle size={13} className="spin" /> : <Play size={12} />}
				<span>{replaying ? "重放中…" : "重放证据"}</span>
			</button>
			{error && (
				<p className="cc-ww-replay-error" role="alert">
					{error}
				</p>
			)}
			{result && (
				<div className={`cc-ww-replay-result status-${result.status}`} role="status">
					<strong>重放结果 · {REPLAY_LABELS[result.status]}</strong>
					<p>{result.evidence.summary}</p>
					{result.evidence.actual && (
						<pre tabIndex={0} aria-label="重放实际结果">
							{result.evidence.actual}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

type ClaimFilter = "all" | WerewolfClaimCategory;

export function WerewolfReportDialog({
	review,
	close,
	onReplay,
	onConfront,
	onOpenCheckpoint,
	onOpenFile,
}: {
	review: WerewolfReview;
	close: () => void;
	onReplay?: ReplayWerewolfClaim;
	onConfront?: (prompt: string) => void;
	onOpenCheckpoint?: (checkpointId: string) => void;
	onOpenFile?: (path: string, line?: number) => void;
}) {
	const [filter, setFilter] = useState<ClaimFilter>("all");
	const [batchReplaySeq, setBatchReplaySeq] = useState(0);
	const metrics = werewolfMetrics(review.claims);
	const tarot = TAROT_ROLE[review.status];

	const sortedClaims = useMemo(() => {
		const order: Record<WerewolfClaimCategory, number> = {
			contradicted: 0,
			gap: 1,
			unverified: 2,
			verified: 3,
		};
		return [...review.claims].sort((a, b) => order[classifyWerewolfClaim(a)] - order[classifyWerewolfClaim(b)]);
	}, [review.claims]);

	const counts = useMemo(() => {
		const map: Record<ClaimFilter, number> = {
			all: review.claims.length,
			contradicted: 0,
			gap: 0,
			verified: 0,
			unverified: 0,
		};
		for (const c of review.claims) map[classifyWerewolfClaim(c)]++;
		return map;
	}, [review.claims]);

	const visibleClaims = filter === "all" ? sortedClaims : sortedClaims.filter((c) => classifyWerewolfClaim(c) === filter);
	const replayableCount = useMemo(() => review.claims.filter((c) => canReplay(c, review)).length, [review]);
	const fullConfrontPrompt = useMemo(() => buildWerewolfConfrontPrompt(review), [review]);
	const actionableCount = counts.contradicted + counts.gap;

	return (
		<Modal title="狼人核验" close={close} wide className="cc-werewolf-modal">
			<div className="simple-dialog cc-werewolf-report">
				{/* 1. Identity Tarot Reveal Hero */}
				<div className={`cc-werewolf-hero status-${review.status}`}>
					<div className={`cc-werewolf-tarot status-${review.status}`} aria-hidden="true">
						<span className="cc-ww-tarot-role">{tarot.en}</span>
						<div className="cc-ww-tarot-crest">
							<ReviewIcon status={review.status} size={30} />
						</div>
						<span className="cc-ww-tarot-stamp">{tarot.stamp}</span>
					</div>
					<div className="cc-werewolf-hero-main">
						<div className={`cc-werewolf-summary ${review.status}`} role="status">
							<ReviewIcon status={review.status} size={15} />
							<strong>{REVIEW_LABELS[review.status]}</strong>
							{review.revision && <code title={review.revision}>版本 {review.revision.slice(0, 12)}</code>}
							<small>{new Date(review.createdAt).toLocaleString("zh-CN")}</small>
						</div>
						<p className="cc-werewolf-hero-desc">
							{review.status === "pending" ? "正在核对本条回复与执行证据。" : HERO_SUBTITLES[review.status]}
						</p>
						{review.checkpointId && onOpenCheckpoint && (
							<div className="cc-werewolf-hero-links">
								<button
									type="button"
									className="cc-mini-btn"
									onClick={() => {
										close();
										onOpenCheckpoint(review.checkpointId!);
									}}
								>
									<GitCommitHorizontal size={12} />
									<span>查看检查点快照</span>
								</button>
							</div>
						)}
					</div>
				</div>

				{review.error && (
					<div className="cc-ww-error-banner" role="alert">
						<span>{review.error}</span>
					</div>
				)}

				{/* 2. Ring-Gauge Metrics & Segmented Distribution */}
				{review.status !== "pending" && (
					<dl className="cc-werewolf-metrics">
						<div className={metrics.contradicted > 0 ? "is-alert" : ""}>
							<div className="cc-ww-metric-copy">
								<dt title="被反证的声明占有明确结论的声明比例">幻觉率</dt>
								<dd>
									{metrics.hallucinationRate === undefined
										? "样本不足"
										: `${percentage.format(metrics.hallucinationRate)}（${metrics.contradicted}/${metrics.checked}）`}
								</dd>
							</div>
							<MetricRingGauge
								value={metrics.hallucinationRate}
								tone={metrics.contradicted > 0 ? "crimson" : "emerald"}
							/>
						</div>
						<div>
							<div className="cc-ww-metric-copy">
								<dt title="有明确结论的声明占已提取声明的比例">声明核验覆盖率</dt>
								<dd>
									{metrics.coverage === undefined
										? "样本不足"
										: `${percentage.format(metrics.coverage)}（${metrics.checked}/${metrics.total}）`}
								</dd>
							</div>
							<MetricRingGauge value={metrics.coverage} tone="indigo" />
						</div>
						{metrics.acceptanceTotal > 0 && (
							<div>
								<div className="cc-ww-metric-copy">
									<dt>需求验收</dt>
									<dd>
										{metrics.acceptanceVerified}/{metrics.acceptanceTotal}
									</dd>
								</div>
								<MetricRingGauge
									value={metrics.acceptanceVerified / metrics.acceptanceTotal}
									tone={metrics.acceptanceVerified === metrics.acceptanceTotal ? "emerald" : "amber"}
								/>
							</div>
						)}
					</dl>
				)}

				{review.status !== "pending" && review.claims.length > 0 && (
					<div className="cc-ww-dist-section">
						<div className="cc-ww-dist-bar" aria-hidden="true">
							{counts.verified > 0 && (
								<span className="seg verified" style={{ flexGrow: counts.verified }} title={`已核实 ${counts.verified}`} />
							)}
							{counts.contradicted > 0 && (
								<span className="seg contradicted" style={{ flexGrow: counts.contradicted }} title={`与证据矛盾 ${counts.contradicted}`} />
							)}
							{counts.gap > 0 && (
								<span className="seg gap" style={{ flexGrow: counts.gap }} title={`交付缺口 ${counts.gap}`} />
							)}
							{counts.unverified > 0 && (
								<span className="seg unverified" style={{ flexGrow: counts.unverified }} title={`待核验 ${counts.unverified}`} />
							)}
						</div>
						<div className="cc-ww-toolbar">
							{metrics.total > 0 && (
								<p className="subtle-note">
									回复声明中，{metrics.verified} 项已核实 · {metrics.contradicted} 项与证据矛盾 · {metrics.pending} 项待核验
									{counts.gap > 0 ? ` · 另有 ${counts.gap} 项交付缺口` : ""}
								</p>
							)}
							{onReplay && replayableCount > 1 && (
								<button
									type="button"
									className="cc-mini-btn"
									onClick={() => setBatchReplaySeq((n) => n + 1)}
								>
									<RotateCcw size={11} />
									<span>全部重放 ({replayableCount})</span>
								</button>
							)}
						</div>
						{review.claims.length > 1 && (
							<SlidingTabList variant="pill" className="cc-ww-filter-tabs" role="tablist" aria-label="筛选核验条目">
								{(
									[
										["all", `全部 (${counts.all})`],
										...(counts.contradicted > 0 ? [["contradicted", `矛盾破绽 (${counts.contradicted})`]] : []),
										...(counts.gap > 0 ? [["gap", `交付缺口 (${counts.gap})`]] : []),
										...(counts.verified > 0 ? [["verified", `已核实 (${counts.verified})`]] : []),
										...(counts.unverified > 0 ? [["unverified", `待核验 (${counts.unverified})`]] : []),
									] as Array<[ClaimFilter, string]>
								).map(([id, label]) => (
									<button
										key={id}
										type="button"
										role="tab"
										aria-selected={filter === id}
										className={`cc-scope-pill-btn ${filter === id ? "active" : ""}`}
										onClick={() => setFilter(id)}
									>
										{label}
									</button>
								))}
							</SlidingTabList>
						)}
					</div>
				)}

				{/* 3. Forensic Claim Cards */}
				{visibleClaims.length > 0 && (
					<ul className="cc-werewolf-claims">
						{visibleClaims.map((claim, index) => {
							const cat = classifyWerewolfClaim(claim);
							const probeInfo = parseProbeSignature(claim.evidence?.reproduction);
							const canConfrontItem = Boolean(onConfront && (cat === "contradicted" || cat === "gap"));
							return (
								<li
									key={claim.id}
									className={`cc-ww-claim-card cat-${cat}`}
									style={{ "--claim-i": index } as CSSProperties}
								>
									<div className="cc-ww-claim-head">
										<h3>
											<span className={`cc-ww-claim-pill ${claim.status} ${cat === "gap" ? "is-gap" : ""}`.trim()}>
												{cat === "gap" ? "交付缺口" : CLAIM_LABELS[claim.status]}
											</span>
											{" · "}
											{claim.description}
										</h3>
										{canConfrontItem && (
											<button
												type="button"
												className="cc-mini-btn cc-ww-item-confront"
												title="将此项破绽填入输入框要求模型修正"
												onClick={() => {
													const prompt = buildWerewolfConfrontPrompt(review, [claim]);
													if (prompt && onConfront) {
														close();
														onConfront(prompt);
													}
												}}
											>
												<ArrowUpRight size={12} />
												<span>追责此项</span>
											</button>
										)}
									</div>
									{probeInfo && (
										<div className="cc-ww-probe-formula" aria-label="可执行探针签名">
											<span className="cc-ww-probe-kind">{probeInfo.badge}</span>
											<code>{probeInfo.formula}</code>
										</div>
									)}
									<ClaimEvidence claim={claim} onOpenFile={onOpenFile} />
									{onReplay && canReplay(claim, review) && (
										<ReplayControl
											replay={() => onReplay(review.id, claim.id)}
											externalTrigger={batchReplaySeq}
										/>
									)}
								</li>
							);
						})}
					</ul>
				)}

				{/* 4. Dialog Footer Actions */}
				<div className="dialog-actions cc-ww-dialog-foot">
					{onConfront && actionableCount > 0 && fullConfrontPrompt ? (
						<button
							type="button"
							className="primary-button cc-ww-confront-all"
							onClick={() => {
								close();
								onConfront(fullConfrontPrompt);
							}}
						>
							<MessageSquareWarning size={14} />
							<span>一键发回追责修复 ({actionableCount} 项)</span>
						</button>
					) : (
						<span />
					)}
					<button type="button" className={onConfront && actionableCount > 0 ? "secondary-button" : "primary-button"} onClick={close}>
						<Check size={13} />
						<span>关闭</span>
					</button>
				</div>
			</div>
		</Modal>
	);
}
