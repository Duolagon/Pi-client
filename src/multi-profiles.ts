import { parseMultiAgentSettings } from "./multi-agent.ts";
import { MULTI_EXECUTORS, type Model, type MultiAgentSettings, type MultiExecutorId, type ThinkingLevel } from "./shared.ts";

export type ModelAccess = "listed" | "confirmed" | "auth" | "subscription" | "quota";
export const ACCESS_LABELS: Record<ModelAccess, string> = {
	listed: "已发现 · 权限待验证", confirmed: "近期调用成功", auth: "未登录", subscription: "无模型权限", quota: "额度不足",
};
export interface NativeModel {
	id: string;
	efforts: string[];
	access: ModelAccess;
	current?: boolean;
	billing?: "subscription";
}
export interface NativeSource {
	id: MultiExecutorId;
	models: NativeModel[];
	readOnly: boolean;
	issue?: string;
}
export interface MultiCatalog { controllers: Model[]; sources: NativeSource[] }
export interface NamedProfile { name: string; config: MultiAgentSettings }
export interface ModelRating { quality?: "basic" | "balanced" | "premium"; cost?: "low" | "medium" | "high" }
export interface MultiLibrary {
	active?: string;
	saved: NamedProfile[];
	previous?: NamedProfile;
	ratings?: Record<string, ModelRating>;
}
export type ProfileAction =
	| { type: "apply" | "save"; name: string; config: MultiAgentSettings }
	| { type: "activate"; name: string }
	| { type: "saveAndApply"; name: string; config: MultiAgentSettings }
	| { type: "rename"; name: string; newName: string }
	| { type: "delete"; name: string }
	| { type: "undo" }
	| { type: "rate"; key: string; rating: ModelRating };
export const TIERS = ["极致", "性价比", "平民"] as const;
export type PlanTier = typeof TIERS[number];
export const ratingKey = (source: string, model: string, role: "native" | "pi" = "native") => JSON.stringify([role, source, model]);
export const canUse = (model: NativeModel) => model.access === "listed" || model.access === "confirmed";

