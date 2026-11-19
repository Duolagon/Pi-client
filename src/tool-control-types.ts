import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import { AGENT_CALL_NAME_PATTERN, MAX_AGENT_PROMPT, MAX_SEND_MESSAGE, MAX_SEND_SUMMARY, MAX_SEND_TARGET, exceedsLength } from "./delegation-limits.ts";
import type { ModelToolResult, ToolUsage } from "./delegation-types.ts";

/** Values accepted by the Agent tool's `model` parameter. */
export const agentModelValues = ["sonnet", "opus", "haiku", "fable", "inherit"] as const;
/** `remote` is accepted by the schema only so the host can explain that it is unsupported. */
export const agentIsolationValues = ["worktree", "shared", "remote"] as const;

export const desktopModelToolNames = [
	"Agent", "SendMessage", "AgentSend", "AgentExecutors", "TaskOutput", "TaskStop", "TaskList",
	"WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove",
] as const;
export type DesktopModelToolName = (typeof desktopModelToolNames)[number];
/** Tools that start or continue a child; a child process never gets them. */
export const delegatingToolNames: readonly DesktopModelToolName[] = ["Agent", "SendMessage", "AgentSend"];
/** Delegating calls whose batch (the other calls of the same message) the parent reports. */
export const batchedToolNames: readonly DesktopModelToolName[] = ["Agent", "SendMessage", "AgentSend"];

export interface DesktopToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	source: "builtin" | "extension" | "mcp" | "desktop";
	sourcePath?: string;
	exposure: ToolExposure;
	namespace?: string;
	/** Callable availability, including MCP tools reachable through codemode/tool search. */
	enabled: boolean;
	/** Whether Pi currently declares this tool directly to the model. */
	modelVisible: boolean;
	/** Explicit desktop setting; absent when the existing Pi configuration governs the tool. */
	override?: boolean;
}

export interface ToolOverrides { overrides: Record<string, boolean> }
/**
 * `followUp` + `triggerTurn` is the native delivery to a live parent. `nextTurn` with
 * `triggerTurn: false` queues a result for the parent's next run without waking it.
 */
export type NotificationDelivery = "followUp" | "nextTurn";
/** A background child's run usage and the model it ran on. */
export interface NotificationUsage { provider: string; model: string; usage: ToolUsage }
export type ToolControlRequest =
	| { requestId: string; operation: "list" | "apply" }
	| {
		requestId: string;
		operation: "notify";
		/** `<task id>:<turn>`; the extension acknowledges each key once per session. */
		key: string;
		content: string;
		details: Record<string, unknown>;
		deliverAs: NotificationDelivery;
		triggerTurn: boolean;
		/** The finished run's usage, counted into the parent session once it receives the result. */
		usage?: NotificationUsage;
	}
	/** Start a parent run that consumes results already queued for its next turn. */
	| { requestId: string; operation: "wake"; count: number };
/**
 * `sent` started or joined an idle parent's run, `queued` waits for the next run, `duplicate`
 * was delivered before, `deferred` was not sent because the parent is mid-run: the host sends
 * it again after the run settles.
 */
export type NotificationDisposition = "sent" | "queued" | "duplicate" | "deferred";
export type ToolControlResponse =
	| { requestId: string; ok: true; tools: DesktopToolInfo[]; delivery?: NotificationDisposition }
	| { requestId: string; ok: false; error: string };
export const NOTIFICATION_KEY_PATTERN = /^[A-Za-z0-9._-]{1,240}:[1-9][0-9]{0,6}$/;

/** Validate a host notification request again inside the Pi process. */
export function validateControlRequest(value: unknown, requestId: string, maxBytes: number): ToolControlRequest {
	const request = object(value);
	if (request.requestId !== requestId || typeof request.operation !== "string") throw new Error("Invalid tool control request");
	const keys = Object.keys(request);
	const only = (allowed: string[]) => { if (keys.some((key) => !allowed.includes(key))) throw new Error("Invalid tool control request"); };
	if (request.operation === "list" || request.operation === "apply") {
		only(["requestId", "operation"]);
		return { requestId, operation: request.operation };
	}
	if (request.operation === "wake") {
		only(["requestId", "operation", "count"]);
		if (!Number.isSafeInteger(request.count) || (request.count as number) < 1 || (request.count as number) > 10000) throw new Error("Invalid tool control request");
		return { requestId, operation: "wake", count: request.count as number };
	}
	if (request.operation !== "notify") throw new Error("Invalid tool control request");
	only(["requestId", "operation", "key", "content", "details", "deliverAs", "triggerTurn", "usage"]);
	if (typeof request.key !== "string" || !NOTIFICATION_KEY_PATTERN.test(request.key)) throw new Error("Invalid background task result");
	if (typeof request.content !== "string" || !request.content.trim() || request.content.includes("\0") ||
		Buffer.byteLength(request.content, "utf8") > maxBytes) throw new Error("Invalid background task result");
	const details = object(request.details);
	if (Buffer.byteLength(JSON.stringify(details), "utf8") > maxBytes) throw new Error("Invalid background task result");
	if (request.deliverAs !== "followUp" && request.deliverAs !== "nextTurn") throw new Error("Invalid background task result");
	if (typeof request.triggerTurn !== "boolean" || (request.deliverAs === "nextTurn" && request.triggerTurn)) throw new Error("Invalid background task result");
	let usage: NotificationUsage | undefined;
	if (request.usage !== undefined) {
		const value = object(request.usage);
		const label = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 200 && !/[\0\r\n]/.test(item);
		const counted = validToolUsage(value.usage);
		if (Object.keys(value).some((key) => !["provider", "model", "usage"].includes(key)) || !label(value.provider) || !label(value.model) || !counted)
			throw new Error("Invalid background task result");
		usage = { provider: value.provider as string, model: value.model as string, usage: counted };
	}
	return {
		requestId, operation: "notify", key: request.key, content: request.content, details, deliverAs: request.deliverAs, triggerTurn: request.triggerTurn,
		...(usage ? { usage } : {}),
	};
}

