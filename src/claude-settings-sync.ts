import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import { validatePermissionRule } from "./permission-policy.ts";
import type { PermissionAction, PermissionRule } from "./permission-types.ts";

export const claudeToolNames: Record<string, string> = {
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	Read: "read",
	Glob: "find",
	Grep: "grep",
	LS: "ls",
	NotebookEdit: "NotebookEdit",
	WebFetch: "WebFetch",
	AskUserQuestion: "AskUserQuestion",
	ExitPlanMode: "ExitPlanMode",
	TodoWrite: "TodoWrite",
	Agent: "Agent",
};

export const piToClaudeToolNames: Record<string, string> = {
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	read: "Read",
	find: "Glob",
	grep: "Grep",
	ls: "LS",
	NotebookEdit: "NotebookEdit",
	WebFetch: "WebFetch",
	AskUserQuestion: "AskUserQuestion",
	ExitPlanMode: "ExitPlanMode",
	TodoWrite: "TodoWrite",
	Agent: "Agent",
};

function ruleId(project: string, action: PermissionAction, spec: string): string {
	return `claude-${action}-${createHash("sha256").update(`${project}:${action}:${spec}`).digest("hex").slice(0, 12)}`;
}

/** Claude applies `Read(...)` / `Edit(...)` rules to every built-in tool of that kind. */
const claudeToolFamilies: Record<string, string[]> = {
	Read: ["read", "grep", "find", "ls"],
	Edit: ["edit", "write", "NotebookEdit"],
	MultiEdit: ["edit"],
	Task: ["Agent"],
};

function validated(rule: PermissionRule): PermissionRule | undefined {
	try {
		return validatePermissionRule(rule);
	} catch {
		return undefined;
	}
}

/**
 * Map Claude path syntax to Desktop globs: `//abs` is absolute, `/p` and `./p`
 * are project-relative, `~/p` is home-relative and a bare name without a slash
 * matches at any depth (gitignore semantics).
 */
function claudePath(arg: string): string | undefined {
	if (arg.startsWith("//")) return arg.slice(1);
	if (arg === "~" || arg.startsWith("~/")) return arg;
	if (arg.startsWith("/")) return arg.slice(1) || undefined;
	const relativePath = arg.replace(/^(?:\.\/)+/, "");
	if (!relativePath || relativePath === ".") return "**";
	return relativePath.includes("/") || relativePath.startsWith("**") ? relativePath : `**/${relativePath}`;
}

