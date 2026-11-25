import { isAbsolute, join } from "node:path";
import {
	AGENT_CALL_NAME_PATTERN,
	MAX_AGENT_MCP_SERVERS,
	MAX_AGENT_OUTPUT,
	MAX_AGENT_TURNS,
	MAX_DELEGATION_DEPTH,
	MAX_MODEL_ID,
	MAX_MODEL_PROVIDER,
	MAX_PENDING_MESSAGE,
	MAX_TASK_ERROR,
	MAX_TURN_CALLS,
	MAX_TASK_MESSAGE,
	MAX_TASK_READ_PATHS,
	MAX_TASK_TITLE,
	MAX_TOOL_LIST,
	TOOL_NAME_PATTERN,
	isTaskReadPath,
	truncateText,
} from "./delegation-limits.ts";
import { validateRuntimePolicy } from "./permission-policy.ts";
import { validateAgentScopePaths } from "./agent-read-scope.ts";
import type { RuntimePermissionPolicy } from "./permission-types.ts";
import { taskStatuses, taskStopReasons, type DesktopTask, type TaskRunStats, type TaskStatsBaseline } from "./task-types.ts";

export interface TaskValidationOptions {
	/** `<dataDir>/agent-prompts`; a stored system prompt file must be `<promptDir>/<task id>.md`. */
	promptDir?: string;
}

const idPattern = /^[a-zA-Z0-9._-]{1,200}$/;
const agentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const mcpServerNamePattern = /^[A-Za-z0-9_.-]{1,64}$/;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const activeStatuses = new Set(["queued", "running", "waiting_for_input"]);
/** Upper bound of a stored task turn counter. */
const MAX_TASK_TURN = 1_000_000;
const permissionModes = new Set(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "read"]);

type Fields = Record<string, unknown>;

function fail(field: string): never {
	throw new Error(`任务字段 ${field} 无效`);
}
function record(value: unknown, field: string): Fields {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
	return value as Fields;
}
function id(value: unknown, field: string): string {
	if (typeof value !== "string" || !idPattern.test(value)) fail(field);
	return value;
}
function text(value: unknown, field: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > max || value.includes("\0") || (!allowEmpty && !value)) fail(field);
	return value;
}
/**
 * Display-only text is repaired instead of failing the record: an over-long or
 * malformed value is cut to the limit and stripped of NUL characters.
 */
function displayText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return truncateText(value.includes("\0") ? value.replaceAll("\0", "") : value, max);
}
function absolute(value: unknown, field: string): string {
	if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || value.includes("\0")) fail(field);
	return value;
}
function finite(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(field);
	return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(field);
	return value as number;
}
function bool(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") fail(field);
	return value;
}
function toolList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_TOOL_LIST) fail(field);
	for (const name of value) if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) fail(field);
	return [...value] as string[];
}
function mcpServerList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_AGENT_MCP_SERVERS) fail(field);
	for (const name of value) if (typeof name !== "string" || !mcpServerNamePattern.test(name)) fail(field);
	return [...value] as string[];
}

function storedModel(value: unknown): { provider: string; id: string } | undefined {
	const model = value as Fields | undefined;
	if (
		model && typeof model === "object" && !Array.isArray(model) &&
		Object.keys(model).every((key) => key === "provider" || key === "id") &&
		typeof model.provider === "string" && model.provider && model.provider.length <= MAX_MODEL_PROVIDER && !model.provider.includes("\0") &&
		typeof model.id === "string" && model.id && model.id.length <= MAX_MODEL_ID && !model.id.includes("\0")
	)
		return { provider: model.provider, id: model.id };
	return undefined;
}
function tokens(value: unknown, field: string): TaskRunStats["tokens"] {
	const input = record(value, field);
	if (Object.keys(input).some((key) => !["input", "output", "cacheRead", "cacheWrite", "total"].includes(key))) fail(field);
	return {
		input: finite(input.input, field), output: finite(input.output, field), cacheRead: finite(input.cacheRead, field),
		cacheWrite: finite(input.cacheWrite, field), total: finite(input.total, field),
	};
}
/** Usage numbers are display and accounting data; a malformed block is dropped, not the task. */
function runStats(value: unknown): TaskRunStats | undefined {
	try {
		const input = record(value, "stats");
		if (Object.keys(input).some((key) => !["tokens", "cost", "toolUses", "startedAt", "durationMs", "model"].includes(key))) return undefined;
		const model = input.model === undefined ? undefined : storedModel(input.model);
		return {
			tokens: tokens(input.tokens, "stats"), cost: finite(input.cost, "stats"),
			toolUses: integer(input.toolUses, "stats", 0, Number.MAX_SAFE_INTEGER),
			startedAt: finite(input.startedAt, "stats"), durationMs: finite(input.durationMs, "stats"),
			...(model ? { model } : {}),
		};
	} catch { return undefined; }
}
function statsBaseline(value: unknown): TaskStatsBaseline | undefined {
	try {
		const input = record(value, "statsAtTurnStart");
		if (Object.keys(input).some((key) => !["tokens", "cost", "toolCalls", "startedAt"].includes(key))) return undefined;
		return {
			tokens: tokens(input.tokens, "statsAtTurnStart"), cost: finite(input.cost, "statsAtTurnStart"),
			toolCalls: integer(input.toolCalls, "statsAtTurnStart", 0, Number.MAX_SAFE_INTEGER),
			startedAt: finite(input.startedAt, "statsAtTurnStart"),
		};
	} catch { return undefined; }
}

