import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentDefinition, AgentRemoveInput, AgentSaveInput, AgentScope } from "./agent-types.ts";
import type { ThinkingLevel } from "./shared.ts";

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const readOnlyTools = new Set(["read", "grep", "find", "ls", "TaskOutput", "TaskList", "TaskStop", "WorktreeList", "AgentExecutors"]);
const toolAliases: Record<string, string> = {
	Read: "read",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	MultiEdit: "edit",
	NotebookEdit: "notebook",
	WebFetch: "WebFetch",
};
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const builtins: AgentDefinition[] = [
	{
		name: "general-purpose",
		description: "General implementation subagent with an isolated context and writable worktree.",
		prompt:
			"You are a general-purpose coding subagent. Work only on the task you were given, inspect the repository, make focused changes, run relevant checks, and return a concise summary of the changes and verification.",
		readOnly: false,
		scope: "builtin",
		removable: false,
	},
	{
		name: "Explore",
		description: "Read-only codebase exploration and research.",
		prompt:
			"You are a read-only exploration subagent. Search the repository, read the relevant files and report concrete findings with file paths and line references. Do not edit files or run commands that write.",
		tools: ["read", "grep", "find", "ls"],
		readOnly: true,
		scope: "builtin",
		removable: false,
	},
	{
		name: "Plan",
		description: "Read-only implementation planning.",
		prompt:
			"You are a read-only planning subagent. Inspect the codebase and produce a concrete implementation plan with affected files, ordered steps, risks and verification. Do not edit files or run commands that write.",
		tools: ["read", "grep", "find", "ls"],
		readOnly: true,
		scope: "builtin",
		removable: false,
	},
];

interface AgentDirectory {
	scope: Exclude<AgentScope, "builtin">;
	path: string;
	removable: boolean;
}

function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`${label}无效。`);
	return value.trim();
}

function parseList(value: string): string[] {
	const raw = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	return raw
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function normalizeTools(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const items = Array.isArray(value) ? value : parseList(value);
	const tools = [...new Set(items.map((item) => toolAliases[item] ?? item).filter((item) => /^[A-Za-z0-9_.:-]{1,80}$/.test(item)))];
	return tools.length ? tools : undefined;
}

function parseModel(value: string | undefined): { provider: string; id: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash).trim();
	const id = value.slice(slash + 1).trim();
	return provider && id ? { provider, id } : undefined;
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { data: {}, body: normalized.trim() };
	const end = normalized.indexOf("\n---", 4);
	if (end < 0) return { data: {}, body: normalized.trim() };
	const data: Record<string, string> = {};
	for (const line of normalized.slice(4, end).split("\n")) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) continue;
		const value = match[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
		if (value) data[match[1]] = value;
	}
	return { data, body: normalized.slice(end + 4).replace(/^\n+/, "").trim() };
}

function parseAgent(content: string, file: string, scope: Exclude<AgentScope, "builtin">, removable: boolean): AgentDefinition | undefined {
	const { data, body } = parseFrontmatter(content);
	const name = (data.name ?? basename(file, ".md")).trim();
	if (!namePattern.test(name) || builtins.some((agent) => agent.name === name)) return undefined;
	const description = (data.description ?? body.split("\n").find((line) => line.trim()) ?? name).trim().slice(0, 500);
	if (!description || !body) return undefined;
	const tools = normalizeTools(data.tools);
	const model = parseModel(data.model);
	const thinkingLevel = data.thinkingLevel && thinkingLevels.has(data.thinkingLevel as ThinkingLevel)
		? (data.thinkingLevel as ThinkingLevel)
		: undefined;
	return {
		name,
		description,
		prompt: body.slice(0, 64 * 1024),
		tools,
		model,
		thinkingLevel,
		readOnly: Boolean(tools?.length && tools.every((tool) => readOnlyTools.has(tool))),
		scope,
		source: file,
		removable,
	};
}

