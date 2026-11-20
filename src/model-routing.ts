import { MODEL_ROUTING_ROLES, type ModelRouting } from "./agent-types.ts";

const MAX_FIELD = 200;

function modelRef(value: unknown): { provider: string; id: string } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { provider, id } = value as Record<string, unknown>;
	if (typeof provider !== "string" || typeof id !== "string") return undefined;
	const p = provider.trim();
	const m = id.trim();
	if (!p || !m || p.length > MAX_FIELD || m.length > MAX_FIELD) return undefined;
	return { provider: p, id: m };
}

/**
 * Keep only known roles with a well-formed { provider, id }. Used when loading the store,
 * so a malformed entry is dropped instead of rejecting the whole settings file.
 */
export function sanitizeModelRouting(value: unknown): ModelRouting | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const result: ModelRouting = {};
	for (const role of MODEL_ROUTING_ROLES) {
		const ref = modelRef(input[role]);
		if (ref) result[role] = ref;
	}
	return Object.keys(result).length ? result : undefined;
}

/**
 * Strict check for a settings update coming over IPC: unknown roles, or a role whose value
 * is neither null (clear) nor a valid { provider, id }, throw.
 */
export function parseModelRoutingUpdate(value: unknown): ModelRouting {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型路由设置格式错误。");
	const input = value as Record<string, unknown>;
	const result: ModelRouting = {};
	for (const [key, entry] of Object.entries(input)) {
		if (!(MODEL_ROUTING_ROLES as readonly string[]).includes(key)) throw new Error(`未知的模型路由角色：${key}`);
		if (entry === null) continue;
		const ref = modelRef(entry);
		if (!ref) throw new Error(`模型路由 ${key} 的模型格式错误。`);
		result[key as keyof ModelRouting] = ref;
	}
	return result;
}
