import { memoryLimit, projectMemoryContext, projectReferenceContext, userMemoryContext } from "./project-memory.ts";
import { staleTodoReminder } from "./todo-reminder.ts";
import { isDesktopWorkspaceContext, wrapDesktopWorkspaceContext } from "./file-references.ts";
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig, ToolDefinition, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { ConnectionMode, ConnectionProtocol, Provider } from "./shared.ts";
import { connectionDefaults, connectionMode } from "./model-connections.ts";
import { providerModels } from "./provider-presets.ts";
import { BALANCE_PROVIDER_NAMES, balanceFor, fetchBalance, formatBalance, validBalanceTarget } from "./provider-balance.ts";
import { evaluatePermission, loadRuntimePermissionPolicy, redactSearchOutput } from "./permission-policy.ts";
import { isStatusOnlyRequest } from "./remote-operation.ts";
import { formatWebSearchResults, injectDeepSeekBuiltinSearch, isDeepSeekModel, searchWithDeepSeekApi } from "./web-search.ts";
import { planRelativePath } from "./plan-path.ts";

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

type CachedHookFile = { ino: number; mtimeMs: number; ctimeMs: number; size: number; events: ReadonlySet<string> };
const hookFileCache = new Map<string, CachedHookFile>();

const HOOK_PHASE_EVENTS: Readonly<Record<string, readonly string[]>> = {
	pre: ["PreToolUse"],
	permission: ["PermissionRequest"],
	post: ["PostToolUse", "PostToolUseFailure"],
	stop: ["Stop", "SubagentStop"],
	compact: ["PreCompact"],
};

async function hookEventsInFile(file: string): Promise<ReadonlySet<string>> {
	let info;
	try {
		info = await stat(file);
	} catch {
		hookFileCache.delete(file);
		return new Set();
	}
	if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 * 1024) return new Set();
	const cached = hookFileCache.get(file);
	if (
		cached &&
		cached.ino === info.ino &&
		cached.mtimeMs === info.mtimeMs &&
		cached.ctimeMs === info.ctimeMs &&
		cached.size === info.size
	) {
		return cached.events;
	}
	const events = new Set<string>();
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as { hooks?: Record<string, unknown> } | undefined;
		if (parsed?.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)) {
			for (const [event, entries] of Object.entries(parsed.hooks)) {
				if (Array.isArray(entries) && entries.length > 0) events.add(event);
			}
		}
	} catch {
		// Malformed hook file behaves as empty, matching HooksService.readJsonFile.
	}
	hookFileCache.set(file, {
		ino: info.ino,
		mtimeMs: info.mtimeMs,
		ctimeMs: info.ctimeMs,
		size: info.size,
		events,
	});
	return events;
}

/**
 * Fast stat-backed pre-check for DesktopService runtimes (`PI_DESKTOP_HOOK_FASTPATH="1"`).
 * Eliminates 100% of `/hook` loopback HTTP roundtrips when no hook is configured for that phase,
 * while immediately detecting any newly created or edited hook config file on disk.
 */
async function mayHaveHookForPhase(phase: unknown): Promise<boolean> {
	if (typeof phase !== "string") return true;
	const targetEvents = HOOK_PHASE_EVENTS[phase];
	if (!targetEvents) return true; // e.g. "max_turns" host state transition
	if (process.env.PI_DESKTOP_HOOK_FASTPATH !== "1") return true;
	if (process.env.PI_DESKTOP_HAS_EXTRA_HOOKS === "1") return true;
	const home = homedir();
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	const project = process.env.PI_DESKTOP_TRUST_PROJECT || process.env.PI_DESKTOP_MEMORY_ROOT || process.cwd();
	const candidates = [
		join(home, ".claude", "settings.json"),
		join(home, ".claude", "settings.local.json"),
		join(agentDir, "hooks.json"),
		join(project, ".claude", "settings.json"),
		join(project, ".claude", "settings.local.json"),
		join(project, ".pi", "hooks.json"),
	];
	const sets = await Promise.all(candidates.map(hookEventsInFile));
	return sets.some((events) => targetEvents.some((ev) => events.has(ev)));
}

