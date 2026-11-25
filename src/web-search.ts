/**
 * WebSearch integration powered by DeepSeek:
 * - Standalone Search API (`POST https://api.deepseek.com/v1/tools/search`) for any model ($0.75 / 1000 searches).
 * - Built-in DeepSeek Web Search (`deepseek_web_search` tool injection) when the active model is DeepSeek (free search, token billing only).
 */

export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";

export interface WebSearchResultItem {
	title: string;
	url: string;
	snippet: string;
	siteName?: string;
	publishedAt?: string;
	content?: string;
}

export interface WebSearchResponse {
	query: string;
	results: WebSearchResultItem[];
	total?: number;
}

export interface DeepSeekSearchOptions {
	query: string;
	count?: number;
	needContent?: boolean;
	apiKey: string;
	endpoint?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

function isLoopbackHost(hostname: string): boolean {
	const clean = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}

export function validateSearchEndpoint(raw?: string): string {
	const target = (raw ?? "").trim() || DEEPSEEK_SEARCH_ENDPOINT;
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		throw new Error("WebSearch 接口地址无效。");
	}
	if (parsed.protocol === "https:") return parsed.href;
	if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.href;
	throw new Error("WebSearch 接口仅支持 HTTPS 地址。");
}

function extractItems(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object") return [];
	const record = payload as Record<string, unknown>;
	if (Array.isArray(record.results)) return record.results;
	if (Array.isArray(record.web_pages)) return record.web_pages;
	if (Array.isArray(record.items)) return record.items;
	if (record.data && typeof record.data === "object") {
		const data = record.data as Record<string, unknown>;
		if (Array.isArray(data.results)) return data.results;
		if (Array.isArray(data.web_pages)) return data.web_pages;
		if (Array.isArray(data.items)) return data.items;
	}
	return [];
}

function normalizeResultItem(raw: unknown): WebSearchResultItem | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const url = typeof item.url === "string" ? item.url.trim() : typeof item.link === "string" ? item.link.trim() : "";
	const title = typeof item.title === "string" ? item.title.trim() : typeof item.name === "string" ? item.name.trim() : url;
	const snippet =
		typeof item.snippet === "string"
			? item.snippet.trim()
			: typeof item.summary === "string"
				? item.summary.trim()
				: typeof item.description === "string"
					? item.description.trim()
					: "";
	const content = typeof item.content === "string" ? item.content.trim() : undefined;
	const siteName =
		typeof item.site_name === "string"
			? item.site_name.trim()
			: typeof item.siteName === "string"
				? item.siteName.trim()
				: undefined;
	const publishedAt =
		typeof item.published_at === "string"
			? item.published_at.trim()
			: typeof item.publishedAt === "string"
				? item.publishedAt.trim()
				: typeof item.date === "string"
					? item.date.trim()
					: undefined;
	if (!title && !url && !snippet) return null;
	return {
		title: title || "(无标题)",
		url,
		snippet,
		...(siteName ? { siteName } : {}),
		...(publishedAt ? { publishedAt } : {}),
		...(content ? { content } : {}),
	};
}

export async function searchWithDeepSeekApi(options: DeepSeekSearchOptions): Promise<WebSearchResponse> {
	const query = options.query.trim().slice(0, 128);
	if (!query) throw new Error("搜索关键词不能为空。");
	const apiKey = options.apiKey.trim();
	if (!apiKey) throw new Error("未配置 DeepSeek Search API Key。请在「设置 → 网络搜索」中填写，或切换到 DeepSeek 模型使用内置搜索。");
	const count = Math.max(1, Math.min(50, Math.round(options.count ?? 10)));
	const endpoint = validateSearchEndpoint(options.endpoint);
	const fetchFn = options.fetchImpl ?? fetch;

	const response = await fetchFn(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			count,
			need_content: options.needContent === true,
		}),
		signal: options.signal ?? AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`DeepSeek Search API 请求失败 (${response.status}): ${text.slice(0, 300) || response.statusText}`);
	}

	const json = (await response.json()) as unknown;
	const rawItems = extractItems(json);
	const results: WebSearchResultItem[] = [];
	for (const raw of rawItems) {
		const normalized = normalizeResultItem(raw);
		if (normalized) results.push(normalized);
		if (results.length >= count) break;
	}
	const total =
		json && typeof json === "object" && typeof (json as { total?: unknown }).total === "number"
			? (json as { total: number }).total
			: results.length;
	return { query, results, total };
}

