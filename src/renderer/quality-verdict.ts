import type { Message } from "../shared.ts";

/** Summarize recorded checks without promoting older results to the current code state. */
export type QualityOmen =
	/** Code changed, a recognized verify command exited 0, and nothing errored. */
	| "verified"
	/** A tool/model error, a nonzero verify exit, or an aborted turn. */
	| "problem"
	/** Code changed but no verification ran — honest "unproven", never a pass. */
	| "unverified"
	/** No code was produced (conversation-only turn): no omen is shown. */
	| "none";

export interface VerificationCheck {
	id: string;
	command: string;
	exitCode?: number;
	status: "passed" | "failed" | "pending" | "stale";
}

export interface QualityVerdict {
	checks: VerificationCheck[];
	omen: QualityOmen;
	/** Short Chinese label for the badge/reveal. */
	label: string;
	/** One-line reason, surfaced on hover. */
	reason: string;
	/** Signals that fed the verdict, for the detail tooltip. */
	signals: {
		edited: boolean;
		verifyRan: boolean;
		verifyPassed: boolean;
		toolErrors: number;
		modelError: boolean;
		aborted: boolean;
	};
}

type Assistant = Extract<Message, { role: "assistant" }>;
type ToolResult = Extract<Message, { role: "toolResult" }>;
type BashExecution = Extract<Message, { role: "bashExecution" }>;

/**
 * Tools that write code to disk. Pi registers its built-in tools in lower case
 * (`edit`, `write`, `bash`), so names are compared case-insensitively.
 */
const EDIT_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit"]);

function toolName(call: { name: string }): string {
	return call.name.toLowerCase();
}

const VERIFY_COMMAND = /^(?:(?:npx(?:\s+--yes)?|uv\s+run|bundle\s+exec|pnpm\s+exec|bunx)\s+)?(?:vitest|jest|mocha|ava|pytest|tsc|tsd|biome|eslint|prettier|ruff|mypy|cargo\s+(?:test|check|clippy)|go\s+test|rspec|phpunit|ctest)\b/i;
const SCRIPT_VERIFY_COMMAND = /^(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:tests?|check|typecheck|type-check|lint|build|ci)(?:[:_-][\w:-]+)?(?:\s|$)/i;
const RUNNER_VERIFY_COMMAND = /^(?:node\s+(?:[^\n]*?\s)?--test\b|python3?\s+-m\s+(?:pytest|unittest)\b)/i;
const SHELL_CONTROL = /[\n;&|<>`]|\$\(/;
const MUTATING_CHECK_OPTIONS = /(?:^|\s)--(?:fix|fix-only|write|apply|update-snapshots?)(?:[=\s]|$)/i;
const READ_ONLY_COMMAND = /^(?:pwd|ls|cat|head|tail|wc|rg|grep|git\s+(?:status|diff|log|show|ls-files|rev-parse))\b/;

export function isVerifyCommand(command: string): boolean {
	const text = command.trim();
	// A compound shell line may contain a check that never runs, or mutate files after it.
	return !SHELL_CONTROL.test(text) && !MUTATING_CHECK_OPTIONS.test(text) &&
		(VERIFY_COMMAND.test(text) || SCRIPT_VERIFY_COMMAND.test(text) || RUNNER_VERIFY_COMMAND.test(text));
}

function mayEditWithShell(command: string): boolean {
	return SHELL_CONTROL.test(command) || !READ_ONLY_COMMAND.test(command.trim());
}

const USER_DENIAL_TEXT = "用户未批准此操作。";

function isUserDenial(result: ToolResult): boolean {
	const content = (result as { content?: unknown }).content;
	if (typeof content === "string") return content.trim() === USER_DENIAL_TEXT;
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && String((part as { text?: unknown }).text ?? "").trim() === USER_DENIAL_TEXT,
	);
}

/** A Bash tool call's command string, from its finalized arguments. */
function bashCommandOf(call: Extract<Assistant["content"][number], { type: "toolCall" }>): string | null {
	if (toolName(call) !== "bash") return null;
	const args = call.arguments as { command?: unknown };
	return typeof args.command === "string" ? args.command : null;
}

export function scoreTurn(turnMessages: Message[]): QualityVerdict {
	let editVersion = 0;
	let toolErrors = 0;
	let modelError = false;
	let aborted = false;
	let edited = false;
	let latestWriteEnd = -Infinity;
	const writes = new Set<string>();
	const runningChecks = new Map<string, { check: VerificationCheck; version: number; startedAt?: number }>();
	for (const message of turnMessages) {
		switch (message.role) {
			case "assistant":
				modelError ||= message.stopReason === "error";
				aborted ||= message.stopReason === "aborted";
				for (const call of message.content) {
					if (call.type !== "toolCall") continue;
					const command = bashCommandOf(call);
					if (command && isVerifyCommand(command)) {
						runningChecks.set(call.id, { check: { id: call.id, command, status: "pending" }, version: editVersion });
					} else if (EDIT_TOOLS.has(toolName(call)) || (command && mayEditWithShell(command))) {
						editVersion++;
						writes.add(call.id);
						edited ||= EDIT_TOOLS.has(toolName(call));
					}
				}
				break;
			case "toolResult": {
				if (message.isError && !isUserDenial(message)) toolErrors++;
				if (writes.has(message.toolCallId) && !isUserDenial(message)) latestWriteEnd = Math.max(latestWriteEnd, message.timestamp);
				const entry = runningChecks.get(message.toolCallId);
				if (entry) {
					entry.startedAt = message.timestamp - (message.durationMs ?? 0);
					const details = message.details as { exitCode?: unknown } | undefined;
					const exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;
					entry.check.exitCode = exitCode;
					entry.check.status = message.isError || (exitCode !== undefined && exitCode !== 0) ? "failed" : "passed";
				}
				break;
			}
			case "bashExecution": {
				if (!isVerifyCommand(message.command)) {
					if (mayEditWithShell(message.command)) editVersion++;
					break;
				}
				const id = `shell-${message.timestamp}-${runningChecks.size}`;
				const status = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0)
					? "failed" : message.exitCode === 0 ? "passed" : "pending";
				runningChecks.set(id, { check: { id, command: message.command, exitCode: message.exitCode ?? undefined, status }, version: editVersion });
				break;
			}
		}
	}
	const checks = [...runningChecks.values()].map(({ check, version, startedAt }) =>
		check.status === "passed" && (version !== editVersion || (startedAt !== undefined && latestWriteEnd > startedAt))
			? { ...check, status: "stale" as const } : check,
	);
	const verifyPassed = checks.some((check) => check.status === "passed");
	const signals = { edited, verifyRan: checks.length > 0, verifyPassed, toolErrors, modelError, aborted };
	const result = (omen: QualityOmen, label: string, reason: string): QualityVerdict => ({ omen, label, reason, signals, checks });
	if (aborted) return result("none", "", "本次回复已停止");
	if (modelError) return result("problem", "有报错", "模型返回错误");
	if (toolErrors || checks.some((check) => check.status === "failed"))
		return result("problem", "有检查未通过", "展开查看失败命令和工具记录");
	if (!signals.edited) return result("none", "", "本轮无代码改动");
	if (verifyPassed && !checks.some((check) => check.status === "pending"))
		return result("verified", "检查通过", "这些检查在本轮最后一次编辑后完成");
	if (checks.some((check) => check.status === "stale"))
		return result("unverified", "改动后待验证", "最近的成功检查早于本轮最后一次编辑");
	return result("unverified", "未验证", "本轮改动尚无完成的检查");
}