function profileName(value: unknown) {
	if (typeof value !== "string" || !value.trim() || value.trim().length > 60 || /[\u0000-\u001f]/.test(value)) throw new Error("方案名称需为 1–60 个可显示字符。");
	return value.trim();
}
function ratingValue(value: ModelRating): ModelRating {
	if (!value || typeof value !== "object" || (value.quality !== undefined && !["basic", "balanced", "premium"].includes(value.quality)) ||
		(value.cost !== undefined && !["low", "medium", "high"].includes(value.cost))) throw new Error("模型标记无效。");
	return { ...(value.quality ? { quality: value.quality } : {}), ...(value.cost ? { cost: value.cost } : {}) };
}
export function loadLibrary(value?: MultiLibrary): MultiLibrary {
	const result: MultiLibrary = { saved: [] };
	if (!value || !Array.isArray(value.saved)) return result;
	for (const entry of value.saved.slice(0, 100)) {
		try { result.saved.push({ name: profileName(entry.name), config: parseMultiAgentSettings(entry.config) }); } catch { /* Skip a corrupt entry. */ }
	}
	try {
		if (value.active) result.active = profileName(value.active);
		if (value.previous) result.previous = { name: profileName(value.previous.name), config: parseMultiAgentSettings(value.previous.config) };
	} catch { /* Other named profiles remain available. */ }
	for (const [key, rating] of Object.entries(value.ratings ?? {}).slice(0, 1500)) {
		try { if (key.startsWith("[") && key.length < 500) (result.ratings ??= {})[key] = ratingValue(rating); } catch { /* Skip invalid annotations. */ }
	}
	return result;
}
export function editProfile(current: MultiAgentSettings, library: MultiLibrary, action: ProfileAction): { library: MultiLibrary; config: MultiAgentSettings } {
	if (action.type === "activate") {
		const entry = library.saved.find(p => p.name === profileName(action.name));
		if (!entry) throw new Error("方案已不存在。");
		return editProfile(current, library, { type: "apply", ...entry });
	}
	if (action.type === "saveAndApply") {
		const saved = editProfile(current, library, { ...action, type: "save" });
		saved.library.active = library.active;
		const applied = editProfile(current, saved.library, { ...action, type: "apply" });
		return applied;
	}
	const next = structuredClone(library);
	let config = current;
	if (action.type === "rate") {
		if (typeof action.key !== "string" || !action.key.startsWith("[") || action.key.length >= 500) throw new Error("无效的模型标识。");
		(next.ratings ??= {})[action.key] = ratingValue(action.rating);
	} else if (action.type === "undo") {
		if (!next.previous) throw new Error("没有可撤销的切换。");
		config = next.previous.config;
		next.active = next.previous.name;
		delete next.previous;
	} else {
		const name = profileName(action.name);
		const index = next.saved.findIndex((entry) => entry.name === name);
		if (action.type === "apply") {
			config = parseMultiAgentSettings(action.config);
			next.previous = { name: next.active ?? "当前自定义", config: current };
			if (!next.active && Object.keys(current).length && !next.saved.some(item => item.name === "当前自定义"))
				next.saved.push(next.previous);
			next.active = name;
		} else if (action.type === "save") {
			if ((TIERS as readonly string[]).includes(name)) throw new Error("此名称已用于推荐方案。");
			const entry = { name, config: parseMultiAgentSettings(action.config) };
			if (index < 0) {
				if (next.saved.length >= 100) throw new Error("最多保存 100 个方案。");
				next.saved.push(entry);
			} else {
				next.saved[index] = entry;
				if (next.active === name && JSON.stringify(current) !== JSON.stringify(entry.config)) delete next.active;
			}
		} else if (action.type === "rename" || action.type === "delete") {
			if (index < 0) throw new Error("方案已不存在。");
			if (action.type === "delete") {
				next.saved.splice(index, 1);
				if (next.active === name) delete next.active;
				if (next.previous?.name === name) next.previous.name = "当前自定义";
			} else {
				const newName = profileName(action.newName);
				if ((TIERS as readonly string[]).includes(newName) || next.saved.some(item => item.name === newName && item.name !== name)) throw new Error("名称已被使用。");
				next.saved[index].name = newName;
				if (next.active === name) next.active = newName;
				if (next.previous?.name === name) next.previous.name = newName;
			}
		} else throw new Error("未知方案操作。");
	}
	return { library: next, config };
}

