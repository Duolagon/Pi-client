import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import { AGENT_CALL_NAME_PATTERN, MAX_AGENT_PROMPT, MAX_SEND_MESSAGE, MAX_SEND_SUMMARY, MAX_SEND_TARGET, exceedsLength } from "./delegation-limits.ts";
import type { ModelToolResult, ToolUsage } from "./delegation-types.ts";
import { MAX_BACKGROUND_SHELL_TIMEOUT_SECONDS } from "./monitor-types.ts";
import { todoStatuses } from "./todo-types.ts";
import { teamMessageTypes } from "./team-types.ts";
import { validateAgentScopePaths } from "./agent-read-scope.ts";

/** Values accepted by the Agent tool's `model` parameter. */
export const agentModelValues = ["sonnet", "opus", "haiku", "fable", "inherit"] as const;
/** `remote` is accepted by the schema only so the host can explain that it is unsupported. */
export const agentIsolationValues = ["worktree", "shared", "remote"] as const;
export const kaggleComputerUseActions = ["inspect", "run_all"] as const;
export type KaggleComputerUseAction = (typeof kaggleComputerUseActions)[number];

export const desktopModelToolNames = [
	"Agent", "SendMessage", "AgentSend", "AgentExecutors", "TaskOutput", "TaskStop", "TaskList",
	"WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove",
	"TodoCreate", "TodoGet", "TodoUpdate", "TodoList",
	"Monitor", "BashOutput", "KillShell",
	"ScheduleWakeup", "CronCreate", "CronList", "CronDelete",
	"TeamCreate", "TeamDelete",
	"WorkflowRun", "StructuredOutput", "LSP", "PreviewCheck", "KaggleComputerUse", "ToolSearch",
] as const;
export type DesktopModelToolName = (typeof desktopModelToolNames)[number];

/**
 * Specialist desktop tools whose full JSON schemas are omitted from initial model requests
 * to reduce declaration size. Enabled specialists remain executable and can be loaded via `ToolSearch`.
 */
export const deferredSpecialistTools = [
	"AgentExecutors",
	"WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove",
	"Monitor",
	"ScheduleWakeup", "CronCreate", "CronList", "CronDelete",
	"WorkflowRun",
	"PreviewCheck",
	"KaggleComputerUse",
] as const satisfies readonly DesktopModelToolName[];
/**
 * Host calls that are not separate model tools. `BashBackground` is the `bash` tool's
 * `run_in_background: true` path; Pi has already run the bash permission checks for it.
 */
export const hostOnlyToolNames = ["BashBackground"] as const;
export type HostToolName = DesktopModelToolName | (typeof hostOnlyToolNames)[number];
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
	/** Enabled for discovery but its declaration is currently omitted. */
	deferred?: true;
	/** Explicit desktop setting; absent when the existing Pi configuration governs the tool. */
	override?: boolean;
}

export interface ToolOverrides { overrides: Record<string, boolean> }
/**
 * `followUp` + `triggerTurn` is the native delivery to a live parent. `nextTurn` with
 * `triggerTurn: false` queues a result for the parent's next run without waking it.
 */