async function callHost(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
	const url = process.env.PI_DESKTOP_HOST_URL;
	const token = process.env.PI_DESKTOP_HOST_TOKEN;
	if (!url || !token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
	if (path === "/hook" && !(await mayHaveHookForPhase(body.phase))) return undefined;
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
	/** Environment variable holding a shell command that prints the API key. */
	keyCommandEnv?: string;
	/** Environment variable holding a JSON object of extra request headers. */
	headersEnv?: string;
	api?: ConnectionProtocol;
	mode?: ConnectionMode;
	presetBaseUrl?: string;
	/** Where the account balance of this connection can be queried. */
	balance?: unknown;
}


const maxFetchBytes = 2 * 1024 * 1024;
const maxRedirects = 5;

// 198.18.0.0/15 is the benchmarking range that proxy tools (Clash, Surge, sing-box)
// hand out as fake-ip DNS answers. Allow it only when it comes from DNS resolution,
// never as a literal IP in the URL.
function blockedIpv4(ip: string, allowFakeIp = false): boolean {
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
		(!allowFakeIp && a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function blockedIpv6(ip: string, allowFakeIp = false): boolean {
	const value = ip.toLowerCase();
	if (value === "::" || value === "::1") return true;
	if (value.startsWith("fc") || value.startsWith("fd")) return true;
	if (/^fe[89ab]/.test(value)) return true;
	if (value.startsWith("ff")) return true;
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (dotted) return blockedIpv4(dotted[1], allowFakeIp);
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
	if (hex) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, allowFakeIp);
	}
	return false;
}

export function blockedAddress(address: string, allowFakeIp = false): boolean {
	return isIP(address) === 4 ? blockedIpv4(address, allowFakeIp) : isIP(address) === 6 ? blockedIpv6(address, allowFakeIp) : true;
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
	if (!addresses.length || addresses.some(({ address }) => blockedAddress(address, true)))
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

/** Header values are literal; escape Pi's "$VAR" and "!command" syntax. */
function connectionHeaders(connection: Connection): Record<string, string> | undefined {
	const raw = connection.headersEnv ? process.env[connection.headersEnv] : undefined;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(parsed))
			if (typeof value === "string") headers[name] = escapeConfigValue(value);
		return Object.keys(headers).length ? headers : undefined;
	} catch {
		return undefined;
	}
}

/** Pi reads "$$" as a literal dollar and a leading "$!" as a literal "!". */
export function escapeConfigValue(value: string): string {
	const dollar = String.fromCharCode(36);
	const escaped = value.split(dollar).join(dollar + dollar);
	return escaped.startsWith("!") ? dollar + escaped : escaped;
}

/** Custom message type of the visible notice written when the conversation switches to the fallback model. */
export const FALLBACK_MESSAGE_TYPE = "desktop_model_fallback";
/** Custom message type written when consecutive verification failures escalate to a stronger routed model. */
export const ESCALATION_MESSAGE_TYPE = "desktop_model_escalation";

const VERIFICATION_COMMAND_RE =
	/\b(?:npm|pnpm|yarn|bun|npx|node|pytest|py\.test|cargo|go|tsc|vitest|jest|mocha|ava|ruff|flake8|mypy|pyright|eslint|biome|make|gradle|mvn)\b[^\r\n]*(?:\btest\b|--test\b|\bcheck\b|\btypecheck\b|--noEmit\b|\blint\b|\bbuild\b|\bclippy\b)/i;

/** Returns true when a bash command string is a test, typecheck, lint, or build verification run. */
export function isVerificationBashCommand(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (!trimmed || trimmed.length > 8192) return false;
	return VERIFICATION_COMMAND_RE.test(trimmed);
}

const CODING_DISCIPLINE_GUIDELINES = [
	"Inspect target files and relevant call sites (`grep` or `LSP`) before editing; use `LSP` with `operation: \"workspaceOutline\"` to map unfamiliar directories in one step instead of reading many files blindly.",
	"Make minimal, surgical root-cause changes matching existing conventions; avoid speculative abstractions or unrelated refactors.",
	"After modifying code, run the narrowest relevant test or typecheck command to verify before concluding, and never mask failures with `.skip`, `.only`, `@ts-ignore`, `as any`, or weakened assertions.",
] as const;

/**
 * Decides whether a final provider error should switch to the fallback model. Returns a short
 * Chinese reason for overload, rate limits and server errors; undefined for everything else
 * (aborts, authentication, invalid requests, context overflow, quota/billing, network issues).
 */
export function fallbackReason(errorMessage: unknown): string | undefined {
	if (typeof errorMessage !== "string") return undefined;
	const text = errorMessage.slice(0, 4096);
	if (!text.trim()) return undefined;
	const code = (pattern: string) => new RegExp(`(?<![a-z0-9.])(?:${pattern})(?![a-z0-9])`, "i");
	// Never fall back on errors another model cannot fix or that the user caused.
	if (/abort|cancel/i.test(text)) return undefined;
	if (code("400|401|403|404|413|422").test(text)) return undefined;
	if (/insufficient.?(?:quota|balance|funds)|quota.?exceeded|billing|out of budget|usage limit|available balance/i.test(text)) return undefined;
	if (code("529").test(text)) return "过载";
	if (code("429").test(text)) return "限流";
	if (code("5[0-9]{2}").test(text)) return "服务端错误";
	if (/unauthori[sz]ed|forbidden|authenticat|permission.?denied|invalid.{0,12}(?:api.?key|token|x-api-key)|incorrect api key|api.?key/i.test(text)) return undefined;
	if (/invalid.?request|bad.?request|validation/i.test(text)) return undefined;
	if (/context.?(?:length|window|overflow)|maximum context|too many tokens|prompt is too long|token limit|exceeds? the (?:model'?s? )?(?:maximum|limit)/i.test(text)) return undefined;
	if (/insufficient.?(?:quota|balance|funds)|quota.?exceeded|billing|out of budget|credit|usage limit|available balance/i.test(text)) return undefined;
	if (/overload|server.?busy|servers are currently busy|high demand|at capacity|capacity/i.test(text)) return "过载";
	if (/rate.?limit|too many requests|throttl/i.test(text)) return "限流";
	if (/service.?(?:is.?)?(?:temporarily.?)?unavailable|bad.?gateway|gateway.?time.?out|server.?error|internal.?(?:server.?)?error/i.test(text))
		return "服务端错误";
	return undefined;
}

/** Parses PI_DESKTOP_FALLBACK_MODEL; malformed values disable the fallback. */
export function parseFallbackModel(raw: string | undefined): { provider: string; id: string } | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as { provider?: unknown; id?: unknown };
		if (typeof value?.provider !== "string" || typeof value.id !== "string") return undefined;
		const provider = value.provider.trim();
		const id = value.id.trim();
		if (!provider || !id || provider.length > 200 || id.length > 200) return undefined;
		return { provider, id };
	} catch {
		return undefined;
	}
}

