import { projectMemoryContext, userMemoryContext } from "./project-memory.ts";
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConnectionMode, ConnectionProtocol, Provider } from "./shared.ts";
import { connectionDefaults, connectionMode } from "./model-connections.ts";
import { providerModels } from "./provider-presets.ts";
import { evaluatePermission, loadRuntimePermissionPolicy, redactSearchOutput } from "./permission-policy.ts";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function textFromBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type?: unknown; text?: unknown } => Boolean(b && typeof b === "object"))
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

function applyUpdatedInput(target: Record<string, unknown>, patch: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(patch)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		target[key] = value;
	}
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


const maxFetchBytes = 2 * 1024 * 1024;
const maxRedirects = 5;

function blockedIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b, c] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function blockedIpv6(ip: string): boolean {
	const value = ip.toLowerCase();
	if (value === "::" || value === "::1") return true;
	if (value.startsWith("fc") || value.startsWith("fd")) return true;
	if (/^fe[89ab]/.test(value)) return true;
	if (value.startsWith("ff")) return true;
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (dotted) return blockedIpv4(dotted[1]);
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
	if (hex) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
	}
	return false;
}

function blockedAddress(address: string): boolean {
	return isIP(address) === 4 ? blockedIpv4(address) : isIP(address) === 6 ? blockedIpv6(address) : true;
}

async function publicAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".local"))
		throw new Error("Refusing to fetch private or loopback network addresses.");
	const family = isIP(host);
	if (family) {
		if (blockedAddress(host)) throw new Error("Refusing to fetch private or loopback network addresses.");
		return [{ address: host, family }];
	}
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = (await lookup(host, { all: true, verbatim: true })) as Array<{ address: string; family: number }>;
	} catch {
		throw new Error("无法解析目标主机。");
	}
	if (!addresses.length || addresses.some(({ address }) => blockedAddress(address)))
		throw new Error("Refusing to fetch private or loopback network addresses.");
	return addresses;
}

async function fetchPinned(url: URL, signal: AbortSignal): Promise<Response> {
	if (url.username || url.password) throw new Error("WebFetch URLs cannot contain credentials.");
	signal.throwIfAborted();
	// Node's TLS still sees the original URL hostname. Only address resolution is pinned.
	const addresses = await publicAddresses(url.hostname);
	signal.throwIfAborted();
	const get = url.protocol === "https:" ? getHttps : getHttp;
	const first = addresses[0]!;
	return new Promise((resolve, reject) => {
		const request = get(url, {
			agent: false,
			signal,
			lookup: (_host, options, callback) => {
				if (options.all) callback(null, addresses);
				else callback(null, first.address, first.family);
			},
			headers: { "user-agent": "Pi-Desktop", "accept-encoding": "identity" },
		}, (incoming) => {
			try {
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (typeof value === "string") headers.set(name, value);
					else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
				}
				const status = incoming.statusCode ?? 502;
				if (status < 200) throw new Error(`Unsupported HTTP status ${status}`);
				const empty = status === 204 || status === 205 || status === 304;
				if (empty) incoming.resume();
				resolve(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
					status, statusText: incoming.statusMessage, headers,
				}));
			} catch (error) {
				incoming.destroy();
				reject(error);
			}
		});
		request.once("error", reject);
	});
}

async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (total + value.byteLength > maxFetchBytes) {
				chunks.push(value.subarray(0, maxFetchBytes - total));
				total = maxFetchBytes;
				truncated = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))), truncated };
}

/**
 * Follow redirects only within the requested host. A redirect to another host
 * is returned to the model so the new URL goes through the permission check
 * (domain rules, hooks, approvals) like a fresh WebFetch call, as in Claude Code.
 */
