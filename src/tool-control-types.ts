import type { ToolExposure } from "@earendil-works/pi-coding-agent";

export const desktopModelToolNames = [
	"Agent", "AgentSend", "AgentExecutors", "TaskOutput", "TaskStop", "TaskList",
	"WorktreeCreate", "WorktreeList", "WorktreeMerge", "WorktreeRemove",
] as const;
export type DesktopModelToolName = (typeof desktopModelToolNames)[number];

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
export type ToolControlRequest =
	| { requestId: string; operation: "list" | "apply" }
	| { requestId: string; operation: "notify"; result: unknown };
export type ToolControlResponse =
	| { requestId: string; ok: true; tools: DesktopToolInfo[] }
	| { requestId: string; ok: false; error: string };

export interface AgentToolInput {
	executor?: "pi" | "codex" | "claude" | "kimi";
	description: string;
	prompt: string;
	subagent_type: "Explore" | "Plan" | "general-purpose";
	run_in_background?: boolean;
	isolation?: "worktree" | "shared";
	worktree_id?: string;
}
export interface TaskOutputToolInput { task_id: string; block?: boolean; timeout?: number }
export interface TaskStopToolInput { task_id: string }
export interface WorktreeCreateToolInput { base_ref?: string }
export interface WorktreeTargetToolInput { worktree_id: string }

export interface DesktopToolInvocation {
	tool: DesktopModelToolName;
	toolCallId: string;
	input: Record<string, unknown>;
}
export interface ToolHostContext {
	conversationId: string;
	toolCallId: string;
	signal: AbortSignal;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object");
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
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
		Agent: ["description", "prompt", "subagent_type", "run_in_background", "isolation", "worktree_id", "executor"],
		AgentSend: ["task_id", "message", "run_in_background"], AgentExecutors: [],
		TaskOutput: ["task_id", "block", "timeout"], TaskStop: ["task_id"], TaskList: [],
		WorktreeCreate: ["base_ref"], WorktreeList: [], WorktreeMerge: ["worktree_id"], WorktreeRemove: ["worktree_id"],
	};
	if (Object.keys(input).some((key) => !allowed[tool].includes(key))) throw new Error("Unknown tool input field");
	if (tool === "Agent") {
		text(input.description, "description", 160);
		text(input.prompt, "prompt", 2 * 1024 * 1024);
		if (typeof input.subagent_type !== "string" || !["Explore", "Plan", "general-purpose"].includes(input.subagent_type)) throw new Error("Invalid subagent_type");
		if (input.executor !== undefined && (typeof input.executor !== "string" || !["pi", "codex", "claude", "kimi"].includes(input.executor))) throw new Error("Invalid executor");
		optionalBoolean(input.run_in_background, "run_in_background");
		if (input.isolation !== undefined && input.isolation !== "worktree" && input.isolation !== "shared")
			throw new Error("Invalid isolation");
		if (input.worktree_id !== undefined) text(input.worktree_id, "worktree_id", 200);
	} else if (tool === "AgentSend") {
		text(input.task_id, "task_id", 200); text(input.message, "message", 2 * 1024 * 1024); optionalBoolean(input.run_in_background, "run_in_background");
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
	if (Object.keys(input).some((key) => !["tool", "toolCallId", "input"].includes(key)) ||
		!desktopModelToolNames.includes(input.tool as DesktopModelToolName)) throw new Error("Invalid desktop tool");
	const tool = input.tool as DesktopModelToolName;
	return { tool, toolCallId: text(input.toolCallId, "toolCallId", 300), input: validateDesktopToolInput(tool, input.input) };
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
