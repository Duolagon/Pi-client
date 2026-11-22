import type { DesktopService } from "./backend.ts";
import { validateExecutorInput } from "./external-executors.ts";
import type { ExternalApprovalResponse, ExternalTaskStartInput } from "./external-types.ts";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;
export function installExternalHandlers(handle: Handle, service: DesktopService): void {
	handle("pi:external:executors", () => service.externalExecutors());
	handle("pi:external:configure", (value) => service.configureExternal(validateExecutorInput(value)));
	handle("pi:external:start", (value) => {
		const input = object(value, ["executor", "conversationId", "description", "prompt", "subagent_type", "isolation", "worktree_id", "run_in_background"]);
		if (!["codex", "claude", "kimi", "antigravity"].includes(input.executor as string)) throw new Error("未知执行器。");
		if (input.subagent_type !== undefined && !["Explore", "Plan", "general-purpose"].includes(input.subagent_type as string)) throw new Error("子任务类型无效。");
		if (input.isolation !== undefined && input.isolation !== "shared" && input.isolation !== "worktree") throw new Error("隔离方式无效。");
		const request: ExternalTaskStartInput = {
			executor: input.executor as ExternalTaskStartInput["executor"], conversationId: input.conversationId === undefined ? undefined : id(input.conversationId),
			description: text(input.description, 160), prompt: text(input.prompt, 2 * 1024 * 1024),
			subagent_type: input.subagent_type as ExternalTaskStartInput["subagent_type"], isolation: input.isolation as ExternalTaskStartInput["isolation"],
			worktree_id: input.worktree_id === undefined ? undefined : id(input.worktree_id), run_in_background: optionalBoolean(input.run_in_background),
		};
		return service.startExternal(request);
	});
	handle("pi:external:list", async (owner) => service.listExternal(owner === undefined ? undefined : id(owner)));
	handle("pi:external:snapshot", async (taskId) => service.externalSnapshot(id(taskId)));
	handle("pi:external:send", (value) => {
		const input = object(value, ["taskId", "message", "runInBackground"]);
		return service.sendExternal({ taskId: id(input.taskId), message: text(input.message, 2 * 1024 * 1024), runInBackground: optionalBoolean(input.runInBackground) });
	});
	handle("pi:external:result", (taskId, value) => {
		const input = object(value ?? {}, ["block", "timeout"]);
		return service.externalResult(id(taskId), { block: optionalBoolean(input.block), timeout: integer(input.timeout, 60000) });
	});
	handle("pi:external:cancel", (taskId) => service.cancelExternal(id(taskId)));
	handle("pi:external:respond", (taskId, requestId, value) => {
		const input = object(value, ["decision", "optionId", "answers"]);
		if (!["allow", "deny", "cancel"].includes(input.decision as string)) throw new Error("审批决定无效。");
		const response: ExternalApprovalResponse = { decision: input.decision as ExternalApprovalResponse["decision"], optionId: input.optionId === undefined ? undefined : text(input.optionId, 500) };
		if (input.answers !== undefined) {
			const answers = object(input.answers);
			if (Object.keys(answers).length > 100) throw new Error("回答数量过多。");
			for (const [key, value] of Object.entries(answers)) {
				text(key, 500);
				if (Array.isArray(value)) { if (value.length > 100) throw new Error("回答数量过多。"); value.forEach((answer) => text(answer, 32768)); }
				else text(value, 32768);
			}
			if (JSON.stringify(answers).length > 256 * 1024) throw new Error("回答内容过大。");
			response.answers = answers as ExternalApprovalResponse["answers"];
		}
		return service.respondExternal(id(taskId), id(requestId), response);
	});
	handle("pi:external:replay", (taskId, sequence) => service.replayExternal(id(taskId), integer(sequence, Number.MAX_SAFE_INTEGER)));
}
function object(value: unknown, keys?: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是对象。");
	const input = value as Record<string, unknown>;
	if (keys && Object.keys(input).some((key) => !keys.includes(key))) throw new Error("未知请求字段。");
	return input;
}
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error("字符串参数无效。"); return value; }
function id(value: unknown): string { const result = text(value, 200); if (!/^[a-zA-Z0-9._-]+$/.test(result)) throw new Error("标识符无效。"); return result; }
function optionalBoolean(value: unknown): boolean | undefined { if (value !== undefined && typeof value !== "boolean") throw new Error("布尔参数无效。"); return value as boolean | undefined; }
function integer(value: unknown, max: number): number | undefined { if (value === undefined) return; if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error("整数参数无效。"); return value as number; }
