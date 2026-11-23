import type { DesktopEvent, Message } from "../shared.ts";
import type { ToolProgress } from "./messages.ts";
import { isVerifyCommand } from "./quality-verdict.ts";

export type RunPhase = "running" | "editing" | "testing" | "approval" | "retrying" | "compacting" | "completed" | "failed" | "stopped";
export const runLabels: Record<RunPhase, string> = {
	running: "运行中",
	editing: "正在编辑",
	testing: "正在检查",
	approval: "待确认",
	retrying: "正在重试",
	compacting: "正在压缩上下文",
	completed: "已结束",
	failed: "失败",
	stopped: "已停止",
};

export function toolPhase(name: string, args: unknown): "editing" | "testing" | "running" {
	if (/^(?:edit|write|multiedit|notebookedit)$/i.test(name)) return "editing";
	const command = (args as { command?: unknown } | null)?.command;
	if (name.toLowerCase() === "bash" && typeof command === "string" && isVerifyCommand(command)) return "testing";
	return "running";
}

export function phaseFromSnapshot(messages: Message[], tools: Record<string, ToolProgress>, running: boolean): RunPhase | undefined {
	if (running) {
		const current = Object.values(tools).findLast((tool) => tool.status === "running");
		return current ? toolPhase(current.name, current.args) : "running";
	}
	const last = messages.findLast((message) => message.role === "assistant");
	if (last?.stopReason === "error") return "failed";
	if (last?.stopReason === "aborted") return "stopped";
	if (last?.stopReason === "stop") return "completed";
}

export function phaseFromEvent(previous: RunPhase | undefined, event: DesktopEvent["event"]): RunPhase | undefined {
	switch (event.type) {
		case "extension_ui_request":
			return ["confirm", "select", "input", "editor"].includes(event.method) ? "approval" : previous;
		case "agent_start": return "running";
		case "auto_retry_start": return "retrying";
		case "auto_retry_end": return event.success ? "running" : "failed";
		case "compaction_start": return "compacting";
		case "compaction_end": return event.errorMessage ? "failed" : event.willRetry ? "running" : "completed";
		case "tool_execution_start": return toolPhase(event.toolName, event.args);
		case "tool_execution_end": return "running";
		case "message_end": return event.message.role === "assistant" && event.message.stopReason === "error" ? "failed" : previous;
		case "desktop_error": return "failed";
		case "agent_settled": return event.aborted ? "stopped" : previous === "failed" ? "failed" : "completed";
		default: return previous;
	}
}