export interface AgentToolInput {
	executor?: "pi" | "codex" | "claude" | "kimi";
	description: string;
	prompt: string;
	/** Defaults to general-purpose; `"fork"` forks this conversation. */
	subagent_type?: string;
	model?: (typeof agentModelValues)[number];
	run_in_background?: boolean;
	name?: string;
	isolation?: "worktree" | "shared" | "remote";
	worktree_id?: string;
	fork?: boolean;
	/** Claude Code team parameters, accepted and ignored. */
	mode?: string;
	team_name?: string;
}
/** Continue an owned child by agentId or name; AgentSend is the legacy alias (`task_id`). */
export interface SendMessageToolInput { to: string; message: string; summary?: string; run_in_background?: boolean }
export interface TaskOutputToolInput { task_id: string; block?: boolean; timeout?: number }
export interface TaskStopToolInput { task_id: string }
export interface WorktreeCreateToolInput { base_ref?: string }
export interface WorktreeTargetToolInput { worktree_id: string }

/**
 * The rest of the assistant message an Agent call came in. Pi runs a batch without a
 * sequential tool in parallel, so `writers` other calls (registered tools that may change
 * files, such as write, edit or bash) would run at the same time as the child.
 */
export interface ToolCallBatch { writers: number }
export interface DesktopToolInvocation {
	tool: DesktopModelToolName;
	toolCallId: string;
	input: Record<string, unknown>;
	/** Reported by the parent's Pi process for Agent calls; absent when unknown. */
	batch?: ToolCallBatch;
}
export interface ToolHostContext {
	conversationId: string;
	toolCallId: string;
	signal: AbortSignal;
	batch?: ToolCallBatch;
	/** Streaming progress sink for NDJSON `/invoke` requests (UI-only). */
	onProgress?: (progress: unknown) => void;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object");
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || exceedsLength(value, max) || value.includes("\0"))
		throw new Error(`Invalid ${label}`);
	return value;
}
function optionalBoolean(value: unknown, label: string): void {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid ${label}`);
}

/** Validate again at the host boundary; a model's schema is not an authorization boundary. */
export function validateDesktopToolInput(tool: DesktopModelToolName, value: unknown): Record<string, unknown> {
	const input = object(value);
	const allowed: Record<DesktopModelToolName, string[]> = {
		// `mode` and `team_name` are the only leniently accepted fields; they are ignored.
		Agent: ["description", "prompt", "subagent_type", "model", "run_in_background", "name", "isolation", "worktree_id", "executor", "fork", "mode", "team_name"],
		SendMessage: ["to", "message", "summary", "run_in_background"],
		AgentSend: ["task_id", "message", "run_in_background"], AgentExecutors: [],
		TaskOutput: ["task_id", "block", "timeout"], TaskStop: ["task_id"], TaskList: [],
		WorktreeCreate: ["base_ref"], WorktreeList: [], WorktreeMerge: ["worktree_id"], WorktreeRemove: ["worktree_id"],
	};
	if (Object.keys(input).some((key) => !allowed[tool].includes(key))) throw new Error("Unknown tool input field");
	if (tool === "Agent") {
		text(input.description, "description", 160);
		text(input.prompt, "prompt", MAX_AGENT_PROMPT);
		if (input.subagent_type !== undefined && (typeof input.subagent_type !== "string" || !input.subagent_type.trim() || exceedsLength(input.subagent_type, 100)))
			throw new Error("Invalid subagent_type");
		if (input.executor !== undefined && (typeof input.executor !== "string" || !["pi", "codex", "claude", "kimi"].includes(input.executor))) throw new Error("Invalid executor");
		if (input.model !== undefined && !agentModelValues.includes(input.model as never)) throw new Error("Invalid model (expected sonnet, opus, haiku, fable or inherit)");
		if (input.name !== undefined && (typeof input.name !== "string" || !AGENT_CALL_NAME_PATTERN.test(input.name))) throw new Error("Invalid name");
		optionalBoolean(input.run_in_background, "run_in_background");
		optionalBoolean(input.fork, "fork");
		if (input.isolation !== undefined && !agentIsolationValues.includes(input.isolation as never))
			throw new Error("Invalid isolation");
		if (input.mode !== undefined) text(input.mode, "mode", 100);
		if (input.team_name !== undefined) text(input.team_name, "team_name", 200);
		if (input.worktree_id !== undefined) text(input.worktree_id, "worktree_id", 200);
	} else if (tool === "SendMessage") {
		text(input.to, "to", MAX_SEND_TARGET); text(input.message, "message", MAX_SEND_MESSAGE);
		if (input.summary !== undefined) text(input.summary, "summary", MAX_SEND_SUMMARY);
		optionalBoolean(input.run_in_background, "run_in_background");
	} else if (tool === "AgentSend") {
		text(input.task_id, "task_id", 200); text(input.message, "message", MAX_SEND_MESSAGE); optionalBoolean(input.run_in_background, "run_in_background");
	} else if (tool === "TaskOutput" || tool === "TaskStop") {
		text(input.task_id, "task_id", 200);
		if (tool === "TaskOutput") {
			optionalBoolean(input.block, "block");
			if (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || Number(input.timeout) < 0 || Number(input.timeout) > 60000))
				throw new Error("Invalid timeout (expected 0–60000 milliseconds)");
		}
	} else if (tool === "WorktreeCreate") {
		if (input.base_ref !== undefined) text(input.base_ref, "base_ref", 1000);
	} else if (tool === "WorktreeMerge" || tool === "WorktreeRemove") {
		text(input.worktree_id, "worktree_id", 200);
	}
	return { ...input };
}

export function validateToolInvocation(value: unknown): DesktopToolInvocation {
	const input = object(value);
	if (Object.keys(input).some((key) => !["tool", "toolCallId", "input", "batch"].includes(key)) ||
		!desktopModelToolNames.includes(input.tool as DesktopModelToolName)) throw new Error("Invalid desktop tool");
	const tool = input.tool as DesktopModelToolName;
	let batch: ToolCallBatch | undefined;
	if (input.batch !== undefined) {
		const value = object(input.batch);
		if (!batchedToolNames.includes(tool) || Object.keys(value).some((key) => key !== "writers") ||
			!Number.isSafeInteger(value.writers) || (value.writers as number) < 0 || (value.writers as number) > 10000) throw new Error("Invalid tool call batch");
		batch = { writers: value.writers as number };
	}
	return { tool, toolCallId: text(input.toolCallId, "toolCallId", 300), input: validateDesktopToolInput(tool, input.input), ...(batch ? { batch } : {}) };
}

export function validateToolOverrides(value: unknown): ToolOverrides {
	const input = object(value);
	if (Object.keys(input).some((key) => key !== "overrides")) throw new Error("Invalid tool configuration");
	const overrides = object(input.overrides);
	if (Object.keys(overrides).length > 10000) throw new Error("Too many tool overrides");
	for (const [name, enabled] of Object.entries(overrides)) {
		if (!name || name.length > 300 || name.includes("\0") || typeof enabled !== "boolean" ||
			["__proto__", "constructor", "prototype"].includes(name)) throw new Error("Invalid tool override");
	}
	return { overrides: { ...overrides } as Record<string, boolean> };
}

const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Validate a tool usage block before Pi adds it to the parent session's statistics. */
export function validToolUsage(value: unknown): ToolUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost as Record<string, unknown> | undefined;
	if (!usageKeys.every((key) => count(usage[key])) || !cost || typeof cost !== "object" || !costKeys.every((key) => count(cost[key])))
		return undefined;
	return {
		input: usage.input as number, output: usage.output as number, cacheRead: usage.cacheRead as number,
		cacheWrite: usage.cacheWrite as number, totalTokens: usage.totalTokens as number,
		cost: { input: cost.input as number, output: cost.output as number, cacheRead: cost.cacheRead as number, cacheWrite: cost.cacheWrite as number, total: cost.total as number },
	};
}

/** A host response shaped as a model-facing tool result instead of raw JSON data. */
export function asModelToolResult(value: unknown): ModelToolResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result = value as Record<string, unknown>;
	if (result.kind !== "desktop_tool_result" || typeof result.text !== "string") return undefined;
	const usage = result.usage === undefined ? undefined : validToolUsage(result.usage);
	return { kind: "desktop_tool_result", text: result.text, details: result.details ?? null, ...(usage ? { usage } : {}) };
}
