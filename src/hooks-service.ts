import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import { piToClaudeToolNames } from "./claude-settings-sync.ts";
import type {
	HookEntry,
	HookEventName,
	HookHandlerType,
	HookRemoveInput,
	HookRunResult,
	HookSaveInput,
	HookScope,
} from "./hook-types.ts";

export const hookEventNames: HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"SessionStart",
	"Notification",
];

const maxTimeoutMs = 60000;
const maxResponseBytes = 256 * 1024;
const toolHookEvents = new Set<HookEventName>(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);

interface RawHookHandler {
	id?: unknown;
	type?: unknown;
	command?: unknown;
	url?: unknown;
	headers?: unknown;
	allowedEnvVars?: unknown;
	timeout?: unknown;
	statusMessage?: unknown;
}

interface RawHookGroup extends RawHookHandler {
	matcher?: unknown;
	hooks?: unknown;
}

interface PiHooksFile {
	version?: number;
	hooks?: Partial<Record<HookEventName, Array<Record<string, unknown>>>>;
}

export interface HookRunContext {
	project?: string;
	projectTrusted: boolean;
	conversationId?: string;
	permissionMode?: string;
	toolName?: string;
	toolCallId?: string;
	toolInput?: Record<string, unknown>;
	toolResponse?: unknown;
	error?: string;
	prompt?: string;
	message?: string;
	title?: string;
	notificationType?: string;
	agentId?: string;
	agentType?: string;
	additionalContext?: string;
	transcriptPath?: string;
	stopHookActive?: boolean;
	lastAssistantMessage?: string;
	trigger?: "manual" | "auto";
	source?: "startup" | "resume" | "clear" | "compact";
	extraHooks?: HookEntry[];
	env?: NodeJS.ProcessEnv;
}