function serializeAgent(input: AgentSaveInput): string {
	const lines = ["---", `name: ${input.name}`, `description: ${JSON.stringify(input.description)}`];
	if (input.tools?.length) lines.push(`tools: [${input.tools.join(", ")}]`);
	if (input.model) lines.push(`model: ${input.model}`);
	if (input.thinkingLevel) lines.push(`thinkingLevel: ${input.thinkingLevel}`);
	lines.push("---", "", input.prompt.trim(), "");
	return lines.join("\n");
}

/** Read and write project/user agent definitions without following paths outside the managed folders. */
export class AgentRegistry {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	private directories(project: string): AgentDirectory[] {
		return [
			{ scope: "user", path: join(homedir(), ".claude", "agents"), removable: false },
			{ scope: "user", path: join(this.agentDir(), "agents"), removable: true },
			{ scope: "project", path: join(project, ".claude", "agents"), removable: false },
			{ scope: "project", path: join(project, ".pi", "agents"), removable: true },
		];
	}

	async list(project: string): Promise<AgentDefinition[]> {
		const merged = new Map<string, AgentDefinition>(builtins.map((agent) => [agent.name, agent]));
		for (const directory of this.directories(project)) {
			let names: string[];
			let root: string;
			try {
				root = await realpath(directory.path);
				names = (await readdir(root, { withFileTypes: true }))
					.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
					.map((entry) => entry.name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const name of names) {
				const file = join(root, name);
				try {
					const actual = await realpath(file);
					if (!inside(root, actual)) continue;
					const definition = parseAgent(await readFile(actual, "utf8"), actual, directory.scope, directory.removable);
					if (definition) merged.set(definition.name, definition);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					// One malformed or unreadable agent must not hide the rest.
				}
			}
		}
		return [...merged.values()].sort((left, right) => {
			if (left.scope === "builtin" && right.scope !== "builtin") return -1;
			if (right.scope === "builtin" && left.scope !== "builtin") return 1;
			if (left.scope === "builtin" && right.scope === "builtin") return 0;
			return left.name.localeCompare(right.name);
		});
	}

	async resolve(project: string, name: string): Promise<AgentDefinition | undefined> {
		const agents = await this.list(project);
		return agents.find((agent) => agent.name === name);
	}

	async save(project: string, input: AgentSaveInput): Promise<AgentDefinition[]> {
		const name = text(input.name, "Agent 名称", 64);
		if (!namePattern.test(name)) throw new Error("Agent 名称只能包含字母、数字、点、下划线和短横线。");
		if (builtins.some((agent) => agent.name === name)) throw new Error("不能覆盖内置 Agent。");
		const description = text(input.description, "Agent 描述", 500);
		const prompt = text(input.prompt, "Agent 提示词", 64 * 1024);
		const tools = normalizeTools(input.tools);
		const thinkingLevel = input.thinkingLevel;
		if (thinkingLevel && !thinkingLevels.has(thinkingLevel)) throw new Error("Agent 思考强度无效。");
		const model = input.model === undefined ? undefined : text(input.model, "Agent 模型", 300);
		if (model && !parseModel(model)) throw new Error("Agent 模型需使用 provider/model-id 格式。");
		const directory = input.scope === "project" ? join(project, ".pi", "agents") : join(this.agentDir(), "agents");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const target = join(directory, `${name}.md`);
		const temporary = `${target}.tmp`;
		await writeFile(temporary, serializeAgent({ ...input, name, description, prompt, tools, model }), { mode: 0o600 });
		await rename(temporary, target);
		return this.list(project);
	}

	async remove(project: string, input: AgentRemoveInput): Promise<AgentDefinition[]> {
		const name = text(input.name, "Agent 名称", 64);
		if (!namePattern.test(name)) throw new Error("Agent 名称无效。");
		if (builtins.some((agent) => agent.name === name)) throw new Error("不能删除内置 Agent。");
		const directory = input.scope === "project" ? join(project, ".pi", "agents") : join(this.agentDir(), "agents");
		const target = resolve(directory, `${name}.md`);
		if (!inside(directory, target)) throw new Error("Agent 路径越界。");
		await rm(target);
		return this.list(project);
	}
}
