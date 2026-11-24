import type { Message, MonitorRecord } from "../shared.ts";

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
	shellId?: string;
	status: "passed" | "failed" | "pending" | "stale" | "stopped" | "timed_out";
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

interface BackgroundCheckExit {
	status: "exited" | "error" | "stopped" | "timed_out";
	exitCode?: number;
	startedAt?: number;
	finishedAt: number;
}

interface VerificationEvidence {
	shellExits: ReadonlyMap<string, BackgroundCheckExit>;
	writeTimes: readonly number[];
}

/** Background checks may finish in a later turn, so index terminal events across the conversation. */
export function collectVerificationEvidence(messages: readonly Message[], monitors: readonly MonitorRecord[] = []): VerificationEvidence {
	const shellExits = new Map<string, BackgroundCheckExit>();
	const writeTimes: number[] = [];
	for (const message of messages) {
		if (message.role === "custom" && message.customType === "desktop_shell_event") {
			const details = message.details as {
				terminal?: unknown; shell_id?: unknown; status?: unknown; exit_code?: unknown; reason?: unknown;
				started_at?: unknown; finished_at?: unknown;
			} | undefined;
			if (details?.terminal !== true || typeof details.shell_id !== "string") continue;
			const status = details.reason === "timed_out" ? "timed_out"
				: details.status === "killed" ? "stopped"
				: details.status === "failed" ? "error"
				: details.status === "completed" ? "exited" : undefined;
			if (status) shellExits.set(details.shell_id, {
				status,
				exitCode: exitCodeOf(details.exit_code),
				startedAt: typeof details.started_at === "number" ? details.started_at : undefined,
				finishedAt: typeof details.finished_at === "number" ? details.finished_at : message.timestamp,
			});
		} else if (
			(message.role === "assistant" && message.content.some((call) => {
				if (call.type !== "toolCall") return false;
				const command = bashCommandOf(call);
				return EDIT_TOOLS.has(toolName(call)) || (command !== null && !isVerifyCommand(command) && mayEditWithShell(command));
			})) || (message.role === "bashExecution" && !isVerifyCommand(message.command) && mayEditWithShell(message.command))
		) {
			writeTimes.push(message.timestamp);
		}
	}
	for (const monitor of monitors) {
		if (monitor.kind !== "shell" || monitor.status === "running") continue;
		shellExits.set(monitor.id, {
			status: monitor.status,
			exitCode: exitCodeOf(monitor.exitCode),
			startedAt: monitor.createdAt,
			finishedAt: monitor.updatedAt,
		});
	}
	return { shellExits, writeTimes };
}

function exitCodeOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function exitStatus(exitCode: number | undefined, failed: boolean): VerificationCheck["status"] {
	if (failed) return "failed";
	return exitCode === undefined ? "pending" : exitCode === 0 ? "passed" : "failed";
}

export function scoreTurn(
	turnMessages: readonly Message[],
	evidence: VerificationEvidence = collectVerificationEvidence(turnMessages),
): QualityVerdict {
	let editVersion = 0;
	let toolErrors = 0;
	let modelError = false;
	let aborted = false;
	let edited = false;
	let latestWriteEnd = -Infinity;
	const writes = new Set<string>();
	const runningChecks = new Map<string, { check: VerificationCheck; version: number; background?: boolean; startedAt?: number }>();
	for (const message of turnMessages) {
		switch (message.role) {
			case "assistant":
				modelError ||= message.stopReason === "error";
				aborted ||= message.stopReason === "aborted";
				for (const call of message.content) {
					if (call.type !== "toolCall") continue;
					const command = bashCommandOf(call);
					if (command && isVerifyCommand(command)) {
						runningChecks.set(call.id, {
							check: { id: call.id, command, status: "pending" },
							version: editVersion,
							background: (call.arguments as { run_in_background?: unknown }).run_in_background === true,
						});
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
					const details = message.details as { exitCode?: unknown; background?: unknown; shell_id?: unknown } | undefined;
					if (entry.background || details?.background === true) {
						if (message.isError) entry.check.status = "failed";
						else if (typeof details?.shell_id === "string") entry.check.shellId = details.shell_id;
					} else {
						entry.check.exitCode = exitCodeOf(details?.exitCode);
						entry.check.status = exitStatus(entry.check.exitCode, message.isError);
					}
				}
				break;
			}
			case "bashExecution": {
				if (!isVerifyCommand(message.command)) {
					if (mayEditWithShell(message.command)) editVersion++;
					break;
				}
				const id = `shell-${message.timestamp}-${runningChecks.size}`;
				const exitCode = exitCodeOf(message.exitCode);
				const status = message.cancelled ? "stopped" : exitStatus(exitCode, false);
				runningChecks.set(id, { check: { id, command: message.command, exitCode, status }, version: editVersion });
				break;
			}
		}
	}
	const checks = [...runningChecks.values()].map(({ check, version, startedAt }) => {
		const shell = check.shellId ? evidence.shellExits.get(check.shellId) : undefined;
		const started = shell?.startedAt ?? startedAt;
		if (shell) {
			check.exitCode = shell.exitCode;
			check.status = shell.status === "timed_out" || shell.status === "stopped" ? shell.status
				: exitStatus(shell.exitCode, shell.status === "error");
		}
		if (check.status !== "passed") return check;
		const wroteDuringShell = shell && started !== undefined && evidence.writeTimes.some((time) => time > started && time <= shell.finishedAt);
		if (version !== editVersion || (started !== undefined && latestWriteEnd > started) || wroteDuringShell) {
			check.status = "stale";
		}
		return check;
	});
	const verifyPassed = checks.some((check) => check.status === "passed");
	const signals = { edited, verifyRan: checks.length > 0, verifyPassed, toolErrors, modelError, aborted };
	const result = (omen: QualityOmen, label: string, reason: string): QualityVerdict => ({ omen, label, reason, signals, checks });
	if (aborted) return result("none", "", "本次回复已停止");
	if (modelError) return result("problem", "有报错", "模型返回错误");
	if (toolErrors || checks.some((check) => ["failed", "stopped", "timed_out"].includes(check.status)))
		return result("problem", "有检查未通过", "展开查看失败命令和工具记录");
	if (!signals.edited) return result("none", "", "本轮无代码改动");
	if (verifyPassed && !checks.some((check) => check.status === "pending"))
		return result("verified", "检查通过", "这些检查在本轮最后一次编辑后完成");
	if (checks.some((check) => check.status === "stale"))
		return result("unverified", "改动后待验证", "最近的成功检查早于本轮最后一次编辑");
	if (checks.some((check) => check.shellId && check.status === "pending"))
		return result("unverified", "等待检查结果", "后台检查尚无最终退出记录");
	return result("unverified", "未验证", "本轮改动尚无完成的检查");
}
