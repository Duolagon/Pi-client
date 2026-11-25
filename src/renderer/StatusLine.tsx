import { useEffect, useRef, useState } from "react";
import { BarChart3, Layers } from "lucide-react";
import type { Provider, ProviderBalanceResult, Snapshot } from "../shared.ts";
import { SurfacePresence } from "./Presence.tsx";
import { desktopProvider } from "./status-line-state.ts";

/** Balance lookups run at most once per this interval per provider. */
export const BALANCE_REFRESH_MS = 60_000;

type BalanceEntry = { at: number; result?: ProviderBalanceResult; pending?: Promise<void> };
/** Module-level so remounting the composer per conversation does not trigger extra lookups. */
const balanceCache = new Map<Provider, BalanceEntry>();

function money(currency: string, amount: number): string {
	return `${currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
}

function balanceLabel(result: ProviderBalanceResult | undefined): { text: string; title: string } | undefined {
	if (!result?.supported || !result.success) return undefined;
	const first = result.balances?.[0];
	if (!first && result.usage === undefined) return undefined;
	const text = first ? money(first.currency, first.amount) : `已用 $${result.usage!.toFixed(2)}`;
	const details = (result.balances ?? []).map((item) => `余额 ${money(item.currency, item.amount)}`);
	if (result.usage !== undefined) details.push(`该 Key 累计用量 $${result.usage.toFixed(2)}`);
	if (result.available === false) details.push("服务商表示余额已不足以调用");
	if (result.checkedAt) details.push(`查询于 ${new Date(result.checkedAt).toLocaleTimeString()}`);
	return { text, title: `账户余额（每分钟最多查询一次）\n${details.join("\n")}` };
}

function useProviderBalance(provider: Provider | undefined, enabled: boolean, running: boolean) {
	const [result, setResult] = useState<ProviderBalanceResult | undefined>(() =>
		provider ? balanceCache.get(provider)?.result : undefined,
	);
	const wasRunning = useRef(running);
	// Set when a settled turn asked for a refresh that has not run yet.
	const refreshWanted = useRef(false);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		// A settled turn may have spent money; the 60 s limit still applies.
		if (wasRunning.current && !running) {
			refreshWanted.current = true;
			setTick((value) => value + 1);
		}
		wasRunning.current = running;
	}, [running]);
	useEffect(() => {
		if (!provider || !enabled) {
			setResult(undefined);
			return;
		}
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const entry = balanceCache.get(provider);
		setResult(entry?.result);
		if (entry?.pending) {
			void entry.pending.then(() => mounted && setResult(balanceCache.get(provider)?.result));
		} else if (entry && Date.now() - entry.at < BALANCE_REFRESH_MS) {
			// Throttled: run the refresh a settled turn asked for once the window opens.
			if (refreshWanted.current)
				timer = setTimeout(() => setTick((value) => value + 1), entry.at + BALANCE_REFRESH_MS - Date.now());
		} else {
			refreshWanted.current = false;
			const next: BalanceEntry = { at: Date.now(), result: entry?.result };
			next.pending = window.pi
				.providerBalance({ provider })
				.then(
					(value) => {
						next.result = value;
					},
					() => {
						next.result = undefined;
					},
				)
				.finally(() => {
					next.pending = undefined;
					if (mounted) setResult(next.result);
				});
			balanceCache.set(provider, next);
		}
		return () => {
			mounted = false;
			if (timer) clearTimeout(timer);
		};
	}, [provider, enabled, tick]);
	return enabled ? result : undefined;
}

function ContextRing({ pct }: { pct: number }) {
	const clamped = Math.max(0, Math.min(100, pct));
	const r = 4.6;
	const c = 2 * Math.PI * r;
	const offset = c - (clamped / 100) * c;
	const tone = clamped >= 85 ? "danger" : clamped >= 65 ? "warn" : "ok";
	return (
		<svg className={`cc-ctx-ring ${tone}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<circle className="cc-ctx-ring-track" cx="6" cy="6" r={r} fill="none" strokeWidth="1.6" />
			<circle
				className="cc-ctx-ring-fill"
				cx="6"
				cy="6"
				r={r}
				fill="none"
				strokeWidth="1.7"
				strokeDasharray={c}
				strokeDashoffset={offset}
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** Compact status line: model, context usage ring, session cost, git branch, account balance & interactive Telemetry HUD. */
export function StatusLine({
	snapshot,
	running,
	gitBranch,
	hideModel = false,
	onOpenContext,
	onOpenStats,
}: {
	snapshot: Snapshot;
	running: boolean;
	gitBranch?: string;
	hideModel?: boolean;
	onOpenContext?: () => void;
	onOpenStats?: () => void;
}) {
	const [hudOpen, setHudOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!hudOpen) return;
		const onDown = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setHudOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setHudOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [hudOpen]);

	const stats = snapshot.stats;
	const contextUsageObj =
		stats?.contextUsage && typeof stats.contextUsage === "object"
			? (stats.contextUsage as { percent?: number | null; tokens?: number; contextWindow?: number })
			: undefined;
	const contextPct = contextUsageObj?.percent ?? undefined;
	const model = snapshot.state?.model;
	const provider = desktopProvider(model?.provider);
	const balanceEnabled =
		snapshot.settings.statusBalance !== false && Boolean(provider && snapshot.settings.configuredProviders.includes(provider));
	const balance = balanceLabel(useProviderBalance(provider, balanceEnabled, running));
	const modelName = model ? model.name || model.id : undefined;
	const visibleModelName = hideModel ? undefined : modelName;
	const tokens = stats?.tokens;
	const showUsage = Boolean(stats && (stats.tokens.total > 0 || contextPct !== undefined));
	const interactive = Boolean(onOpenContext || onOpenStats || tokens || balance);
	const showIdleCtxRing = hideModel && !showUsage && Boolean(snapshot.active && interactive);
	if (!visibleModelName && !showUsage && !gitBranch && !balance && !showIdleCtxRing) return null;

	const displayCtxPct = contextPct ?? (showIdleCtxRing ? 0 : undefined);

	return (
		<span ref={rootRef} className={`cc-stats-pill cc-status-line ${hudOpen ? "is-open" : ""}`.trim()} role="status" aria-label="状态栏">
			<button
				type="button"
				className="cc-status-hud-trigger"
				aria-expanded={interactive ? hudOpen : undefined}
				title="点击查看上下文与费用明细"
				onClick={() => {
					if (interactive) setHudOpen((v) => !v);
				}}
			>
				{visibleModelName && (
					<span className="cc-status-model">
						{visibleModelName}
					</span>
				)}
				{displayCtxPct !== undefined && (
					<span className="cc-status-item cc-status-ctx">
						<ContextRing pct={displayCtxPct} />
						<span>Ctx {Math.round(displayCtxPct)}%</span>
					</span>
				)}
				{showUsage && contextPct === undefined && tokens && (
					<span className="cc-status-item">
						{Math.round(tokens.total / 1000)}k tok
					</span>
				)}
				{stats && stats.cost > 0 && (
					<span className="cc-status-item">
						${stats.cost.toFixed(3)}
					</span>
				)}
				{gitBranch && (
					<span className="cc-status-item cc-status-branch">
						⎇ {gitBranch}
					</span>
				)}
				{balance && (
					<span className="cc-status-item cc-status-balance">
						{balance.text}
					</span>
				)}
			</button>

			<SurfacePresence show={hudOpen} direction="up">
				{(hudRef) => (
					<div ref={hudRef} className="cc-telemetry-hud" role="region" aria-label="会话遥测明细">
						<div className="cc-telemetry-head">
							<strong>会话用量与遥测</strong>
							{modelName && <span className="cc-source-tag">{modelName}</span>}
						</div>
						<div className="cc-telemetry-meter">
							<div className="cc-telemetry-meter-row">
								<span>上下文窗口</span>
								<strong>
									{(contextPct ?? 0).toFixed(1)}%
									{contextUsageObj?.contextWindow ? ` · ${Math.round(contextUsageObj.contextWindow / 1000)}k` : ""}
								</strong>
							</div>
							<div className="cc-telemetry-bar">
								<div
									className={`cc-telemetry-bar-fill ${(contextPct ?? 0) >= 85 ? "danger" : (contextPct ?? 0) >= 65 ? "warn" : ""}`}
									style={{ width: `${Math.max(2, Math.min(100, contextPct ?? 0))}%` }}
								/>
							</div>
						</div>
						<div className="cc-telemetry-grid">
							<div>
								<span>输入 Token</span>
								<strong>{(tokens?.input ?? 0).toLocaleString()}</strong>
							</div>
							<div>
								<span>输出 Token</span>
								<strong>{(tokens?.output ?? 0).toLocaleString()}</strong>
							</div>
							<div>
								<span>缓存读取</span>
								<strong>{(tokens?.cacheRead ?? 0).toLocaleString()}</strong>
							</div>
							<div>
								<span>本会话费用</span>
								<strong>${(stats?.cost ?? 0).toFixed(4)}</strong>
							</div>
						</div>
						{balance && <p className="cc-telemetry-balance">{balance.title.replace(/^账户余额（[^）]+）\n?/, "")}</p>}
						{(onOpenContext || onOpenStats) && (
							<div className="cc-telemetry-actions">
								{onOpenContext && (
									<button
										type="button"
										className="cc-mini-btn"
										onClick={() => {
											setHudOpen(false);
											onOpenContext();
										}}
									>
										<Layers size={12} /> 上下文分析
									</button>
								)}
								{onOpenStats && (
									<button
										type="button"
										className="cc-mini-btn"
										onClick={() => {
											setHudOpen(false);
											onOpenStats();
										}}
									>
										<BarChart3 size={12} /> 30 天统计
									</button>
								)}
							</div>
						)}
					</div>
				)}
			</SurfacePresence>
		</span>
	);
}
