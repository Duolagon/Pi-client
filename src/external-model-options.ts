export function externalModelOptions(model: unknown, effort: unknown): { model?: string; effort?: string } {
	if (model === "inherit") model = undefined;
	if (model !== undefined && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/.test(model)))
		throw new Error("外部执行器模型标识无效。");
	if (effort !== undefined && (typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)))
		throw new Error("外部执行器思考强度无效。");
	return { ...(typeof model === "string" ? { model } : {}), ...(typeof effort === "string" ? { effort } : {}) };
}
