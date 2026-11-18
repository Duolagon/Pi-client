import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
	HookEntry,
	HookEventName,
	HookRemoveInput,
	HookRunResult,
	HookSaveInput,
	HookScope,
} from "./hook-types.ts";

export const hookEventNames: HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"Notification",
];

interface RawClaudeHandler {
	type?: unknown;
	command?: unknown;
	timeout?: unknown;
	id?: unknown;
}

interface RawClaudeMatcherGroup {
	matcher?: unknown;
	hooks?: unknown;
}

interface PiHooksFile {
	version?: number;
	hooks?: Partial<Record<HookEventName, Array<{ id?: string; matcher?: string; command: string; timeout?: number }>>>;
}

function stableId(prefix: string, parts: unknown[]): string {
	return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12)}`;
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

function parseClaudeSettingsHooks(
	data: Record<string, unknown> | undefined,
	scope: HookScope,
	sourceFile: string,
	editable: boolean,
): HookEntry[] {
	if (!data || !data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) return [];
	const hooksObj = data.hooks as Record<string, unknown>;
	const entries: HookEntry[] = [];
	for (const event of hookEventNames) {
		const list = hooksObj[event];
		if (!Array.isArray(list)) continue;
		for (let groupIdx = 0; groupIdx < list.length; groupIdx++) {
			const group = list[groupIdx];
			if (!group || typeof group !== "object") continue;
			const rec = group as RawClaudeMatcherGroup & RawClaudeHandler;
			const matcher = typeof rec.matcher === "string" && rec.matcher.trim() ? rec.matcher.trim().slice(0, 300) : undefined;
			// Support both nested Claude { matcher, hooks: [...] } and flat { id, matcher, command } schemas.
			if (Array.isArray(rec.hooks)) {
				for (let idx = 0; idx < rec.hooks.length; idx++) {
					const handler = rec.hooks[idx] as RawClaudeHandler;
					if (!handler || typeof handler !== "object") continue;
					if (handler.type !== undefined && handler.type !== "command") continue;
					if (typeof handler.command !== "string" || !handler.command.trim()) continue;
					const timeout = typeof handler.timeout === "number" && Number.isFinite(handler.timeout)
						? Math.min(Math.max(500, Math.floor(handler.timeout)), 30000)
						: undefined;
					const id = typeof handler.id === "string" && handler.id.trim()
						? handler.id.trim()
						: stableId(scope, [sourceFile, event, groupIdx, idx, matcher ?? "", handler.command]);
					entries.push({ id, event, matcher, command: handler.command.trim(), timeout, scope, sourceFile, editable });
				}
			} else if (typeof rec.command === "string" && rec.command.trim()) {
				const timeout = typeof rec.timeout === "number" && Number.isFinite(rec.timeout)
					? Math.min(Math.max(500, Math.floor(rec.timeout)), 30000)
					: undefined;
				const id = typeof rec.id === "string" && rec.id.trim()
					? rec.id.trim()
					: stableId(scope, [sourceFile, event, groupIdx, matcher ?? "", rec.command]);
				entries.push({ id, event, matcher, command: rec.command.trim(), timeout, scope, sourceFile, editable });
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

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`${label}无效。`);
	return value.trim();
}

export class HooksService {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	private editableFile(scope: HookScope, project?: string): string {
		if (scope === "user") return join(this.agentDir(), "hooks.json");
		if (!project || !isAbsolute(project)) throw new Error("项目作用域 Hook 需要绝对项目路径。");
		return join(project, ".pi", "hooks.json");
	}

	async list(project?: string, projectTrusted = true): Promise<HookEntry[]> {
		const claudeHome = join(homedir(), ".claude", "settings.json");
		const piHome = join(this.agentDir(), "hooks.json");
		const entries: HookEntry[] = [
			...parseClaudeSettingsHooks(await readJsonFile(claudeHome), "user", claudeHome, false),
			...parseClaudeSettingsHooks(await readJsonFile(piHome), "user", piHome, true),
		];
		if (project && isAbsolute(project) && projectTrusted) {
			const claudeProj = join(project, ".claude", "settings.json");
			const claudeLocal = join(project, ".claude", "settings.local.json");
			const piProj = join(project, ".pi", "hooks.json");
			entries.push(
				...parseClaudeSettingsHooks(await readJsonFile(claudeProj), "project", claudeProj, false),
				...parseClaudeSettingsHooks(await readJsonFile(claudeLocal), "project", claudeLocal, false),
				...parseClaudeSettingsHooks(await readJsonFile(piProj), "project", piProj, true),
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
		const command = text(input.command, "Hook 命令", 16384);
		const matcher = input.matcher?.trim() ? input.matcher.trim().slice(0, 300) : undefined;
		const timeout = input.timeout !== undefined ? Math.min(Math.max(500, Math.floor(input.timeout)), 30000) : undefined;
		const file = this.editableFile(input.scope, input.project);
		const raw = (await readJsonFile(file)) as PiHooksFile | undefined;
		const hooks: NonNullable<PiHooksFile["hooks"]> = { ...(raw?.hooks ?? {}) };
		const existing = Array.isArray(hooks[input.event]) ? [...hooks[input.event]!] : [];
		const id = input.id?.trim() || stableId(input.scope, [file, input.event, Date.now(), Math.random()]);
		const nextEntry = { id, ...(matcher ? { matcher } : {}), command, ...(timeout ? { timeout } : {}) };
		const filtered = existing.filter((item) => item?.id !== id);
		if (filtered.length >= 100) throw new Error("单个事件的 Hook 数量已达上限。");
		hooks[input.event] = [...filtered, nextEntry];
		await mkdir(dirname(file), { recursive: true });
		await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, hooks }, null, 2), "utf8");
		await rename(`${file}.tmp`, file);
		return this.list(input.project, true);
	}

	async remove(input: HookRemoveInput): Promise<HookEntry[]> {
		const id = text(input.id, "Hook ID", 200);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Hook 作用域无效。");
		const file = this.editableFile(input.scope, input.project);
		const raw = (await readJsonFile(file)) as PiHooksFile | undefined;
		if (!raw?.hooks) return this.list(input.project, true);
		const hooks: NonNullable<PiHooksFile["hooks"]> = { ...raw.hooks };
		for (const event of hookEventNames) {
			const list = hooks[event];
			if (!Array.isArray(list)) continue;
			hooks[event] = list.filter((item) => {
				if (!item) return false;
				const derived = item.id?.trim() || stableId(input.scope, [file, event, list.indexOf(item), item.matcher ?? "", item.command]);
				return derived !== id && item.id !== id;
			});
		}
		await mkdir(dirname(file), { recursive: true });
		await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, hooks }, null, 2), "utf8");
		await rename(`${file}.tmp`, file);
		return this.list(input.project, true);
	}

	async run(
		event: HookEventName,
		context: {
			project?: string;
			projectTrusted: boolean;
			conversationId?: string;
			toolName?: string;
			toolInput?: Record<string, unknown>;
			toolResponse?: unknown;
			prompt?: string;
			message?: string;
			env?: NodeJS.ProcessEnv;
		},
	): Promise<HookRunResult> {
		const all = await this.list(context.project, context.projectTrusted);
		const matching = all.filter(
			(entry) =>
				entry.event === event &&
				matcherMatches(entry.matcher, context.toolName ?? context.message ?? event),
		);
		if (!matching.length) return { blocked: false, executedCount: 0 };

		const contexts: string[] = [];
		const messages: string[] = [];
		let permissionDecision: "allow" | "deny" | "ask" | undefined;
		const cwd = context.project && isAbsolute(context.project) ? context.project : process.cwd();
		const stdinPayload = JSON.stringify({
			hook_event_name: event,
			session_id: context.conversationId,
			cwd,
			tool_name: context.toolName,
			tool_input: context.toolInput,
			tool_response: context.toolResponse,
			prompt: context.prompt,
			message: context.message,
		});

		for (const entry of matching) {
			const outcome = await execHookCommand(entry.command, {
				cwd,
				stdin: stdinPayload,
				timeout: entry.timeout ?? 10000,
				env: {
					...process.env,
					...context.env,
					CLAUDE_PROJECT_DIR: cwd,
					PI_PROJECT_DIR: cwd,
				},
			});
			if (outcome.code === 2) {
				return {
					blocked: true,
					permissionDecision: "deny",
					reason: outcome.stderr.trim() || outcome.stdout.trim() || `Hook (${entry.id}) 阻止了操作。`,
					executedCount: matching.indexOf(entry) + 1,
				};
			}
			const trimmed = outcome.stdout.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as {
					continue?: boolean;
					decision?: string;
					reason?: string;
					stopReason?: string;
					systemMessage?: string;
					hookSpecificOutput?: {
						permissionDecision?: "allow" | "deny" | "ask";
						permissionDecisionReason?: string;
						additionalContext?: string;
					};
				};
				if (typeof parsed.systemMessage === "string" && parsed.systemMessage.trim())
					messages.push(parsed.systemMessage.trim());
				if (typeof parsed.hookSpecificOutput?.additionalContext === "string" && parsed.hookSpecificOutput.additionalContext.trim())
					contexts.push(parsed.hookSpecificOutput.additionalContext.trim());
				const specific = parsed.hookSpecificOutput?.permissionDecision;
				if (parsed.continue === false || parsed.decision === "block" || parsed.decision === "deny" || specific === "deny") {
					return {
						blocked: true,
						permissionDecision: "deny",
						reason:
							parsed.hookSpecificOutput?.permissionDecisionReason ??
							parsed.reason ??
							parsed.stopReason ??
							`Hook (${entry.id}) 拒绝执行。`,
						additionalContext: contexts.join("\n") || undefined,
						systemMessage: messages.join("\n") || undefined,
						executedCount: matching.indexOf(entry) + 1,
					};
				}
				if (specific === "ask") permissionDecision = "ask";
				else if (specific === "allow" && permissionDecision !== "ask") permissionDecision = "allow";
			} catch {
				// Non-JSON stdout is treated as optional informational context.
				if (event === "PostToolUse" || event === "UserPromptSubmit") contexts.push(trimmed.slice(0, 4000));
			}
		}

		return {
			blocked: false,
			permissionDecision,
			additionalContext: contexts.join("\n") || undefined,
			systemMessage: messages.join("\n") || undefined,
			executedCount: matching.length,
		};
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
			child.kill("SIGKILL");
			finish(1);
		}, options.timeout);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < 256 * 1024) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 256 * 1024) stderr += chunk.toString("utf8");
		});
		child.on("error", () => finish(1));
		child.on("close", (code) => finish(code));
		child.stdin.end(options.stdin);
	});
}
