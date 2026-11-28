import type { ExternalProvider } from "./external-types.ts";

/** Kimi's ACP model IDs can include the configured provider name, with internal spaces. */
export function isExternalModelId(value: unknown, executor?: string): value is string {
	if (typeof value !== "string" || value.length > 200 || value.trim() !== value) return false;
	const pattern = executor === "kimi"
		? /^[A-Za-z0-9][A-Za-z0-9._:/@[\] -]*$/
		: /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
	return pattern.test(value);
}

export function externalModelOptions(model: unknown, effort: unknown, executor?: ExternalProvider): { model?: string; effort?: string } {
	if (model === "inherit") model = undefined;
	if (model !== undefined && !isExternalModelId(model, executor))
		throw new Error("外部执行器模型标识无效。");
	if (effort !== undefined && (typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)))
		throw new Error("外部执行器思考强度无效。");
	return { ...(typeof model === "string" ? { model } : {}), ...(typeof effort === "string" ? { effort } : {}) };
}
