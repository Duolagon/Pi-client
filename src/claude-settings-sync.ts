import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validatePermissionRule } from "./permission-policy.ts";
import type { PermissionAction, PermissionRule } from "./permission-types.ts";

const toolMap: Record<string, string> = {
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

const reverseToolMap: Record<string, string> = {
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
	const tool = toolMap[rawTool] ?? rawTool;
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
	const name = reverseToolMap[rule.tool] ?? rule.tool;
	if (rule.command) {
		if (rule.command.type === "exact") return `${name}(${rule.command.value})`;
		return `${name}(${rule.command.argv.join(" ")}:*)`;
	}
	if (rule.path) return `${name}(${rule.path})`;
	return name;
}

export async function readClaudeProjectPermissions(project: string): Promise<PermissionRule[]> {
	const rules: PermissionRule[] = [];
	for (const file of [join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")]) {
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
					if (parsed) rules.push(parsed);
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
	const target = join(project, ".claude", "settings.json");
	let doc: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
	} catch {
		// Create new settings.json cleanly.
	}
	const permissions: { allow: string[]; ask: string[]; deny: string[] } = { allow: [], ask: [], deny: [] };
	for (const rule of rules) {
		if (rule.scope !== "project" || rule.project !== project) continue;
		const spec = formatClaudePermissionSpec(rule);
		if (spec && !permissions[rule.action].includes(spec)) permissions[rule.action].push(spec);
	}
	doc.permissions = permissions;
	await mkdir(dirname(target), { recursive: true });
	await writeFile(`${target}.tmp`, JSON.stringify(doc, null, 2), "utf8");
	await rename(`${target}.tmp`, target);
	return { path: target, count: permissions.allow.length + permissions.ask.length + permissions.deny.length };
}