export type NotificationDelivery = "followUp" | "nextTurn";
/** Allowlisted custom message types accepted by the generalized delivery control channel. */
export const DELIVER_CUSTOM_TYPES = [
	"desktop_task_notification",
	"desktop_monitor_event",
	"desktop_cron_wakeup",
	"desktop_team_message",
	"desktop_workflow_event",
	"desktop_shell_event",
] as const;
export type DeliverCustomType = (typeof DELIVER_CUSTOM_TYPES)[number];
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
	| {
		requestId: string;
		operation: "deliver";
		customType: DeliverCustomType;
		/** Optional idempotency key (`<id>:<seq>`); required if `usage` is attached. */
		key?: string;
		content: string;
		details: Record<string, unknown>;
		deliverAs: NotificationDelivery;
		triggerTurn: boolean;
		display?: boolean;
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
	if (request.operation !== "notify" && request.operation !== "deliver") throw new Error("Invalid tool control request");
	const isDeliver = request.operation === "deliver";
	only(
		isDeliver
			? ["requestId", "operation", "customType", "key", "content", "details", "deliverAs", "triggerTurn", "display", "usage"]
			: ["requestId", "operation", "key", "content", "details", "deliverAs", "triggerTurn", "usage"],
	);
	let customType: DeliverCustomType = "desktop_task_notification";
	if (isDeliver) {
		if (typeof request.customType !== "string" || !DELIVER_CUSTOM_TYPES.includes(request.customType as DeliverCustomType))
			throw new Error("Invalid delivery customType");
		customType = request.customType as DeliverCustomType;
	}
	let key: string | undefined;
	if (!isDeliver || request.key !== undefined) {
		if (typeof request.key !== "string" || !NOTIFICATION_KEY_PATTERN.test(request.key)) throw new Error("Invalid background task result");
		key = request.key;
	}
	if (typeof request.content !== "string" || !request.content.trim() || request.content.includes("\0") ||
		Buffer.byteLength(request.content, "utf8") > maxBytes) throw new Error("Invalid background task result");
	const details = object(request.details);
	if (Buffer.byteLength(JSON.stringify(details), "utf8") > maxBytes) throw new Error("Invalid background task result");
	if (request.deliverAs !== "followUp" && request.deliverAs !== "nextTurn") throw new Error("Invalid background task result");
	if (typeof request.triggerTurn !== "boolean" || (request.deliverAs === "nextTurn" && request.triggerTurn)) throw new Error("Invalid background task result");
	if (isDeliver && request.display !== undefined && typeof request.display !== "boolean") throw new Error("Invalid delivery display flag");
	let usage: NotificationUsage | undefined;
	if (request.usage !== undefined) {
		if (!key) throw new Error("Delivery with usage requires a key");
		const value = object(request.usage);
		const label = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 200 && !/[\0\r\n]/.test(item);
		const counted = validToolUsage(value.usage);
		if (Object.keys(value).some((k) => !["provider", "model", "usage"].includes(k)) || !label(value.provider) || !label(value.model) || !counted)
			throw new Error("Invalid background task result");
		usage = { provider: value.provider as string, model: value.model as string, usage: counted };
	}
	if (isDeliver) {
		return {
			requestId,
			operation: "deliver",
			customType,
			...(key ? { key } : {}),
			content: request.content,
			details,
			deliverAs: request.deliverAs,
			triggerTurn: request.triggerTurn,
			...(typeof request.display === "boolean" ? { display: request.display } : {}),
			...(usage ? { usage } : {}),
		};
	}
	return {
		requestId, operation: "notify", key: key!, content: request.content, details, deliverAs: request.deliverAs, triggerTurn: request.triggerTurn,
		...(usage ? { usage } : {}),
	};
}

