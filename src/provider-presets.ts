import type { Model as PiModel } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { connectionDefaults } from "./model-connections.ts";
import type { ConnectionProtocol, Provider, ProviderPreset } from "./shared.ts";

// Catalog modules contain public model definitions, without provider SDKs or authentication state.
export const providerModels: Record<Provider, readonly PiModel<ConnectionProtocol>[]> = {
	anthropic: Object.values(ANTHROPIC_MODELS),
	openai: Object.values(OPENAI_MODELS),
	google: Object.values(GOOGLE_MODELS),
	openrouter: Object.values(OPENROUTER_MODELS),
	deepseek: Object.values(DEEPSEEK_MODELS),
};

const preferredModels: Record<Provider, string> = {
	anthropic: "claude-opus-5-5",
	openai: "gpt-6.1-sol",
	google: "gemini-4-argon",
	openrouter: "moonshotai/kimi-k2.7-code",
	deepseek: "deepseek-flash",
};
const names: Record<Provider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google Gemini",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
};

export const providerPresets: ProviderPreset[] = (Object.keys(connectionDefaults) as Provider[]).map((provider) => {
	const catalog = providerModels[provider];
	const preferred = catalog.find((model) => model.id === preferredModels[provider]) ?? catalog[0];
	if (!preferred) throw new Error(`服务商 ${provider} 缺少内置模型目录。`);
	return {
		provider,
		name: names[provider],
		...connectionDefaults[provider],
		defaultModelId: preferred.id,
		models: catalog.map(({ id, name, api, contextWindow, maxTokens, reasoning, input }) => ({
			id,
			name,
			api,
			contextWindow,
			maxTokens,
			reasoning,
			input,
		})),
	};
});
