import { readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { validatePermissionRule } from "./permission-policy.ts";
import type { PermissionRule } from "./permission-types.ts";
import type { ToolToggleInput } from "./control-types.ts";

interface ToolOverride {
	name: string;
	enabled: boolean;
	scope: "global" | "project" | "conversation";
	project?: string;
	conversationId?: string;
}
interface ControlSettings { version: 1; rules: PermissionRule[]; tools: ToolOverride[] }

/** Desktop policy only; contains no provider credentials or upstream Pi config. */
export class ToolSettingsStore {
	private value: ControlSettings = { version: 1, rules: [], tools: [] };
	private directory: string;
	constructor(directory: string) { this.directory = directory; }
	async initialize(): Promise<void> {
		let input: unknown;
		try { input = JSON.parse(await readFile(join(this.directory, "tool-settings.json"), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (!input || typeof input !== "object") throw new Error("工具与权限设置格式错误。");
		const data = input as Record<string, unknown>;
		if (data.version !== 1 || !Array.isArray(data.rules) || !Array.isArray(data.tools) || data.rules.length > 500 || data.tools.length > 2000)
			throw new Error("工具与权限设置版本或数量无效。");
		const rules = data.rules.map(validatePermissionRule);
		if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("权限规则标识重复。");
		const tools = data.tools.map((item) => validateToolOverride(item));
		this.value = { version: 1, rules, tools };
	}
	rules(): PermissionRule[] { return structuredClone(this.value.rules); }
	effective(project: string, conversationId: string): { rules: PermissionRule[]; overrides: Record<string, boolean> } {
		const matches = (entry: { scope: string; project?: string; conversationId?: string }) =>
			entry.scope === "global" || (entry.scope === "project" && entry.project === project) ||
			(entry.scope === "conversation" && entry.conversationId === conversationId);
		const rules = this.value.rules.filter(matches);
		const overrides: Record<string, boolean> = Object.create(null);
		for (const scope of ["global", "project", "conversation"])
			for (const entry of this.value.tools.filter((entry) => entry.scope === scope && matches(entry))) overrides[entry.name] = entry.enabled;
		return { rules: structuredClone(rules), overrides };
	}
	async upsert(rule: PermissionRule): Promise<void> {
		const valid = validatePermissionRule(rule);
		const rules = this.value.rules.filter((item) => item.id !== valid.id);
		if (rules.length >= 500) throw new Error("权限规则最多 500 条。");
		await this.save({ ...this.value, rules: [...rules, valid] });
	}
	async remove(id: string): Promise<void> {
		await this.save({ ...this.value, rules: this.value.rules.filter((item) => item.id !== id) });
	}
	async toggle(input: ToolToggleInput): Promise<void> {
		const entry = validateToolOverride({ ...input, enabled: input.enabled ?? false, scope: input.scope ?? "conversation" });
		const tools = this.value.tools.filter((item) => !(item.name === entry.name && item.scope === entry.scope && item.project === entry.project && item.conversationId === entry.conversationId));
		if (input.enabled !== null) tools.push(entry);
		if (tools.length > 2000) throw new Error("工具启停规则过多。");
		await this.save({ ...this.value, tools });
	}
	private async save(value: ControlSettings): Promise<void> {
		const target = join(this.directory, "tool-settings.json");
		await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
		await rename(`${target}.tmp`, target);
		this.value = value;
	}
}

function validateToolOverride(input: unknown): ToolOverride {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工具启停设置无效。");
	const value = input as Record<string, unknown>;
	if (typeof value.name !== "string" || !/^[a-zA-Z0-9_.:-]{1,300}$/.test(value.name) || ["__proto__", "constructor", "prototype"].includes(value.name) || typeof value.enabled !== "boolean" || typeof value.scope !== "string" || !["global", "project", "conversation"].includes(value.scope))
		throw new Error("工具启停设置无效。");
	if (value.scope === "project" && (typeof value.project !== "string" || !isAbsolute(value.project))) throw new Error("项目范围需要绝对路径。");
	if (value.scope === "conversation" && (typeof value.conversationId !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(value.conversationId))) throw new Error("会话范围需要有效标识。");
	return { name: value.name, enabled: value.enabled, scope: value.scope as ToolOverride["scope"],
		...(value.scope === "project" ? { project: value.project as string } : {}),
		...(value.scope === "conversation" ? { conversationId: value.conversationId as string } : {}) };
}