/**
 * Validate one persisted task field by field and rebuild it from known fields only.
 * Disk metadata is a trust boundary: tool names and maxTurns flow into Pi CLI
 * arguments and environment variables, and parent links decide ownership.
 */
export function validateTask(value: unknown, conversationIds: ReadonlySet<string>, options: TaskValidationOptions = {}): DesktopTask {
	const input = record(value, "task");
	const taskId = id(input.id, "id");
	const conversationId = id(input.conversationId, "conversationId");
	// Policies are keyed by task id but looked up by conversation id; they must be one identity.
	if (taskId !== conversationId) fail("conversationId");
	if (!conversationIds.has(conversationId)) fail("conversationId");
	if (!taskStatuses.includes(input.status as DesktopTask["status"])) fail("status");
	const task: DesktopTask = {
		id: taskId,
		conversationId,
		project: absolute(input.project, "project"),
		workingDirectory: absolute(input.workingDirectory, "workingDirectory"),
		title: displayText(input.title, MAX_TASK_TITLE) ?? "",
		prompt: displayText(input.prompt, MAX_TASK_MESSAGE) ?? "",
		status: input.status as DesktopTask["status"],
		createdAt: finite(input.createdAt, "createdAt"),
		updatedAt: finite(input.updatedAt, "updatedAt"),
		revision: input.revision === undefined ? 0 : integer(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER),
		turn: 1,
	};
	if (input.worktreeId !== undefined) task.worktreeId = id(input.worktreeId, "worktreeId");
	const error = displayText(input.error, MAX_TASK_ERROR);
	if (error !== undefined) task.error = error;
	if (input.checkpointId !== undefined) task.checkpointId = id(input.checkpointId, "checkpointId");
	// The model selection never affects permissions; a malformed one falls back to the default model.
	const model = storedModel(input.model);
	if (model) task.model = model;
	if (input.thinkingLevel !== undefined) {
		if (!thinkingLevels.has(input.thinkingLevel as string)) fail("thinkingLevel");
		task.thinkingLevel = input.thinkingLevel as DesktopTask["thinkingLevel"];
	}
	if (input.parentConversationId !== undefined) {
		const parent = id(input.parentConversationId, "parentConversationId");
		if (parent === conversationId || !conversationIds.has(parent)) fail("parentConversationId");
		task.parentConversationId = parent;
		task.parentToolCallId = text(input.parentToolCallId, "parentToolCallId", 300);
		if (typeof input.subagentType !== "string" || !agentNamePattern.test(input.subagentType)) fail("subagentType");
		task.subagentType = input.subagentType;
		task.delegationDepth = integer(input.delegationDepth, "delegationDepth", 1, MAX_DELEGATION_DEPTH);
		if (input.name !== undefined) {
			if (typeof input.name !== "string" || !AGENT_CALL_NAME_PATTERN.test(input.name)) fail("name");
			task.name = input.name;
		}
		if (input.teamName !== undefined) {
			task.teamName = text(input.teamName, "teamName", 64);
		}
		if (input.workflowId !== undefined) {
			task.workflowId = id(input.workflowId, "workflowId");
		}
		if (input.workflowWorkspace !== undefined) {
			if (!task.workflowId || typeof input.workflowWorkspace !== "string" || !/^[a-f0-9]{64}$/.test(input.workflowWorkspace))
				fail("workflowWorkspace");
			task.workflowWorkspace = input.workflowWorkspace;
		}
		if (input.isFork !== undefined) task.isFork = bool(input.isFork, "isFork");
		if (input.systemPromptFile !== undefined) {
			// The file is passed to the child's command line; only the host's own path is accepted.
			const file = absolute(input.systemPromptFile, "systemPromptFile");
			if (options.promptDir && file === join(options.promptDir, `${taskId}.md`)) task.systemPromptFile = file;
			else if (options.promptDir) fail("systemPromptFile");
		}
	} else if (
		input.parentToolCallId !== undefined || input.subagentType !== undefined || input.delegationDepth !== undefined ||
		input.name !== undefined || input.isFork !== undefined || input.systemPromptFile !== undefined ||
		input.workflowWorkspace !== undefined
	) {
		fail("parentConversationId");
	}
	if (input.readOnly !== undefined) task.readOnly = bool(input.readOnly, "readOnly");
	if (input.scopePaths !== undefined) {
		if (!task.parentConversationId || !task.readOnly || task.isFork || task.worktreeId) fail("scopePaths");
		task.scopePaths = validateAgentScopePaths(input.scopePaths);
	}
	if (input.omitClaudeMd !== undefined) task.omitClaudeMd = bool(input.omitClaudeMd, "omitClaudeMd");
	if (input.mcpServers !== undefined) task.mcpServers = mcpServerList(input.mcpServers, "mcpServers");
	if (input.runInBackground !== undefined) task.runInBackground = bool(input.runInBackground, "runInBackground");
	if (input.allowedTools !== undefined) task.allowedTools = toolList(input.allowedTools, "allowedTools");
	if (input.disallowedTools !== undefined) task.disallowedTools = toolList(input.disallowedTools, "disallowedTools");
	if (input.permissionMode !== undefined) {
		if (!permissionModes.has(input.permissionMode as string)) fail("permissionMode");
		task.permissionMode = input.permissionMode as DesktopTask["permissionMode"];
	}
	if (input.maxTurns !== undefined) task.maxTurns = integer(input.maxTurns, "maxTurns", 1, MAX_AGENT_TURNS);
	if (input.result !== undefined) {
		// A stored result is untrusted display data; an over-long one is cut and marked truncated.
		const result = input.result as Fields;
		if (
			result && typeof result === "object" && !Array.isArray(result) &&
			Object.keys(result).every((key) => ["text", "truncated", "partial", "readPaths"].includes(key)) &&
			typeof result.text === "string" && typeof result.truncated === "boolean" &&
			(result.partial === undefined || typeof result.partial === "boolean")
		) {
			const resultText = displayText(result.text, MAX_AGENT_OUTPUT) ?? "";
			const readPaths = Array.isArray(result.readPaths)
				? [...new Set(result.readPaths.slice(0, MAX_TASK_READ_PATHS).filter(isTaskReadPath))]
				: [];
			task.result = {
				text: resultText,
				truncated: result.truncated || resultText.length !== result.text.length,
				...(result.partial === undefined ? {} : { partial: result.partial }),
				...(readPaths.length ? { readPaths } : {}),
			};
		}
	}
	const stats = input.stats === undefined ? undefined : runStats(input.stats);
	if (stats) task.stats = stats;
	const baseline = input.statsAtTurnStart === undefined ? undefined : statsBaseline(input.statsAtTurnStart);
	if (baseline) task.statsAtTurnStart = baseline;
	if (input.stopReason !== undefined) {
		if (!taskStopReasons.includes(input.stopReason as DesktopTask["stopReason"] & string)) fail("stopReason");
		task.stopReason = input.stopReason as DesktopTask["stopReason"];
	}
	// Outbox state. A record written before turns existed has no `turn`; its finished run
	// counts as already delivered so an upgrade never replays old results into parents.
	if (input.turn === undefined) {
		if (!activeStatuses.has(task.status)) task.notifiedTurn = 1;
	} else task.turn = integer(input.turn, "turn", 1, MAX_TASK_TURN);
	if (input.notifiedTurn !== undefined && task.notifiedTurn === undefined)
		task.notifiedTurn = integer(input.notifiedTurn, "notifiedTurn", 1, task.turn);
	if (input.notifySuppressed !== undefined) task.notifySuppressed = bool(input.notifySuppressed, "notifySuppressed");
	// A resumed run's message becomes a user message of the child; a malformed one is dropped
	// (the run then has nothing to send and fails visibly) instead of being repaired.
	if (input.pendingMessage !== undefined) {
		const message = displayText(input.pendingMessage, MAX_PENDING_MESSAGE);
		if (message !== undefined && message === input.pendingMessage && message.trim()) task.pendingMessage = message;
	}
	// Idempotency keys only; malformed entries are dropped.
	if (Array.isArray(input.turnCalls)) {
		const calls = input.turnCalls.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 300 && !item.includes("\0"));
		if (calls.length) task.turnCalls = calls.slice(-MAX_TURN_CALLS);
	}
	if (input.quarantined !== undefined) {
		if (input.quarantined !== true) fail("quarantined");
		task.quarantined = true;
		task.readOnly = true;
		task.permissionMode = "read";
		task.notifySuppressed = true;
	}
	return task;
}