function claudeBashSelector(arg: string): PermissionRule["command"] | null | undefined {
	const legacyPrefix = arg.endsWith(":*");
	const spacedPrefix = !legacyPrefix && /\s\*$/.test(arg);
	const text = (legacyPrefix ? arg.slice(0, -2) : spacedPrefix ? arg.slice(0, -1) : arg).trim();
	if (!text || text === "*") return null; // whole tool
	// Mid-pattern wildcards and shell quoting have no faithful token mapping.
	if (/[*?'"\\`$]/.test(text)) return undefined;
	const words = text.split(/\s+/).filter(Boolean);
	return legacyPrefix || spacedPrefix ? { type: "prefix", argv: words } : { type: "exact", value: text };
}

/**
 * Parse one Claude Code permission spec. Returns every Desktop rule it expands
 * to, or an empty list when the spec has no safe equivalent (callers report
 * those instead of dropping them silently).
 */
export function parseClaudePermissionRules(spec: string, action: PermissionAction, project: string): PermissionRule[] {
	const trimmed = spec.trim();
	const match = /^([A-Za-z0-9_.:?*-]+)(?:\((.*)\))?$/s.exec(trimmed);
	if (!match) return [];
	const rawTool = match[1];
	const arg = match[2]?.trim();
	const mcpServer = /^mcp__[A-Za-z0-9-](?:(?!__)[A-Za-z0-9_.-])*$/.test(rawTool);
	// Claude matches tool names exactly; only `mcp__server__*` is a wildcard. A
	// bare `*` must not become a Desktop glob that allows every tool.
	if (/[*?]/.test(rawTool) && !/^mcp__[A-Za-z0-9-](?:(?!__)[A-Za-z0-9_.-])*__\*$/.test(rawTool)) return [];
	let tools = claudeToolFamilies[rawTool] ?? [claudeToolNames[rawTool] ?? rawTool];
	// `mcp__server` selects every tool of that server.
	if (mcpServer) tools = [`${rawTool}__*`];
	let extra: Partial<PermissionRule> = {};
	if (arg && arg !== "*") {
		if (tools[0] === "bash") {
			const command = claudeBashSelector(arg);
			if (command === undefined) return [];
			if (command) extra = { command };
		} else if (rawTool === "WebFetch") {
			if (!arg.startsWith("domain:")) return [];
			extra = { domain: arg.slice("domain:".length).trim() };
		} else if (tools[0] === "Agent") {
			if (!/^[A-Za-z0-9_.*?*-]+$/.test(arg)) return [];
			extra = { agentType: arg };
		} else if (claudeToolFamilies[rawTool] || ["read", "grep", "find", "ls", "edit", "write", "NotebookEdit"].includes(tools[0])) {
			const path = claudePath(arg);
			if (!path) return [];
			extra = { path };
		} else return [];
	}
	const rules: PermissionRule[] = [];
	for (const [index, tool] of tools.entries()) {
		// Keep the first ID stable with rules imported by earlier versions.
		const id = ruleId(project, action, index === 0 ? trimmed : `${trimmed}#${tool}`);
		const rule = validated({ id, scope: "project", project, action, tool, ...extra });
		if (!rule) return [];
		rules.push(rule);
	}
	return rules;
}

export function parseClaudePermissionSpec(
	spec: string,
	action: PermissionAction,
	project: string,
): PermissionRule | undefined {
	return parseClaudePermissionRules(spec, action, project)[0];
}

export function formatClaudePermissionSpec(rule: PermissionRule): string | undefined {
	if (/^Agent\([^()]+\)$/.test(rule.tool)) return rule.tool;
	const name = piToClaudeToolNames[rule.tool] ?? rule.tool;
	if (rule.command) {
		if (rule.command.type === "exact") return `${name}(${rule.command.value})`;
		return `${name}(${rule.command.argv.join(" ")}:*)`;
	}
	if (rule.domain) return `${name}(domain:${rule.domain})`;
	if (rule.agentType) return `${name}(${rule.agentType})`;
	if (rule.path) {
		const path = rule.path;
		const spec = path.startsWith("/") ? `/${path}` : path.startsWith("~") ? path : path.startsWith("**/") && !path.slice(3).includes("/") ? path.slice(3) : `/${path}`;
		return `${name}(${spec})`;
	}
	return name;
}

export async function readClaudeProjectPermissions(project: string): Promise<PermissionRule[]> {
	return (await readClaudeProjectPermissionsDetailed(project)).rules;
}

/** Like readClaudeProjectPermissions, plus the specs that have no Desktop equivalent. */
export async function readClaudeProjectPermissionsDetailed(project: string): Promise<{ rules: PermissionRule[]; skipped: string[] }> {
	const rules: PermissionRule[] = [];
	const skipped: string[] = [];
	for (const name of ["settings.json", "settings.local.json"]) {
		const file = await managedFile(project, [".claude"], name, false);
		if (!file) continue;
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as {
				permissions?: { allow?: unknown; ask?: unknown; deny?: unknown };
			};
			if (!raw?.permissions || typeof raw.permissions !== "object") continue;
			for (const action of ["allow", "ask", "deny"] as const) {
				const list = raw.permissions[action];
				if (!Array.isArray(list)) continue;
				for (const item of list) {
					if (typeof item !== "string") continue;
					const parsed = parseClaudePermissionRules(item, action, project);
					if (!parsed.length) skipped.push(`${action}: ${item}`);
					for (const rule of parsed) rules.push(name === "settings.local.json" ? { ...rule, id: `private-${rule.id}` } : rule);
				}
			}
		} catch {
			// File absent or unreadable; ignore.
		}
	}
	return { rules, skipped };
}

export async function writeClaudeProjectPermissions(
	project: string,
	rules: PermissionRule[],
): Promise<{ path: string; count: number }> {
	const target = (await managedFile(project, [".claude"], "settings.json", true))!;
	let doc: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude 设置必须是 JSON 对象。");
		doc = parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const existing = doc.permissions ?? {};
	if (typeof existing !== "object" || Array.isArray(existing)) throw new Error("Claude permissions 必须是对象。");
	const permissions = { ...existing } as Record<string, unknown>;
	// Rules that came from either Claude file are already represented there
	// (family expansions such as Read -> grep/find/ls included); never write
	// them back. Older imports used the shared ID even for private rules.
	const fromFiles = await readClaudeProjectPermissions(project);
	const importedIds = new Set(fromFiles.flatMap((rule) => [rule.id, rule.id.replace(/^private-/, "")]));
	const signature = (rule: PermissionRule) =>
		JSON.stringify([rule.action, rule.tool, rule.path ?? null, rule.command ?? null, rule.domain ?? null, rule.agentType ?? null]);
	const present = new Set(fromFiles.map(signature));
	let count = 0;
	for (const rule of rules) {
		if (rule.scope !== "project" || rule.project !== project || rule.id.startsWith("private-") || importedIds.has(rule.id)) continue;
		if (present.has(signature(rule))) continue;
		const spec = formatClaudePermissionSpec(rule);
		if (!spec) continue;
		present.add(signature(rule));
		const list = permissions[rule.action];
		if (list !== undefined && !Array.isArray(list)) throw new Error(`Claude permissions.${rule.action} 必须是数组。`);
		if (list?.includes(spec)) continue;
		permissions[rule.action] = [...(list ?? []), spec];
		count++;
	}
	if (count > 0) await writeManagedFile(target, JSON.stringify({ ...doc, permissions }, null, 2) + "\n");
	return { path: target, count };
}