async function fetchPublic(url: URL, signal: AbortSignal): Promise<{ response: Response; url: URL } | { redirect: URL; status: number }> {
	let current = url;
	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const response = await fetchPinned(current, signal);
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => {});
			if (!location) throw new Error(`HTTP ${response.status} redirect without Location.`);
			const next = new URL(location, current);
			if (next.protocol !== "http:" && next.protocol !== "https:")
				throw new Error("Only http and https redirects are supported.");
			if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) return { redirect: next, status: response.status };
			current = next;
			continue;
		}
		return { response, url: current };
	}
	throw new Error("Too many redirects.");
}

export default function permissions(pi: ExtensionAPI) {
	// This JSON is supplied by the desktop host, separate from the user's Pi files.
	const connections = JSON.parse(process.env.PI_DESKTOP_CONNECTIONS ?? "{}") as Partial<Record<Provider, Connection>>;
	const testingConnection = process.env.PI_DESKTOP_CONNECTION_TEST === "1";
	const forkChild = process.env.PI_DESKTOP_FORK_CHILD === "1";
	const isChild = process.env.PI_DESKTOP_CHILD === "1" || process.env.PI_DESKTOP_READ_ONLY_CHILD === "1";
	if (!testingConnection && (!isChild || forkChild) && process.env.PI_DESKTOP_HOST_URL) {
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
				const maxChars = typeof rec.max_chars === "number" ? Math.min(Math.max(200, rec.max_chars), 100000) : 24000;
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 15000);
				const onAbort = () => controller.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const fetched = await fetchPublic(parsed, controller.signal);
					if ("redirect" in fetched) {
						return {
							content: [{
								type: "text",
								text: `HTTP ${fetched.status} redirect to a different host: ${fetched.redirect.toString()}\nThe redirect was not followed. Call WebFetch again with this URL if you still need it.`,
							}],
							details: { url: parsed.toString(), status: fetched.status, truncated: false, redirect: fetched.redirect.toString() } as { url: string; status: number; truncated: boolean; redirect?: string },
						};
					}
					const { response, url } = fetched;
					if (!response.ok) {
						await response.body?.cancel().catch(() => {});
						throw new Error(`HTTP ${response.status} ${response.statusText}`);
					}
					const body = await readLimited(response);
					const contentType = response.headers.get("content-type") ?? "";
					const readable = contentType.includes("html")
						? body.text
								.replace(/<script[\s\S]*?<\/script>/gi, " ")
								.replace(/<style[\s\S]*?<\/style>/gi, " ")
								.replace(/<[^>]+>/g, " ")
								.replace(/\s+/g, " ")
								.trim()
						: body.text;
					const truncated = body.truncated || readable.length > maxChars;
					return {
						content: [{ type: "text", text: readable.slice(0, maxChars) + (truncated ? "\n\n[Truncated]" : "") }],
						details: { url: url.toString(), status: response.status, truncated },
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
	const memoryRoot = process.env.PI_DESKTOP_MEMORY_ROOT;
	const userMemoryFile = process.env.PI_DESKTOP_USER_MEMORY_FILE;
	const memoryToolPaths = new Set<string>();
	if (memoryRoot || userMemoryFile) {
		let prompt = "";
		let system = "";
		let context: string | undefined;
		let analyzedPaths = -1;
		pi.on("before_agent_start", (event) => {
			prompt = event.messageType === "user" ? event.prompt : "";
			system = event.systemPrompt;
			memoryToolPaths.clear();
			analyzedPaths = -1;
		});
		pi.on("context_with_system", async (event) => {
			if (analyzedPaths !== memoryToolPaths.size) {
				const user = userMemoryFile ? await userMemoryContext(userMemoryFile, system) : "";
				const project = memoryRoot
					? await projectMemoryContext(memoryRoot, prompt, process.env.PI_DESKTOP_MEMORY_FILE, [...memoryToolPaths], system)
					: "";
				context = [user, project].filter(Boolean).join("\n\n") || undefined;
				analyzedPaths = memoryToolPaths.size;
			}
			const first = event.messages[0];
			if (context && first?.role === "system") {
				return { messages: [{ ...first, sections: { ...first.sections, desktopProjectMemory: context } }, ...event.messages.slice(1)] };
			}
		});
	}
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
	const maxTurnsRaw = Number(process.env.PI_DESKTOP_MAX_TURNS);
	const maxTurns = Number.isSafeInteger(maxTurnsRaw) && maxTurnsRaw > 0 ? maxTurnsRaw : 0;
	let turnCount = 0;
	let stopHookActive = false;
	let maxTurnsStopped = false;

	pi.on("before_agent_start", () => {
		turnCount = 0;
		stopHookActive = false;
		maxTurnsStopped = false;
	});
	pi.on("turn_start", () => {
		turnCount++;
	});
	pi.on("turn_end", async (event, ctx) => {
		if (maxTurns > 0 && turnCount >= maxTurns) {
			// `continue:false` alone does not end a run that still has tool results to answer:
			// the loop would make one more model request. Abort the run instead, after the host
			// has recorded that this stop is the limit (a completed, partial result) rather than
			// a cancellation. SubagentStop hooks cannot extend the run past maxTurns.
			// The aborted request's own turn_end must not repeat the notice.
			if (maxTurnsStopped) return;
			const pendingWork = Boolean(event?.toolResults?.length) || Boolean(ctx?.hasPendingMessages?.());
			if (pendingWork) {
				maxTurnsStopped = true;
				await callHost("/hook", { phase: "max_turns", toolCallId: `max-turns-${Date.now()}` }).catch(() => undefined);
				ctx?.abort?.();
			}
			return {
				continue: false,
				entries: [
					{
						type: "custom_message",
						customType: "desktop_max_turns",
						content: `已达到子 Agent 最大轮次上限 (${maxTurns})。`,
						display: true,
					},
				],
			};
		}
	});
	pi.on("session_before_compact", async (event) => {
		if (testingConnection) return;
		const hook = await callHost(
			"/hook",
			{
				phase: "compact",
				toolCallId: `compact-${Date.now()}`,
				trigger: event.reason === "manual" ? "manual" : "auto",
				...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
			},
			event.signal,
		).catch(() => undefined);
		if (hook?.blocked) return { cancel: true };
	});
	pi.on("agent_before_settle", async (event) => {
		if (testingConnection || event.outcome !== "completed") return;
		if (maxTurns > 0 && turnCount >= maxTurns) return;
		const lastAssistant = [...event.context.contextMessages].reverse().find((msg) => msg.role === "assistant");
		const lastAssistantMessage = lastAssistant ? textFromBlocks(lastAssistant.content).slice(0, 16384) : undefined;
		const hook = await callHost("/hook", {
			phase: "stop",
			toolCallId: `stop-${Date.now()}`,
			stopHookActive,
			...(lastAssistantMessage ? { lastAssistantMessage } : {}),
		}).catch(() => undefined);
		if (hook?.blocked && !stopHookActive && event.context.canContinue) {
			stopHookActive = true;
			const reason = typeof hook.reason === "string" && hook.reason.trim() ? hook.reason.trim() : "Stop Hook 要求补充完成后再结束。";
			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "hook_stop_feedback",
						content: `[Hook Stop Blocked] ${reason}`,
						display: true,
					},
				],
			};
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (forkChild && (event.toolName === "Agent" || event.toolName === "SendMessage" || event.toolName === "AgentSend")) {
				return { block: true, reason: "Forked agents cannot fork or spawn agents" };
			}
			if (maxTurns > 0 && turnCount > maxTurns) {
				return { block: true, reason: `已达到子 Agent 最大轮次上限 (${maxTurns})，停止执行工具。`, terminate: true };
			}
			const policy = await loadRuntimePermissionPolicy();
			let decision = await evaluatePermission(policy, event);
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
				if (hook?.updatedInput && typeof hook.updatedInput === "object" && !Array.isArray(hook.updatedInput)) {
					applyUpdatedInput(event.input as Record<string, unknown>, hook.updatedInput as Record<string, unknown>);
					decision = await evaluatePermission(policy, event);
					if (decision.action === "deny") return { block: true, reason: decision.reason };
					effectiveAction = decision.action;
					confirmReason = decision.reason;
				}
				if (hook?.permissionDecision === "allow" && effectiveAction === "ask" && !decision.ruleId) {
					effectiveAction = "allow";
				} else if (hook?.permissionDecision === "ask" && effectiveAction === "allow") {
					effectiveAction = "ask";
					confirmReason = typeof hook.reason === "string" ? hook.reason : "PreToolUse Hook 要求人工确认。";
				}
			}
			if (effectiveAction === "ask") {
				if (!testingConnection) {
					const permHook = await callHost("/hook", {
						phase: "permission",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						toolInput: (event.input ?? {}) as Record<string, unknown>,
					}).catch(() => undefined);
					if (permHook?.blocked || permHook?.permissionDecision === "deny") {
						return { block: true, reason: typeof permHook.reason === "string" ? permHook.reason : "PermissionRequest Hook 拒绝了此操作。" };
					}
					if (permHook?.updatedInput && typeof permHook.updatedInput === "object" && !Array.isArray(permHook.updatedInput)) {
						applyUpdatedInput(event.input as Record<string, unknown>, permHook.updatedInput as Record<string, unknown>);
						decision = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
						if (decision.action === "deny") return { block: true, reason: decision.reason };
					}
					if (permHook?.permissionDecision === "allow") {
						const recheck = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
						if (recheck.action === "deny") return { block: true, reason: recheck.reason };
						effectiveAction = "allow";
					}
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
		if (memoryRoot && !event.isError && ["read", "write", "edit"].includes(event.toolName) && typeof event.input.path === "string" && memoryToolPaths.size < 64)
			memoryToolPaths.add(event.input.path);
		// grep/find/ls search a directory; hide individual results that path deny
		// rules (e.g. an imported Claude `Read(.env)`) would refuse to read.
		const redacted = event.isError
			? undefined
			: await redactSearchResult(await loadRuntimePermissionPolicy().catch(() => undefined), event.toolName, event.input, event.content);
		if (redacted) event = { ...event, content: redacted } as typeof event;
		const changed = () => (redacted ? { content: redacted } : undefined);
		if (testingConnection) return changed();
		const errorText = event.isError ? textFromBlocks(event.content).slice(0, 4000) : undefined;
		const hook = await callHost("/hook", {
			phase: "post",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			toolInput: (event.input ?? {}) as Record<string, unknown>,
			toolResponse: { isError: event.isError, content: event.content },
			isError: event.isError,
			...(errorText !== undefined ? { error: errorText } : {}),
		}).catch(() => undefined);
		if (!hook) return changed();
		if (hook.blocked && !event.isError) {
			const reason = typeof hook.reason === "string" ? hook.reason : "PostToolUse Hook 报告检查失败。";
			return { content: [...event.content, { type: "text" as const, text: `\n\n[Hook Blocked] ${reason}` }], isError: true };
		}
		if (!hook.suppressOutput && typeof hook.additionalContext === "string" && hook.additionalContext.trim()) {
			return { content: [...event.content, { type: "text" as const, text: `\n\n[Hook Context]\n${hook.additionalContext.trim()}` }] };
		}
		return changed();
	});
}

async function redactSearchResult<T extends { type: string }>(
	policy: Awaited<ReturnType<typeof loadRuntimePermissionPolicy>> | undefined,
	toolName: string,
	input: unknown,
	blocks: T[],
): Promise<T[] | undefined> {
	if (!policy || !["grep", "find", "ls"].includes(toolName)) return;
	let removed = 0;
	const content: T[] = [];
	for (const block of blocks) {
		const text = (block as { text?: unknown }).text;
		if (block.type !== "text" || typeof text !== "string") {
			content.push(block);
			continue;
		}
		const result = await redactSearchOutput(policy, toolName, input, text);
		removed += result.removed;
		content.push({ ...block, text: result.text });
	}
	if (!removed) return;
	content.push({ type: "text", text: `\n[已按权限规则隐藏 ${removed} 条结果]` } as unknown as T);
	return content;
}
