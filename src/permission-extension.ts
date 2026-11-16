import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ConnectionMode, ConnectionProtocol, Provider } from "./shared.ts";
import { connectionDefaults, connectionMode } from "./model-connections.ts";
import { providerModels } from "./provider-presets.ts";

interface Connection {
	baseUrl?: string;
	modelId?: string;
	envKey?: string;
	api?: ConnectionProtocol;
	mode?: ConnectionMode;
	presetBaseUrl?: string;
}

export default function permissions(pi: ExtensionAPI) {
	// This JSON is supplied by the desktop host, separate from the user's Pi files.
	const connections = JSON.parse(process.env.PI_DESKTOP_CONNECTIONS ?? "{}") as Partial<Record<Provider, Connection>>;
	const testingConnection = process.env.PI_DESKTOP_CONNECTION_TEST === "1";
	function registerConnection(provider: Provider, connection: Connection, registry?: ModelRegistry) {
		const definition = connectionDefaults[provider];
		if (!definition) return;
		if (connection.envKey && connection.modelId) {
			const mode = connectionMode({ ...connection, provider });
			const ids = mode === "preset" ? providerModels[provider].map((model) => model.id) : [connection.modelId];
			const models: ProviderModelConfig[] = ids.map((id) => {
				const builtIn = providerModels[provider].find((item) => item.id === id);
				const model = registry?.find(provider, id) ?? builtIn;
				const api = mode === "preset" ? (builtIn?.api ?? definition.api) : (connection.api ?? definition.api);
				return {
					id,
					name: model?.name ?? id,
					api,
					baseUrl:
						mode === "preset"
							? (connection.presetBaseUrl ?? builtIn?.baseUrl ?? definition.baseUrl)
							: (connection.baseUrl ?? definition.baseUrl),
					reasoning: model?.reasoning ?? false,
					input: model?.input ?? ["text", "image"],
					inputLimits: model?.inputLimits,
					cost: model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: model?.contextWindow ?? 128000,
					maxTokens: testingConnection ? Math.min(model?.maxTokens ?? 8192, 4096) : (model?.maxTokens ?? 8192),
					thinkingLevelMap: model?.thinkingLevelMap,
					promptCache: model?.promptCache,
					samplingParams: model?.samplingParams,
					samplingParamsByThinkingLevel: model?.samplingParamsByThinkingLevel,
					// Compatibility fields describe one wire protocol and cannot be carried across protocols.
					compat: model?.api === api ? model.compat : undefined,
				};
			});
			// A distinct provider prevents a stored OAuth credential from outranking the desktop key.
			pi.registerProvider(`desktop-${provider}`, {
				name: `${provider} (Desktop)`,
				baseUrl: definition.baseUrl,
				api: definition.api,
				apiKey: `$${connection.envKey}`,
				models,
			});
		} else if (connection.baseUrl) pi.registerProvider(provider, { baseUrl: connection.baseUrl });
	}
	for (const [provider, connection] of Object.entries(connections))
		registerConnection(provider as Provider, connection);
	pi.on("session_start", async (_event, ctx) => {
		// The registry is bound after initial loading and can include user-defined model capabilities.
		for (const [provider, connection] of Object.entries(connections)) {
			if (!connection.envKey || !connection.modelId) continue;
			registerConnection(provider as Provider, connection, ctx.modelRegistry);
			if (ctx.model?.provider === `desktop-${provider}`) {
				const refreshed = ctx.modelRegistry.find(`desktop-${provider}`, ctx.model.id);
				if (refreshed) await pi.setModel(refreshed);
			}
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		if (["read", "grep", "find", "ls"].includes(event.toolName)) return;
		if (process.env.PI_DESKTOP_PERMISSION_MODE === "read") return { block: true, reason: "当前为只读模式。" };
		if (process.env.PI_DESKTOP_PERMISSION_MODE === "auto") return;
		const allowed = await ctx.ui.confirm(`允许执行 ${event.toolName}？`, JSON.stringify(event.input, null, 2));
		if (!allowed) return { block: true, reason: "用户未批准此操作。" };
	});
}
