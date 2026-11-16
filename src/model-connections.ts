import type { ConnectionInput, ConnectionMode, ConnectionProtocol, Provider, Settings } from "./shared.ts";

export const connectionDefaults: Record<Provider, { baseUrl: string; api: ConnectionProtocol }> = {
	anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
	openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
	google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
	openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
	deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions" },
};

export function validateEndpoint(value: string): string | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;
	const url = new URL(normalized);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("API 地址必须是 HTTP(S) 基础地址，不能包含账号、密码、查询参数或片段。");
	return normalized.replace(/\/$/, "");
}

/** Keep existing custom endpoints while making new key-only connections use the provider preset. */
export function connectionMode(input: ConnectionInput, stored?: Settings["connections"][Provider]): ConnectionMode {
	return (
		input.mode ??
		stored?.mode ??
		(input.baseUrl !== undefined ||
		input.api !== undefined ||
		stored?.baseUrl !== undefined ||
		stored?.api !== undefined
			? "custom"
			: "preset")
	);
}
