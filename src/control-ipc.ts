import type { DesktopService } from "./backend.ts";
import { validatePermissionRule } from "./permission-policy.ts";
import type { ToolToggleInput } from "./control-types.ts";
import type { AgentRemoveInput, AgentSaveInput } from "./agent-types.ts";
import type { McpRemoveInput, McpSaveInput } from "./mcp-types.ts";
import { hookEventNames } from "./hooks-service.ts";
import type { HookEventName, HookRemoveInput, HookSaveInput, HookTestInput } from "./hook-types.ts";
import type { SkillRemoveInput, SkillSaveInput } from "./skill-registry.ts";
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
		const disallowedTools = input.disallowedTools === undefined ? undefined : stringArray(input.disallowedTools, 50, 80);
		const skills = input.skills === undefined ? undefined : stringArray(input.skills, 50, 80);
		const thinkingLevel = input.thinkingLevel;
		if (
			thinkingLevel !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinkingLevel))
		)
			throw new Error("Agent 思考强度无效。");
		const permissionMode = input.permissionMode;
		if (
			permissionMode !== undefined &&
			!["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "read"].includes(String(permissionMode))
		)
			throw new Error("Agent 权限模式无效。");
		if (
			input.maxTurns !== undefined &&
			(!Number.isSafeInteger(input.maxTurns) || Number(input.maxTurns) < 1 || Number(input.maxTurns) > 200)
		)
			throw new Error("Agent 最大轮次需在 1–200 之间。");
		const memory = input.memory;
		if (memory !== undefined && !["user", "project", "local"].includes(String(memory)))
			throw new Error("Agent 记忆作用域无效。");
		const isolation = input.isolation;
		if (isolation !== undefined && isolation !== "worktree" && isolation !== "shared")
			throw new Error("Agent 隔离模式无效。");
		if (input.background !== undefined && typeof input.background !== "boolean")
			throw new Error("Agent 后台标志无效。");
		const request: AgentSaveInput = {
			name: text(input.name, 64),
			description: text(input.description, 500),
			prompt: text(input.prompt, 64 * 1024),
			tools,
			disallowedTools,
			model: input.model === undefined ? undefined : text(input.model, 300),
			thinkingLevel: thinkingLevel as AgentSaveInput["thinkingLevel"],
			permissionMode: permissionMode as AgentSaveInput["permissionMode"],
			maxTurns: input.maxTurns as number | undefined,
			skills,
			memory: memory as AgentSaveInput["memory"],
			isolation: isolation as AgentSaveInput["isolation"],
			background: input.background as boolean | undefined,
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
			command: optionalText(input.command, 4096),
			args: input.args === undefined ? undefined : stringArray(input.args, 100, 4096),
			url: optionalText(input.url, 4096),
			description: optionalText(input.description, 500),
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
	handle("pi:permissions:import-claude", (id) => service.importClaudePermissions(optionalId(id)));
	handle("pi:permissions:export-claude", (id) => service.exportClaudePermissions(optionalId(id)));
	handle("pi:hooks:list", (project) => service.listHooks(optionalPath(project)));
	handle("pi:hooks:save", (value) => {
		const input = object(value);
		if (!hookEventNames.includes(String(input.event) as HookEventName)) throw new Error("不支持的 Hook 事件。");
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Hook 作用域无效。");
		if (input.handlerType !== undefined && input.handlerType !== "command" && input.handlerType !== "http")
			throw new Error("Hook 类型无效。");
		const handlerType = input.handlerType === "http" ? "http" : "command";
		if (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || Number(input.timeout) < 500 || Number(input.timeout) > 60000))
			throw new Error("Hook 超时须在 500–60000ms 之间。");
		let headers: Record<string, string> | undefined;
		if (input.headers !== undefined) {
			const rawHeaders = object(input.headers);
			headers = {};
			for (const [k, v] of Object.entries(rawHeaders)) {
				headers[text(k, 128)] = text(v, 4096);
			}
		}
		const request: HookSaveInput = {
			id: input.id === undefined ? undefined : text(input.id, 200),
			event: input.event as HookEventName,
			handlerType,
			matcher: input.matcher === undefined || input.matcher === "" ? undefined : text(input.matcher, 300),
			command: handlerType === "command" ? text(input.command, 16384) : undefined,
			url: handlerType === "http" ? text(input.url, 2048) : undefined,
			headers,
			allowedEnvVars: input.allowedEnvVars === undefined ? undefined : stringArray(input.allowedEnvVars, 32, 128),
			timeout: input.timeout as number | undefined,
			statusMessage: input.statusMessage === undefined ? undefined : text(input.statusMessage, 200),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.saveHook(request);
	});
	handle("pi:hooks:remove", (value) => {
		const input = object(value);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Hook 作用域无效。");
		const request: HookRemoveInput = {
			id: text(input.id, 200),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.removeHook(request);
	});
	handle("pi:hooks:test", (value) => {
		const input = object(value);
		if (!hookEventNames.includes(String(input.event) as HookEventName)) throw new Error("不支持的 Hook 事件。");
		if (input.trigger !== undefined && input.trigger !== "manual" && input.trigger !== "auto")
			throw new Error("Hook 触发类型无效。");
		const request: HookTestInput = {
			event: input.event as HookEventName,
			toolName: input.toolName === undefined ? undefined : text(input.toolName, 300),
			toolInput: input.toolInput === undefined ? undefined : object(input.toolInput),
			prompt: input.prompt === undefined ? undefined : text(input.prompt, 16384),
			error: input.error === undefined ? undefined : text(input.error, 8192),
			agentType: input.agentType === undefined ? undefined : text(input.agentType, 128),
			trigger: input.trigger as "manual" | "auto" | undefined,
			notificationType: input.notificationType === undefined ? undefined : text(input.notificationType, 128),
			project: optionalPath(input.project),
		};
		return service.testHook(request);
	});
	handle("pi:skills:list", (project) => service.listSkills(optionalPath(project)));
	handle("pi:skills:save", (value) => {
		const input = object(value);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Skill 作用域无效。");
		const request: SkillSaveInput = {
			name: text(input.name, 64),
			description: text(input.description, 500),
			body: text(input.body, 128 * 1024),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.saveSkill(request);
	});
	handle("pi:skills:remove", (value) => {
		const input = object(value);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Skill 作用域无效。");
		const request: SkillRemoveInput = {
			name: text(input.name, 64),
			scope: input.scope,
			project: optionalPath(input.project),
		};
		return service.removeSkill(request);
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
function optionalText(value: unknown, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maxLength || value.includes("\0"))
		throw new Error("参数字符串无效。");
	const trimmed = value.trim();
	return trimmed || undefined;
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
