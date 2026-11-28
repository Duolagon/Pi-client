import { MULTI_EXECUTORS, type MultiAgentSettings, type MultiExecutorId, type ProviderPreset, type ThinkingLevel } from "../shared.ts";
import { EXECUTOR_EFFORTS } from "../multi-agent.ts";
import { SelectPopover } from "./SelectPopover.tsx";

/** Editable form of the multi tier settings: "" means "keep the default". */
export interface MultiAgentDraft {
	routes: Pick<MultiAgentSettings, "implementation" | "reviewer" | "allowed" | "fallbacks" | "reviewPolicy" | "parallelism">;
	controllerModel: string;
	controllerThinking: string;
	executors: Record<MultiExecutorId, { model: string; effort: string }>;
}

const THINKING: Array<{ value: ThinkingLevel; label: string }> = [
	{ value: "off", label: "关闭" }, { value: "minimal", label: "极低" }, { value: "low", label: "低" },
	{ value: "medium", label: "中" }, { value: "high", label: "高" }, { value: "xhigh", label: "超高" }, { value: "max", label: "最高" },
];
const EXECUTORS: Record<MultiExecutorId, { title: string; models: string[]; hint: string }> = {
	codex: { title: "Codex", models: [],
		hint: "填 Codex 的模型名（终端里 codex 的 /model 可查）；启动时会核对，填错会直接报错并列出可用模型。" },
	claude: { title: "Claude Code", models: ["opus", "sonnet", "haiku"],
		hint: "可填别名（opus / sonnet / haiku）或完整模型 ID。" },
	kimi: { title: "Kimi Code", models: [],
		hint: "填写 Kimi ACP 会话公布的思考强度选项 ID。留空沿用 CLI 设置。" },
};

export function multiAgentDraft(settings: MultiAgentSettings | undefined): MultiAgentDraft {
	const model = settings?.controller?.model;
	return {
		routes: { parallelism: settings?.parallelism, implementation: settings?.implementation, reviewer: settings?.reviewer, allowed: settings?.allowed, fallbacks: settings?.fallbacks, reviewPolicy: settings?.reviewPolicy },
		controllerModel: model ? `${model.provider}/${model.id}` : "",
		controllerThinking: settings?.controller?.thinkingLevel ?? "",
		executors: Object.fromEntries(MULTI_EXECUTORS.map((id) => [id, {
			model: settings?.executors?.[id]?.model ?? "", effort: settings?.executors?.[id]?.effort ?? "",
		}])) as MultiAgentDraft["executors"],
	};
}

export function multiAgentFromDraft(draft: MultiAgentDraft): MultiAgentSettings {
	const result: MultiAgentSettings = { ...draft.routes };
	const at = draft.controllerModel.indexOf("/");
	const model = at > 0 && at < draft.controllerModel.length - 1
		? { provider: draft.controllerModel.slice(0, at), id: draft.controllerModel.slice(at + 1) } : undefined;
	if (model || draft.controllerThinking)
		result.controller = { ...(model ? { model } : {}), ...(draft.controllerThinking ? { thinkingLevel: draft.controllerThinking as ThinkingLevel } : {}) };
	const executors: NonNullable<MultiAgentSettings["executors"]> = {};
	for (const id of MULTI_EXECUTORS) {
		const entry = draft.executors[id];
		const value = { ...(entry.model.trim() ? { model: entry.model.trim() } : {}), ...(entry.effort ? { effort: entry.effort } : {}) };
		if (value.model || value.effort) executors[id] = value;
	}
	if (Object.keys(executors).length) result.executors = executors;
	return result;
}

/**
 * Controller choices: models the conversation can reach plus the DeepSeek presets, which stay
 * listed so DeepSeek can be chosen before its key is configured.
 */
function controllerOptions(models: Array<{ provider: string; id: string; name: string }>, presets: ProviderPreset[], current: string) {
	const seen = new Set<string>();
	const options: Array<{ value: string; label: string }> = [{ value: "", label: "沿用会话当前模型" }];
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) { seen.add(key); options.push({ value: key, label: `${model.name || model.id} · ${model.provider}` }); }
	}
	for (const model of presets.find((item) => item.provider === "deepseek")?.models ?? []) {
		const key = `desktop-deepseek/${model.id}`;
		if (!seen.has(key)) { seen.add(key); options.push({ value: key, label: `${model.name || model.id} · DeepSeek（需先配置 DeepSeek 密钥）` }); }
	}
	if (current && !seen.has(current)) options.push({ value: current, label: `${current}（当前不可用）` });
	return options;
}