// Family hints rank known models only. Custom endpoints can override both dimensions.
function quality(id: string, rating?: ModelRating) {
	if (rating?.quality) return { basic: 1, balanced: 2, premium: 3 }[rating.quality];
	if (/opus|astra|(?:^|[-/])pro(?:$|[-.])|reasoner/i.test(id)) return 3;
	if (/haiku|flash|mini|luna|lite/i.test(id)) return 1;
	return 2;
}
interface Choice { id: string; source: string; efforts: string[]; price?: number; current?: boolean; confirmed?: boolean; native?: MultiExecutorId }
function ranked(choices: Choice[], tier: PlanTier, library: MultiLibrary) {
	function score(item: Choice) {
		const mark = library.ratings?.[ratingKey(item.source, item.id, item.native ? "native" : "pi")];
		const q = quality(item.id, mark);
		// USD per representative 1M input + 250k output tokens, or the user's relative cost band.
		const cost = mark?.cost ? { low: 1, medium: 2, high: 4 }[mark.cost] :
			item.price !== undefined ? 1 + Math.log2(1 + item.price) : undefined;
		const evidence = (item.confirmed ? 0.4 : 0) + (item.current ? 0.2 : 0);
		if (tier === "极致") return q * 5 + evidence;
		if (tier === "平民") return cost === undefined ? -10000 - q * 0.1 + evidence : -cost * 5 + q * 0.1 + evidence;
		return q * 2 - (cost ?? 4) + evidence;
	}
	return [...choices].sort((a, b) => score(b) - score(a) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
function effort(choice: Choice, tier: PlanTier) {
	const order = ["none", "off", "minimal", "low", "medium", "on", "high", "xhigh", "max", "ultra"];
	const levels = order.filter(value => choice.efforts.includes(value));
	if (!levels.length) return undefined;
	if (tier === "极致") return levels.at(-1);
	const target = tier === "平民" ? "low" : "medium";
	return [...levels].sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(target)) - Math.abs(order.indexOf(b) - order.indexOf(target)))[0];
}
export function recommend(catalog: MultiCatalog, tier: PlanTier, library: MultiLibrary): MultiAgentSettings | undefined {
	const controllers = catalog.controllers.map(m => ({ id: m.id, source: m.provider, efforts: m.thinkingLevels ?? [], price:
		m.cost && (m.cost.input > 0 || m.cost.output > 0) ? m.cost.input + m.cost.output / 4 : undefined }));
	const controller = ranked(controllers, tier, library)[0];
	const choices = catalog.sources.flatMap(source => source.models.filter(canUse).map(m => ({
		source: source.id, native: source.id, id: m.id, efforts: m.efforts, confirmed: m.access === "confirmed", current: m.current,
	})));
	const natives = ranked(choices, tier, library);
	const writer = natives[0];
	if (!controller || !writer?.native) return undefined;
	const executors: MultiAgentSettings["executors"] = {};
	const allowed = MULTI_EXECUTORS.filter(id => natives.some(item => item.native === id));
	for (const id of allowed) {
		const choice = natives.find(item => item.native === id)!;
		executors[id] = { model: choice.id, effort: effort(choice, tier) };
	}
	const reviewers = natives.filter(item => catalog.sources.some(s => s.id === item.native && s.readOnly));
	const reviewer = reviewers.find(item => item.native !== writer.native) ?? reviewers[0];
	return parseMultiAgentSettings({ controller: { model: { provider: controller.source, id: controller.id }, thinkingLevel: effort(controller, tier) as ThinkingLevel | undefined },
		implementation: writer.native, parallelism: tier === "平民" ? "single" : "parallel", allowed, executors, reviewPolicy: !reviewer ? "on-demand" : tier === "极致" ? "always" : tier === "性价比" ? "important" : "on-demand",
		...(reviewer ? { reviewer: { executor: reviewer.native, model: reviewer.id, effort: effort(reviewer, tier) } } : {}) });
}
export function validateProfileResources(config: MultiAgentSettings, catalog: MultiCatalog) {
	const ref = config.controller?.model;
	if (ref) {
		const model = catalog.controllers.find(m => m.provider === ref.provider && m.id === ref.id);
		if (!model) throw new Error("主控模型当前不可用。");
		if (config.controller?.thinkingLevel && model.thinkingLevels?.length && !model.thinkingLevels.includes(config.controller.thinkingLevel)) throw new Error("主控模型不支持所选强度。");
	}
	function check(id: MultiExecutorId, model?: string, effort?: string) {
		const source = catalog.sources.find(s => s.id === id);
		if (!source || source.issue) throw new Error(`${id}：${source?.issue ?? "执行器不可用"}`);
		const option = source.models.find(m => m.id === model);
		if (model && (!option || !canUse(option))) throw new Error(`${id} · ${model}：${option ? ACCESS_LABELS[option.access] : "模型未被当前 CLI 列出"}`);
		if (effort && option?.efforts.length && !option.efforts.includes(effort)) throw new Error(`${model} 不支持 ${effort}。`);
	}
	for (const id of new Set([...(config.allowed ?? []), ...Object.keys(config.executors ?? {}) as MultiExecutorId[], ...(config.fallbacks ?? []), ...(config.implementation ? [config.implementation] : [])])) {
		if (!config.allowed || config.allowed.includes(id)) check(id, config.executors?.[id]?.model, config.executors?.[id]?.effort);
	}
	if (config.reviewer) check(config.reviewer.executor, config.reviewer.model, config.reviewer.effort);
}