/** A record the host wrote for a model-delegated child, or one carrying a child policy. */
function looksDelegated(input: Fields, hasPolicy: boolean): boolean {
	return hasPolicy || input.quarantined !== undefined || input.readOnly === true ||
		["parentConversationId", "parentToolCallId", "subagentType", "delegationDepth", "scopePaths"].some((key) => input[key] !== undefined);
}

/**
 * Rebuild a minimal, restricted record for a delegated child whose stored record is
 * invalid. Its conversation still exists, so dropping the record would turn the child
 * into an unrestricted root conversation. The rebuilt record is read-only, cannot
 * delegate, never runs again by itself and keeps a parent link only when the parent
 * conversation exists.
 */
function quarantineTask(
	value: unknown,
	conversations: ReadonlySet<string> | ReadonlyMap<string, string>,
	hasPolicy: (id: string) => boolean,
): DesktopTask | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Fields;
	if (typeof input.id !== "string" || !idPattern.test(input.id) || !conversations.has(input.id)) return undefined;
	if (!looksDelegated(input, hasPolicy(input.id))) return undefined;
	const valid = <T>(read: () => T): T | undefined => {
		try {
			return read();
		} catch {
			return undefined;
		}
	};
	const project =
		valid(() => absolute(input.project, "project")) ??
		(conversations instanceof Map ? conversations.get(input.id) : undefined);
	if (!project || !isAbsolute(project)) return undefined;
	const now = Date.now();
	const status = input.status as DesktopTask["status"];
	const terminal = taskStatuses.includes(status) && !activeStatuses.has(status);
	const task: DesktopTask = {
		id: input.id,
		conversationId: input.id,
		project,
		workingDirectory: valid(() => absolute(input.workingDirectory, "workingDirectory")) ?? project,
		title: displayText(input.title, MAX_TASK_TITLE) ?? "",
		prompt: "",
		status: terminal ? status : "interrupted",
		createdAt: valid(() => finite(input.createdAt, "createdAt")) ?? now,
		updatedAt: now,
		revision: 0,
		error: "任务记录已损坏，已按只读方式保留，不能再委派子 Agent。",
		readOnly: true,
		permissionMode: "read",
		quarantined: true,
		// A damaged record never notifies its parent: its result is not trustworthy.
		turn: 1,
		notifySuppressed: true,
		...(terminal ? {} : { stopReason: "restart" as const }),
	};
	const worktreeId = valid(() => id(input.worktreeId, "worktreeId"));
	if (worktreeId) task.worktreeId = worktreeId;
	const parent = valid(() => id(input.parentConversationId, "parentConversationId"));
	if (parent && parent !== task.id && conversations.has(parent)) {
		task.parentConversationId = parent;
		task.parentToolCallId = valid(() => text(input.parentToolCallId, "parentToolCallId", 300)) ?? `recovered-${task.id}`.slice(0, 300);
		task.subagentType =
			typeof input.subagentType === "string" && agentNamePattern.test(input.subagentType) ? input.subagentType : "general-purpose";
		task.delegationDepth = valid(() => integer(input.delegationDepth, "delegationDepth", 1, MAX_DELEGATION_DEPTH)) ?? 1;
	}
	return task;
}

