import { isExternalModelId } from "./external-model-options.ts";
import { MULTI_EXECUTORS, type MultiAgentSettings, type MultiExecutorId, type ThinkingLevel } from "./shared.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
/** Suggested native values. Codex and Kimi validate against their model's advertised options. */
export const EXECUTOR_EFFORTS: Record<MultiExecutorId, readonly string[] | undefined> = {
	codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	kimi: undefined,
};

function modelRef(value: unknown): { provider: string; id: string } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { provider, id } = value as Record<string, unknown>;
	if (typeof provider !== "string" || typeof id !== "string" || !provider || !id || provider.length > 100 || id.length > 200) return undefined;
	return { provider, id };
}

/** Validate a settings update. Throws on malformed input; empty fields are dropped. */
export function parseMultiAgentSettings(value: unknown): MultiAgentSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("multi 档位设置格式错误。");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) if (!["controller", "executors", "implementation", "reviewer", "reviewPolicy", "allowed", "fallbacks", "parallelism"].includes(key)) throw new Error(`未知的 multi 档位设置：${key}`);
	const result: MultiAgentSettings = {};
	if (input.controller !== undefined && input.controller !== null) {
		if (typeof input.controller !== "object" || Array.isArray(input.controller)) throw new Error("主控模型设置格式错误。");
		const controller = input.controller as Record<string, unknown>;
		const next: NonNullable<MultiAgentSettings["controller"]> = {};
		if (controller.model !== undefined && controller.model !== null) {
			const ref = modelRef(controller.model);
			if (!ref) throw new Error("主控模型格式错误。");
			next.model = ref;
		}
		if (controller.thinkingLevel !== undefined && controller.thinkingLevel !== null) {
			if (!THINKING_LEVELS.includes(controller.thinkingLevel as ThinkingLevel)) throw new Error("主控思考强度无效。");
			next.thinkingLevel = controller.thinkingLevel as ThinkingLevel;
		}
		if (next.model || next.thinkingLevel) result.controller = next;
	}
	if (input.executors !== undefined && input.executors !== null) {
		if (typeof input.executors !== "object" || Array.isArray(input.executors)) throw new Error("子 Agent 设置格式错误。");
		const executors: NonNullable<MultiAgentSettings["executors"]> = {};
		for (const [id, entry] of Object.entries(input.executors as Record<string, unknown>)) {
			if (!(MULTI_EXECUTORS as readonly string[]).includes(id)) throw new Error(`未知的子 Agent 执行器：${id}`);
			if (entry === null || entry === undefined) continue;
			if (typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${id} 设置格式错误。`);
			const { model, effort } = entry as Record<string, unknown>;
			const next: { model?: string; effort?: string } = {};
			if (model !== undefined && model !== null && model !== "") {
				const name = typeof model === "string" ? model.trim() : "";
				const base = id === "kimi" && name.endsWith(",thinking") ? name.slice(0, -",thinking".length) : name;
				if (name.length > 200 || !isExternalModelId(base, id)) throw new Error(`${id} 模型名无效。`);
				next.model = name;
			}
			if (effort !== undefined && effort !== null && effort !== "") {
				const allowed = id === "claude" ? EXECUTOR_EFFORTS.claude : undefined;
				if (typeof effort !== "string" || !EFFORT.test(effort) || (allowed && !allowed.includes(effort))) throw new Error(`${id} 思考强度无效。`);
				next.effort = effort;
			}
			if (next.model || next.effort) executors[id as MultiExecutorId] = next;
		}
		if (Object.keys(executors).length) result.executors = executors;
	}
	const executorId = (value: unknown): MultiExecutorId => {
		if (!MULTI_EXECUTORS.includes(value as MultiExecutorId)) throw new Error("未知执行器。");
		return value as MultiExecutorId;
	};
	for (const key of ["allowed", "fallbacks"] as const) {
		if (input[key] === undefined) continue;
		if (!Array.isArray(input[key]) || input[key].length > MULTI_EXECUTORS.length) throw new Error("执行器列表无效。");
		result[key] = [...new Set(input[key].map(executorId))];
	}
	if (input.implementation !== undefined) result.implementation = executorId(input.implementation);
	if (input.parallelism !== undefined) {
		if (input.parallelism !== "single" && input.parallelism !== "parallel") throw new Error("委派方式无效。");
		result.parallelism = input.parallelism;
	}
	if (input.reviewPolicy !== undefined) {
		if (!["important", "on-demand", "always"].includes(String(input.reviewPolicy))) throw new Error("审查策略无效。");
		result.reviewPolicy = input.reviewPolicy as MultiAgentSettings["reviewPolicy"];
	}
	if (input.reviewer !== undefined) {
		if (!input.reviewer || typeof input.reviewer !== "object") throw new Error("审查配置无效。");
		const { executor, model, effort } = input.reviewer as Record<string, unknown>;
		const id = executorId(executor);
		if (id === "kimi") throw new Error("Kimi 不支持只读审查。");
		const values = parseMultiAgentSettings({ executors: { [id]: { model, effort } } }).executors?.[id];
		result.reviewer = { executor: id, ...values };
	}
	for (const id of [result.implementation, result.reviewer?.executor, ...(result.fallbacks ?? [])])
		if (id && result.allowed && !result.allowed.includes(id)) throw new Error("所选角色或备用执行器未获此方案允许。");
	return result;
}

/** Sanitize a stored value; invalid data is dropped instead of failing the store load. */
export function sanitizeMultiAgentSettings(value: unknown): MultiAgentSettings | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		const parsed = parseMultiAgentSettings(value);
		return Object.keys(parsed).length ? parsed : undefined;
	} catch { return undefined; }
}

const EXECUTOR_TEXT: Record<MultiExecutorId, string> = {
	codex: "codex (OpenAI Codex CLI): strong at focused implementation, refactors and test fixing",
	claude: "claude (Claude Code): strong at reading large codebases, planning and careful multi-file edits; it also runs read-only Explore/Plan work",
	kimi: "kimi (Kimi Code): a second opinion and parallel implementer; it cannot run read-only Explore/Plan tasks",
};

/**
 * System prompt section for the multi tier. `available` lists executors that are installed and
 * enabled now; the host re-checks at call time.
 */
export function multiTierPromptSection(settings: MultiAgentSettings | undefined, available: readonly MultiExecutorId[], turnOnly = false): string {
	const lines = [
		"# Orchestration (multi tier)",
		turnOnly
			? "For this turn, you are the controller of a team of external coding agents."
			: "The user turned on the multi tier: you are the controller of a team of external coding agents. This opt-in is standing.",
		"Plan the work yourself, then delegate the substantive pieces with the Agent tool. Give each call a complete, self-contained prompt: the goal, the files or area, constraints, and what done looks like. The executor does not see this conversation.",
	];
	if (!settings?.implementation && available.length) lines.push("Specify the native executor in the Agent executor parameter.");
	if (settings?.implementation) lines.push(`For implementation, omit executor to use the configured default (${settings.implementation}). Only explicitly choose a different allowed executor when needed.`);
	if (settings?.reviewer) lines.push(`For review_of omit executor, model and effort to use the configured reviewer (${settings.reviewer.executor}).`);
	if (settings?.reviewPolicy) lines.push({
		always: "Request an independent read-only review of each completed implementation diff.",
		important: "Request an independent review for complex or high-impact changes.",
		"on-demand": "Only request independent reviews when the user asks."
	}[settings.reviewPolicy]);
	if (available.length) {
		lines.push("Executors available now:");
		for (const id of available) {
			const pinned = settings?.executors?.[id];
			const detail = pinned?.model || pinned?.effort ? ` (model ${pinned.model ?? "its default"}, effort ${pinned.effort ?? "its default"}, set by the user)` : "";
			lines.push(`- ${EXECUTOR_TEXT[id]}${detail}`);
		}
	} else {
		lines.push("No external executor is installed and enabled right now. Tell the user, and do the work with local Pi subagents (set `executor` to pi) or yourself.");
	}
	lines.push(
		"Writable external tasks run in their own Git worktree. Their result notification lists the changed files and a diff stat; review the diff before you merge it with WorktreeMerge, and send fixes back with SendMessage to the same task_id instead of starting over.",
		settings?.parallelism === "single" ? "By default, delegate to one implementation agent at a time. Reuse its task for follow-ups." :
			"Run independent pieces in parallel by launching several Agent calls in one message.",
		settings?.reviewPolicy ? "Follow the configured review policy when requesting an independent review." : "For important changes, ask a different executor to review the first one’s worktree diff.",
		"Do small or tightly coupled edits yourself. Use the configured executor defaults unless a task needs its own model or effort.",
	);
	return lines.join("\n");
}
