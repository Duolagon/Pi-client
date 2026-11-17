import type { ExtensionAPI, ModelRegistry, ProviderModelConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConnectionMode, ConnectionProtocol, Provider } from "./shared.ts";
import { connectionDefaults, connectionMode } from "./model-connections.ts";
import { providerModels } from "./provider-presets.ts";
import { evaluatePermission, loadRuntimePermissionPolicy } from "./permission-policy.ts";

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
	const isChild = process.env.PI_DESKTOP_CHILD === "1" || process.env.PI_DESKTOP_READ_ONLY_CHILD === "1";
	if (!testingConnection && !isChild && process.env.PI_DESKTOP_HOST_URL) {
		pi.registerTool({
			name: "TodoWrite",
			label: "TodoWrite",
			description: "Manage a structured task checklist for multi-step coding work so the user can track progress.",
			promptSnippet: "Track multi-step task progress with a structured checklist",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["todos"],
				properties: {
					todos: {
						type: "array",
						maxItems: 50,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["id", "content", "status"],
							properties: {
								id: { type: "string", minLength: 1, maxLength: 100 },
								content: { type: "string", minLength: 1, maxLength: 500 },
								status: { type: "string", enum: ["pending", "in_progress", "completed"] },
							},
						},
					},
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const rec = input as { todos?: Array<{ id: string; content: string; status: string }> };
				const todos = Array.isArray(rec?.todos) ? rec.todos.slice(0, 50) : [];
				return { content: [{ type: "text", text: JSON.stringify({ todos }) }], details: { todos } };
			},
		});
		pi.registerTool({
			name: "WebFetch",
			label: "WebFetch",
			description: "Fetch text or documentation from a public HTTP/HTTPS URL and return readable content.",
			promptSnippet: "Fetch public web documentation via HTTP/HTTPS",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["url"],
				properties: {
					url: { type: "string", minLength: 1, maxLength: 4096 },
					max_chars: { type: "integer", minimum: 200, maximum: 100000 },
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "parallel",
			async execute(_toolCallId, input, signal) {
				const rec = input as { url?: string; max_chars?: number };
				const rawUrl = typeof rec?.url === "string" ? rec.url.trim() : "";
				const parsed = new URL(rawUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
					throw new Error("Only http and https URLs are supported.");
				const hostName = parsed.hostname.toLowerCase();
				if (
					hostName === "localhost" ||
					hostName === "::1" ||
					hostName === "[::1]" ||
					hostName.endsWith(".local") ||
					/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostName)
				) {
					throw new Error("Refusing to fetch private or loopback network addresses.");
				}
				const maxChars = typeof rec.max_chars === "number" ? Math.min(Math.max(200, rec.max_chars), 100000) : 24000;
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 15000);
				const onAbort = () => controller.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const res = await fetch(parsed.toString(), {
						signal: controller.signal,
						headers: { "user-agent": "Pi-Desktop/0.1" },
					});
					if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
					const text = (await res.text()).slice(0, 2 * 1024 * 1024);
					const contentType = res.headers.get("content-type") ?? "";
					const readable = contentType.includes("html")
						? text
								.replace(/<script[\s\S]*?<\/script>/gi, " ")
								.replace(/<style[\s\S]*?<\/style>/gi, " ")
								.replace(/<[^>]+>/g, " ")
								.replace(/\s+/g, " ")
								.trim()
						: text;
					const truncated = readable.length > maxChars;
					return {
						content: [{ type: "text", text: readable.slice(0, maxChars) + (truncated ? "\n\n[Truncated]" : "") }],
						details: { url: parsed.toString(), status: res.status, truncated },
					};
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}
			},
		});
	}
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
		try {
			const policy = await loadRuntimePermissionPolicy();
			const decision = await evaluatePermission(policy, event);
			if (decision.action === "deny") return { block: true, reason: decision.reason };
			if (decision.action === "allow") return;
			const allowed = await ctx.ui.confirm(
				`允许执行 ${event.toolName}？`,
				`${decision.reason}\n\n${JSON.stringify(event.input, null, 2)}`,
			);
			if (!allowed) return { block: true, reason: "用户未批准此操作。" };
			// An approval dialog can stay open while the host revokes this tool or adds a deny rule.
			const latest = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
			if (latest.action === "deny") return { block: true, reason: latest.reason };
		} catch (error) {
			return { block: true, reason: `无法验证工具权限：${error instanceof Error ? error.message : String(error)}` };
		}
	});
}