export interface SanitizedTasks {
	tasks: DesktopTask[];
	taskPolicies: Record<string, RuntimePermissionPolicy>;
	/** Human-readable reasons for each dropped task or policy record. */
	dropped: string[];
}

/**
 * Drop malformed, duplicate or cyclic tasks and orphan child policies. Invalid
 * policies are dropped individually; the child then still inherits its parent's
 * live ceiling, its read-only flag and its tool restrictions.
 */
export function sanitizeStoredTasks(
	rawTasks: unknown,
	/** Conversation ids, or conversation id → project path so damaged child records can be quarantined. */
	conversations: ReadonlySet<string> | ReadonlyMap<string, string>,
	rawPolicies: unknown,
	options: TaskValidationOptions = {},
): SanitizedTasks {
	const conversationIds: ReadonlySet<string> = conversations instanceof Map ? new Set(conversations.keys()) : (conversations as ReadonlySet<string>);
	const dropped: string[] = [];
	if (rawTasks !== undefined && !Array.isArray(rawTasks)) throw new Error("后台任务配置格式错误。");
	if (rawPolicies !== undefined && (!rawPolicies || typeof rawPolicies !== "object" || Array.isArray(rawPolicies)))
		throw new Error("子 Agent 权限配置格式错误。");
	const policies = new Map<string, RuntimePermissionPolicy>();
	for (const [key, policy] of Object.entries((rawPolicies ?? {}) as Record<string, unknown>)) {
		try {
			if (!idPattern.test(key)) throw new Error("标识无效");
			policies.set(key, validateRuntimePolicy(policy));
		} catch (error) {
			dropped.push(`权限 ${key.slice(0, 80)}：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const candidates = new Map<string, DesktopTask>();
	const ordered: DesktopTask[] = [];
	const rawPolicyIds = new Set(Object.keys((rawPolicies ?? {}) as Record<string, unknown>));
	for (const [index, raw] of ((rawTasks ?? []) as unknown[]).entries()) {
		let task: DesktopTask;
		try {
			task = validateTask(raw, conversationIds, options);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const recovered = quarantineTask(raw, conversations, (key) => rawPolicyIds.has(key));
			if (!recovered || candidates.has(recovered.id)) {
				dropped.push(`任务 #${index + 1}：${reason}`);
				continue;
			}
			dropped.push(`任务 #${index + 1}：${reason}，已按只读方式隔离`);
			task = recovered;
		}
		if (candidates.has(task.id)) {
			dropped.push(`任务 #${index + 1}：任务标识重复`);
			continue;
		}
		candidates.set(task.id, task);
		ordered.push(task);
	}
	// Parent chains must terminate within the depth limit; a cycle would recurse forever
	// when permission ceilings are inherited from parents.
	const byConversation = new Map([...candidates.values()].map((task) => [task.conversationId, task]));
	for (const task of [...candidates.values()]) {
		const seen = new Set<string>([task.conversationId]);
		let current: DesktopTask | undefined = task;
		let depth = 0;
		let valid = true;
		while (current?.parentConversationId) {
			depth++;
			if (depth > MAX_DELEGATION_DEPTH || seen.has(current.parentConversationId)) {
				valid = false;
				break;
			}
			seen.add(current.parentConversationId);
			current = byConversation.get(current.parentConversationId);
		}
		if (!valid) {
			// Keep the child restricted instead of letting its conversation become a root.
			const recovered = quarantineTask(task, conversations, () => true);
			if (recovered) {
				delete recovered.parentConversationId;
				delete recovered.parentToolCallId;
				delete recovered.subagentType;
				delete recovered.delegationDepth;
				candidates.set(task.id, recovered);
				ordered[ordered.indexOf(task)] = recovered;
				byConversation.set(recovered.conversationId, recovered);
				dropped.push(`任务 ${task.id}：父会话链无效，已按只读方式隔离`);
			} else {
				candidates.delete(task.id);
				dropped.push(`任务 ${task.id}：父会话链无效`);
			}
		}
	}
	const tasks = ordered.filter((task) => candidates.has(task.id));
	const taskPolicies: Record<string, RuntimePermissionPolicy> = {};
	for (const [key, policy] of policies) {
		const task = candidates.get(key);
		if (task?.parentConversationId) taskPolicies[key] = policy;
		else dropped.push(`权限 ${key.slice(0, 80)}：没有对应的子 Agent 任务`);
	}
	return { tasks, taskPolicies, dropped };
}
