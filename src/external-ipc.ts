import type { DesktopService } from "./backend.ts";
import { validateExecutorInput } from "./external-executors.ts";
import { externalModelOptions } from "./external-model-options.ts";
import { isExternalProvider } from "./external-registry.ts";
import { parseAgentOutputSchema } from "./agent-output-schema.ts";
import type { ExternalApprovalResponse, ExternalTaskStartInput } from "./external-types.ts";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;
export function installExternalHandlers(handle: Handle, service: DesktopService): void {
	handle("pi:external:executors", (value) => {
		const options = object(value ?? {}, ["verifyCompatibility"]);
		return service.externalExecutors({ verifyCompatibility: optionalBoolean(options.verifyCompatibility) });
	});
	handle("pi:external:configure", (value) => service.configureExternal(validateExecutorInput(value)));
	handle("pi:external:start", (value) => {
		const input = object(value, ["executor", "conversationId", "description", "prompt", "subagent_type", "isolation", "worktree_id", "run_in_background", "model", "effort", "output_schema"]);
		if (!isExternalProvider(input.executor)) throw new Error("未知执行器。");
		if (input.subagent_type !== undefined && !["Explore", "Plan", "general-purpose"].includes(input.subagent_type as string)) throw new Error("子任务类型无效。");
		if (input.isolation !== undefined && input.isolation !== "shared" && input.isolation !== "worktree") throw new Error("隔离方式无效。");
		const request: ExternalTaskStartInput = {
			executor: input.executor as ExternalTaskStartInput["executor"], conversationId: input.conversationId === undefined ? undefined : id(input.conversationId),
			description: text(input.description, 160), prompt: text(input.prompt, 2 * 1024 * 1024),
			subagent_type: input.subagent_type as ExternalTaskStartInput["subagent_type"], isolation: input.isolation as ExternalTaskStartInput["isolation"],
			worktree_id: input.worktree_id === undefined ? undefined : id(input.worktree_id), run_in_background: optionalBoolean(input.run_in_background),
			...externalModelOptions(input.model, input.effort),
			...(input.output_schema === undefined ? {} : { output_schema: parseAgentOutputSchema(input.output_schema) }),
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
		const input = object(value, ["decision", "optionId", "answers", "rememberForSession"]);
		if (!["allow", "deny", "cancel"].includes(input.decision as string)) throw new Error("审批决定无效。");
		const response: ExternalApprovalResponse = { decision: input.decision as ExternalApprovalResponse["decision"], optionId: input.optionId === undefined ? undefined : text(input.optionId, 500) };
		response.rememberForSession = optionalBoolean(input.rememberForSession);
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
	handle("pi:external:diff", (taskId, checkpointId, path, includeText) =>
		service.externalDiff(id(taskId), id(checkpointId), path === undefined ? undefined : text(path, 4096), optionalBoolean(includeText)));
	handle("pi:external:change-files", (value) => {
		const input = object(value, ["taskId", "checkpointId", "action", "paths"]);
		if (input.action !== "apply" && input.action !== "discard") throw new Error("文件操作无效。");
		const paths = input.paths;
		if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 200)) throw new Error("文件选择无效。");
		return service.changeExternalFiles({
			taskId: id(input.taskId), checkpointId: id(input.checkpointId), action: input.action,
			paths: (paths as unknown[] | undefined)?.map((path) => text(path, 4096)),
		});
	});
	handle("pi:external:review", (value) => {
		const input = object(value, ["taskId", "executor"]);
		if (input.executor !== undefined && !isExternalProvider(input.executor)) throw new Error("未知执行器。");
		return service.reviewExternal({ taskId: id(input.taskId), executor: input.executor });
	});
	handle("pi:external:compare", (value) => {
		const input = object(value, ["taskId", "candidates"]);
		if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 3)
			throw new Error("多方案比较需要 2 或 3 个候选。");
		return service.compareExternal({ taskId: id(input.taskId), candidates: input.candidates.map((value) => {
			const candidate = object(value, ["executor", "model", "effort"]);
			if (!isExternalProvider(candidate.executor)) throw new Error("未知执行器。");
			return { executor: candidate.executor, ...externalModelOptions(candidate.model, candidate.effort) };
		}) });
	});
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
