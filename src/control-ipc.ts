import type { DesktopService } from "./backend.ts";
import { validatePermissionRule } from "./permission-policy.ts";
import type { ToolToggleInput } from "./control-types.ts";
import type { AgentRemoveInput, AgentSaveInput } from "./agent-types.ts";
import type { McpRemoveInput, McpSaveInput } from "./mcp-types.ts";
import { isAbsolute } from "node:path";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;

/** All handlers run behind main.ts's existing renderer sender/origin validation. */
export function installControlHandlers(handle: Handle, service: DesktopService): void {
	handle("pi:tools:list", (id) => service.listTools(optionalId(id)));
	handle("pi:tools:set-enabled", (value) => {
		const input = object(value);
		if (input.enabled !== null && typeof input.enabled !== "boolean") throw new Error("enabled 必须是 boolean 或 null。");
		if (input.scope !== undefined && (typeof input.scope !== "string" || !["global", "project", "conversation"].includes(input.scope))) throw new Error("工具设置范围无效。");
		if (input.project !== undefined && (typeof input.project !== "string" || !isAbsolute(input.project))) throw new Error("项目目录需要绝对路径。");
		const request: ToolToggleInput = { name: text(input.name, 300), enabled: input.enabled,
			scope: input.scope as ToolToggleInput["scope"], conversationId: optionalId(input.conversationId),
			project: input.project === undefined ? undefined : text(input.project, 32768) };
		return service.setToolEnabled(request);
	});
	handle("pi:permissions:list", (id) => service.permissionSettings(optionalId(id)));
	handle("pi:permissions:upsert", (value) => service.upsertPermission(validatePermissionRule(value)));
	handle("pi:permissions:remove", (id) => service.removePermission(text(id, 200)));
	handle("pi:permissions:check", (value) => {
		const input = object(value);
		const args = object(input.input);
		if (Buffer.byteLength(JSON.stringify(args), "utf8") > 3 * 1024 * 1024) throw new Error("工具参数过大。");
		return service.checkPermission({ conversationId: optionalId(input.conversationId), toolName: text(input.toolName, 300), input: args });
	});
	handle("pi:task:result", (id, value) => {
		const input = object(value ?? {});
		if (input.block !== undefined && typeof input.block !== "boolean") throw new Error("block 格式错误。");
		if (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || Number(input.timeout) < 0 || Number(input.timeout) > 60000)) throw new Error("timeout 必须为 0–60000 毫秒。");
		return service.delegatedTaskResult(text(id, 200), { block: input.block as boolean | undefined, timeout: input.timeout as number | undefined });
	});
	handle("pi:agents:list", (project) => service.listAgents(optionalPath(project)));
	handle("pi:agents:save", (value) => {
		const input = object(value);
		if (input.scope !== "project" && input.scope !== "user") throw new Error("Agent 作用域无效。");
		const tools = input.tools === undefined ? undefined : stringArray(input.tools, 50, 80);
		const thinkingLevel = input.thinkingLevel;
		if (
			thinkingLevel !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinkingLevel))
		)
			throw new Error("Agent 思考强度无效。");
		const request: AgentSaveInput = {
			name: text(input.name, 64),
			description: text(input.description, 500),
			prompt: text(input.prompt, 64 * 1024),
			tools,
			model: input.model === undefined ? undefined : text(input.model, 300),
			thinkingLevel: thinkingLevel as AgentSaveInput["thinkingLevel"],
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.saveAgent(request);
	});
	handle("pi:agents:remove", (value) => {
		const input = object(value);
		if (input.scope !== "project" && input.scope !== "user") throw new Error("Agent 作用域无效。");
		const request: AgentRemoveInput = {
			name: text(input.name, 64),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.removeAgent(request);
	});
	handle("pi:mcp:list", (project) => service.listMcpServers(optionalPath(project)));
	handle("pi:mcp:save", (value) => {
		const input = object(value);
		if (input.scope !== "project" && input.scope !== "user") throw new Error("MCP 作用域无效。");
		if (input.transport !== "stdio" && input.transport !== "http") throw new Error("MCP 传输方式无效。");
		if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("MCP enabled 格式错误。");
		if (input.overrideOnly !== undefined && typeof input.overrideOnly !== "boolean") throw new Error("MCP overrideOnly 格式错误。");
		const request: McpSaveInput = {
			name: text(input.name, 64),
			scope: input.scope,
			transport: input.transport,
			command: input.command === undefined ? undefined : text(input.command, 4096),
			args: input.args === undefined ? undefined : stringArray(input.args, 100, 4096),
			url: input.url === undefined ? undefined : text(input.url, 4096),
			description: input.description === undefined ? undefined : text(input.description, 500),
			enabled: input.enabled as boolean | undefined,
			overrideOnly: input.overrideOnly as boolean | undefined,
			project: optionalPath(input.project),
		};
		return service.saveMcpServer(request);
	});
	handle("pi:mcp:remove", (value) => {
		const input = object(value);
		if (input.scope !== "project" && input.scope !== "user") throw new Error("MCP 作用域无效。");
		const request: McpRemoveInput = {
			name: text(input.name, 64),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.removeMcpServer(request);
	});
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是对象。");
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new Error("参数字符串无效。");
	return value;
}
function optionalId(value: unknown): string | undefined {
	if (value === undefined) return;
	const id = text(value, 200);
	if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("会话标识无效。");
	return id;
}
function optionalPath(value: unknown): string | undefined {
	if (value === undefined) return;
	const path = text(value, 32768);
	if (!isAbsolute(path)) throw new Error("项目目录需要绝对路径。");
	return path;
}
function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error("Agent 工具列表无效。");
	return value.map((item) => text(item, maxLength));
}