export function formatWebSearchResults(response: WebSearchResponse, maxContentChars = 2000): string {
	if (response.results.length === 0) {
		return `WebSearch（"${response.query}"）未找到相关结果。`;
	}
	const maximumResultChars = 24_000;
	let text = `WebSearch 结果（"${response.query}"，共 ${response.results.length} 条）：\n\n`;
	for (const [index, item] of response.results.entries()) {
		const meta = [item.siteName, item.publishedAt].filter(Boolean).join(" · ");
		const lines = [`${index + 1}. **${item.title}**${meta ? ` (${meta})` : ""}`];
		if (item.url) lines.push(`   URL: ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
		if (item.content) {
			const trimmed = item.content.length > maxContentChars ? `${item.content.slice(0, maxContentChars)}…` : item.content;
			lines.push(`   正文摘录: ${trimmed}`);
		}
		const entry = lines.join("\n");
		const omitted = `\n\n[已达搜索输出上限，省略后续 ${response.results.length - index} 条结果]`;
		if (text.length + entry.length + omitted.length > maximumResultChars)
			return text.trimEnd() + omitted;
		text += `${entry}\n\n`;
	}
	return text.trimEnd();
}

export function isDeepSeekModel(model?: { provider?: string; id?: string; baseUrl?: string }): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	if (provider === "deepseek" || provider === "desktop-deepseek") return true;
	if (model.baseUrl) {
		try {
			const host = new URL(model.baseUrl).hostname.toLowerCase();
			if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return true;
		} catch {
			// ignore invalid URL
		}
	}
	return false;
}

/**
 * Rewrites a provider request payload for DeepSeek models so they use DeepSeek's
 * native built-in `deepseek_web_search` tool (free search, token billing only)
 * instead of the client-side `WebSearch` tool.
 */
export function injectDeepSeekBuiltinSearch(payload: unknown, protocol = "openai-completions"): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	if (protocol !== "openai-completions" && protocol !== "openai-responses" && protocol !== "anthropic-messages") return payload;
	const record = payload as Record<string, unknown>;
	const existingTools = Array.isArray(record.tools) ? record.tools : [];
	const isBuiltinSearch = (tool: unknown) => {
		const entry = tool as { type?: unknown; name?: unknown } | null;
		return entry?.type === "deepseek_web_search" || entry?.name === "deepseek_web_search";
	};
	const filtered = existingTools.filter((tool) => {
		if (!tool || typeof tool !== "object") return true;
		const t = tool as { name?: unknown; function?: { name?: unknown } };
		if (t.name === "WebSearch" || t.function?.name === "WebSearch") return false;
		return true;
	});
	const thinking = record.thinking as { type?: unknown } | undefined;
	const reasoning = record.reasoning as { effort?: unknown } | undefined;
	const hasClientTools = filtered.some((tool) => !isBuiltinSearch(tool) &&
		(tool as { type?: unknown } | null)?.type !== "deepseek_read_url");
	if ((thinking?.type === "disabled" || reasoning?.effort === "none") && hasClientTools) {
		// DeepSeek rejects mixing built-in search with client tools in non-thinking mode.
		const clientTools = existingTools.filter((tool) => !isBuiltinSearch(tool));
		return clientTools.length === existingTools.length ? payload : { ...record, tools: clientTools };
	}
	const builtin = protocol === "anthropic-messages"
		? { type: "deepseek_web_search", name: "deepseek_web_search" }
		: { type: "deepseek_web_search" };
	const nextTools = filtered.some(isBuiltinSearch)
		? filtered
		: [...filtered, builtin];
	// DeepSeek rejects `strict` on function tools whenever a built-in tool such as deepseek_web_search is present.
	const relaxed = nextTools.map((tool) => {
		const fn = (tool as { function?: Record<string, unknown> } | null)?.function;
		if (!fn || typeof fn !== "object" || !("strict" in fn)) return tool;
		const { strict: _strict, ...rest } = fn;
		return { ...(tool as object), function: rest };
	});
	return { ...record, tools: relaxed };
}