export function MultiAgentSettingsFields({ draft, setDraft, models, presets, disabled, catalog, children }: {
	draft: MultiAgentDraft;
	setDraft: (update: (current: MultiAgentDraft) => MultiAgentDraft) => void;
	models: Array<{ provider: string; id: string; name: string }>;
	presets: ProviderPreset[];
	disabled: boolean;
	catalog?: import("../multi-profiles.ts").MultiCatalog;
	children?: import("react").ReactNode;
}) {
	const setExecutor = (id: MultiExecutorId, patch: Partial<{ model: string; effort: string }>) =>
		setDraft((current) => ({ ...current, executors: { ...current.executors, [id]: { ...current.executors[id], ...patch } } }));
	return (
		<fieldset className="live-routing live-multi">
			<legend>multi 档位：外部 Agent 协作</legend>
			<small>会话切到 multi 档位后，主控模型负责拆分任务、审查 diff 并合并；改代码交给 Codex / Claude Code / Kimi Code，各自用本机 CLI 的账号和额度。留空表示沿用默认。</small>
			{children}
			<div className="field-label">
				主控模型
				<SelectPopover ariaLabel="主控模型" field direction="down" value={draft.controllerModel} disabled={disabled}
					options={controllerOptions(models, presets, draft.controllerModel)}
					onChange={(value) => setDraft((current) => ({ ...current, controllerModel: value }))} />
				<small>multi 档位的每一轮开始前切到这个模型；它不可用时会提示，并继续用当前模型。</small>
			</div>
			<div className="field-label">
				主控思考强度
				<SelectPopover ariaLabel="主控思考强度" field direction="down" value={draft.controllerThinking} disabled={disabled}
					options={[{ value: "", label: "沿用会话当前设置" }, ...THINKING]}
					onChange={(value) => setDraft((current) => ({ ...current, controllerThinking: value }))} />
			</div>
			{MULTI_EXECUTORS.map((id) => {
				const info = EXECUTORS[id];
				const entry = draft.executors[id];
				const discovered = catalog?.sources.find(s => s.id === id)?.models ?? [];
				const modelNames = discovered.length ? discovered.map(m => m.id) : info.models;
				const nativeEfforts = discovered.find(m => m.id === entry.model)?.efforts;
				const efforts = nativeEfforts ?? EXECUTOR_EFFORTS[id];
				const listId = `multi-models-${id}`;
				return (
					<div className="field-label live-multi-executor" key={id}>
						{info.title}
						<div className="live-multi-row">
							<input aria-label={`${info.title} 模型`} list={modelNames.length ? listId : undefined} placeholder="模型：CLI 默认"
								value={entry.model} disabled={disabled} spellCheck={false}
								onChange={(event) => setExecutor(id, { model: event.target.value })} />
							{modelNames.length > 0 && <datalist id={listId}>{modelNames.map((model) => <option key={model} value={model} />)}</datalist>}
							{efforts ? (
								<SelectPopover ariaLabel={`${info.title} 思考强度`} field direction="down" value={entry.effort} disabled={disabled}
									options={[
										{ value: "", label: "思考强度：默认" },
										...efforts.map((effort) => ({ value: effort, label: effort })),
										...(entry.effort && !efforts.includes(entry.effort) ? [{ value: entry.effort, label: entry.effort }] : []),
									]}
									onChange={(value) => setExecutor(id, { effort: value })} />
							) : (
								<input aria-label={`${info.title} 思考强度`} placeholder="思考强度：默认" value={entry.effort} disabled={disabled} spellCheck={false}
									onChange={(event) => setExecutor(id, { effort: event.target.value.trim() })} />
							)}
						</div>
						<small>{info.hint}</small>
					</div>
				);
			})}
		</fieldset>
	);
}
