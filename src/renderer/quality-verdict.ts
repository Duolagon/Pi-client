import type { Message } from "../shared.ts";

/**
 * Per-turn code-quality verdict derived ONLY from honest signals that already exist
 * in the finalized transcript — never a fabricated pass. Pi runs no standing
 * test/tsc/biome, so "verified" requires that the agent itself ran a recognized
 * verify command that exited 0, with no tool/model errors. Labels stay neutral:
 * the Grail wording is reserved for the user-initiated judgement.
 */
export type QualityOmen =
	/** Code changed, a recognized verify command exited 0, and nothing errored. */
	| "verified"
	/** A tool/model error, a nonzero verify exit, or an aborted turn. */
	| "problem"
	/** Code changed but no verification ran — honest "unproven", never a pass. */
	| "unverified"
	/** No code was produced (conversation-only turn): no omen is shown. */
	| "none";

export interface QualityVerdict {
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

/**
 * Recognized verification commands. Matched against the leading program token of a
 * shell command (after common runners), so only a real check counts as verified.
 */
const VERIFY_PATTERN =
	/\b(vitest|jest|mocha|ava|pytest|tsc|tsd|biome|eslint|prettier|ruff|mypy|cargo\s+(test|check|clippy)|go\s+test|rspec|phpunit|ctest)\b/i;
/** `npm test`, `npm run build`, `pnpm lint`, `yarn check`, etc. */
const SCRIPT_VERIFY_PATTERN =
	/\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(test|tests|check|typecheck|type-check|lint|build|ci)\b/i;
/** `node --test`, `python -m pytest`. */
const RUNNER_VERIFY_PATTERN = /\bnode\b[^\n]*--test\b|\bpython3?\b[^\n]*-m\s+(pytest|unittest)\b/i;

function isVerifyCommand(command: string): boolean {
	const text = command.trim();
	return VERIFY_PATTERN.test(text) || SCRIPT_VERIFY_PATTERN.test(text) || RUNNER_VERIFY_PATTERN.test(text);
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

/**
 * Score one finished assistant turn (the consecutive assistant messages plus the
 * toolResult / bashExecution messages that belong to it) into a verdict.
 *
 * `turnMessages` is the slice of the transcript for a single turn, in order. It may
 * include the assistant messages, their toolResults, and any bashExecution (`!`) messages.
 */
export function scoreTurn(turnMessages: Message[]): QualityVerdict {
	const assistants = turnMessages.filter((m): m is Assistant => m.role === "assistant");
	const toolResults = turnMessages.filter((m): m is ToolResult => m.role === "toolResult");
	const bashExecs = turnMessages.filter((m): m is BashExecution => m.role === "bashExecution");

	const toolCalls = assistants.flatMap((m) =>
		m.content.filter((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall"),
	);

	const edited = toolCalls.some((c) => EDIT_TOOLS.has(toolName(c)));
	const aborted = assistants.some((m) => m.stopReason === "aborted");
	const modelError = assistants.some((m) => m.stopReason === "error");
	// A write the user declined in the approval dialog is their choice, not a tool failure.
	const toolErrors = toolResults.filter((r) => r.isError && !isUserDenial(r)).length;

	// Verify commands come from both the agent's Bash tool calls (matched to their
	// toolResult by toolCallId) and user `!` bashExecution messages (own exit code).
	let verifyRan = false;
	let verifyFailed = false;
	let verifyPassed = false;

	for (const call of toolCalls) {
		const command = bashCommandOf(call);
		if (!command || !isVerifyCommand(command)) continue;
		verifyRan = true;
		const result = toolResults.find((r) => r.toolCallId === call.id);
		// No matching result yet (or it errored) counts as a failed verification.
		if (!result || result.isError) verifyFailed = true;
		else verifyPassed = true;
	}
	for (const exec of bashExecs) {
		if (!isVerifyCommand(exec.command)) continue;
		verifyRan = true;
		if (exec.cancelled || (exec.exitCode !== undefined && exec.exitCode !== 0)) verifyFailed = true;
		else if (exec.exitCode === 0) verifyPassed = true;
	}

	const signals = { edited, verifyRan, verifyPassed, toolErrors, modelError, aborted };

	// The user pressed stop: neither success nor failure, so no omen.
	if (aborted) return { omen: "none", label: "", reason: "本次回复已停止", signals };
	if (modelError) return { omen: "problem", label: "有报错", reason: "模型返回错误", signals };
	if (toolErrors > 0 || verifyFailed) {
		const bits: string[] = [];
		if (verifyFailed) bits.push("校验未通过");
		if (toolErrors > 0) bits.push(`${toolErrors} 处工具报错`);
		return { omen: "problem", label: "有报错", reason: bits.join(" · "), signals };
	}
	if (!edited) return { omen: "none", label: "", reason: "本轮无代码改动", signals };
	if (verifyPassed) return { omen: "verified", label: "已验证", reason: "改动已自验证且全部通过", signals };
	return { omen: "unverified", label: "未验证", reason: "有代码改动，但本轮未运行校验", signals };
}