export interface AgentToolInput {
	executor?: "pi" | "codex" | "claude" | "kimi" | "antigravity";
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
	tool: HostToolName;
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
export function validateDesktopToolInput(tool: HostToolName, value: unknown): Record<string, unknown> {
	const input = object(value);
	const allowed: Record<HostToolName, string[]> = {
		// `mode` and `team_name` are the only leniently accepted fields; they are ignored.
		Agent: ["description", "prompt", "subagent_type", "model", "run_in_background", "name", "isolation", "worktree_id", "executor", "fork", "mode", "team_name", "scope_paths"],
		SendMessage: ["to", "message", "summary", "run_in_background", "message_type", "request_id", "approve"],
		AgentSend: ["task_id", "message", "run_in_background"], AgentExecutors: [],
		TaskOutput: ["task_id", "block", "timeout"], TaskStop: ["task_id"], TaskList: [],
		WorktreeCreate: ["base_ref"], WorktreeList: [], WorktreeMerge: ["worktree_id"], WorktreeRemove: ["worktree_id"],
		TodoCreate: ["subject", "description", "activeForm", "owner", "blocks", "blockedBy", "metadata", "estimatedSeconds"],
		TodoGet: ["id"],
		TodoUpdate: ["id", "subject", "description", "status", "activeForm", "owner", "addBlocks", "addBlockedBy", "metadata", "estimatedSeconds"],
		TodoList: ["include_completed"],
		Monitor: ["description", "command", "url", "timeout_ms", "persistent"],
		BashOutput: ["bash_id", "filter", "cursor"],
		KillShell: ["shell_id"],
		BashBackground: ["command", "description", "timeout"],
		ScheduleWakeup: ["delay_seconds", "reason", "prompt"],
		CronCreate: ["prompt", "cron", "interval_seconds", "recurring", "durable"],
		CronList: [],
		CronDelete: ["id"],
		TeamCreate: ["team_name", "description"],
		TeamDelete: ["team_name"],
		WorkflowRun: ["title", "script", "budget", "run_in_background"],
		StructuredOutput: ["data"],
		LSP: ["operation", "filePath", "line", "character", "silent"],
		PreviewCheck: ["action", "name", "server_id", "url", "mobile", "actions", "selector", "read_dom", "screenshot", "wait_ms"],
		KaggleComputerUse: ["action"],
		ToolSearch: ["query", "max_results"],
	};
	if (Object.keys(input).some((key) => !allowed[tool].includes(key))) throw new Error("Unknown tool input field");
	if (tool === "Agent") {
		text(input.description, "description", 160);
		text(input.prompt, "prompt", MAX_AGENT_PROMPT);
		if (input.subagent_type !== undefined && (typeof input.subagent_type !== "string" || !input.subagent_type.trim() || exceedsLength(input.subagent_type, 100)))
			throw new Error("Invalid subagent_type");
		if (input.executor !== undefined && (typeof input.executor !== "string" || !["pi", "codex", "claude", "kimi", "antigravity"].includes(input.executor))) throw new Error("Invalid executor");
		if (input.model !== undefined && !agentModelValues.includes(input.model as never)) throw new Error("Invalid model (expected sonnet, opus, haiku, fable or inherit)");
		if (input.name !== undefined && (typeof input.name !== "string" || !AGENT_CALL_NAME_PATTERN.test(input.name))) throw new Error("Invalid name");
		optionalBoolean(input.run_in_background, "run_in_background");
		optionalBoolean(input.fork, "fork");
		if (input.isolation !== undefined && !agentIsolationValues.includes(input.isolation as never))
			throw new Error("Invalid isolation");
		if (input.mode !== undefined) text(input.mode, "mode", 100);
		if (input.team_name !== undefined) text(input.team_name, "team_name", 200);
		if (input.worktree_id !== undefined) text(input.worktree_id, "worktree_id", 200);
		if (input.scope_paths !== undefined) validateAgentScopePaths(input.scope_paths);
	} else if (tool === "SendMessage") {
		text(input.to, "to", MAX_SEND_TARGET); text(input.message, "message", MAX_SEND_MESSAGE);
		if (input.summary !== undefined) text(input.summary, "summary", MAX_SEND_SUMMARY);
		optionalBoolean(input.run_in_background, "run_in_background");
		if (input.message_type !== undefined && (typeof input.message_type !== "string" || !teamMessageTypes.includes(input.message_type as never))) {
			throw new Error("Invalid message_type");
		}
		if (input.request_id !== undefined) text(input.request_id, "request_id", 128);
		optionalBoolean(input.approve, "approve");
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
	} else if (tool === "TodoCreate") {
		text(input.subject, "subject", 500);
		text(input.description, "description", 16000);
		if (input.activeForm !== undefined) text(input.activeForm, "activeForm", 500);
		if (input.owner !== undefined) text(input.owner, "owner", 128);
		for (const field of ["blocks", "blockedBy"] as const) {
			if (input[field] !== undefined) {
				if (!Array.isArray(input[field]) || (input[field] as unknown[]).length > 100 ||
					(input[field] as unknown[]).some((item) => typeof item !== "string" || !item.trim() || item.length > 64))
					throw new Error(`Invalid ${field}`);
			}
		}
		if (input.metadata !== undefined) object(input.metadata);
		if (input.estimatedSeconds !== undefined && (typeof input.estimatedSeconds !== "number" || !Number.isFinite(input.estimatedSeconds) || input.estimatedSeconds < 1 || input.estimatedSeconds > 604_800))
			throw new Error("Invalid estimatedSeconds (expected 1–604800 seconds)");
	} else if (tool === "TodoGet") {
		text(input.id, "id", 64);
	} else if (tool === "TodoUpdate") {
		text(input.id, "id", 64);
		if (input.subject !== undefined) text(input.subject, "subject", 500);
		if (input.description !== undefined) text(input.description, "description", 16000);
		if (input.status !== undefined && (typeof input.status !== "string" || !todoStatuses.includes(input.status as never)))
			throw new Error("Invalid todo status");
		if (input.activeForm !== undefined) text(input.activeForm, "activeForm", 500);
		if (input.owner !== undefined) text(input.owner, "owner", 128);
		for (const field of ["addBlocks", "addBlockedBy"] as const) {
			if (input[field] !== undefined) {
				if (!Array.isArray(input[field]) || (input[field] as unknown[]).length > 100 ||
					(input[field] as unknown[]).some((item) => typeof item !== "string" || !item.trim() || item.length > 64))
					throw new Error(`Invalid ${field}`);
			}
		}
		if (input.metadata !== undefined) object(input.metadata);
		if (input.estimatedSeconds !== undefined && (typeof input.estimatedSeconds !== "number" || !Number.isFinite(input.estimatedSeconds) || input.estimatedSeconds < 1 || input.estimatedSeconds > 604_800))
			throw new Error("Invalid estimatedSeconds (expected 1–604800 seconds)");
	} else if (tool === "TodoList") {
		optionalBoolean(input.include_completed, "include_completed");
	} else if (tool === "Monitor") {
		if (input.description !== undefined) text(input.description, "description", 160);
		if (input.command !== undefined) text(input.command, "command", 16384);
		if (input.url !== undefined) text(input.url, "url", 2048);
		if ((input.command !== undefined) === (input.url !== undefined)) {
			throw new Error("Monitor requires exactly one of 'command' or 'url'");
		}
		if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || Number(input.timeout_ms) < 1000 || Number(input.timeout_ms) > 86_400_000)) {
			throw new Error("Invalid timeout_ms (expected 1000–86400000 ms)");
		}
		optionalBoolean(input.persistent, "persistent");
	} else if (tool === "BashOutput") {
		text(input.bash_id, "bash_id", 200);
		if (input.filter !== undefined) text(input.filter, "filter", 1000);
		if (input.cursor !== undefined && (typeof input.cursor !== "number" || !Number.isSafeInteger(input.cursor) || input.cursor < 0))
			throw new Error("Invalid BashOutput cursor");
	} else if (tool === "KillShell") {
		text(input.shell_id, "shell_id", 200);
	} else if (tool === "BashBackground") {
		text(input.command, "command", 64 * 1024);
		if (input.description !== undefined) text(input.description, "description", 160);
		if (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > MAX_BACKGROUND_SHELL_TIMEOUT_SECONDS)) {
			throw new Error(`Background Bash timeout must be greater than 0 and at most ${MAX_BACKGROUND_SHELL_TIMEOUT_SECONDS} seconds`);
		}
	} else if (tool === "ScheduleWakeup") {
		if (typeof input.delay_seconds !== "number" || !Number.isSafeInteger(input.delay_seconds) || input.delay_seconds < 1 || input.delay_seconds > 604800) {
			throw new Error("Invalid delay_seconds (expected 1–604800)");
		}
		text(input.reason, "reason", 2000);
		if (input.prompt !== undefined) text(input.prompt, "prompt", 16000);
	} else if (tool === "CronCreate") {
		text(input.prompt, "prompt", 16000);
		if (input.cron !== undefined) text(input.cron, "cron", 200);
		if (input.interval_seconds !== undefined && (typeof input.interval_seconds !== "number" || !Number.isSafeInteger(input.interval_seconds) || input.interval_seconds < 10 || input.interval_seconds > 604800)) {
			throw new Error("Invalid interval_seconds (expected 10–604800)");
		}
		if ((input.cron !== undefined) === (input.interval_seconds !== undefined)) {
			throw new Error("CronCreate requires exactly one of 'cron' or 'interval_seconds'");
		}
		optionalBoolean(input.recurring, "recurring");
		optionalBoolean(input.durable, "durable");
	} else if (tool === "CronDelete") {
		text(input.id, "id", 80);
	} else if (tool === "TeamCreate") {
		text(input.team_name, "team_name", 64);
		if (input.description !== undefined) text(input.description, "description", 500);
	} else if (tool === "TeamDelete") {
		if (input.team_name !== undefined) text(input.team_name, "team_name", 64);
	} else if (tool === "WorkflowRun") {
		if (input.title !== undefined) text(input.title, "title", 160);
		text(input.script, "script", 256 * 1024);
		optionalBoolean(input.run_in_background, "run_in_background");
		if (input.budget !== undefined) {
			const b = object(input.budget);
			if (Object.keys(b).some((k) => !["maxCost", "maxTokens", "maxAgents"].includes(k))) {
				throw new Error("Invalid workflow budget field");
			}
		}
	} else if (tool === "StructuredOutput") {
		if (!("data" in input)) throw new Error("StructuredOutput requires 'data'");
	} else if (tool === "LSP") {
		const validOps = ["diagnostics", "documentSymbol", "goToDefinition", "inspect", "workspaceOutline"];
		if (typeof input.operation !== "string" || !validOps.includes(input.operation)) {
			throw new Error("LSP operation must be diagnostics, documentSymbol, goToDefinition, inspect, or workspaceOutline");
		}
		text(input.filePath, "filePath", 4096);
		if (input.line !== undefined && (!Number.isSafeInteger(input.line) || Number(input.line) < 1)) {
			throw new Error("LSP line must be a positive integer");
		}
		if (input.character !== undefined && (!Number.isSafeInteger(input.character) || Number(input.character) < 1)) {
			throw new Error("LSP character must be a positive integer");
		}
		optionalBoolean(input.silent, "silent");
	} else if (tool === "KaggleComputerUse") {
		if (input.action !== "inspect" && input.action !== "run_all")
			throw new Error("KaggleComputerUse action must be inspect or run_all");
	} else if (tool === "ToolSearch") {
		text(input.query, "query", 500);
		if (input.max_results !== undefined && (!Number.isSafeInteger(input.max_results) || Number(input.max_results) < 1 || Number(input.max_results) > 30)) {
			throw new Error("ToolSearch max_results must be an integer between 1 and 30");
		}
	} else if (tool === "PreviewCheck") {
		const validActions = ["list_configs", "start_server", "stop_server", "server_logs", "check"];
		if (input.action !== undefined && (typeof input.action !== "string" || !validActions.includes(input.action))) {
			throw new Error("PreviewCheck action must be list_configs, start_server, stop_server, server_logs, or check");
		}
		if (input.name !== undefined) text(input.name, "name", 100);
		if (input.server_id !== undefined) text(input.server_id, "server_id", 200);
		if (input.url !== undefined) text(input.url, "url", 4096);
		optionalBoolean(input.mobile, "mobile");
		optionalBoolean(input.read_dom, "read_dom");
		optionalBoolean(input.screenshot, "screenshot");
		if (input.selector !== undefined) text(input.selector, "selector", 500);
		if (input.wait_ms !== undefined && (!Number.isSafeInteger(input.wait_ms) || Number(input.wait_ms) < 500 || Number(input.wait_ms) > 60000)) {
			throw new Error("PreviewCheck wait_ms must be between 500 and 60000");
		}
		if (input.actions !== undefined) {
			if (!Array.isArray(input.actions) || input.actions.length > 20) {
				throw new Error("PreviewCheck actions must be an array of at most 20 steps");
			}
			for (const step of input.actions) {
				const rec = object(step);
				const kind = rec.type;
				if (kind === "click") {
					text(rec.selector, "actions[].selector", 500);
				} else if (kind === "fill") {
					text(rec.selector, "actions[].selector", 500);
					if (typeof rec.value !== "string" || rec.value.length > 4096 || rec.value.includes("\0")) {
						throw new Error("Invalid actions[].value");
					}
				} else if (kind === "wait") {
					if (typeof rec.ms !== "number" || !Number.isFinite(rec.ms) || rec.ms < 50 || rec.ms > 5000) {
						throw new Error("Invalid actions[].ms (expected 50–5000)");
					}
				} else if (kind === "wait_for") {
					text(rec.selector, "actions[].selector", 500);
					if (rec.timeoutMs !== undefined && (typeof rec.timeoutMs !== "number" || !Number.isFinite(rec.timeoutMs) || rec.timeoutMs < 200 || rec.timeoutMs > 5000)) {
						throw new Error("Invalid actions[].timeoutMs (expected 200–5000)");
					}
				} else if (kind === "scroll") {
					if (rec.selector !== undefined) text(rec.selector, "actions[].selector", 500);
					if (rec.y !== undefined && (typeof rec.y !== "number" || !Number.isFinite(rec.y))) {
						throw new Error("Invalid actions[].y");
					}
				} else {
					throw new Error("PreviewCheck action step type must be click, fill, wait, wait_for, or scroll");
				}
			}
		}
	}
	return { ...input };
}

export function validateToolInvocation(value: unknown): DesktopToolInvocation {
	const input = object(value);
	if (Object.keys(input).some((key) => !["tool", "toolCallId", "input", "batch"].includes(key)) ||
		(!desktopModelToolNames.includes(input.tool as DesktopModelToolName) && !hostOnlyToolNames.includes(input.tool as never))) throw new Error("Invalid desktop tool");
	const tool = input.tool as HostToolName;
	let batch: ToolCallBatch | undefined;
	if (input.batch !== undefined) {
		const value = object(input.batch);
		if (!batchedToolNames.includes(tool as DesktopModelToolName) || Object.keys(value).some((key) => key !== "writers") ||
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
