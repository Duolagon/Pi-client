/**
 * Account balance lookups for providers that expose one to an ordinary API key.
 * Pure functions plus a fetch wrapper, shared by the main process and the Pi
 * extension.
 */

export type BalanceKind = "deepseek" | "openrouter" | "moonshot" | "siliconflow";

export interface BalanceAmount {
	currency: string;
	amount: number;
}

export interface BalanceResult {
	kind: BalanceKind;
	/** False when the provider says the account can no longer pay for calls. */
	available: boolean;
	/** Remaining amounts, one per currency; empty when the provider reports none. */
	balances: BalanceAmount[];
	/** Lifetime spend of this key, when the provider reports it (OpenRouter). */
	usage?: number;
	note?: string;
}

const HOSTS: Record<string, BalanceKind> = {
	"api.deepseek.com": "deepseek",
	"openrouter.ai": "openrouter",
	"api.moonshot.ai": "moonshot",
	"api.moonshot.cn": "moonshot",
	"api.siliconflow.cn": "siliconflow",
	"api.siliconflow.com": "siliconflow",
};

export const BALANCE_PROVIDER_NAMES: Record<BalanceKind, string> = {
	deepseek: "DeepSeek",
	openrouter: "OpenRouter",
	moonshot: "Kimi（Moonshot）",
	siliconflow: "硅基流动",
};

const PATHS: Record<BalanceKind, string> = {
	deepseek: "/user/balance",
	openrouter: "/api/v1/key",
	moonshot: "/v1/users/me/balance",
	siliconflow: "/v1/user/info",
};

const PRESET_ORIGINS: Partial<Record<string, { kind: BalanceKind; origin: string }>> = {
	deepseek: { kind: "deepseek", origin: "https://api.deepseek.com" },
	openrouter: { kind: "openrouter", origin: "https://openrouter.ai" },
};

/** Where a connection's balance is queried. The key only ever goes to the provider's official host. */
export interface BalanceTarget {
	kind: BalanceKind;
	url: string;
	/** Currency the provider reports when the response does not name one. */
	currency: string;
}

/**
 * Preset DeepSeek and OpenRouter connections use their official hosts; a custom
 * connection qualifies only when its base URL is a known official HTTPS host.
 * `origin` replaces the official origin and is accepted only for loopback HTTP (tests).
 */
export function balanceTarget(
	provider: string,
	mode: "preset" | "custom" | undefined,
	baseUrl: string | undefined,
	origin?: string,
): BalanceTarget | undefined {
	let kind: BalanceKind | undefined;
	let host: string | undefined;
	let official: string | undefined;
	if (mode !== "custom") {
		const preset = PRESET_ORIGINS[provider];
		if (!preset) return undefined;
		kind = preset.kind;
		official = preset.origin;
		host = new URL(preset.origin).hostname;
	} else {
		if (!baseUrl || !URL.canParse(baseUrl)) return undefined;
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		host = url.hostname.toLowerCase();
		kind = HOSTS[host];
		official = url.origin;
	}
	if (!kind) return undefined;
	const override = origin && loopbackOrigin(origin);
	return {
		kind,
		url: `${override || official}${PATHS[kind]}`,
		currency: kind === "deepseek" ? "CNY" : host.endsWith(".cn") ? "CNY" : "USD",
	};
}

function loopbackOrigin(value: string): string | undefined {
	if (!URL.canParse(value)) return undefined;
	const url = new URL(value);
	return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.origin : undefined;
}

/** A target received over IPC or the environment: the URL must match its kind's path on HTTPS or loopback. */
export function validBalanceTarget(value: unknown): BalanceTarget | undefined {
	const item = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	if (!item || typeof item.url !== "string" || typeof item.currency !== "string") return undefined;
	const kind = item.kind as BalanceKind;
	if (!PATHS[kind] || !URL.canParse(item.url)) return undefined;
	const url = new URL(item.url);
	if (url.pathname !== PATHS[kind] || url.search || url.username || url.password) return undefined;
	if (!(url.protocol === "https:" && HOSTS[url.hostname] === kind) && !loopbackOrigin(url.origin)) return undefined;
	if (!/^[A-Z]{3}$/.test(item.currency)) return undefined;
	return { kind, url: url.href, currency: item.currency };
}

