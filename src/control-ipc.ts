import type { DesktopService } from "./backend.ts";
import { validatePermissionRule } from "./permission-policy.ts";
import type { ToolToggleInput } from "./control-types.ts";
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
