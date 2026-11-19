import type { DesktopService } from "./backend.ts";
import type { TodoCreateInput, TodoUpdateInput } from "./todo-types.ts";
import type { CronCreateInput } from "./cron-types.ts";
import type { WorkflowApprovalDecision, WorkflowRunInput } from "./workflow-types.ts";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求参数必须是对象。");
	return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
		throw new Error("文本参数格式无效。");
	}
	return value;
}

function optionalId(value: unknown): string | undefined {
	return value === undefined ? undefined : text(value, 200);
}

/** IPC handlers for P8 persistent checklists, monitors, cron schedules, teams, and workflows. */
export function installP8Handlers(handle: Handle, service: DesktopService): void {
	handle("pi:todos:list", (conversationId) => service.listTodos(optionalId(conversationId)));
	handle("pi:todos:create", (conversationId, input) =>
		service.createTodo(text(conversationId, 200), object(input) as unknown as TodoCreateInput),
	);
	handle("pi:todos:update", (conversationId, input) =>
		service.updateTodo(text(conversationId, 200), object(input) as unknown as TodoUpdateInput),
	);
	handle("pi:monitor:list", (conversationId) => service.listMonitors(optionalId(conversationId)));
	handle("pi:monitor:stop", (id) => service.stopMonitor(text(id, 200)));
	handle("pi:cron:list", (conversationId) => service.listCron(optionalId(conversationId)));
	handle("pi:cron:create", (conversationId, input) =>
		service.createCron(text(conversationId, 200), object(input) as unknown as CronCreateInput),
	);
	handle("pi:cron:loop", (conversationId, args) =>
		service.runLoopCommand(text(conversationId, 200), text(args, 16500)),
	);
	handle("pi:cron:delete", (id, conversationId) =>
		service.deleteCron(text(id, 80), optionalId(conversationId)),
	);
	handle("pi:teams:get", (conversationId) => service.getTeam(optionalId(conversationId)));
	handle("pi:teams:delete", (conversationId, teamName) =>
		service.deleteTeam(text(conversationId, 200), teamName === undefined ? undefined : text(teamName, 64)),
	);
	handle("pi:workflow:list", (conversationId) => service.listWorkflows(optionalId(conversationId)));
	handle("pi:workflow:start", (conversationId, input) =>
		service.startWorkflow(text(conversationId, 200), object(input) as unknown as WorkflowRunInput),
	);
	handle("pi:workflow:resume", (id) => service.resumeWorkflow(text(id, 128)));
	handle("pi:workflow:stop", (id) => service.stopWorkflow(text(id, 128)));
	handle("pi:workflow:respond", (workflowId, requestId, decision) => {
		const dec = text(decision, 16);
		if (dec !== "once" && dec !== "always" && dec !== "deny") {
			throw new Error("无效的工作流审批决定。");
		}
		return service.respondWorkflowApproval(text(workflowId, 128), text(requestId, 128), dec as WorkflowApprovalDecision);
	});
}