function amount(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Reads a provider's balance response; throws when the shape is not the documented one. */
export function parseBalance(target: BalanceTarget, body: unknown): BalanceResult {
	const { kind, currency } = target;
	const root = record(body);
	const invalid = () => new Error("服务商返回的余额格式无法识别。");
	if (!root) throw invalid();
	if (kind === "deepseek") {
		if (typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos)) throw invalid();
		const balances: BalanceAmount[] = [];
		for (const item of root.balance_infos) {
			const info = record(item);
			const total = amount(info?.total_balance);
			if (!info || typeof info.currency !== "string" || total === undefined) throw invalid();
			const code = info.currency.toUpperCase();
			if (!/^[A-Z]{3}$/.test(code)) throw invalid();
			balances.push({ currency: code, amount: total });
		}
		return { kind, available: root.is_available, balances };
	}
	const data = record(root.data);
	if (!data) throw invalid();
	if (kind === "openrouter") {
		const usage = amount(data.usage);
		if (data.limit_remaining === null || data.limit_remaining === undefined)
			return {
				kind,
				available: true,
				balances: [],
				usage,
				note: "这个 Key 没有设置额度上限，账户余额需在 OpenRouter 网页查看。",
			};
		const remaining = amount(data.limit_remaining);
		if (remaining === undefined) throw invalid();
		return { kind, available: remaining > 0, balances: [{ currency: "USD", amount: remaining }], usage };
	}
	if (kind === "moonshot") {
		const available = amount(data.available_balance);
		if (available === undefined) throw invalid();
		return {
			kind,
			available: available > 0,
			balances: [{ currency, amount: available }],
		};
	}
	const total = amount(data.totalBalance);
	if (total === undefined) throw invalid();
	return {
		kind,
		available: total > 0 && data.status !== "disabled",
		balances: [{ currency, amount: total }],
	};
}

const MAX_BODY = 64 * 1024;

export interface BalanceFetchOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Passed through to the fetch implementation (an undici dispatcher in the main process). */
	dispatcher?: unknown;
}

/** Queries the balance with the connection's own key. Error messages never include the key or body. */
export async function fetchBalance(target: BalanceTarget, apiKey: string, options: BalanceFetchOptions = {}): Promise<BalanceResult> {
	const key = apiKey.trim();
	if (!key || /[\r\n]/.test(key)) throw new Error("没有可用的 API Key。");
	const init: RequestInit & { dispatcher?: unknown } = {
		method: "GET",
		headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		redirect: "error",
		signal: options.signal ?? AbortSignal.timeout(15000),
	};
	if (options.dispatcher) init.dispatcher = options.dispatcher;
	const response = await (options.fetch ?? fetch)(target.url, init);
	if (response.status === 401 || response.status === 403)
		throw new Error(
			target.kind === "openrouter"
				? "OpenRouter 拒绝了余额查询，请检查 API Key 是否有效。"
				: "服务商拒绝了余额查询，请检查 API Key 是否有效。",
		);
	if (!response.ok) throw new Error(`余额查询失败（HTTP ${response.status}）。`);
	const text = await response.text();
	if (text.length > MAX_BODY) throw new Error("服务商返回的余额数据过大。");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error("服务商返回的余额格式无法识别。");
	}
	return parseBalance(target, body);
}

/** The amount compared against a floor: the entry in the floor's currency, else the first one. */
export function balanceFor(result: BalanceResult, currency?: string): BalanceAmount | undefined {
	return result.balances.find((item) => item.currency === currency) ?? result.balances[0];
}

export function formatBalance(item: BalanceAmount): string {
	const symbol = item.currency === "CNY" ? "¥" : item.currency === "USD" ? "$" : `${item.currency} `;
	return `${symbol}${item.amount.toFixed(2)}`;
}
