import type { BuiltinExternalProvider, ExternalProvider } from "./external-types.ts";
import { redactLogText } from "./desktop-log.ts";
import { externalExecutorDefinition } from "./external-registry.ts";

/** Why an external turn failed, as far as the protocol or the message tells. */
export type ExternalFailureKind = "auth" | "quota" | "rate_limit" | "context" | "model" | "refusal" | "policy" | "network" | "protocol" | "exit" | "other";

/** A JSON-RPC error response, keeping its code and data for classification. */
export class ExternalRpcError extends Error {
	readonly code?: number;
	readonly data?: unknown;
	constructor(message: string, code?: number, data?: unknown) { super(message); this.name = "ExternalRpcError"; this.code = code; this.data = data; }
}

/** An error whose kind the adapter already knows from structured protocol data. */
export class ExternalFailure extends Error {
	readonly kind: ExternalFailureKind;
	constructor(kind: ExternalFailureKind, message: string) { super(message); this.name = "ExternalFailure"; this.kind = kind; }
}

const LOGIN: Record<BuiltinExternalProvider, string> = {
	codex: "在终端运行 codex login",
	claude: "在终端运行 claude 并完成 /login",
	kimi: "在终端运行 kimi 并完成 /login",
	antigravity: "在终端运行 agy 登录",
};
const labelOf = (provider: ExternalProvider) => externalExecutorDefinition(provider)?.label ?? provider;
const loginFor = (provider: ExternalProvider) => LOGIN[provider as BuiltinExternalProvider] ?? `在终端打开 ${labelOf(provider)} 并完成登录`;

/** Map a Codex `codexErrorInfo` value to a failure kind. */
export function codexErrorKind(info: unknown): ExternalFailureKind | undefined {
	const key = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
	switch (key) {
		case "unauthorized": return "auth";
		case "usageLimitExceeded": case "sessionBudgetExceeded": return "quota";
		case "rateLimitExceeded": case "serverOverloaded": case "flexUnavailable": case "policyCapacityUnavailable": return "rate_limit";
		case "contextWindowExceeded": return "context";
		case "modelNotFound": return "model";
		case "cyberPolicy": case "bioPolicy": case "misalignmentPolicyViolation": return "refusal";
		case "inferenceHookDenied": case "tooManyDenials": case "sandboxError": return "policy";
		case "httpConnectionFailed": case "responseStreamConnectionFailed": case "responseStreamDisconnected": case "responseTooManyFailedAttempts": case "internalServerError": return "network";
		default: return undefined;
	}
}

function kindFromText(message: string): ExternalFailureKind {
	if (/auth(?:entication|orization)? required|not (?:logged|signed) in|unauthori[sz]ed|\b401\b|invalid api key|login required|please (?:log ?in|sign in)/i.test(message)) return "auth";
	if (/usage limit|quota|insufficient (?:balance|credit)|billing|credit balance|\b402\b|budget/i.test(message)) return "quota";
	if (/rate.?limit|too many requests|\b429\b|overloaded|\b529\b/i.test(message)) return "rate_limit";
	if (/context (?:window|length)|too many tokens|maximum context|prompt is too long/i.test(message)) return "context";
	if (/model[^\n]{0,40}(?:not found|not available|does not exist|unsupported|invalid)|unknown model|invalid (?:reasoning )?effort/i.test(message)) return "model";
	if (/unsupported_policy|cannot enforce|read-only tool ceiling/i.test(message)) return "policy";
	if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection refused|network|socket hang up|fetch failed|stream disconnected/i.test(message)) return "network";
	if (/\brefus(?:al|ed|es)\b/i.test(message)) return "refusal";
	if (/protocol|JSONL|Invalid .* (?:object|text|id)|JSON-RPC/i.test(message)) return "protocol";
	if (/exited \(|could not start/i.test(message)) return "exit";
	return "other";
}

const HINT: Record<ExternalFailureKind, (provider: ExternalProvider) => string | undefined> = {
	auth: (provider) => `${labelOf(provider)} 未登录或登录已过期：请${loginFor(provider)}，再用 SendMessage 继续此任务。`,
	quota: (provider) => `${labelOf(provider)} 账号额度或预算已用完：请换一个执行器，或等额度恢复后再继续。`,
	rate_limit: (provider) => `${labelOf(provider)} 被限流或服务繁忙：稍后用 SendMessage 继续，或换一个执行器。`,
	context: () => "上下文超出模型窗口：缩小任务范围，或开一个新任务只传必要信息。",
	model: () => "所选模型或思考强度不可用：在设置的 multi 档位里改回该执行器的默认模型后再试。",
	refusal: (provider) => `${labelOf(provider)} 拒绝了这个请求：调整任务描述，或换一个执行器。`,
	policy: () => "当前权限设置无法由这个执行器强制执行：换一个执行器，或调整权限模式。",
	network: () => "网络连接失败：检查代理或网络后用 SendMessage 继续。",
	protocol: (provider) => `${labelOf(provider)} 的协议输出不符合预期：可能是 CLI 版本不兼容，请升级 CLI 后再试。`,
	exit: (provider) => `${labelOf(provider)} 进程意外退出：查看下方诊断输出；必要时在终端单独运行它确认能启动。`,
	other: () => undefined,
};

/** Kind of a failure from structured data first (RPC code, adapter kind), then from its message. */
export function classifyExternalError(error: unknown, provider?: ExternalProvider): ExternalFailureKind {
	if (error instanceof ExternalFailure) return error.kind;
	if (error instanceof ExternalRpcError) {
		// ACP auth_required; JSON-RPC parse / invalid request errors are protocol mismatches.
		if (error.code === -32000 && provider && externalExecutorDefinition(provider)?.capabilities.transport === "acp") return "auth";
		if (error.code === -32700 || error.code === -32600 || error.code === -32601) return "protocol";
	}
	return kindFromText(error instanceof Error ? error.message : String(error));
}

/** A user-facing failure text: the original message, a recovery hint, and the redacted stderr tail. */
export function describeExternalFailure(provider: ExternalProvider, error: unknown, stderrTail?: string, env: NodeJS.ProcessEnv = {}): { kind: ExternalFailureKind; message: string } {
	const kind = classifyExternalError(error, provider);
	const original = redactDiagnostic(error instanceof Error ? error.message : String(error), env).slice(0, 4000);
	const hint = HINT[kind](provider);
	const stderr = stderrTail ? redactDiagnostic(stderrTail, env).trim() : "";
	const tail = stderr && !original.includes(stderr.slice(-200)) ? stderr.slice(-1500) : "";
	const message = [original, hint ? `提示：${hint}` : "", tail ? `诊断输出（已脱敏）：\n${tail}` : ""].filter(Boolean).join("\n");
	return { kind, message: message.slice(0, 8000) };
}

/** Replace environment secrets and common token shapes in diagnostic text. */
export function redactDiagnostic(text: string, env: NodeJS.ProcessEnv): string {
	for (const [key, value] of Object.entries(env))
		if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)/i.test(key) && value && value.length >= 8) text = text.split(value).join("[REDACTED]");
	return redactLogText(text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"), "");
}

/** Attach the native stderr tail to an error raised while a session opened (and was then closed). */
export function withDiagnostics<T>(error: T, tail: string | undefined): T {
	if (tail && error && typeof error === "object") (error as { diagnostics?: string }).diagnostics = tail;
	return error;
}
export function diagnosticsOf(error: unknown): string | undefined {
	const value = error && typeof error === "object" ? (error as { diagnostics?: unknown }).diagnostics : undefined;
	return typeof value === "string" ? value : undefined;
}
