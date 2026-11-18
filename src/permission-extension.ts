import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConnectionMode, ConnectionProtocol, Provider } from "./shared.ts";
import { connectionDefaults, connectionMode } from "./model-connections.ts";
import { providerModels } from "./provider-presets.ts";
import { evaluatePermission, loadRuntimePermissionPolicy } from "./permission-policy.ts";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function callHost(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
	const url = process.env.PI_DESKTOP_HOST_URL;
	const token = process.env.PI_DESKTOP_HOST_TOKEN;
	if (!url || !token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
	const response = await fetch(`${new URL(url).origin}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
		redirect: "error",
	});
	const result = (await response.json()) as { ok?: boolean; data?: Record<string, unknown>; error?: string };
	if (!response.ok || result?.ok !== true) throw new Error(result?.error ?? `Desktop host error (${response.status})`);
	return result.data ?? {};
}

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
		pi.registerTool({
			name: "AskUserQuestion",
			label: "AskUserQuestion",
			description: "Ask the user 1-4 structured multiple-choice or free-text questions when requirements or preferences need clarification.",
			promptSnippet: "Ask the user structured clarifying questions",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["questions"],
				properties: {
					questions: {
						type: "array",
						minItems: 1,
						maxItems: 4,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["question", "options"],
							properties: {
								header: { type: "string", minLength: 1, maxLength: 60 },
								question: { type: "string", minLength: 1, maxLength: 1000 },
								multiSelect: { type: "boolean" },
								options: {
									type: "array",
									minItems: 1,
									maxItems: 8,
									items: {
										type: "object",
										additionalProperties: false,
										required: ["label"],
										properties: {
											label: { type: "string", minLength: 1, maxLength: 120 },
											description: { type: "string", maxLength: 400 },
										},
									},
								},
							},
						},
					},
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
				const rec = input as { questions?: unknown[] };
				const questions = Array.isArray(rec?.questions) ? rec.questions.slice(0, 4) : [];
				if (!questions.length) throw new Error("At least one question is required.");
				const answer = await ctx.ui.input("__PI_ASK_QUESTIONS__", JSON.stringify({ questions }));
				if (answer === undefined) throw new Error("用户取消了提问。");
				let parsed: unknown = answer;
				try {
					parsed = JSON.parse(answer);
				} catch {
					parsed = { raw: answer };
				}
				return {
					content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(parsed) }],
					details: { questions, response: parsed },
				};
			},
		});
		pi.registerTool({
			name: "ExitPlanMode",
			label: "ExitPlanMode",
			description: "Finalize and save the implementation plan (.pi/plans/) and signal readiness for user plan approval before exiting Plan mode.",
			promptSnippet: "Save the plan and request user approval to begin implementation",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: { type: "string", maxLength: 200 },
					plan: { type: "string", maxLength: 262144 },
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "sequential",
			async execute(toolCallId, input, signal) {
				const rec = input as { title?: string; plan?: string };
				const hostResult = await callHost("/plan-exit", {
					toolCallId,
					title: typeof rec?.title === "string" ? rec.title : undefined,
					plan: typeof rec?.plan === "string" ? rec.plan : undefined,
				}, signal);
				const data = hostResult ?? { saved: false, status: "awaiting_user_approval" };
				return {
					content: [{ type: "text", text: JSON.stringify(data) }],
					details: data,
				};
			},
		});
		pi.registerTool({
			name: "NotebookEdit",
			label: "NotebookEdit",
			description: "Edit, insert, or delete a cell in a Jupyter Notebook (.ipynb) file.",
			promptSnippet: "Modify cells in a Jupyter .ipynb notebook",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["notebook_path", "new_source"],
				properties: {
					notebook_path: { type: "string", minLength: 1, maxLength: 4096 },
					cell_id: { type: "string", maxLength: 120 },
					cell_number: { type: "integer", minimum: 0, maximum: 10000 },
					new_source: { type: "string", maxLength: 512 * 1024 },
					cell_type: { type: "string", enum: ["code", "markdown"] },
					edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
				const rec = input as {
					notebook_path: string;
					cell_id?: string;
					cell_number?: number;
					new_source: string;
					cell_type?: "code" | "markdown";
					edit_mode?: "replace" | "insert" | "delete";
				};
				if (!rec.notebook_path.endsWith(".ipynb")) throw new Error("NotebookEdit 仅支持 .ipynb 文件。");
				const target = await realpath(resolve(ctx.cwd, rec.notebook_path));
				const raw = await readFile(target, "utf8");
				const nb = JSON.parse(raw) as { cells?: Array<{ id?: string; cell_type: string; source: string[] | string; metadata?: Record<string, unknown>; outputs?: unknown[]; execution_count?: unknown }> };
				if (!Array.isArray(nb.cells)) throw new Error("无效的 Notebook 格式（缺少 cells 数组）。");
				const mode = rec.edit_mode ?? "replace";
				const sourceLines = rec.new_source.split("\n").map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line));
				let idx = rec.cell_id ? nb.cells.findIndex((c) => c.id === rec.cell_id) : (rec.cell_number ?? 0);
				if (mode === "insert") {
					const insertAt = Math.max(0, Math.min(nb.cells.length, rec.cell_id ? idx + 1 : idx));
					const cellType = rec.cell_type ?? "code";
					nb.cells.splice(insertAt, 0, {
						id: `cell-${Date.now().toString(36)}`,
						cell_type: cellType,
						metadata: {},
						source: sourceLines,
						...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
					});
					idx = insertAt;
				} else {
					if (idx < 0 || idx >= nb.cells.length) throw new Error(`找不到指定的 Notebook 单元格（index=${idx}）。`);
					if (mode === "delete") {
						nb.cells.splice(idx, 1);
					} else {
						const cell = nb.cells[idx];
						if (rec.cell_type) cell.cell_type = rec.cell_type;
						cell.source = sourceLines;
					}
				}
				await writeFile(target, `${JSON.stringify(nb, null, 1)}\n`, "utf8");
				return {
					content: [{ type: "text", text: `Updated notebook ${rec.notebook_path} (${mode} at cell ${idx})` }],
					details: { notebook_path: rec.notebook_path, edit_mode: mode, cell_index: idx, total_cells: nb.cells.length },
				};
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
			let effectiveAction = decision.action;
			let confirmReason = decision.reason;
			if (!testingConnection) {
				const hook = await callHost("/hook", {
					phase: "pre",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					toolInput: (event.input ?? {}) as Record<string, unknown>,
				}).catch(() => undefined);
				if (hook?.blocked || hook?.permissionDecision === "deny") {
					return { block: true, reason: typeof hook.reason === "string" ? hook.reason : "PreToolUse Hook 阻止了此工具执行。" };
				}
				if (hook?.permissionDecision === "allow" && effectiveAction === "ask") effectiveAction = "allow";
				else if (hook?.permissionDecision === "ask" && effectiveAction === "allow") {
					effectiveAction = "ask";
					confirmReason = typeof hook.reason === "string" ? hook.reason : "PreToolUse Hook 要求人工确认。";
				}
			}
			if (effectiveAction === "ask") {
				const allowed = await ctx.ui.confirm(
					`允许执行 ${event.toolName}？`,
					`${confirmReason}\n\n${JSON.stringify(event.input, null, 2)}`,
				);
				if (!allowed) return { block: true, reason: "用户未批准此操作。" };
				// An approval dialog can stay open while the host revokes this tool or adds a deny rule.
				const latest = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
				if (latest.action === "deny") return { block: true, reason: latest.reason };
			}
			const sandboxProfile = process.env.PI_DESKTOP_SANDBOX_PROFILE;
			if (sandboxProfile && event.toolName === "bash" && typeof (event.input as { command?: unknown })?.command === "string") {
				const bashInput = event.input as { command: string };
				bashInput.command = `/usr/bin/sandbox-exec -f ${shellQuote(sandboxProfile)} /bin/sh -c ${shellQuote(bashInput.command)}`;
			}
		} catch (error) {
			return { block: true, reason: `无法验证工具权限：${error instanceof Error ? error.message : String(error)}` };
		}
	});
	pi.on("tool_result", async (event) => {
		if (testingConnection) return;
		const hook = await callHost("/hook", {
			phase: "post",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			toolInput: (event.input ?? {}) as Record<string, unknown>,
			toolResponse: { isError: event.isError, content: event.content },
		}).catch(() => undefined);
		if (!hook) return;
		if (hook.blocked) {
			const reason = typeof hook.reason === "string" ? hook.reason : "PostToolUse Hook 报告检查失败。";
			return { content: [...event.content, { type: "text" as const, text: `\n\n[Hook Blocked] ${reason}` }], isError: true };
		}
		if (typeof hook.additionalContext === "string" && hook.additionalContext.trim()) {
			return { content: [...event.content, { type: "text" as const, text: `\n\n[Hook Context]\n${hook.additionalContext.trim()}` }] };
		}
	});
}