/** Session spend in USD from the entries Pi records, including subagent usage entries. */
export function sessionCost(entries: readonly unknown[]): number {
	let total = 0;
	const add = (usage: unknown) => {
		const value = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
	};
	for (const entry of entries as Array<{ type?: string; usage?: unknown; message?: { role?: string; usage?: unknown } }>) {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") add(entry.usage);
		else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult"))
			add(entry.message.usage);
	}
	return total;
}

export default function permissions(pi: ExtensionAPI) {
	// This JSON is supplied by the desktop host, separate from the user's Pi files.
	const connections = JSON.parse(process.env.PI_DESKTOP_CONNECTIONS ?? "{}") as Partial<Record<Provider, Connection>>;
	const limitConnectionOutput = process.env.PI_DESKTOP_CONNECTION_TEST === "1";
	const testingConnection = limitConnectionOutput || process.env.PI_DESKTOP_GRAIL_REVIEW === "1";
	const forkChild = process.env.PI_DESKTOP_FORK_CHILD === "1";
	const isChild = process.env.PI_DESKTOP_CHILD === "1" || process.env.PI_DESKTOP_READ_ONLY_CHILD === "1";
	let activeTodoWriteItems: Array<{ id: string; content: string; status: string; estimatedSeconds?: number }> = [];
	const sharedTodoItems = new Map<string, { content: string; status: string }>();
	let checklist: "simple" | "shared" = "simple";
	let callsSinceTodoUpdate = 0;
	if (!testingConnection && (!isChild || forkChild) && process.env.PI_DESKTOP_HOST_URL) {
		pi.registerTool({
			name: "TodoWrite",
			label: "TodoWrite",
			description:
				"Manage a structured task checklist for multi-step work so the user can track progress. " +
				"The user sees only the latest call, so call it again every time a step finishes or starts: " +
				"mark finished items completed right away (do not batch them), keep exactly one item in_progress, " +
				"and rewrite the list when the plan changes. Include estimatedSeconds when a step may take noticeable time so the user sees an ETA. Always pass the whole list.",
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
								estimatedSeconds: {
									type: "integer",
									minimum: 1,
									maximum: 604_800,
									description: "Optional rough duration estimate in seconds so the UI can show ETA",
								},
							},
						},
					},
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const rec = input as { todos?: Array<{ id: string; content: string; status: string; estimatedSeconds?: number }> };
				const todos = Array.isArray(rec?.todos) ? rec.todos.slice(0, 50) : [];
				activeTodoWriteItems = todos;
				checklist = "simple";
				callsSinceTodoUpdate = 0;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								todos,
								message:
									"Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress: call TodoWrite immediately whenever a step finishes or starts, and keep exactly one item in_progress.",
							}),
						},
					],
					details: { todos },
				};
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
		if (process.env.PI_DESKTOP_WEB_SEARCH_ENABLED !== "0") {
			pi.registerTool({
				name: "WebSearch",
				label: "WebSearch",
				description:
					"Search the web using DeepSeek Search API ($0.75/1000 calls) and return titles, URLs, snippets, and optional page content. When using a DeepSeek model, DeepSeek's built-in free search is used automatically.",
				promptSnippet: "Search the web for up-to-date information",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["query"],
					properties: {
						query: { type: "string", minLength: 1, maxLength: 128 },
						count: { type: "integer", minimum: 1, maximum: 50 },
						need_content: { type: "boolean" },
					},
				} as ToolDefinition["parameters"],
				exposure: "model-only",
				defaultActive: true,
				executionMode: "parallel",
				async execute(_toolCallId, input, signal) {
					const rec = input as { query?: string; count?: number; need_content?: boolean };
					const apiKey = process.env.PI_DESKTOP_WEB_SEARCH_KEY ?? "";
					const result = await searchWithDeepSeekApi({
						query: String(rec?.query ?? ""),
						count: typeof rec?.count === "number" ? rec.count : undefined,
						needContent: rec?.need_content === true,
						apiKey,
						endpoint: process.env.PI_DESKTOP_WEB_SEARCH_ENDPOINT,
						signal,
					});
					return {
						content: [{ type: "text", text: formatWebSearchResults(result) }],
						details: { query: result.query, count: result.results.length, total: result.total },
					};
				},
			});
			pi.on("before_provider_request", async (event, ctx) => {
				if (!isDeepSeekModel(ctx.model as { provider?: string; id?: string; baseUrl?: string } | undefined)) return undefined;
				try {
					const policy = await loadRuntimePermissionPolicy();
					if (policy.disabledTools.includes("WebSearch")) return undefined;
				} catch {
					// If policy file isn't readable, proceed cleanly.
				}
				return injectDeepSeekBuiltinSearch(event.payload);
			});
		}
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
		let planFile: string | undefined;
		const describePlan = "Submit the implementation plan for approval. Pass the full Markdown in plan.";
		pi.registerTool({
			name: "ExitPlanMode",
			label: "ExitPlanMode",
			description: describePlan,
			prepareLoadout: () => planFile ? { descriptions: {
				ExitPlanMode: `${describePlan} You may omit plan only if already saved to \`${planFile}\`.`,
			} } : undefined,
			promptSnippet: "Submit the implementation plan's Markdown for user approval",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: { type: "string", maxLength: 200 },
					plan: { type: "string", maxLength: 262144 },
				},
			} as ToolDefinition["parameters"],
			exposure: "model-only",
			defaultActive: false,
			executionMode: "sequential",
			async execute(toolCallId, input, signal) {
				const rec = input as { title?: string; plan?: string };
				const hostResult = await callHost("/plan-exit", {
					toolCallId,
					title: typeof rec?.title === "string" ? rec.title : undefined,
					plan: typeof rec?.plan === "string" ? rec.plan : undefined,
				}, signal);
				if (hostResult?.saved !== true) throw new Error("计划未提交，请确认客户端已连接，并提供计划正文。");
				return {
					content: [{ type: "text", text: JSON.stringify(hostResult) }],
					details: hostResult,
				};
			},
		});
		pi.on("session_start", (_event, ctx) => {
			planFile = planRelativePath(ctx.sessionManager.getSessionId());
			const active = pi.getActiveTools();
			if (active.includes("ExitPlanMode")) pi.setActiveTools(active);
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
		const keyCommand = connection.keyCommandEnv ? process.env[connection.keyCommandEnv] : undefined;
		if ((connection.envKey || keyCommand) && connection.modelId) {
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
					maxTokens: limitConnectionOutput ? Math.min(model?.maxTokens ?? 8192, 4096) : (model?.maxTokens ?? 8192),
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
				// Pi runs a value starting with "!" as a shell command and caches the output.
				apiKey: connection.envKey ? `$${connection.envKey}` : `!${keyCommand}`,
				...(connectionHeaders(connection) ? { headers: connectionHeaders(connection) } : {}),
				models,
			});
		} else if (connection.baseUrl) pi.registerProvider(provider, { baseUrl: connection.baseUrl });
	}
	for (const [provider, connection] of Object.entries(connections))
		registerConnection(provider as Provider, connection);
	registerOutputStyle(pi, process.env.PI_DESKTOP_OUTPUT_STYLE_FILE);
	const memoryRoot = process.env.PI_DESKTOP_MEMORY_ROOT;
	const userMemoryFile = process.env.PI_DESKTOP_USER_MEMORY_FILE;
	const seenRules = new Set<string>();
	let scopedBudget = memoryLimit;
	let scopedQueue = Promise.resolve();
	const scopedContext = (prompt: string, paths: string[] = []) => {
		if (!memoryRoot) return Promise.resolve("");
		const context = scopedQueue.then(async () => {
			const scoped = await projectMemoryContext(memoryRoot, prompt, undefined, paths, "", {
				mode: "scoped", seenRules, limit: scopedBudget,
			});
			scopedBudget -= Buffer.byteLength(scoped);
			return scoped;
		});
		scopedQueue = context.then(() => {}, () => {});
		return context;
	};
	if (memoryRoot || userMemoryFile) {
		pi.on("before_agent_start", async (event) => {
			seenRules.clear();
			scopedBudget = memoryLimit;
			const [user, project] = await Promise.all([
				userMemoryFile ? userMemoryContext(userMemoryFile, event.systemPrompt) : "",
				memoryRoot
					? projectMemoryContext(memoryRoot, "", process.env.PI_DESKTOP_MEMORY_FILE, [], event.systemPrompt, { mode: "base" })
					: "",
			]);
			const context = [user, project].filter(Boolean).join("\n\n");
			const sections = event.systemPromptOptions?.sections;
			if (context && sections) sections.desktop_project_memory = context;
		});
	}
	if (memoryRoot) {
		// Finalized native user messages include queued inputs and are persisted before the model call.
		pi.on("message_end", async ({ message }) => {
			if (message.role !== "user") return;
			const original = typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: message.content;
			if (original.some((part) => part.type === "text" && isDesktopWorkspaceContext(part.text))) return;
			const prompt = textFromBlocks(original);
			if (!prompt.includes("@")) return;
			const policy = await loadRuntimePermissionPolicy().catch(() => undefined);
			const [references, rules] = await Promise.all([
				policy
					? projectReferenceContext(memoryRoot, prompt, async (path) => (await evaluatePermission(policy, {
						toolName: "read", input: { path },
					}).catch(() => undefined))?.action === "allow")
					: "",
				scopedContext(prompt),
			]);
			const context = [references, rules].filter(Boolean).join("\n\n");
			if (context) return { message: { ...message, content: [...original, { type: "text" as const, text: wrapDesktopWorkspaceContext(context) }] } };
		});
	}
	pi.on("session_start", async (_event, ctx) => {
		// The registry is bound after initial loading and can include user-defined model capabilities.
		for (const [provider, connection] of Object.entries(connections)) {
			if ((!connection.envKey && !connection.keyCommandEnv) || !connection.modelId) continue;
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
	let editedThisRun = false;
	let consecutiveVerifyFailures = 0;
	let lastVerifyFailureSummary = "";

	pi.on("before_agent_start", (event) => {
		turnCount = 0;
		stopHookActive = false;
		maxTurnsStopped = false;
		editedThisRun = false;
		consecutiveVerifyFailures = 0;
		lastVerifyFailureSummary = "";
		if (!testingConnection && event?.systemPromptOptions?.promptGuidelines) {
			const list = event.systemPromptOptions.promptGuidelines;
			for (const rule of CODING_DISCIPLINE_GUIDELINES) {
				if (!list.includes(rule)) list.push(rule);
			}
		}
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
	const maxCostRaw = Number(process.env.PI_DESKTOP_MAX_COST);
	const maxCost = Number.isFinite(maxCostRaw) && maxCostRaw > 0 ? maxCostRaw : 0;
	const costFile = process.env.PI_DESKTOP_MAX_COST_FILE;
	if (maxCost > 0 || costFile) {
		const readMaximumCost = async () => {
			if (!costFile) return maxCost;
			const value = Number(await readFile(costFile, "utf8").catch(() => ""));
			return Number.isFinite(value) && value > 0 ? value : 0;
		};
		const costNotice = (spent: number, limit: number) =>
			isChild
				? `子 Agent 已用完会话剩余的费用额度（$${spent.toFixed(2)}），已自动停止。`
				: `本会话已花费 $${spent.toFixed(2)}，可用上限为 $${limit.toFixed(2)}，已自动停止。运行中的子任务可能占用了部分额度。`;
		let costStopped = false;
		let noticeShown = false;
		pi.on("input", async (_event, ctx) => {
			const spent = sessionCost(ctx.sessionManager.getEntries());
			const limit = await readMaximumCost();
			if (spent < limit) return { action: "continue" };
			ctx.ui.notify(costNotice(spent, limit), "warning");
			return { action: "handled" };
		});
		pi.on("before_agent_start", () => {
			costStopped = false;
		});
		// Wakeups and follow-ups that bypass `input` are stopped before any paid request.
		pi.on("before_provider_request", async (_event, ctx) => {
			const spent = sessionCost(ctx.sessionManager.getEntries());
			const limit = await readMaximumCost();
			if (spent < limit) {
				noticeShown = false;
				return undefined;
			}
			if (!noticeShown) {
				noticeShown = true;
				ctx.ui.notify(costNotice(spent, limit), "warning");
			}
			costStopped = true;
			ctx.abort();
			return undefined;
		});
		pi.on("turn_end", async (_event, ctx) => {
			if (costStopped) return;
			const spent = sessionCost(ctx.sessionManager.getEntries());
			const limit = await readMaximumCost();
			if (spent < limit) return;
			costStopped = true;
			ctx.abort();
			return {
				continue: false,
				entries: [{ type: "custom_message", customType: "desktop_max_cost", content: costNotice(spent, limit), display: true }],
			};
		});
	}
	const minBalanceRaw = Number(process.env.PI_DESKTOP_MIN_BALANCE);
	const minBalance = Number.isFinite(minBalanceRaw) && minBalanceRaw > 0 ? minBalanceRaw : 0;
	if (minBalance > 0 && !testingConnection) {
		type BalanceState = { at: number; low: boolean; notice: string };
		const cache = new Map<string, BalanceState>();
		const pending = new Map<string, Promise<BalanceState | undefined>>();
		const FRESH_MS = 30000;
		/** The guard waits at most this long; a slower provider is treated like a failed lookup. */
		const LOOKUP_TIMEOUT_MS = 5000;
		const fresh = (state: BalanceState | undefined) => state !== undefined && Date.now() - state.at < FRESH_MS;
		/**
		 * Queries the active connection's balance; undefined when it has no balance API.
		 * A failed lookup is cached as "not low" for FRESH_MS so it neither blocks work nor
		 * makes every message wait on the timeout again.
		 */
		const refresh = (ctx: { model?: { provider: string }; modelRegistry: ModelRegistry }) => {
			const model = ctx.model;
			const provider = model?.provider.startsWith("desktop-") ? model.provider.slice(8) : undefined;
			const target = provider ? validBalanceTarget(connections[provider as Provider]?.balance) : undefined;
			if (!model || !provider || !target) return Promise.resolve(undefined);
			const running = pending.get(provider);
			if (running) return running;
			const task = (async () => {
				try {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
					if (!auth.ok || !auth.apiKey) return undefined;
					const result = await fetchBalance(target, auth.apiKey, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
					const item = balanceFor(result, target.currency);
					const floor = formatBalance({ currency: item?.currency ?? target.currency, amount: minBalance });
					const name = BALANCE_PROVIDER_NAMES[target.kind];
					const low = !result.available || (item !== undefined && item.amount <= minBalance);
					const state: BalanceState = {
						at: Date.now(),
						low,
						notice: !result.available
							? `${name} 账户余额已不足以调用模型，已自动停止。充值后再继续。`
							: `${name} 账户余额 ${item ? formatBalance(item) : ""} 已到底线 ${floor}，已自动停止。可充值，或在设置中调低余额底线。`,
					};
					cache.set(provider, state);
					return state;
				} catch {
					const state: BalanceState = { at: Date.now(), low: false, notice: "" };
					cache.set(provider, state);
					return state;
				} finally {
					pending.delete(provider);
				}
			})();
			pending.set(provider, task);
			return task;
		};
		const cached = (ctx: { model?: { provider: string } }) => {
			const provider = ctx.model?.provider.startsWith("desktop-") ? ctx.model.provider.slice(8) : undefined;
			return provider ? cache.get(provider) : undefined;
		};
		let balanceStopped = false;
		let balanceNoticeShown = false;
		pi.on("input", async (_event, ctx) => {
			const known = cached(ctx);
			const state = fresh(known) ? known : await refresh(ctx);
			if (!state?.low) return { action: "continue" };
			ctx.ui.notify(state.notice, "warning");
			return { action: "handled" };
		});
		pi.on("before_agent_start", () => {
			balanceStopped = false;
		});
		// Requests never wait on the lookup: a fresh low balance stops them, a stale one only triggers a refresh.
		pi.on("before_provider_request", (_event, ctx) => {
			const known = cached(ctx);
			const state = fresh(known) ? known : undefined;
			if (!state) void refresh(ctx);
			if (!state?.low) {
				balanceNoticeShown = false;
				return undefined;
			}
			if (!balanceNoticeShown) {
				balanceNoticeShown = true;
				ctx.ui.notify(state.notice, "warning");
			}
			balanceStopped = true;
			ctx.abort();
			return undefined;
		});
		pi.on("turn_end", async (_event, ctx) => {
			if (balanceStopped) return;
			const known = cached(ctx);
			const state = fresh(known) ? known : await refresh(ctx);
			if (!state?.low) return;
			balanceStopped = true;
			ctx.abort();
			return {
				continue: false,
				entries: [{ type: "custom_message", customType: "desktop_min_balance", content: state.notice, display: true }],
			};
		});
	}
	const escalation = testingConnection || isChild ? undefined : parseFallbackModel(process.env.PI_DESKTOP_ESCALATION_MODEL);
	if (escalation) {
		let escalatedThisRun = false;
		let escalatedFromModel: { provider: string; id: string } | undefined;
		pi.on("before_agent_start", () => {
			escalatedThisRun = false;
		});
		pi.on("turn_end", async (event, ctx) => {
			if (escalatedThisRun || !editedThisRun || consecutiveVerifyFailures < 2) return;
			if (maxTurns > 0 && turnCount >= maxTurns) return;
			const current = ctx?.model;
			if (!current || (current.provider === escalation.provider && current.id === escalation.id)) return;
			const target = ctx.modelRegistry?.find?.(escalation.provider, escalation.id);
			const switched = target ? await pi.setModel(target).catch(() => false) : false;
			if (!target || !switched) return;
			escalatedThisRun = true;
			escalatedFromModel = { provider: current.provider, id: current.id };
			const fromLabel = current.name || current.id;
			const toLabel = target.name || target.id;
			const notice = `连续 ${consecutiveVerifyFailures} 次代码验证未通过，已临时从 ${fromLabel} 升档至 ${toLabel} 协助根因诊断与修复。`;
			ctx.ui?.notify?.(notice, "info");
			const detail = lastVerifyFailureSummary ? `\n最近一次验证摘要：${lastVerifyFailureSummary}` : "";
			return {
				entries: [
					...(event?.entries ?? []),
					{
						type: "custom_message",
						customType: ESCALATION_MESSAGE_TYPE,
						content: `${notice}${detail}\n请先审视根因与调用链（避免重复同一无效补丁），给出最小精确修复并重新运行验证。`,
						display: true,
					},
				],
			};
		});
		pi.on("agent_settled", async (_event, ctx) => {
			const origin = escalatedFromModel;
			escalatedFromModel = undefined;
			if (!origin || ctx?.model?.provider !== escalation.provider || ctx.model.id !== escalation.id) return;
			const target = ctx.modelRegistry?.find?.(origin.provider, origin.id);
			if (target) await pi.setModel(target).catch(() => false);
		});
	}
	const fallback = testingConnection ? undefined : parseFallbackModel(process.env.PI_DESKTOP_FALLBACK_MODEL);
	if (fallback) {
		let fallbackUsed = false;
		let primaryModel: { provider: string; id: string } | undefined;
		let lastError: string | undefined;
		// One automatic fallback per prompt (user message, wakeup or other run start).
		pi.on("before_agent_start", () => {
			fallbackUsed = false;
			lastError = undefined;
		});
		pi.on("message_end", (event) => {
			const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
			if (message.role !== "assistant") return;
			lastError = message.stopReason === "error" ? (message.errorMessage ?? "") : undefined;
		});
		// Pi reaches this boundary only after its own retries are exhausted and the run was not
		// aborted; cost-cap and balance-floor stops abort the run, so they never get here.
		pi.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome !== "error" || fallbackUsed || lastError === undefined) return;
			if (maxTurns > 0 && turnCount >= maxTurns) return;
			const reason = fallbackReason(lastError);
			if (!reason) return;
			const current = ctx.model;
			if (!current || (current.provider === fallback.provider && current.id === fallback.id)) return;
			const recent = event.context.contextMessages.slice(-4) as Array<{ role?: string; customType?: string }>;
			if (recent.some((m) => m.role === "custom" && (m.customType === "desktop_max_cost" || m.customType === "desktop_min_balance")))
				return;
			fallbackUsed = true;
			const target = ctx.modelRegistry.find(fallback.provider, fallback.id);
			const switched = target ? await pi.setModel(target).catch(() => false) : false;
			const primary = current.name || current.id;
			if (!target || !switched) {
				ctx.ui.notify(`主模型 ${primary} 暂不可用（${reason}），但备用模型 ${fallback.id} 当前不可用，未自动切换。`, "warning");
				return;
			}
			primaryModel = { provider: current.provider, id: current.id };
			const notice = `主模型 ${primary} 暂不可用（${reason}），已切换到备用模型 ${target.name || target.id} 继续。`;
			ctx.ui.notify(notice, "warning");
			lastError = undefined;
			return {
				continue: true,
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: FALLBACK_MESSAGE_TYPE,
						content: `${notice}\n请从中断处继续完成上一个任务。`,
						display: true,
					},
				],
			};
		});
		pi.on("agent_settled", async (_event, ctx) => {
			const primary = primaryModel;
			primaryModel = undefined;
			if (!primary || ctx.model?.provider !== fallback.provider || ctx.model.id !== fallback.id) return;
			const target = ctx.modelRegistry.find(primary.provider, primary.id);
			if (target) await pi.setModel(target).catch(() => false);
		});
	}
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
			const statusOnlyTurn = () => {
				const lastUser = ctx.sessionManager?.getBranch?.().findLast((entry) => entry.type === "message" && entry.message.role === "user");
				if (lastUser?.type !== "message" || lastUser.message.role !== "user") return false;
				const content = lastUser.message.content;
				if (typeof content === "string") return isStatusOnlyRequest(content);
				return content.every((item) => item.type === "text") &&
					isStatusOnlyRequest(content.filter((item) => !isDesktopWorkspaceContext(item.text)).map((item) => item.text).join("\n"));
			};
			const statusBlockReason = "本轮仅查询状态，不能执行远端写操作。";
			if (decision.remoteMutation && statusOnlyTurn()) return { block: true, reason: statusBlockReason };
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
					if (decision.remoteMutation && statusOnlyTurn()) return { block: true, reason: statusBlockReason };
					effectiveAction = decision.action;
					confirmReason = decision.reason;
				}
				if (hook?.permissionDecision === "allow" && effectiveAction === "ask" && !decision.ruleId && !decision.remoteMutation) {
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
						if (decision.remoteMutation && statusOnlyTurn()) return { block: true, reason: statusBlockReason };
						if (decision.remoteMutation) confirmReason = decision.reason;
					}
					if (permHook?.permissionDecision === "allow" && !decision.remoteMutation) {
						const recheck = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
						if (recheck.action === "deny") return { block: true, reason: recheck.reason };
						if (recheck.remoteMutation) {
							if (statusOnlyTurn()) return { block: true, reason: statusBlockReason };
							decision = recheck;
							confirmReason = recheck.reason;
						} else effectiveAction = "allow";
					}
				}
			}
			// dontAsk never opens an approval dialog, including prompts a hook asked for.
			if (effectiveAction === "ask" && policy.dontAsk)
				return { block: true, reason: `dontAsk 模式自动拒绝未预授权的操作：${confirmReason}` };
			if (effectiveAction === "ask") {
				const allowed = await ctx.ui.confirm(
					`允许执行 ${event.toolName}${decision.remoteMutation ? "（远端写入，仅本次）" : ""}？`,
					`${confirmReason}\n\n${JSON.stringify(event.input, null, 2)}`,
				);
				if (!allowed) return { block: true, reason: "用户未批准此操作。" };
				// An approval dialog can stay open while the host revokes this tool or adds a deny rule.
				const latest = await evaluatePermission(await loadRuntimePermissionPolicy(), event);
				if (latest.action === "deny") return { block: true, reason: latest.reason };
				if (latest.remoteMutation && statusOnlyTurn()) return { block: true, reason: statusBlockReason };
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
		const bashExitCode = event.toolName === "bash" && event.structuredContent &&
			typeof event.structuredContent === "object" && "exit_code" in event.structuredContent
			? event.structuredContent.exit_code : undefined;
		let recorded: Pick<ToolResultEventResult, "details"> | undefined = typeof bashExitCode === "number" && Number.isInteger(bashExitCode)
			? { details: { ...(event.details && typeof event.details === "object" ? event.details : {}), exitCode: bashExitCode } }
			: undefined;
		const pathRules = !event.isError && ["read", "write", "edit"].includes(event.toolName) && typeof event.input.path === "string"
			? await scopedContext("", [event.input.path]).catch(() => "")
			: "";
		let redacted: typeof event.content | undefined;
		if (!event.isError && ["grep", "find", "ls"].includes(event.toolName)) {
			try {
				const policy = await loadRuntimePermissionPolicy();
				redacted = await redactSearchResult(policy, event.toolName, event.input, event.content);
				if ((policy.sandbox || redacted) && event.details && typeof event.details === "object" &&
					"truncation" in event.details && event.details.truncation && typeof event.details.truncation === "object") {
					const { content: _unfiltered, ...truncation } = event.details.truncation as Record<string, unknown>;
					recorded = { details: { ...event.details, truncation } };
				}
			} catch {
				return {
					content: [{ type: "text" as const, text: "无法确认搜索结果中的文件权限，已隐藏结果。" }],
					details: {},
					isError: true,
				};
			}
		}
		if (redacted) event = { ...event, content: redacted } as typeof event;
		if (!event.isError && ["TodoCreate", "TodoUpdate", "TodoGet", "TodoList"].includes(event.toolName)) {
			const details = event.details as { todo?: unknown; todos?: unknown } | undefined;
			if (event.toolName === "TodoList" && Array.isArray(details?.todos)) sharedTodoItems.clear();
			const items = Array.isArray(details?.todos) ? details.todos : [details?.todo];
			for (const item of items) {
				if (!item || typeof item !== "object") continue;
				const todo = item as { id?: unknown; subject?: unknown; status?: unknown };
				if (typeof todo.id === "string" && typeof todo.subject === "string" && typeof todo.status === "string")
					sharedTodoItems.set(todo.id, { content: todo.subject, status: todo.status });
			}
			checklist = "shared";
			callsSinceTodoUpdate = 0;
		} else if (event.toolName !== "TodoWrite" || event.isError) {
			callsSinceTodoUpdate++;
		}
		const postTodoReminder = !testingConnection && callsSinceTodoUpdate === 4
			? staleTodoReminder(checklist, checklist === "simple" ? activeTodoWriteItems : [...sharedTodoItems.values()])
			: undefined;
		const additions = [pathRules, postTodoReminder].filter(Boolean).join("\n\n");
		const content = additions ? [...event.content, { type: "text" as const, text: additions }] : event.content;
		if (!testingConnection) {
			if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
				editedThisRun = true;
				const fullOut = textFromBlocks(content);
				if (/\[LSP 诊断 [^\]]+\]:[\s\S]*?\[Error\]/.test(fullOut)) {
					consecutiveVerifyFailures++;
					lastVerifyFailureSummary = fullOut.split("\n").find((l) => l.includes("[Error]"))?.slice(0, 240) ?? "LSP 类型检查报错";
				}
			} else if (event.toolName === "bash" && editedThisRun) {
				const rawCmd = (event.input as { command?: unknown } | undefined)?.command;
				const cleanCmd = typeof rawCmd === "string"
					? rawCmd.replace(/^\/usr\/bin\/sandbox-exec -f '[^']*' \/bin\/sh -c '/, "").replace(/'$/, "")
					: rawCmd;
				if (isVerificationBashCommand(cleanCmd)) {
					const failed = Boolean(event.isError) || (typeof bashExitCode === "number" && bashExitCode !== 0);
					if (failed) {
						consecutiveVerifyFailures++;
						lastVerifyFailureSummary = textFromBlocks(event.content).trim().split("\n").slice(-3).join(" / ").slice(0, 260);
					} else {
						consecutiveVerifyFailures = 0;
						lastVerifyFailureSummary = "";
					}
				}
			}
		}
		const changed = () => {
			if (!redacted && !additions) return recorded;
			return { ...recorded, content };
		};
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
			return { ...recorded, content: [...content, { type: "text" as const, text: `\n\n[Hook Blocked] ${reason}` }], isError: true };
		}
		if (!hook.suppressOutput && typeof hook.additionalContext === "string" && hook.additionalContext.trim()) {
			return { ...recorded, content: [...content, { type: "text" as const, text: `\n\n[Hook Context]\n${hook.additionalContext.trim()}` }] };
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

/**
 * Appends the desktop output style to the main conversation's system prompt.
 * The file is re-read every turn, so a style change applies on the next turn.
 * Delegated children never receive the file path.
 */
export const OUTPUT_STYLE_SECTION = "output_style";
export function registerOutputStyle(pi: Pick<ExtensionAPI, "on">, file: string | undefined): void {
	if (!file) return;
	pi.on("before_agent_start", async (event) => {
		// Write a named prompt section instead of returning `systemPrompt`: a returned prompt is
		// forced as opaque text for the whole run and drops sections added by later handlers.
		const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
		if (!sections) return;
		const style = (await readFile(file, "utf8").catch(() => "")).trim();
		if (style) sections[OUTPUT_STYLE_SECTION] = style.slice(0, 64 * 1024);
		else delete sections[OUTPUT_STYLE_SECTION];
	});
}
