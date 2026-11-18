import { readFile } from "node:fs/promises";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import type { McpRemoveInput, McpSaveInput, McpScope, McpServerInfo, McpTransport } from "./mcp-types.ts";

type JsonObject = Record<string, unknown>;
interface McpConfig {
	data: JsonObject;
	rejected?: JsonObject;
	servers: Record<string, JsonObject>;
}

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
	return value as JsonObject;
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`${label}无效。`);
	return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
	if (value === undefined) return undefined;
	return text(value, label, max);
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效。`);
	return value.map((item) => text(item, label, maxLength));
}

function transportOf(entry: JsonObject): McpTransport | undefined {
	if (typeof entry.command === "string" && entry.command.trim()) return "stdio";
	if (typeof entry.url === "string" && entry.url.trim()) return "http";
	if (entry.type === "stdio") return "stdio";
	if (entry.type === "http" || entry.type === "streamable-http") return "http";
	return undefined;
}

async function readConfig(file: string): Promise<McpConfig> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: {}, servers: Object.create(null) };
		throw new Error(`无法读取 MCP 配置 ${file}：${error instanceof Error ? error.message : String(error)}`);
	}
	const data = object(parsed, "MCP 配置");
	const servers = data.mcpServers === undefined ? {} : object(data.mcpServers, "mcpServers");
	const result: Record<string, JsonObject> = Object.create(null);
	const rejected: JsonObject = Object.create(null);
	for (const [name, value] of Object.entries(servers)) {
		if (!namePattern.test(name)) {
			rejected[name] = value;
			continue;
		}
		try {
			result[name] = object(value, `MCP 服务器 ${name}`);
		} catch {
			rejected[name] = value;
		}
	}
	return { data, servers: result, rejected };
}

async function writeConfig(file: string, config: McpConfig): Promise<void> {
	const output = { ...config.data, mcpServers: { ...config.rejected, ...config.servers } };
	await writeManagedFile(file, JSON.stringify(output, null, 2) + "\n");
}

/** Manage the Pi-compatible mcp.json files without rewriting unrelated entries. */
export class McpRegistry {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	private async path(scope: McpScope, project: string, create: boolean): Promise<string | undefined> {
		return scope === "project"
			? managedFile(project, [".pi"], "mcp.json", create)
			: managedFile(this.agentDir(), [], "mcp.json", create);
	}

	async list(project: string): Promise<McpServerInfo[]> {
		const userPath = await this.path("user", project, false);
		const projectPath = await this.path("project", project, false);
		const user = userPath ? await readConfig(userPath) : { data: {}, servers: {} };
		const local = projectPath ? await readConfig(projectPath) : { data: {}, servers: {} };
		const merged = new Map<string, McpServerInfo>();
		for (const [name, entry] of Object.entries(user.servers)) {
			const transport = transportOf(entry);
			if (!transport) continue;
			merged.set(name, {
				name,
				scope: "user",
				transport,
				command: typeof entry.command === "string" ? entry.command : undefined,
				args: Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === "string") : undefined,
				url: typeof entry.url === "string" ? entry.url : undefined,
				description: typeof entry.description === "string" ? entry.description : undefined,
				enabled: entry.enabled !== false,
				source: userPath!,
				overridden: false,
			});
		}
		for (const [name, entry] of Object.entries(local.servers)) {
			const base = merged.get(name);
			const transport = transportOf(entry) ?? base?.transport;
			if (!transport) continue;
			const inherits = !transportOf(entry) && Boolean(base);
			const source = inherits ? base!.source : projectPath!;
			const effective = inherits ? { ...(base ?? {}), ...entry } : entry;
			merged.set(name, {
				name,
				scope: "project",
				transport,
				command: inherits ? base?.command : typeof effective.command === "string" ? effective.command : undefined,
				args: inherits ? base?.args : Array.isArray(effective.args) ? effective.args.filter((item): item is string => typeof item === "string") : undefined,
				url: inherits ? base?.url : typeof effective.url === "string" ? effective.url : undefined,
				description: typeof effective.description === "string" ? effective.description : undefined,
				enabled: entry.enabled === undefined ? (base?.enabled ?? true) : entry.enabled !== false,
				source,
				overridden: inherits,
			});
		}
		return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	async save(project: string, input: McpSaveInput): Promise<McpServerInfo[]> {
		const name = text(input.name, "MCP 服务器名称", 64);
		if (!namePattern.test(name)) throw new Error("MCP 服务器名称只能包含字母、数字、下划线和短横线。");
		if (input.scope !== "user" && input.scope !== "project") throw new Error("MCP 作用域无效。");
		const file = await this.path(input.scope, project, true);
		if (!file) throw new Error("无法创建 MCP 配置目录。");
		const config = await readConfig(file);
		if (input.overrideOnly) {
			const existing = config.servers[name];
			if (!existing) throw new Error("项目覆盖条目不存在。");
			if (input.enabled !== undefined) existing.enabled = input.enabled;
			const description = optionalText(input.description, "MCP 描述", 500);
			if (description === undefined) delete existing.description;
			else existing.description = description;
			config.servers[name] = existing;
			await writeConfig(file, config);
			return this.list(project);
		}
		if (input.transport !== "stdio" && input.transport !== "http") throw new Error("MCP 传输方式无效。");
		const entry: JsonObject = { ...(config.servers[name] ?? {}) };
		entry.enabled = input.enabled !== false;
		const description = optionalText(input.description, "MCP 描述", 500);
		if (description === undefined) delete entry.description;
		else entry.description = description;
		if (input.transport === "stdio") {
			entry.command = text(input.command, "MCP 命令", 4096);
			const args = stringArray(input.args, "MCP 参数", 100, 4096);
			if (args?.length) entry.args = args;
			else delete entry.args;
			delete entry.url;
			delete entry.type;
		} else {
			const url = text(input.url, "MCP 地址", 4096);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error("MCP 地址不是有效 URL。");
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP 地址必须使用 http 或 https。");
			entry.url = parsed.toString();
			delete entry.command;
			delete entry.args;
			delete entry.type;
		}
		config.servers[name] = entry;
		await writeConfig(file, config);
		return this.list(project);
	}

	async remove(project: string, input: McpRemoveInput): Promise<McpServerInfo[]> {
		const name = text(input.name, "MCP 服务器名称", 64);
		if (!namePattern.test(name)) throw new Error("MCP 服务器名称无效。");
		if (input.scope !== "user" && input.scope !== "project") throw new Error("MCP 作用域无效。");
		const file = await this.path(input.scope, project, false);
		if (!file) throw new Error("MCP 配置不存在。");
		const config = await readConfig(file);
		if (!config.servers[name]) throw new Error("MCP 服务器不存在于此作用域。");
		delete config.servers[name];
		await writeConfig(file, config);
		return this.list(project);
	}
}
