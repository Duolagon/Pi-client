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
	Agent: "Agent",
};

function ruleId(project: string, action: PermissionAction, spec: string): string {
	return `claude-${action}-${createHash("sha256").update(`${project}:${action}:${spec}`).digest("hex").slice(0, 12)}`;
}

export function parseClaudePermissionSpec(
	spec: string,
	action: PermissionAction,
	project: string,
): PermissionRule | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	const match = /^([A-Za-z0-9_.:?*-]+)(?:\((.*)\))?$/.exec(trimmed);
	if (!match) return undefined;
	const rawTool = match[1];
	const tool = claudeToolNames[rawTool] ?? rawTool;
	const arg = match[2]?.trim();
	const base: PermissionRule = {
		id: ruleId(project, action, trimmed),
		scope: "project",
		project,
		action,
		tool,
	};
	if (!arg) {
		try {
			return validatePermissionRule(base);
		} catch {
			return undefined;
		}
	}
	if (tool === "bash") {
		const isPrefix = arg.endsWith(":*");
		const cmdText = (isPrefix ? arg.slice(0, -2) : arg).trim();
		if (!cmdText) {
			try {
				return validatePermissionRule(base);
			} catch {
				return undefined;
			}
		}
		const words = cmdText.split(/\s+/).filter(Boolean);
		const candidate: PermissionRule =
			isPrefix && words.length >= 2
				? { ...base, command: { type: "prefix", argv: words } }
				: { ...base, command: { type: "exact", value: cmdText } };
		try {
			return validatePermissionRule(candidate);
		} catch {
			return undefined;
		}
	}
	try {
		return validatePermissionRule({ ...base, path: arg });
	} catch {
		return undefined;
	}
}

export function formatClaudePermissionSpec(rule: PermissionRule): string | undefined {
	const name = piToClaudeToolNames[rule.tool] ?? rule.tool;
	if (rule.command) {
		if (rule.command.type === "exact") return `${name}(${rule.command.value})`;
		return `${name}(${rule.command.argv.join(" ")}:*)`;
	}
	if (rule.path) return `${name}(${rule.path})`;
	return name;
}

export async function readClaudeProjectPermissions(project: string): Promise<PermissionRule[]> {
	const rules: PermissionRule[] = [];
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
					const parsed = parseClaudePermissionSpec(item, action, project);
					if (parsed) rules.push(name === "settings.local.json" ? { ...parsed, id: `private-${parsed.id}` } : parsed);
				}
			}
		} catch {
			// File absent or unreadable; ignore.
		}
	}
	return rules;
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
	// Older imports used the shared ID even when the original rule was private.
	const privateIds = new Set((await readClaudeProjectPermissions(project)).map((rule) => rule.id)
		.filter((id) => id.startsWith("private-")).map((id) => id.slice("private-".length)));
	let count = 0;
	for (const rule of rules) {
		if (rule.scope !== "project" || rule.project !== project || rule.id.startsWith("private-") || privateIds.has(rule.id)) continue;
		const spec = formatClaudePermissionSpec(rule);
		if (!spec) continue;
		const list = permissions[rule.action];
		if (list !== undefined && !Array.isArray(list)) throw new Error(`Claude permissions.${rule.action} 必须是数组。`);
		if (list?.includes(spec)) continue;
		permissions[rule.action] = [...(list ?? []), spec];
		count++;
	}
	if (count > 0) await writeManagedFile(target, JSON.stringify({ ...doc, permissions }, null, 2) + "\n");
	return { path: target, count };
}
