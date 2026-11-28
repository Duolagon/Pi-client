import { useEffect, useState, type ComponentProps } from "react";
import { MULTI_EXECUTORS, type MultiAgentSettings, type MultiExecutorId, type Settings, type Snapshot } from "../shared.ts";
import { ACCESS_LABELS, TIERS, ratingKey, recommend, type ModelRating, type MultiCatalog, type ProfileAction } from "../multi-profiles.ts";
import { MultiAgentSettingsFields, multiAgentDraft, multiAgentFromDraft } from "./MultiAgentSettingsFields.tsx";
import "./multi-profiles.css";

const reviewLabels = { always: "每次独立审查", important: "重要改动独立审查", "on-demand": "按需审查" };
function summary(config: MultiAgentSettings) {
	const impl = config.implementation;
	const writer = impl && config.executors?.[impl];
	const reviewer = config.reviewer;
	return <>
		<span>主控　{config.controller?.model ? config.controller.model.provider + " / " + config.controller.model.id : "会话模型"} · {config.controller?.thinkingLevel ?? "默认强度"}</span>
		<span>实现　{[impl ?? "由主控选择", writer?.model, writer?.effort].filter(Boolean).join(" · ")}</span>
		<span>审查　{[reviewer?.executor ?? (config.allowed && !config.allowed.some(id => id !== "kimi") ? "无可用只读执行器" : "自动选择只读执行器"), reviewer?.model, reviewer?.effort].filter(Boolean).join(" · ")}</span>
		{config.reviewPolicy && <small>{reviewLabels[config.reviewPolicy]}</small>}
	</>;
}
type Props = ComponentProps<typeof MultiAgentSettingsFields> & { settings: Settings; apply(snapshot: Snapshot): void };
export function MultiProfileEditor({ settings, apply, ...fields }: Props) {
	const { draft, setDraft } = fields;
	const [catalog, setCatalog] = useState<MultiCatalog>();
	const [revision, refresh] = useState(0);
	const [scanning, setScanning] = useState(true);
	const [working, setWorking] = useState(false);
	const [notice, setNotice] = useState("");
	const [name, setName] = useState("");
	const [selected, setSelected] = useState("");
	const [resource, setResource] = useState("");
	const busy = fields.disabled || working;
	const library = settings.multiProfiles ?? { saved: [] };
	useEffect(() => {
		let alive = true;
		setScanning(true);
		window.pi.multiCatalog().then(value => { if (alive) setCatalog(value); }).catch(error => { if (alive) setNotice(String(error)); })
			.finally(() => { if (alive) setScanning(false); });
		return () => { alive = false; };
	}, [revision]);
	async function change(action: ProfileAction) {
		setWorking(true);
		try {
			const next = await window.pi.updateMultiProfile(action);
			apply(next);
			const activating = ["apply", "activate", "saveAndApply", "undo"].includes(action.type);
			if (activating) {
				const config = multiAgentDraft(next.settings.multiAgent);
				setDraft(() => config);
			}
			if (action.type === "save" || action.type === "saveAndApply") setSelected(action.name.trim());
			if (action.type === "rename") setSelected(action.newName.trim());
			if (action.type === "delete") { setSelected(""); setName(""); }
			setNotice(activating ? "已应用，下次 multi 调度生效。" : "已保存。");
		} catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
		finally { setWorking(false); }
	}
	function edit(config: MultiAgentSettings, title: string, saved = "") {
		setDraft(() => multiAgentDraft(config)); setName(title); setSelected(saved); setNotice("已载入编辑区。");
	}
	const routes = draft.routes;
	function route(patch: Partial<typeof routes>) { setDraft(value => ({ ...value, routes: { ...value.routes, ...patch } })); }
	const choices = catalog?.sources.flatMap(s => s.models.map(m => ({ key: ratingKey(s.id, m.id), label: s.id + " · " + m.id, detail:
		[ACCESS_LABELS[m.access], m.billing === "subscription" ? "使用订阅额度" : "价格未知", m.efforts.join(" / ")].filter(Boolean).join(" · ") }))) ?? [];
	const resources = [...(catalog?.controllers ?? []).map(m => ({ key: ratingKey(m.provider, m.id, "pi"), label: m.provider + " · " + m.id,
		detail: m.cost && (m.cost.input || m.cost.output) ? `每百万 token（美元） 输入 ${m.cost.input} / 输出 ${m.cost.output}` : "价格未知" })), ...choices];
	const rating = library.ratings?.[resource] ?? {};
	const allowed = routes.allowed ?? MULTI_EXECUTORS;
	const reviewer = routes.reviewer;
	const reviewerModels = catalog?.sources.find(s => s.id === reviewer?.executor)?.models;
	const plans = TIERS.map(tier => catalog && recommend(catalog, tier, library));
	const canSave = !busy && !!name.trim() && (selected === name.trim() || !library.saved.some(p => p.name === name.trim()));
	const btn = "cc-mini-btn";
	return <MultiAgentSettingsFields {...fields} catalog={catalog} disabled={busy}>
		<div className="multi-profiles">
			<div className="multi-toolbar"><strong>当前方案 · {library.active ?? "当前自定义"}</strong>
				<button type="button" className={btn} disabled={scanning || busy} onClick={() => refresh(v => v + 1)}>{scanning ? "正在发现模型…" : "刷新模型"}</button>
				{library.previous && <button type="button" className={btn} disabled={busy} onClick={() => void change({ type: "undo" })}>撤销切换</button>}
			</div>
			<div className="multi-cards">{TIERS.map((tier, index) => {
				const config = plans[index];
				const identical = config && plans.slice(0, index).findIndex(p => JSON.stringify(p) === JSON.stringify(config));
				const writer = config?.implementation;
				const model = writer && config?.executors?.[writer]?.model;
				const row = catalog?.sources.find(s => s.id === writer)?.models.find(m => m.id === model);
				const cost = writer && model && library.ratings?.[ratingKey(writer, model)]?.cost;
				return <section key={tier}><strong>{tier}</strong><small>{["优先模型能力和推理深度", "兼顾模型能力与已知成本", "优先已知低成本资源，减少额外审查"][index]}</small>
					{config ? summary(config) : <small>{scanning ? "读取可用资源中" : "需要可用的主控和至少一个外部模型"}</small>}
					{row && <small>{ACCESS_LABELS[row.access]} · {cost ? "自定成本" + { low: "低", medium: "中", high: "高" }[cost] : row.billing === "subscription" ? "使用订阅额度" : "实现模型价格未知"}</small>}
					{identical !== undefined && identical >= 0 && <small>当前资源下与「{TIERS[identical]}」配置相同</small>}
					<div className="multi-toolbar"><button type="button" className={btn} disabled={!config || busy || scanning}
						onClick={() => config && void change({ type: "apply", name: tier, config })}>应用{tier}</button>
					<button type="button" className={btn} disabled={!config || busy} onClick={() => config && edit(config, tier + " · 自定义")}>基于此方案编辑</button></div>
				</section>;
			})}</div>
			<details><summary>模型资源和成本标记（{resources.length}）</summary>
				{catalog?.sources.map(s => <small key={s.id}>{s.id} · {s.issue ?? s.models.length + " 个模型"}</small>)}
				<select aria-label="模型资源" value={resource} onChange={e => setResource(e.target.value)}><option value="">选择模型查看权限和价格</option>
					{resources.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
				{resource && <><small>{resources.find(m => m.key === resource)?.detail}</small>
					{(["quality", "cost"] as const).map(key => <label key={key}>{key === "quality" ? "能力标记" : "成本标记"}
						<select disabled={busy} value={rating[key] ?? ""} onChange={e => void change({ type: "rate", key: resource, rating: { ...rating, [key]: e.target.value || undefined } as ModelRating })}>
							<option value="">自动</option>{Object.entries(key === "quality" ? { basic: "基础", balanced: "均衡", premium: "较强" } : { low: "低", medium: "中", high: "高" }).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
						</select></label>)}</>}
			</details>
			<strong>我的方案</strong>
			<div className="multi-toolbar"><select aria-label="已保存方案" value={selected} disabled={busy} onChange={e => {
				const p = library.saved.find(v => v.name === e.target.value);
				if (p) edit(p.config, p.name, p.name); else edit(settings.multiAgent ?? {}, "");
			}}><option value="">新建 / 当前配置</option>{library.saved.map(p => <option key={p.name}>{p.name}</option>)}</select>
			<input aria-label="方案名称" maxLength={60} placeholder="方案名称" value={name} onChange={e => setName(e.target.value)} />
			<button type="button" className={btn} disabled={!canSave}
				onClick={() => void change({ type: "save", name, config: multiAgentFromDraft(draft) })}>{selected === name.trim() && selected ? "更新方案" : "另存方案"}</button>
			<button type="button" className={btn} disabled={!canSave} onClick={() => void change({ type: "saveAndApply", name, config: multiAgentFromDraft(draft) })}>保存并应用</button>
			{selected && <><button type="button" className={btn} disabled={busy || !name.trim() || selected === name.trim()} onClick={() => void change({ type: "rename", name: selected, newName: name })}>重命名</button>
				<button type="button" className={btn} disabled={busy} onClick={() => void change({ type: "delete", name: selected })}>删除方案</button>
				<button type="button" className={btn} disabled={busy} onClick={() => void change({ type: "activate", name: selected })}>应用已保存方案</button></>}
			</div>
			{notice && <p role="status">{notice}</p>}
			<div className="multi-roles"><label>默认实现执行器<select disabled={busy} value={routes.implementation ?? ""} onChange={e => route({ implementation: e.target.value as MultiExecutorId || undefined })}>
				<option value="">由主控选择</option>{allowed.map(id => <option key={id}>{id}</option>)}</select></label>
			<label>只读审查执行器<select disabled={busy} value={reviewer?.executor ?? ""} onChange={e => route({ reviewer: e.target.value ? { executor: e.target.value as MultiExecutorId } : undefined })}>
				<option value="">自动选择</option>{allowed.filter(id => id !== "kimi").map(id => <option key={id}>{id}</option>)}</select></label>
			{reviewer && <><label>审查模型<input list="multi-review-models" value={reviewer.model ?? ""} placeholder="执行器默认" onChange={e => route({ reviewer: { ...reviewer, model: e.target.value, effort: undefined } })} /></label>
				<datalist id="multi-review-models">{reviewerModels?.map(m => <option key={m.id}>{m.id}</option>)}</datalist>
				<label>审查思考强度<input list="multi-review-efforts" value={reviewer.effort ?? ""} placeholder="执行器默认" onChange={e => route({ reviewer: { ...reviewer, effort: e.target.value } })} /></label>
				<datalist id="multi-review-efforts">{reviewerModels?.find(m => m.id === reviewer.model)?.efforts.map(v => <option key={v}>{v}</option>)}</datalist></>}
			<label>实现任务委派<select disabled={busy} value={routes.parallelism ?? ""} onChange={e => route({ parallelism: e.target.value as typeof routes.parallelism || undefined })}>
				<option value="">主控默认</option><option value="single">默认逐个执行</option><option value="parallel">独立任务并行</option></select></label>
			<label>审查策略<select disabled={busy} value={routes.reviewPolicy ?? ""} onChange={e => route({ reviewPolicy: e.target.value as typeof routes.reviewPolicy || undefined })}>
				<option value="">主控默认</option>{Object.entries(reviewLabels).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label></div>
			<div className="multi-toolbar">允许参与{MULTI_EXECUTORS.map(id => <label key={id}><input type="checkbox" disabled={busy} checked={allowed.includes(id)} onChange={e => {
				const ids = MULTI_EXECUTORS.filter(v => v === id ? e.target.checked : allowed.includes(v));
				route({ allowed: ids, implementation: ids.includes(routes.implementation!) ? routes.implementation : undefined, reviewer: reviewer && ids.includes(reviewer.executor) ? reviewer : undefined,
					fallbacks: routes.fallbacks?.filter(v => ids.includes(v)) });
			}} />{id}</label>)}</div>
			<div className="multi-toolbar">不可用时
				<select aria-label="添加备用执行器" disabled={busy} value="" onChange={e => route({ fallbacks: [...(routes.fallbacks ?? []), e.target.value as MultiExecutorId] })}>
					<option value="">{routes.fallbacks?.length ? "添加下一顺位" : "停止并提示（可添加备用）"}</option>
					{allowed.filter(id => !routes.fallbacks?.includes(id)).map(id => <option key={id}>{id}</option>)}</select>
				{routes.fallbacks?.map(id => <button type="button" className={btn} key={id} disabled={busy} onClick={() => route({ fallbacks: routes.fallbacks?.filter(v => v !== id) })}>{id} ×</button>)}
			</div>
		</div>
	</MultiAgentSettingsFields>;
}