function stableId(prefix: string, parts: unknown[]): string {
	return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12)}`;
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`${label}无效。`);
	return value.trim();
}

export function validateHttpHookUrl(rawUrl: string): string {
	const trimmed = text(rawUrl, "Hook URL", 2048);
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Hook URL 格式无效。");
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password)
		throw new Error("HTTP Hook URL 仅支持无凭据的 http/https 地址。");
	return parsed.toString();
}

function safePlainRecord(value: unknown, maxKeys = 64): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, unknown> = {};
	let count = 0;
	for (const [key, item] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		out[key] = item;
		if (++count >= maxKeys) break;
	}
	return out;
}

function parseHeadersMap(value: unknown): Record<string, string> | undefined {
	const raw = safePlainRecord(value, 32);
	if (!raw) return undefined;
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(raw)) {
		if (!/^[A-Za-z0-9-]+$/.test(key) || typeof val !== "string" || val.includes("\0") || val.length > 4096) continue;
		out[key] = val;
	}
	return Object.keys(out).length ? out : undefined;
}

function parseAllowedEnvVars(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const vars = value
		.filter((item): item is string => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))
		.slice(0, 32);
	return vars.length ? [...new Set(vars)] : undefined;
}

function normalizeTimeout(raw: unknown, timeoutInSeconds: boolean): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
	const ms = timeoutInSeconds && raw <= 1000 ? raw * 1000 : raw;
	return Math.min(Math.max(500, Math.floor(ms)), maxTimeoutMs);
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		if (Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) return undefined;
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function parseHandlerObject(
	handler: RawHookHandler,
	event: HookEventName,
	matcher: string | undefined,
	scope: HookScope,
	sourceFile: string,
	editable: boolean,
	timeoutInSeconds: boolean,
	indexKeys: unknown[],
): HookEntry | undefined {
	const handlerType: HookHandlerType | undefined =
		handler.type === "http" || (handler.type === undefined && typeof handler.url === "string" && !handler.command)
			? "http"
			: handler.type === undefined || handler.type === "command"
				? "command"
				: undefined;
	if (!handlerType) return undefined;
	const timeout = normalizeTimeout(handler.timeout, timeoutInSeconds);
	const statusMessage =
		typeof handler.statusMessage === "string" && handler.statusMessage.trim()
			? handler.statusMessage.trim().slice(0, 200)
			: undefined;

	if (handlerType === "http") {
		if (typeof handler.url !== "string" || !handler.url.trim()) return undefined;
		let url: string;
		try {
			url = validateHttpHookUrl(handler.url);
		} catch {
			return undefined;
		}
		const headers = parseHeadersMap(handler.headers);
		const allowedEnvVars = parseAllowedEnvVars(handler.allowedEnvVars);
		const id =
			typeof handler.id === "string" && handler.id.trim()
				? handler.id.trim()
				: stableId(scope, [sourceFile, event, ...indexKeys, matcher ?? "", "http", url]);
		return {
			id,
			event,
			handlerType: "http",
			matcher,
			url,
			...(headers ? { headers } : {}),
			...(allowedEnvVars ? { allowedEnvVars } : {}),
			timeout,
			...(statusMessage ? { statusMessage } : {}),
			scope,
			sourceFile,
			editable,
		};
	}

	if (typeof handler.command !== "string" || !handler.command.trim()) return undefined;
	const command = handler.command.trim();
	const id =
		typeof handler.id === "string" && handler.id.trim()
			? handler.id.trim()
			: stableId(scope, [sourceFile, event, ...indexKeys, matcher ?? "", command]);
	return {
		id,
		event,
		handlerType: "command",
		matcher,
		command,
		timeout,
		...(statusMessage ? { statusMessage } : {}),
		scope,
		sourceFile,
		editable,
	};
}

/** Parse either Claude nested matcher groups or Pi flat hook lists. Shared by HooksService & AgentRegistry. */
export function parseHooksMap(
	rawHooks: unknown,
	scope: HookScope,
	sourceFile: string,
	editable: boolean,
	timeoutInSeconds = !editable,
): HookEntry[] {
	if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks)) return [];
	const hooksObj = rawHooks as Record<string, unknown>;
	const entries: HookEntry[] = [];
	for (const event of hookEventNames) {
		const list = hooksObj[event];
		if (!Array.isArray(list)) continue;
		for (let groupIdx = 0; groupIdx < list.length; groupIdx++) {
			const group = list[groupIdx];
			if (!group || typeof group !== "object") continue;
			const rec = group as RawHookGroup;
			const matcher = typeof rec.matcher === "string" && rec.matcher.trim() ? rec.matcher.trim().slice(0, 300) : undefined;
			if (Array.isArray(rec.hooks)) {
				for (let idx = 0; idx < rec.hooks.length; idx++) {
					const handler = rec.hooks[idx] as RawHookHandler;
					if (!handler || typeof handler !== "object") continue;
					const parsed = parseHandlerObject(handler, event, matcher, scope, sourceFile, editable, timeoutInSeconds, [groupIdx, idx]);
					if (parsed) entries.push(parsed);
				}
			} else {
				const parsed = parseHandlerObject(rec, event, matcher, scope, sourceFile, editable, timeoutInSeconds, [groupIdx]);
				if (parsed) entries.push(parsed);
			}
		}
	}
	return entries;
}

function matcherMatches(matcher: string | undefined, target: string | undefined): boolean {
	if (!matcher || matcher === "*") return true;
	if (!target) return false;
	try {
		return new RegExp(matcher).test(target);
	} catch {
		return target === matcher || target.includes(matcher);
	}
}

function matchesEventContext(entry: HookEntry, context: HookRunContext): boolean {
	if (!entry.matcher || entry.matcher === "*") return true;
	if (toolHookEvents.has(entry.event)) {
		const tool = context.toolName;
		if (!tool) return matcherMatches(entry.matcher, context.message ?? entry.event);
		if (matcherMatches(entry.matcher, tool)) return true;
		const claudeName = piToClaudeToolNames[tool];
		return Boolean(claudeName && matcherMatches(entry.matcher, claudeName));
	}
	if (entry.event === "SubagentStart" || entry.event === "SubagentStop")
		return matcherMatches(entry.matcher, context.agentType);
	if (entry.event === "PreCompact") return matcherMatches(entry.matcher, context.trigger ?? "manual");
	if (entry.event === "SessionStart") return matcherMatches(entry.matcher, context.source ?? "startup");
	if (entry.event === "Notification") return matcherMatches(entry.matcher, context.notificationType ?? context.title);
	return matcherMatches(entry.matcher, context.prompt ?? context.message ?? entry.event);
}

function stripSensitiveDesktopEnv(baseEnv: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
	const cleaned: NodeJS.ProcessEnv = {};
	for (const [key, val] of Object.entries(baseEnv)) {
		if (val === undefined) continue;
		if (/^PI_DESKTOP_(?:KEY_|HOST_TOKEN|TOOLS_TOKEN|NAVIGATION_TOKEN)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
			continue;
		cleaned[key] = val;
	}
	cleaned.CLAUDE_PROJECT_DIR = cwd;
	cleaned.PI_PROJECT_DIR = cwd;
	return cleaned;
}

function interpolateAllowedHeaders(
	headers: Record<string, string> | undefined,
	allowedEnvVars: string[] | undefined,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const out: Record<string, string> = { "content-type": "application/json" };
	if (!headers) return out;
	const allowed = new Set(allowedEnvVars ?? []);
	for (const [name, template] of Object.entries(headers)) {
		if (name.toLowerCase() === "content-type") continue;
		out[name] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_full, a, b) => {
			const varName = (a ?? b) as string;
			return allowed.has(varName) ? (env[varName] ?? "") : "";
		});
	}
	return out;
}

interface ParsedHookJson {
	blocked?: boolean;
	permissionDecision?: "allow" | "deny" | "ask";
	reason?: string;
	additionalContext?: string;
	systemMessage?: string;
	updatedInput?: Record<string, unknown>;
	suppressOutput?: boolean;
}

function parseHookJsonOutput(rawText: string, event: HookEventName, fallbackEntryId: string): ParsedHookJson | undefined {
	const trimmed = rawText.trim();
	if (!trimmed) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "UserPromptSubmit" || event === "SessionStart") {
			return { additionalContext: trimmed.slice(0, 4000) };
		}
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const rec = parsed as {
		continue?: unknown;
		decision?: unknown;
		reason?: unknown;
		stopReason?: unknown;
		systemMessage?: unknown;
		suppressOutput?: unknown;
		hookSpecificOutput?: {
			permissionDecision?: unknown;
			permissionDecisionReason?: unknown;
			additionalContext?: unknown;
			updatedInput?: unknown;
			decision?: {
				behavior?: unknown;
				message?: unknown;
				updatedInput?: unknown;
			};
		};
	};
	const specific = rec.hookSpecificOutput;
	const nestedBehavior = specific?.decision?.behavior;
	const decisionValue: "allow" | "deny" | "ask" | undefined =
		specific?.permissionDecision === "allow" || specific?.permissionDecision === "deny" || specific?.permissionDecision === "ask"
			? specific.permissionDecision
			: nestedBehavior === "allow" || nestedBehavior === "deny"
				? nestedBehavior
				: undefined;
	const updatedInput = safePlainRecord(specific?.updatedInput ?? specific?.decision?.updatedInput, 64);
	const systemMessage = typeof rec.systemMessage === "string" && rec.systemMessage.trim() ? rec.systemMessage.trim() : undefined;
	const additionalContext =
		typeof specific?.additionalContext === "string" && specific.additionalContext.trim()
			? specific.additionalContext.trim()
			: undefined;
	const blocked =
		rec.continue === false ||
		rec.decision === "block" ||
		rec.decision === "deny" ||
		decisionValue === "deny";
	const reason = blocked
		? (typeof specific?.permissionDecisionReason === "string" && specific.permissionDecisionReason.trim()
				? specific.permissionDecisionReason.trim()
				: typeof specific?.decision?.message === "string" && specific.decision.message.trim()
					? specific.decision.message.trim()
					: typeof rec.reason === "string" && rec.reason.trim()
						? rec.reason.trim()
						: typeof rec.stopReason === "string" && rec.stopReason.trim()
							? rec.stopReason.trim()
							: `Hook (${fallbackEntryId}) 拒绝执行。`)
		: (typeof specific?.permissionDecisionReason === "string" && specific.permissionDecisionReason.trim()
				? specific.permissionDecisionReason.trim()
				: undefined);

	return {
		blocked,
		permissionDecision: decisionValue,
		reason,
		additionalContext,
		systemMessage,
		updatedInput,
		suppressOutput: rec.suppressOutput === true ? true : undefined,
	};
}

export class HooksService {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	private async editableFile(scope: "user" | "project", project: string | undefined, create: boolean) {
		if (scope === "user") return managedFile(this.agentDir(), [], "hooks.json", create);
		if (!project || !isAbsolute(project)) throw new Error("项目作用域 Hook 需要绝对项目路径。");
		return managedFile(project, [".pi"], "hooks.json", create);
	}

	async list(project?: string, projectTrusted = true): Promise<HookEntry[]> {
		const claudeHome = join(homedir(), ".claude", "settings.json");
		const claudeHomeLocal = join(homedir(), ".claude", "settings.local.json");
		const piHome = join(this.agentDir(), "hooks.json");
		const entries: HookEntry[] = [
			...parseHooksMap((await readJsonFile(claudeHome))?.hooks, "user", claudeHome, false, true),
			...parseHooksMap((await readJsonFile(claudeHomeLocal))?.hooks, "user", claudeHomeLocal, false, true),
			...parseHooksMap((await readJsonFile(piHome))?.hooks, "user", piHome, true, false),
		];
		if (project && isAbsolute(project) && projectTrusted) {
			const claudeProj = join(project, ".claude", "settings.json");
			const claudeLocal = join(project, ".claude", "settings.local.json");
			const piProj = join(project, ".pi", "hooks.json");
			entries.push(
				...parseHooksMap((await readJsonFile(claudeProj))?.hooks, "project", claudeProj, false, true),
				...parseHooksMap((await readJsonFile(claudeLocal))?.hooks, "project", claudeLocal, false, true),
				...parseHooksMap((await readJsonFile(piProj))?.hooks, "project", piProj, true, false),
			);
		}
		return entries;
	}

	async hasConfiguredHooks(project?: string, projectTrusted = false): Promise<boolean> {
		return (await this.list(project, projectTrusted)).length > 0;
	}

	async save(input: HookSaveInput): Promise<HookEntry[]> {
		if (!hookEventNames.includes(input.event)) throw new Error("不支持的 Hook 事件类型。");
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Hook 作用域无效。");
		const handlerType: HookHandlerType = input.handlerType === "http" ? "http" : "command";
		const matcher = input.matcher?.trim() ? input.matcher.trim().slice(0, 300) : undefined;
		const timeout =
			input.timeout !== undefined ? Math.min(Math.max(500, Math.floor(input.timeout)), maxTimeoutMs) : undefined;
		const statusMessage = input.statusMessage?.trim() ? input.statusMessage.trim().slice(0, 200) : undefined;
		const file = (await this.editableFile(input.scope, input.project, true))!;
		const raw = (await readJsonFile(file)) as PiHooksFile | undefined;
		const hooks: NonNullable<PiHooksFile["hooks"]> = { ...(raw?.hooks ?? {}) };
		const existing = Array.isArray(hooks[input.event]) ? [...hooks[input.event]!] : [];
		const id = input.id?.trim() || stableId(input.scope, [file, input.event, Date.now(), Math.random()]);

		let nextEntry: Record<string, unknown>;
		if (handlerType === "http") {
			const url = validateHttpHookUrl(input.url ?? "");
			const headers = parseHeadersMap(input.headers);
			const allowedEnvVars = parseAllowedEnvVars(input.allowedEnvVars);
			nextEntry = {
				id,
				type: "http",
				...(matcher ? { matcher } : {}),
				url,
				...(headers ? { headers } : {}),
				...(allowedEnvVars ? { allowedEnvVars } : {}),
				...(timeout ? { timeout } : {}),
				...(statusMessage ? { statusMessage } : {}),
			};
		} else {
			const command = text(input.command, "Hook 命令", 16384);
			nextEntry = {
				id,
				type: "command",
				...(matcher ? { matcher } : {}),
				command,
				...(timeout ? { timeout } : {}),
				...(statusMessage ? { statusMessage } : {}),
			};
		}

		const filtered = existing.filter((item) => item?.id !== id);
		if (filtered.length >= 100) throw new Error("单个事件的 Hook 数量已达上限。");
		hooks[input.event] = [...filtered, nextEntry];
		await writeManagedFile(file, JSON.stringify({ version: 1, hooks }, null, 2) + "\n");
		return this.list(input.project, true);
	}

	async remove(input: HookRemoveInput): Promise<HookEntry[]> {
		const id = text(input.id, "Hook ID", 200);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Hook 作用域无效。");
		const file = await this.editableFile(input.scope, input.project, false);
		if (!file) return this.list(input.project, true);
		const raw = (await readJsonFile(file)) as PiHooksFile | undefined;
		if (!raw?.hooks) return this.list(input.project, true);
		const hooks: NonNullable<PiHooksFile["hooks"]> = { ...raw.hooks };
		for (const event of hookEventNames) {
			const list = hooks[event];
			if (!Array.isArray(list)) continue;
			hooks[event] = list.filter((item, idx) => {
				if (!item) return false;
				const rec = item as RawHookHandler & { matcher?: string };
				if (rec.id === id) return false;
				const derived =
					typeof rec.url === "string"
						? stableId(input.scope, [file, event, idx, rec.matcher ?? "", "http", rec.url])
						: stableId(input.scope, [file, event, idx, rec.matcher ?? "", String(rec.command ?? "")]);
				return derived !== id;
			});
		}
		await writeManagedFile(file, JSON.stringify({ version: 1, hooks }, null, 2) + "\n");
		return this.list(input.project, true);
	}

	async run(event: HookEventName, context: HookRunContext): Promise<HookRunResult> {
		const all = [...(await this.list(context.project, context.projectTrusted)), ...(context.extraHooks ?? [])];
		const matching = all.filter((entry) => entry.event === event && matchesEventContext(entry, context));
		if (!matching.length) return { blocked: false, executedCount: 0 };

		const contexts: string[] = [];
		const messages: string[] = [];
		let permissionDecision: "allow" | "deny" | "ask" | undefined;
		let askReason: string | undefined;
		let mergedUpdatedInput: Record<string, unknown> | undefined;
		let suppressOutput = false;

		const cwd = context.project && isAbsolute(context.project) ? context.project : process.cwd();
		const sanitizedEnv = stripSensitiveDesktopEnv({ ...process.env, ...context.env }, cwd);
		const baseInput = {
			hook_event_name: event,
			session_id: context.conversationId,
			cwd,
			...(context.permissionMode ? { permission_mode: context.permissionMode } : {}),
			...(context.toolName !== undefined ? { tool_name: context.toolName } : {}),
			...(context.toolCallId !== undefined ? { tool_use_id: context.toolCallId } : {}),
			...(context.toolInput !== undefined ? { tool_input: context.toolInput } : {}),
			...(context.toolResponse !== undefined ? { tool_response: context.toolResponse } : {}),
			...(context.error !== undefined ? { error: context.error, is_interrupt: false } : {}),
			...(context.prompt !== undefined ? { prompt: context.prompt } : {}),
			...(context.message !== undefined ? { message: context.message } : {}),
			...(context.notificationType !== undefined
				? { notification_type: context.notificationType, ...(context.title ? { title: context.title } : {}) }
				: {}),
			...(context.agentId !== undefined ? { agent_id: context.agentId } : {}),
			...(context.agentType !== undefined ? { agent_type: context.agentType } : {}),
			...(context.transcriptPath !== undefined ? { agent_transcript_path: context.transcriptPath } : {}),
			...(context.stopHookActive !== undefined ? { stop_hook_active: context.stopHookActive } : {}),
			...(context.lastAssistantMessage !== undefined ? { last_assistant_message: context.lastAssistantMessage } : {}),
			...(context.trigger !== undefined ? { trigger: context.trigger } : {}),
			...(context.source !== undefined ? { source: context.source } : {}),
		};

		for (let i = 0; i < matching.length; i++) {
			const entry = matching[i]!;
			const payloadObj =
				context.toolName && (!entry.editable || entry.scope === "agent")
					? { ...baseInput, tool_name: piToClaudeToolNames[context.toolName] ?? context.toolName }
					: baseInput;
			const payloadJson = JSON.stringify(payloadObj);

			let parsed: ParsedHookJson | undefined;
			if (entry.handlerType === "http") {
				parsed = await execHttpHook(entry, payloadJson, sanitizedEnv, event);
			} else {
				const outcome = await execHookCommand(entry.command ?? "", {
					cwd,
					stdin: payloadJson,
					timeout: entry.timeout ?? 10000,
					env: sanitizedEnv,
				});
				if (outcome.code === 2) {
					return {
						blocked: true,
						permissionDecision: "deny",
						reason: outcome.stderr.trim() || outcome.stdout.trim() || `Hook (${entry.id}) 阻止了操作。`,
						additionalContext: contexts.join("\n") || undefined,
						systemMessage: messages.join("\n") || undefined,
						executedCount: i + 1,
					};
				}
				parsed = parseHookJsonOutput(outcome.stdout, event, entry.id);
			}

			if (!parsed) continue;
			if (parsed.suppressOutput) suppressOutput = true;
			if (parsed.systemMessage) messages.push(parsed.systemMessage);
			if (parsed.additionalContext && !parsed.suppressOutput) contexts.push(parsed.additionalContext);
			if (parsed.updatedInput) {
				mergedUpdatedInput = { ...(mergedUpdatedInput ?? {}), ...parsed.updatedInput };
			}
			if (parsed.blocked || parsed.permissionDecision === "deny") {
				return {
					blocked: true,
					permissionDecision: "deny",
					reason: parsed.reason ?? `Hook (${entry.id}) 拒绝执行。`,
					additionalContext: contexts.join("\n") || undefined,
					systemMessage: messages.join("\n") || undefined,
					...(mergedUpdatedInput ? { updatedInput: mergedUpdatedInput } : {}),
					...(suppressOutput ? { suppressOutput: true } : {}),
					executedCount: i + 1,
				};
			}
			if (parsed.permissionDecision === "ask") {
				permissionDecision = "ask";
				if (parsed.reason) askReason = parsed.reason;
			} else if (parsed.permissionDecision === "allow" && permissionDecision !== "ask") {
				permissionDecision = "allow";
			}
		}

		return {
			blocked: false,
			permissionDecision,
			...(askReason ? { reason: askReason } : {}),
			additionalContext: contexts.join("\n") || undefined,
			systemMessage: messages.join("\n") || undefined,
			...(mergedUpdatedInput ? { updatedInput: mergedUpdatedInput } : {}),
			...(suppressOutput ? { suppressOutput: true } : {}),
			executedCount: matching.length,
		};
	}
}

async function execHttpHook(
	entry: HookEntry,
	body: string,
	env: NodeJS.ProcessEnv,
	event: HookEventName,
): Promise<ParsedHookJson> {
	if (!entry.url) return {};
	let validUrl: string;
	try {
		validUrl = validateHttpHookUrl(entry.url);
	} catch (error) {
		return { systemMessage: error instanceof Error ? error.message : "HTTP Hook URL 无效。" };
	}
	const headers = interpolateAllowedHeaders(entry.headers, entry.allowedEnvVars, env);
	try {
		const response = await fetch(validUrl, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(entry.timeout ?? 10000),
			redirect: "error",
		});
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (reader) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value) continue;
					const take = Math.min(value.byteLength, maxResponseBytes - total);
					if (take > 0) {
						chunks.push(value.subarray(0, take));
						total += take;
					}
					if (total >= maxResponseBytes) {
						await reader.cancel().catch(() => {});
						break;
					}
				}
			} finally {
				reader.releaseLock();
			}
		}
		const textBody = chunks.length ? Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") : "";
		if (!response.ok) {
			// Per Claude Code HTTP hook semantics, non-2xx responses are non-blocking errors.
			return { systemMessage: `HTTP Hook (${entry.id}) returned HTTP ${response.status}` };
		}
		return parseHookJsonOutput(textBody, event, entry.id) ?? {};
	} catch (error) {
		return { systemMessage: `HTTP Hook (${entry.id}) failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function execHookCommand(
	command: string,
	options: { cwd: string; stdin: string; timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
		const child = spawn(shell, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		const timer = setTimeout(() => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* The command may already have exited. */ }
			finish(1);
		}, options.timeout);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < maxResponseBytes) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < maxResponseBytes) stderr += chunk.toString("utf8");
		});
		child.on("error", () => finish(1));
		child.on("close", (code) => finish(code));
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin);
	});
}
