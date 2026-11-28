import { MULTI_EXECUTORS, type MultiAgentSettings, type MultiExecutorId, type ThinkingLevel } from "./shared.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Native model ids: provider/model names, aliases such as `opus` or `kimi-k2`, bracketed context tags. */
const NATIVE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
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
	for (const key of Object.keys(input)) if (key !== "controller" && key !== "executors") throw new Error(`未知的 multi 档位设置：${key}`);
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
				if (name.length > 200 || !NATIVE_MODEL.test(base)) throw new Error(`${id} 模型名无效。`);
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
	return result;
}

/** Sanitize a stored value; invalid data is dropped instead of failing the store load. */
export function sanitizeMultiAgentSettings(value: unknown): MultiAgentSettings | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		const parsed = parseMultiAgentSettings(value);
		return parsed.controller || parsed.executors ? parsed : undefined;
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
		"Plan the work yourself, then delegate the substantive pieces with the Agent tool and an `executor` parameter. Give each call a complete, self-contained prompt: the goal, the files or area, constraints, and what done looks like. The executor does not see this conversation.",
	];
	if (available.length) {
		lines.push("Executors available now:");
		for (const id of available) {
			const pinned = settings?.executors?.[id];
			const detail = pinned?.model || pinned?.effort ? ` (model ${pinned.model ?? "its default"}, effort ${pinned.effort ?? "its default"}, set by the user)` : "";
			lines.push(`- ${EXECUTOR_TEXT[id]}${detail}`);
		}
	} else {
		lines.push("No external executor is installed and enabled right now. Tell the user, and do the work with local Pi subagents (omit `executor`) or yourself.");
	}
	lines.push(
		"Writable external tasks run in their own Git worktree. Their result notification lists the changed files and a diff stat; review the diff before you merge it with WorktreeMerge, and send fixes back with SendMessage to the same task_id instead of starting over.",
		"Run independent pieces in parallel by launching several Agent calls in one message. For important changes, ask a different executor to review the first one's worktree diff.",
		"Do small or tightly coupled edits yourself. Do not pass `model` to external executors; the user configured their models.",
	);
	return lines.join("\n");
}
