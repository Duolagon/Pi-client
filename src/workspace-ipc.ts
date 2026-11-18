import type { DesktopService } from "./backend.ts";
import type { Command, RpcExtensionUIResponse, TaskStartInput, WorktreeCreateInput } from "./shared.ts";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;

/** Install workspace endpoints behind the main process's existing sender/origin gate. */
export function installWorkspaceHandlers(
	handle: Handle,
	service: DesktopService,
	command: (value: unknown) => Command,
): void {
	handle("pi:git:begin", (value) => {
		const input = object(value ?? {});
		return service.beginCheckpoint(optionalId(input.conversationId), optionalText(input.label, "检查点名称", 160));
	});
	handle("pi:git:finish", (value) => {
		const input = object(value);
		return service.finishCheckpoint(id(input.checkpointId), optionalId(input.conversationId));
	});
	handle("pi:git:list", (conversationId) => service.listCheckpoints(optionalId(conversationId)));
	handle("pi:git:diff", (value) => {
		const input = object(value);
		return service.checkpointDiff(
			id(input.checkpointId),
			optionalId(input.conversationId),
			optionalText(input.path, "文件路径"),
		);
	});
	handle("pi:git:restore", (value) => {
		const input = object(value);
		let paths: string[] | undefined;
		if (input.paths !== undefined) {
			if (!Array.isArray(input.paths) || input.paths.length > 5000) throw new Error("恢复文件列表无效。");
			paths = input.paths.map((path) => string(path, "文件路径"));
		}
		return service.restoreCheckpoint(id(input.checkpointId), optionalId(input.conversationId), paths);
	});
	handle("pi:terminal:create", (value) => {
		const input = object(value ?? {});
		return service.createTerminal({
			conversationId: optionalId(input.conversationId),
			cols: optionalInteger(input.cols, "终端列数", 1, 1000),
			rows: optionalInteger(input.rows, "终端行数", 1, 1000),
			shell: optionalText(input.shell, "Shell 路径"),
		});
	});
	handle("pi:terminal:list", async (conversationId) => service.listTerminals(optionalId(conversationId)));
	handle("pi:terminal:write", (terminalId, data) => {
		if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 1024 * 1024)
			throw new Error("终端输入格式错误。");
		return service.writeTerminal(id(terminalId), data);
	});
	handle("pi:terminal:resize", (terminalId, cols, rows) =>
		service.resizeTerminal(id(terminalId), integer(cols, "终端列数", 1, 1000), integer(rows, "终端行数", 1, 1000)),
	);
	handle("pi:terminal:close", (terminalId) => service.closeTerminal(id(terminalId)));
	handle("pi:terminal:replay", async (terminalId, afterSequence) =>
		service.terminalReplay(id(terminalId), optionalInteger(afterSequence, "输出序号", 0, Number.MAX_SAFE_INTEGER)),
	);
	handle("pi:task:start", (value) => {
		const input = object(value);
		const isolation = input.isolation;
		if (isolation !== undefined && isolation !== "worktree" && isolation !== "shared")
			throw new Error("任务隔离方式无效。");
		const task: TaskStartInput = {
			message: string(input.message, "任务内容", 2 * 1024 * 1024),
			project: optionalText(input.project, "项目目录"),
			title: optionalText(input.title, "任务名称", 160),
			baseRef: optionalText(input.baseRef, "Git 基准", 1000),
			isolation,
			worktreeId: optionalId(input.worktreeId),
		};
		if (input.model !== undefined) {
			const model = object(input.model);
			task.model = { provider: string(model.provider, "服务商", 300), id: string(model.id, "模型", 500) };
		}
		if (input.thinkingLevel !== undefined) {
			const selection = command({ type: "set_thinking_level", level: input.thinkingLevel });
			if (selection.type === "set_thinking_level") task.thinkingLevel = selection.level;
		}
		return service.startTask(task);
	});
	handle("pi:task:list", () => service.listTasks());
	handle("pi:task:snapshot", (taskId) => service.taskSnapshot(id(taskId)));
	handle("pi:task:cancel", (taskId) => service.cancelTask(id(taskId)));
	handle("pi:task:command", (taskId, value) => service.command(command(value), id(taskId)));
	handle("pi:task:respond", (taskId, value) => {
		const response = object(value);
		id(response.id);
		if (
			response.type !== "extension_ui_response" ||
			!(response.cancelled === true || typeof response.confirmed === "boolean" || typeof response.value === "string")
		)
			throw new Error("确认响应格式错误。");
		if (response.value !== undefined) string(response.value, "确认内容", 1024 * 1024);
		return service.respond(response as RpcExtensionUIResponse, id(taskId));
	});
	handle("pi:task:files", (taskId, path) => service.files(string(path, "文件路径"), id(taskId)));
	handle("pi:task:read-file", (taskId, path) => service.readFile(string(path, "文件路径"), id(taskId)));
	handle("pi:task:workspace", (taskId) => service.workspace(id(taskId)));
	handle("pi:task:diff", (taskId, path) => service.diff(string(path, "文件路径"), id(taskId)));
	handle("pi:worktree:create", (value) => {
		const input = object(value);
		const request: WorktreeCreateInput = {
			project: string(input.project, "项目目录"),
			baseRef: optionalText(input.baseRef, "Git 基准", 1000),
			conversationId: optionalId(input.conversationId),
		};
		return service.createWorktree(request);
	});
	handle("pi:worktree:list", (project) => service.listWorktrees(optionalText(project, "项目目录")));
	handle("pi:worktree:remove", (worktreeId) => service.removeWorktree(id(worktreeId)));
	handle("pi:worktree:merge", (worktreeId) => service.mergeWorktree(id(worktreeId)));
	handle("pi:workspace:stage", (paths) => service.gitStage(optionalPathArray(paths)));
	handle("pi:workspace:unstage", (paths) => service.gitUnstage(optionalPathArray(paths)));
	handle("pi:workspace:discard", (paths) => service.gitDiscard(pathArray(paths)));
	handle("pi:workspace:commit", (message) => service.gitCommit(string(message, "提交说明", 32768)));
	handle("pi:workspace:read-memory", () => service.readMemory());
	handle("pi:workspace:write-memory", (file, content) => {
		if (file !== "AGENTS.md" && file !== "CLAUDE.md") throw new Error("记忆文件名无效。");
		return service.writeMemory(file, string(content, "记忆内容", 1024 * 1024));
	});
	handle("pi:workspace:context-report", () => service.contextReport());
	handle("pi:workspace:write-memory-file", (relativePath, content) =>
		service.writeMemoryFile(string(relativePath, "记忆文件路径", 500), string(content, "记忆内容", 1024 * 1024)),
	);
	handle("pi:workspace:delete-memory-rule", (relativePath) =>
		service.deleteMemoryRule(string(relativePath, "规则文件路径", 500)),
	);
	handle("pi:plan:read", (conversationId) => service.readPlan(optionalId(conversationId)));
	handle("pi:plan:write", (content, conversationId) =>
		service.writePlan(string(content, "计划内容", 512 * 1024), optionalId(conversationId)),
	);
	handle("pi:btw", (question) => service.askBtw(string(question, "侧问问题", 32768)));
	handle("pi:sandbox:status", () => service.sandboxStatus());
}

function pathArray(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 5000) throw new Error("文件路径列表无效。");
	return value.map((item) => string(item, "文件路径"));
}
function optionalPathArray(value: unknown): string[] | undefined {
	return value === undefined ? undefined : pathArray(value);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求参数格式错误。");
	return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 32768): string {
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label}格式错误。`);
	return value;
}
function optionalText(value: unknown, label: string, max = 32768): string | undefined {
	return value === undefined ? undefined : string(value, label, max);
}
function id(value: unknown): string {
	const result = string(value, "标识符", 200);
	if (!/^[a-zA-Z0-9._-]+$/.test(result)) throw new Error("标识符格式错误。");
	return result;
}
function optionalId(value: unknown): string | undefined {
	return value === undefined ? undefined : id(value);
}
function integer(value: unknown, label: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`${label}无效。`);
	return value;
}
function optionalInteger(value: unknown, label: string, min: number, max: number): number | undefined {
	return value === undefined ? undefined : integer(value, label, min, max);
}
