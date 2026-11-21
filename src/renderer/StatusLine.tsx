import { useEffect, useRef, useState } from "react";
import type { Provider, ProviderBalanceResult, Snapshot } from "../shared.ts";
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

/** Compact status line: model, context usage, session cost, git branch and account balance. */
export function StatusLine({ snapshot, running, gitBranch }: { snapshot: Snapshot; running: boolean; gitBranch?: string }) {
	const stats = snapshot.stats;
	const contextPct =
		stats?.contextUsage && typeof stats.contextUsage === "object" && "percent" in stats.contextUsage
			? (stats.contextUsage as { percent?: number | null }).percent ?? undefined
			: undefined;
	const model = snapshot.state?.model;
	const provider = desktopProvider(model?.provider);
	const balanceEnabled =
		snapshot.settings.statusBalance !== false && Boolean(provider && snapshot.settings.configuredProviders.includes(provider));
	const balance = balanceLabel(useProviderBalance(provider, balanceEnabled, running));
	const modelName = model ? model.name || model.id : undefined;
	const tokens = stats?.tokens;
	const showUsage = Boolean(stats && (stats.tokens.total > 0 || contextPct !== undefined));
	if (!modelName && !showUsage && !gitBranch && !balance) return null;
	return (
		<span className="cc-stats-pill cc-status-line" role="status" aria-label="状态栏">
			{modelName && (
				<span className="cc-status-model" title={`当前模型：${model?.provider}/${model?.id}`}>
					{modelName}
				</span>
			)}
			{showUsage && contextPct !== undefined && (
				<span className="cc-status-item" title={`上下文已用 ${contextPct.toFixed(1)}%${tokens ? `\n输入 ${tokens.input} · 输出 ${tokens.output}` : ""}`}>
					Ctx {Math.round(contextPct)}%
				</span>
			)}
			{showUsage && contextPct === undefined && tokens && (
				<span className="cc-status-item" title={`输入 ${tokens.input} · 输出 ${tokens.output}`}>
					{Math.round(tokens.total / 1000)}k tok
				</span>
			)}
			{stats && stats.cost > 0 && (
				<span className="cc-status-item" title="本会话费用（按服务商价格计算）">
					${stats.cost.toFixed(3)}
				</span>
			)}
			{gitBranch && (
				<span className="cc-status-item cc-status-branch" title={`Git 分支：${gitBranch}`}>
					⎇ {gitBranch}
				</span>
			)}
			{balance && (
				<span className="cc-status-item" title={balance.title}>
					{balance.text}
				</span>
			)}
		</span>
	);
}
