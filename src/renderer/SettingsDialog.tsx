import { useEffect, useRef, useState } from "react";
import { Bell, Bot, Globe, Plug, Route, ShieldCheck } from "lucide-react";
import type {
	ConnectionInput,
	ConnectionMode,
	ConnectionProtocol,
	ConnectionTestResult,
	ProviderBalanceResult,
	DesktopAPI,
	EditorChoice,
	OutputStyleInfo,
	PermissionMode,
	Provider,
	ProviderPreset,
	SandboxStatus,
	Settings,
	Snapshot,
} from "../shared.ts";
import { Modal } from "../prototype/ui.tsx";
import { useConfirmation } from "./ConfirmationDialog.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import { SelectPopover } from "./SelectPopover.tsx";
import { SmoothCollapse } from "./SmoothCollapse.tsx";
import { parseForegroundMinutes } from "./settings-input.ts";
import { MODEL_ROUTING_ROLES, type ModelRoutingRole } from "../agent-types.ts";

const ROUTING_LABELS: Record<ModelRoutingRole, { title: string; hint: string }> = {
	explore: { title: "Explore（检索）", hint: "只读找代码，适合便宜快速的模型" },
	plan: { title: "Plan（规划）", hint: "只读出方案，适合推理强的模型" },
	review: { title: "Review（审查）", hint: "只读审改动，选一个和主模型不同的模型做交叉审查" },
};

interface ConnectionDraft {
	mode: ConnectionMode;
	apiKey: string;
	keyCommand: string;
	headerText: string;
	clearHeaders: boolean;
	baseUrl: string;
	modelId: string;
	api: ConnectionProtocol;
	customModel: boolean;
	advanced: boolean;
	makeDefault: boolean;
}

/** "provider/id" select value for each role; "" means inherit the parent's model. */
function routingKeys(routing: Settings["modelRouting"]): Record<ModelRoutingRole, string> {
	const keys = { explore: "", plan: "", review: "" };
	for (const role of MODEL_ROUTING_ROLES) {
		const ref = routing?.[role];
		if (ref) keys[role] = `${ref.provider}/${ref.id}`;
	}
	return keys;
}

function parseRoutingKey(key: string): { provider: string; id: string } | undefined {
	const at = key.indexOf("/");
	return at > 0 && at < key.length - 1 ? { provider: key.slice(0, at), id: key.slice(at + 1) } : undefined;
}

const protocols: { value: ConnectionProtocol; label: string }[] = [
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "openai-completions", label: "OpenAI Chat Completions（兼容接口）" },
	{ value: "google-generative-ai", label: "Google Gemini" },
];

function connectionValues(settings: Settings, preset: ProviderPreset) {
	const stored = settings.connections[preset.provider];
	const preferred =
		settings.defaultModel?.provider === `desktop-${preset.provider}` ? settings.defaultModel.id : undefined;
	const modelId = preferred ?? stored?.modelId ?? preset.defaultModelId;
	const unknownModel = !preset.models.some((model) => model.id === modelId);
	const mode: ConnectionMode = stored?.mode ?? (stored?.baseUrl || stored?.api || unknownModel ? "custom" : "preset");
	return {
		mode,
		keyCommand: stored?.keyCommand ?? "",
		headerNames: stored?.headerNames ?? [],
		modelId: mode === "preset" && unknownModel ? preset.defaultModelId : modelId,
		baseUrl: stored?.baseUrl ?? "",
		api: stored?.api ?? preset.models.find((model) => model.id === modelId)?.api ?? preset.api,
	};
}

/** Parses "Name: value" lines into headers, or returns an error message. */
export function parseHeaderLines(text: string): Record<string, string> | string {
	const headers: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) return `请求头格式应为“名称: 值”：${line.slice(0, 40)}`;
		const name = line.slice(0, colon).trim();
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) return `请求头名称无效：${name.slice(0, 40)}`;
		headers[name] = line.slice(colon + 1).trim();
	}
	return headers;
}

export function SettingsDialog({
	settings,
	presets,
	models = [],
	connectionOnly = false,
	busy,
	close,
	apply,
	onSaved,
}: {
	settings: Settings;
	presets: ProviderPreset[];
	/** Models the active conversation can reach; routing choices are limited to these. */
	models?: Array<{ provider: string; id: string; name: string }>;
	busy: boolean;
	connectionOnly?: boolean;
	close: () => void;
	apply: (snapshot: Snapshot) => void;
	fail: (error: unknown) => void;
	onSaved?: () => void;
}) {
	const initialProvider =
		presets.find((item) => settings.defaultModel?.provider === `desktop-${item.provider}`)?.provider ??
		settings.configuredProviders[0] ??
		presets.find((item) => settings.connections[item.provider])?.provider ??
		presets[0].provider;
	const initialPreset = presets.find((item) => item.provider === initialProvider)!;
	const initial = connectionValues(settings, initialPreset);
	const [permission, setPermission] = useState<PermissionMode>(settings.permission);
	const [theme, setTheme] = useState<Settings["theme"]>(settings.theme);
	const [sandbox, setSandbox] = useState<boolean>(Boolean(settings.sandbox));
	const [notifications, setNotifications] = useState<boolean>(settings.notifications !== false);
	const [subagentBackground, setSubagentBackground] = useState<boolean>(settings.subagentDefaultBackground !== false);
	const initialForegroundMinutes = String(Math.round((settings.foregroundSubagentTimeoutMs ?? 0) / 60000));
	const [foregroundMinutes, setForegroundMinutes] = useState(initialForegroundMinutes);
	const [forkSubagent, setForkSubagent] = useState<boolean>(settings.forkSubagent !== false);
	const [confineSubagentBash, setConfineSubagentBash] = useState<boolean>(settings.confineSubagentBash !== false);
	const [maxSubagentDepthText, setMaxSubagentDepthText] = useState(String(settings.maxSubagentDepth ?? 1));
	const [maxConcurrentText, setMaxConcurrentText] = useState(String(settings.maxConcurrentSubagents ?? 8));
	const [cronEnabled, setCronEnabled] = useState<boolean>(settings.cronEnabled !== false);
	const [agentTeams, setAgentTeams] = useState<boolean>(settings.agentTeams === true);
	const initialRouting = routingKeys(settings.modelRouting);
	const [routing, setRouting] = useState<Record<ModelRoutingRole, string>>(initialRouting);
	const initialFallback = settings.fallbackModel ? `${settings.fallbackModel.provider}/${settings.fallbackModel.id}` : "";
	const [fallbackModel, setFallbackModel] = useState(initialFallback);
	const initialGrailModel = settings.grailModel ? `${settings.grailModel.provider}/${settings.grailModel.id}` : "";
	const [grailModel, setGrailModel] = useState(initialGrailModel);
	const initialGrailCost = settings.grailMaxCost !== undefined ? String(settings.grailMaxCost) : "";
	const [grailCostText, setGrailCostText] = useState(initialGrailCost);
	const initialGrailTimeout = settings.grailTimeoutSec !== undefined ? String(settings.grailTimeoutSec) : "";
	const [grailTimeoutText, setGrailTimeoutText] = useState(initialGrailTimeout);
	const [sandboxOffline, setSandboxOffline] = useState(Boolean(settings.sandboxOffline));
	const [sandboxInfo, setSandboxInfo] = useState<SandboxStatus | null>(null);
	const [provider, setProvider] = useState<Provider>(initialProvider);
	const [mode, setMode] = useState<ConnectionMode>(initial.mode);
	const [agentDir, setAgentDir] = useState(settings.agentDir ?? "");
	const [proxy, setProxy] = useState(settings.proxy ?? "");
	const [noProxy, setNoProxy] = useState(settings.noProxy ?? "");
	const [caFile, setCaFile] = useState(settings.caFile ?? "");
	const [apiKey, setApiKey] = useState("");
	const [keyCommand, setKeyCommand] = useState(initial.keyCommand);
	const [headerText, setHeaderText] = useState("");
	const [clearHeaders, setClearHeaders] = useState(false);
	const [maxCostText, setMaxCostText] = useState(settings.maxCostUsd ? String(settings.maxCostUsd) : "");
	const [disableAllHooks, setDisableAllHooks] = useState(settings.disableAllHooks === true);
	const [statusBalance, setStatusBalance] = useState(settings.statusBalance !== false);
	const [webSearchEnabled, setWebSearchEnabled] = useState(settings.webSearchEnabled !== false);
	const [webSearchApiKey, setWebSearchApiKey] = useState("");
	const [clearWebSearchKey, setClearWebSearchKey] = useState(false);
	const initialOutputStyle = settings.outputStyle ?? "default";
	const [outputStyle, setOutputStyle] = useState(initialOutputStyle);
	const [outputStyles, setOutputStyles] = useState<OutputStyleInfo[]>([]);
	const initialEditor: EditorChoice = settings.editor ?? "vscode";
	const [editor, setEditor] = useState<EditorChoice>(initialEditor);
	const [minBalanceText, setMinBalanceText] = useState(settings.minBalance ? String(settings.minBalance) : "");
	const [balance, setBalance] = useState<ProviderBalanceResult | null>(null);
	const [checkingBalance, setCheckingBalance] = useState(false);
	const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
	const [modelId, setModelId] = useState(initial.modelId);
	const [api, setApi] = useState<ConnectionProtocol>(initial.api);
	const [customModel, setCustomModel] = useState(!initialPreset.models.some((model) => model.id === initial.modelId));
	const [advanced, setAdvanced] = useState(initial.mode === "custom");
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState("");
	const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
	const [makeDefault, setMakeDefault] = useState(false);
	const [savedMessage, setSavedMessage] = useState("");
	const [section, setSection] = useState<"connection" | "appearance" | "budget" | "agents" | "routing" | "network">("connection");
	const connectionDrafts = useRef(new Map<Provider, ConnectionDraft>());
	const { confirm, confirmation } = useConfirmation();
	useEffect(() => {
		let mounted = true;
		void window.pi.sandboxStatus().then((status) => { if (mounted) setSandboxInfo(status); }).catch(() => {});
		void window.pi.outputStyles().then((styles) => { if (mounted) setOutputStyles(styles); }).catch(() => {});
		return () => { mounted = false; };
	}, []);
	const preset = presets.find((item) => item.provider === provider)!;
	const externalModel =
		settings.defaultModel && !settings.defaultModel.provider.startsWith("desktop-")
			? `${settings.defaultModel.provider}/${settings.defaultModel.id}`
			: undefined;
	const original = connectionValues(settings, preset);
	const model = preset.models.find((item) => item.id === modelId);
	const pending = saving || testing || checkingBalance;
	const storedKey = settings.configuredProviders.includes(provider);
	const hasKey = Boolean(apiKey.trim()) || storedKey || Boolean(keyCommand.trim());
	const isDefaultProvider = settings.defaultModel?.provider === `desktop-${provider}`;
	const generalSettingsChanged =
		permission !== settings.permission ||
		theme !== settings.theme ||
		sandbox !== Boolean(settings.sandbox) ||
		(sandbox && sandboxOffline) !== Boolean(settings.sandboxOffline) ||
		notifications !== (settings.notifications !== false) ||
		subagentBackground !== (settings.subagentDefaultBackground !== false) ||
		foregroundMinutes.trim() !== initialForegroundMinutes ||
		forkSubagent !== (settings.forkSubagent !== false) ||
		confineSubagentBash !== (settings.confineSubagentBash !== false) ||
		maxSubagentDepthText.trim() !== String(settings.maxSubagentDepth ?? 1) ||
		maxConcurrentText.trim() !== String(settings.maxConcurrentSubagents ?? 8) ||
		cronEnabled !== (settings.cronEnabled !== false) ||
		agentTeams !== (settings.agentTeams === true) ||
		MODEL_ROUTING_ROLES.some((role) => routing[role] !== initialRouting[role]) ||
		fallbackModel !== initialFallback ||
		grailModel !== initialGrailModel ||
		grailCostText.trim() !== initialGrailCost ||
		grailTimeoutText.trim() !== initialGrailTimeout ||
		agentDir.trim() !== (settings.agentDir ?? "") ||
		proxy.trim() !== (settings.proxy ?? "") ||
		noProxy.trim() !== (settings.noProxy ?? "") ||
		caFile.trim() !== (settings.caFile ?? "") ||
		maxCostText.trim() !== (settings.maxCostUsd ? String(settings.maxCostUsd) : "") ||
		minBalanceText.trim() !== (settings.minBalance ? String(settings.minBalance) : "") ||
		disableAllHooks !== (settings.disableAllHooks === true) ||
		statusBalance !== (settings.statusBalance !== false) ||
		webSearchEnabled !== (settings.webSearchEnabled !== false) ||
		Boolean(webSearchApiKey.trim()) ||
		clearWebSearchKey ||
		outputStyle !== initialOutputStyle ||
		editor !== initialEditor;
	const headersEdited = Boolean(headerText.trim()) || clearHeaders;
	const connectionChanged =
		Boolean(apiKey.trim()) ||
		keyCommand.trim() !== original.keyCommand ||
		headersEdited ||
		mode !== original.mode ||
		modelId.trim() !== original.modelId ||
		(mode === "custom" && (baseUrl.trim() !== original.baseUrl || api !== original.api)) ||
		(makeDefault && !isDefaultProvider);
	const useAsDefault = Boolean(connectionOnly || makeDefault || isDefaultProvider || !settings.defaultModel);
	const parsedHeaders = headerText.trim() ? parseHeaderLines(headerText) : {};
	const connectionInput: ConnectionInput = {
		provider,
		mode,
		apiKey: apiKey.trim() || undefined,
		...(keyCommand.trim() !== original.keyCommand ? { keyCommand: keyCommand.trim() } : {}),
		...(headersEdited && typeof parsedHeaders === "object" ? { headers: parsedHeaders } : {}),
		modelId: modelId.trim() || undefined,
		...(mode === "custom" ? { baseUrl: baseUrl.trim(), api } : {}),
	};
	const clearResult = () => {
		setError("");
		setTestResult(null);
		setBalance(null);
	};
	const selectProvider = (next: Provider) => {
		if (connectionChanged) connectionDrafts.current.set(provider, {
			mode, apiKey, keyCommand, headerText, clearHeaders, baseUrl, modelId, api, customModel, advanced, makeDefault,
		});
		else connectionDrafts.current.delete(provider);
		const nextPreset = presets.find((item) => item.provider === next)!;
		const values = connectionValues(settings, nextPreset);
		const draft = connectionDrafts.current.get(next);
		connectionDrafts.current.delete(next);
		setProvider(next);
		setMode(draft?.mode ?? values.mode);
		setApiKey(draft?.apiKey ?? "");
		setKeyCommand(draft?.keyCommand ?? values.keyCommand);
		setHeaderText(draft?.headerText ?? "");
		setClearHeaders(draft?.clearHeaders ?? false);
		setBaseUrl(draft?.baseUrl ?? values.baseUrl);
		setModelId(draft?.modelId ?? values.modelId);
		setApi(draft?.api ?? values.api);
		setCustomModel(draft?.customModel ?? !nextPreset.models.some((item) => item.id === values.modelId));
		setAdvanced(draft?.advanced ?? values.mode === "custom");
		setMakeDefault(draft?.makeDefault ?? false);
		clearResult();
	};
	const requestClose = async () => {
		if (pending) return;
		if ((generalSettingsChanged || connectionChanged || connectionDrafts.current.size > 0) && !await confirm({
			title: "放弃未保存的设置更改？", confirmLabel: "放弃更改", destructive: true,
		})) return;
		close();
	};
	const restorePreset = () => {
		setMode("preset");
		setBaseUrl("");
		setModelId(preset.defaultModelId);
		setCustomModel(false);
		setApi(preset.api);
		clearResult();
	};
	const save = async () => {
		setError("");
		if (connectionOnly) {
			if ((mode === "custom" && !modelId.trim()) || typeof parsedHeaders === "string" || (mode === "preset" && !hasKey)) {
				if (mode === "custom") setAdvanced(true);
				setError(typeof parsedHeaders === "string" ? parsedHeaders : mode === "custom" ? "请填写自定义模型 ID。" : `请填写 ${preset.name} 的 API Key。`);
				return;
			}
			setTesting(true);
			try {
				const verified = await window.pi.testConnection(connectionInput);
				setTestResult(verified);
				if (!verified.success) return;
				setTesting(false);
				setSaving(true);
				const next = await window.pi.saveSettings({ permission: settings.permission, theme: settings.theme, ...connectionInput });
				apply(next);
				if (next.engineError || !next.models.length) {
					setError(next.engineError || "模型暂不可用，请检查连接后重试。");
					return;
				}
				onSaved?.();
				close();
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			} finally {
				setTesting(false);
				setSaving(false);
			}
			return;
		}

		if (mode === "custom" && connectionChanged && !modelId.trim()) {
			setSection("connection");
			setAdvanced(true);
			setError("请填写自定义接口的模型 ID，或恢复官方预设。");
			return;
		}
		if (!connectionChanged && !generalSettingsChanged) {
			if (connectionDrafts.current.size) setSavedMessage("其他服务商还有未保存的连接更改。");
			else close();
			return;
		}
		if (!hasKey && mode === "preset" && connectionChanged) {
			setSection("connection");
			setError(`请填写 ${preset.name} 的 API Key。`);
			return;
		}
		// An emptied field is invalid rather than 0 ("wait without limit").
		const minutes = parseForegroundMinutes(foregroundMinutes);
		if (minutes === undefined) {
			setSection("agents");
			setError("前台子 Agent 等待时长需为 0–1440 分钟的整数。");
			return;
		}
		if (typeof parsedHeaders === "string") {
			setSection("connection");
			setAdvanced(true);
			setError(parsedHeaders);
			return;
		}
		const maxCost = maxCostText.trim() ? Number(maxCostText.trim()) : null;
		if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0.01 || maxCost > 100000)) {
			setSection("budget");
			setError("费用上限需为 0.01–100000 美元，留空表示不限制。");
			return;
		}
		const grailCost = grailCostText.trim() ? Number(grailCostText.trim()) : null;
		if (grailCost !== null && (!Number.isFinite(grailCost) || grailCost < 0.01 || grailCost > 1000)) {
			setSection("routing");
			setError("单次鉴定费用上限需为 0.01–1000 美元，留空表示默认 2 美元。");
			return;
		}
		const grailTimeout = grailTimeoutText.trim() ? Number(grailTimeoutText.trim()) : null;
		if (grailTimeout !== null && (!/^\d+$/.test(grailTimeoutText.trim()) || grailTimeout < 30 || grailTimeout > 7200)) {
			setSection("routing");
			setError("鉴定超时需为 30–7200 秒的整数，留空表示默认 900 秒。");
			return;
		}
		const minBalance = minBalanceText.trim() ? Number(minBalanceText.trim()) : null;
		if (minBalance !== null && (!Number.isFinite(minBalance) || minBalance < 0.01 || minBalance > 1000000)) {
			setSection("budget");
			setError("余额底线需为 0.01–1000000，留空表示不检查。");
			return;
		}
		const depthNum = Number(maxSubagentDepthText.trim());
		if (!/^\d+$/.test(maxSubagentDepthText.trim()) || !Number.isSafeInteger(depthNum) || depthNum < 1 || depthNum > 3) {
			setSection("agents");
			setError("子 Agent 最大嵌套深度需为 1–3 的整数。");
			return;
		}
		const concurrentNum = Number(maxConcurrentText.trim());
		if (!/^\d+$/.test(maxConcurrentText.trim()) || !Number.isSafeInteger(concurrentNum) || concurrentNum < 1 || concurrentNum > 20) {
			setSection("agents");
			setError("最大并发子 Agent 数量需为 1–20 的整数。");
			return;
		}
		setSaving(true);
		try {
			const update: Parameters<DesktopAPI["saveSettings"]>[0] = {
				permission, theme, sandbox, sandboxOffline: sandbox && sandboxOffline, notifications,
				subagentDefaultBackground: subagentBackground,
				...(foregroundMinutes.trim() !== initialForegroundMinutes ? { foregroundSubagentTimeoutMs: minutes * 60000 } : {}),
				forkSubagent,
				confineSubagentBash,
				...(maxSubagentDepthText.trim() !== String(settings.maxSubagentDepth ?? 1) ? { maxSubagentDepth: depthNum } : {}),
				...(maxConcurrentText.trim() !== String(settings.maxConcurrentSubagents ?? 8) ? { maxConcurrentSubagents: concurrentNum } : {}),
				cronEnabled,
				agentTeams,
				...(maxCostText.trim() !== (settings.maxCostUsd ? String(settings.maxCostUsd) : "") ? { maxCostUsd: maxCost } : {}),
				...(disableAllHooks !== (settings.disableAllHooks === true) ? { disableAllHooks } : {}),
				...(outputStyle !== initialOutputStyle ? { outputStyle: outputStyle === "default" ? null : outputStyle } : {}),
				...(editor !== initialEditor ? { editor } : {}),
				...(statusBalance !== (settings.statusBalance !== false) ? { statusBalance } : {}),
				...(webSearchEnabled !== (settings.webSearchEnabled !== false) ? { webSearchEnabled } : {}),
				...(clearWebSearchKey ? { webSearchApiKey: "" } : webSearchApiKey.trim() ? { webSearchApiKey: webSearchApiKey.trim() } : {}),
				...(minBalanceText.trim() !== (settings.minBalance ? String(settings.minBalance) : "") ? { minBalance } : {}),
			};
			if (MODEL_ROUTING_ROLES.some((role) => routing[role] !== initialRouting[role])) {
				// The backend replaces the whole map, so an omitted role means "inherit".
				const next: NonNullable<Settings["modelRouting"]> = {};
				for (const role of MODEL_ROUTING_ROLES) {
					const ref = parseRoutingKey(routing[role]);
					if (ref) next[role] = ref;
				}
				update.modelRouting = next;
			}
			if (fallbackModel !== initialFallback) update.fallbackModel = parseRoutingKey(fallbackModel) ?? null;
			if (grailModel !== initialGrailModel) update.grailModel = parseRoutingKey(grailModel) ?? null;
			if (grailCostText.trim() !== initialGrailCost) update.grailMaxCost = grailCost;
			if (grailTimeoutText.trim() !== initialGrailTimeout) update.grailTimeoutSec = grailTimeout;
			if (agentDir.trim() !== (settings.agentDir ?? "")) update.agentDir = agentDir.trim();
			if (proxy.trim() !== (settings.proxy ?? "")) update.proxy = proxy.trim();
			if (noProxy.trim() !== (settings.noProxy ?? "")) update.noProxy = noProxy.trim();
			if (caFile.trim() !== (settings.caFile ?? "")) update.caFile = caFile.trim();
			if (connectionChanged) Object.assign(update, connectionInput, { useAsDefault });
			const next = await window.pi.saveSettings(update);
			apply(next);
			setApiKey("");
			setMakeDefault(false);
			setWebSearchApiKey("");
			setClearWebSearchKey(false);
			setHeaderText("");
			setClearHeaders(false);
			if (next.engineError) {
				setError(`设置已保存，但模型暂不可用：${next.engineError}`);
				return;
			}
			onSaved?.();
			if (connectionDrafts.current.size) {
				setSavedMessage("已保存。其他服务商还有未保存的连接更改。");
				return;
			}
			close();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	const checkBalance = async () => {
		clearResult();
		if (typeof parsedHeaders === "string") {
			setAdvanced(true);
			setError(parsedHeaders);
			return;
		}
		setCheckingBalance(true);
		try {
			setBalance(await window.pi.providerBalance(connectionInput));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setCheckingBalance(false);
		}
	};
	const testConnection = async () => {
		clearResult();
		if (mode === "custom" && !modelId.trim()) {
			setAdvanced(true);
			setError("请填写自定义接口的模型 ID，或恢复官方预设。");
			return;
		}
		if (typeof parsedHeaders === "string") {
			setAdvanced(true);
			setError(parsedHeaders);
			return;
		}
		setTesting(true);
		try {
			if (agentDir.trim() !== (settings.agentDir ?? "")) throw new Error("请先保存 Pi 配置目录，再测试连接。");
			setTestResult(await window.pi.testConnection(connectionInput));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setTesting(false);
		}
	};
	const activeSection = connectionOnly ? "connection" : section;
	const navItems = [
		{ id: "connection" as const, label: "连接与模型", icon: Plug },
		{ id: "appearance" as const, label: "权限与外观", icon: ShieldCheck },
		{ id: "agents" as const, label: "Agent 与自动化", icon: Bot },
		{ id: "routing" as const, label: "模型路由与评审", icon: Route },
		{ id: "budget" as const, label: "预算与通知", icon: Bell },
		{ id: "network" as const, label: "网络与证书", icon: Globe },
	];

	return (
		<>
		<Modal
			title={connectionOnly ? "连接模型" : "设置与模型连接"}
			wide={!connectionOnly}
			className={connectionOnly ? "" : "cc-settings-modal"}
			close={() => void requestClose()}
		>
			<form
				className={`simple-dialog live-settings ${connectionOnly ? "" : "cc-settings-layout"}`.trim()}
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				{!connectionOnly && (
					<nav className="cc-settings-nav" aria-label="设置分类">
						<SlidingTabList variant="nav" className="cc-settings-nav-track">
							{navItems.map((item) => {
								const Icon = item.icon;
								const active = activeSection === item.id;
								return (
									<button
										key={item.id}
										type="button"
										className={`cc-settings-nav-btn ${active ? "active" : ""}`}
										aria-current={active ? "page" : undefined}
										onClick={() => setSection(item.id)}
									>
										<Icon size={15} aria-hidden="true" />
										<span>{item.label}</span>
									</button>
								);
							})}
						</SlidingTabList>
					</nav>
				)}
				<div className="cc-settings-main">
				<div key={activeSection} className="cc-settings-pane">
				{activeSection === "connection" && (
				<>
				<div className="live-settings-intro">
					<h3>连接模型服务</h3>
					<p className="subtle-note">选择服务商并填写 API Key，即可使用预设模型。已有 Pi 配置会自动读取。</p>
					{externalModel && (
						<p className="subtle-note cc-settings-current">
							当前使用 Pi 配置中的模型 {externalModel}。不填 API Key 时，保存只更新下面的设置，模型保持不变。
						</p>
					)}
				</div>
				<div className="field-label">
					模型服务商
					<SelectPopover
						ariaLabel="模型服务商"
						field
						direction="down"
						value={provider}
						disabled={pending}
						options={presets.map((item) => ({
							value: item.provider,
							label: `${item.name}${settings.configuredProviders.includes(item.provider) ? " · 已连接" : ""}`,
							hint: settings.configuredProviders.includes(item.provider) ? "已连接" : undefined,
						}))}
						onChange={(val) => selectProvider(val as Provider)}
					/>
				</div>
				<label className="field-label">
					<span className="live-setting-label">
						API Key {storedKey && <span className="live-setting-saved">已保存</span>}
					</span>
					<input
						aria-label="API Key"
						type="password"
						autoComplete="off"
						placeholder={storedKey ? "留空保留已有密钥" : `填写 ${preset.name} 的 API Key`}
						value={apiKey}
						disabled={pending}
						onChange={(event) => {
							setApiKey(event.target.value);
							clearResult();
						}}
					/>
				</label>
				<div className="field-label">
					默认模型
					<SelectPopover
						ariaLabel="默认模型"
						field
						direction="down"
						value={customModel ? "" : modelId}
						disabled={pending}
						options={[
							...preset.models.map((item) => ({
								value: item.id,
								label: `${item.name}${item.id === preset.defaultModelId ? "（推荐）" : ""}`,
							})),
							{ value: "", label: "自定义模型…" },
						]}
						onChange={(value) => {
							setCustomModel(value === "");
							if (value) {
								setModelId(value);
								if (mode === "preset") setApi(preset.models.find((item) => item.id === value)?.api ?? preset.api);
							} else {
								setMode("custom");
								setModelId("");
								setAdvanced(true);
							}
							clearResult();
						}}
					/>
				</div>
				{mode === "preset" ? (
					<div className="live-provider-summary">
						<strong>{preset.name} 官方接口已预设</strong>
						<p>无需填写 API 地址、接口协议或模型 ID。</p>
						{model && (
							<span>
								{model.reasoning ? "支持思考" : "通用对话"} · {model.input.includes("image") ? "支持图片" : "文本输入"}{" "}
								· {model.contextWindow.toLocaleString()} Token 上下文
							</span>
						)}
					</div>
				) : (
					<div className="live-provider-summary custom">
						<strong>正在使用自定义接口</strong>
						<p>现有地址、协议和模型已保留，可在高级设置中调整。</p>
					</div>
				)}
				{!connectionOnly && !isDefaultProvider && settings.defaultModel && hasKey && (
					<label className="live-setting-toggle">
						<input type="checkbox" checked={makeDefault} disabled={pending || busy}
							onChange={(event) => setMakeDefault(event.target.checked)} />
						<span>将此连接设为默认模型</span>
					</label>
				)}
				<div className="live-settings-section">
					<button
						type="button"
						className="cc-settings-accordion-btn"
						aria-expanded={advanced}
						onClick={() => setAdvanced((v) => !v)}
					>
						<span>高级设置{mode === "custom" ? " · 自定义接口" : ""}</span>
						<span className={`cc-settings-chevron ${advanced ? "open" : ""}`} aria-hidden="true">›</span>
					</button>
					<SmoothCollapse open={advanced}>
					<div className="live-settings-section-content">
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="使用自定义接口"
								checked={mode === "custom"}
								disabled={pending}
								onChange={(event) => {
									if (event.target.checked) {
										setMode("custom");
										setApi(model?.api ?? preset.api);
										clearResult();
									} else restorePreset();
								}}
							/>
							<span>使用自定义接口或模型</span>
						</label>
						{mode === "custom" ? (
							<>
								<label className="field-label">
									API 地址
									<input
										aria-label="API 地址"
										type="url"
										placeholder={preset.baseUrl}
										value={baseUrl}
										disabled={pending}
										onChange={(event) => {
											setBaseUrl(event.target.value);
											clearResult();
										}}
									/>
								</label>
								<div className="field-label">
									接口协议
									<SelectPopover
										ariaLabel="接口协议"
										field
										direction="down"
										value={api}
										disabled={pending}
										options={protocols.map((item) => ({ value: item.value, label: item.label }))}
										onChange={(val) => {
											setApi(val as ConnectionProtocol);
											clearResult();
										}}
									/>
								</div>
								<label className="field-label">
									自定义模型 ID
									<input
										aria-label="自定义模型 ID"
										value={modelId}
										disabled={pending}
										placeholder="填写接口提供的模型 ID"
										onChange={(event) => {
											setModelId(event.target.value);
											setCustomModel(!preset.models.some((item) => item.id === event.target.value));
											clearResult();
										}}
									/>
								</label>
								<button type="button" className="secondary-button" disabled={pending} onClick={restorePreset}>
									恢复官方预设
								</button>
							</>
						) : (
							<p className="subtle-note">已使用 {preset.baseUrl}，模型参数由服务商预设自动配置。</p>
						)}
						<label className="field-label">
							取 Key 命令（可选）
							<input
								aria-label="取 Key 命令"
								placeholder="例如 security find-generic-password -s my-llm -w"
								autoComplete="off"
								spellCheck={false}
								value={keyCommand}
								disabled={pending}
								onChange={(event) => {
									setKeyCommand(event.target.value);
									clearResult();
								}}
							/>
							<small>没有保存 API Key 时，用这条命令的输出作为 Key（类似 Claude Code 的 apiKeyHelper）。每次启动模型进程时运行一次。</small>
						</label>
						<label className="field-label">
							<span className="live-setting-label">
								自定义请求头（可选）
								{original.headerNames.length > 0 && !clearHeaders && (
									<span className="live-setting-saved">已保存 {original.headerNames.join("、")}</span>
								)}
							</span>
							<textarea
								aria-label="自定义请求头"
								rows={3}
								placeholder={original.headerNames.length ? "留空保留已保存的请求头；填写会整体替换" : "每行一个，例如 X-Org-Id: team-a"}
								spellCheck={false}
								value={headerText}
								disabled={pending}
								onChange={(event) => {
									setHeaderText(event.target.value);
									if (event.target.value.trim()) setClearHeaders(false);
									clearResult();
								}}
							/>
							<small>每行“名称: 值”，随每个模型请求发送。值会加密保存，界面不再显示。</small>
						</label>
						{original.headerNames.length > 0 && !headerText.trim() && (
							<label className="live-setting-toggle">
								<input
									type="checkbox"
									aria-label="清除已保存的请求头"
									checked={clearHeaders}
									disabled={pending}
									onChange={(event) => {
										setClearHeaders(event.target.checked);
										clearResult();
									}}
								/>
								<span>清除已保存的请求头</span>
							</label>
						)}
						<div className="live-settings-config-dir">
							<label className="field-label">
								Pi 配置目录（可选）
								<input
									aria-label="Pi 配置目录"
									placeholder="~/.pi/agent"
									value={agentDir}
									disabled={pending}
									onChange={(event) => {
										setAgentDir(event.target.value);
										clearResult();
									}}
								/>
							</label>
							<p className="subtle-note">留空使用 Pi 标准目录，已有模型和登录配置继续生效。</p>
						</div>
					</div>
					</SmoothCollapse>
				</div>
				</>
				)}
				{activeSection === "network" && (
					<div className="cc-settings-card">
						<div className="live-settings-intro">
							<h3>网络代理与 TLS 证书</h3>
							<p className="subtle-note">配置模型连接与 WebFetch 使用的本地代理、绕过规则和企业自定义根证书。</p>
						</div>
						<label className="field-label">
							代理地址
							<input
								aria-label="代理地址"
								placeholder="http://127.0.0.1:7890"
								autoComplete="off"
								spellCheck={false}
								value={proxy}
								disabled={pending || busy}
								onChange={(event) => setProxy(event.target.value)}
							/>
							<small>用于模型请求和 WebFetch。留空时沿用终端里的 HTTPS_PROXY / HTTP_PROXY（从 Finder 启动也会读取）。</small>
						</label>
						<label className="field-label">
							不走代理的地址
							<input
								aria-label="不走代理的地址"
								placeholder="localhost,127.0.0.1,.internal.example.com"
								autoComplete="off"
								spellCheck={false}
								value={noProxy}
								disabled={pending || busy}
								onChange={(event) => setNoProxy(event.target.value)}
							/>
							<small>逗号分隔，对应 NO_PROXY。</small>
						</label>
						<label className="field-label">
							自定义 CA 证书
							<input
								aria-label="自定义 CA 证书"
								placeholder="/path/to/company-ca.pem"
								autoComplete="off"
								spellCheck={false}
								value={caFile}
								disabled={pending || busy}
								onChange={(event) => setCaFile(event.target.value)}
							/>
							<small>PEM 文件的绝对路径，公司网络做 HTTPS 解密时需要。保存后会重启当前会话的模型进程。</small>
						</label>
					</div>
				)}
				{activeSection === "appearance" && (
					<div className="cc-settings-card">
						<div className="live-settings-intro">
							<h3>权限策略与界面外观</h3>
							<p className="subtle-note">管理新建会话的默认权限、客户端主题色、输出风格与 Seatbelt 系统级沙箱隔离。</p>
						</div>
						<div className="field-label">
							默认权限
							<SelectPopover
								ariaLabel="默认权限"
								field
								direction="down"
								value={permission}
								disabled={pending || busy}
								options={[
									{ value: "ask", label: "手动确认：写文件和运行工具前询问" },
									{ value: "acceptEdits", label: "接受编辑：项目内文件编辑自动允许，命令仍按规则询问" },
									{ value: "plan", label: "计划模式：只读调研、子 Agent 与写入 .pi/plans/，批准后实施" },
									{ value: "auto", label: "全部放行（危险）：除规则外不再询问，命令以本机权限运行" },
									{ value: "dontAsk", label: "不询问（未放行即拒绝）：不弹审批，规则或安全默认未放行的操作直接拒绝" },
									{ value: "read", label: "只读：仅允许读取与搜索" },
								]}
								onChange={(val) => setPermission(val as PermissionMode)}
							/>
							<small>为未单独设置权限的会话使用。输入框旁的权限选择只影响当前会话。</small>
						</div>
						<div className="field-label">
							外观
							<SelectPopover
								ariaLabel="外观"
								field
								direction="down"
								value={theme}
								disabled={pending}
								options={[
									{ value: "light", label: "浅色（雾白 Mist）" },
									{ value: "dark", label: "深色（石墨 Graphite）" },
									{ value: "grail", label: "圣杯（二次元星夜）" },
									{ value: "system", label: "跟随系统" },
								]}
								onChange={(val) => setTheme(val as Settings["theme"])}
							/>
						</div>
						<div className="field-label">
							输出风格
							<SelectPopover
								ariaLabel="输出风格"
								field
								direction="down"
								value={outputStyle}
								disabled={pending}
								options={[
									...(!outputStyles.some((style) => style.name === outputStyle)
										? [{ value: outputStyle, label: outputStyle }]
										: []),
									...outputStyles.map((style) => ({
										value: style.name,
										label: `${style.name}${style.description ? `：${style.description}` : ""}${style.source === "user" ? "（用户）" : style.source === "project" ? "（项目）" : ""}`,
									})),
								]}
								onChange={(val) => setOutputStyle(val)}
							/>
							<small>只作用于主会话，子 Agent 不受影响。自定义风格放在 ~/.claude/output-styles 或已信任项目的 .claude/output-styles（Markdown）。下一轮对话生效。</small>
						</div>
						<div className="field-label">
							打开文件的编辑器
							<SelectPopover
								ariaLabel="打开文件的编辑器"
								field
								direction="down"
								value={editor}
								disabled={pending}
								options={[
									{ value: "vscode", label: "VS Code" },
									{ value: "cursor", label: "Cursor" },
									{ value: "system", label: "系统默认应用" },
								]}
								onChange={(val) => setEditor(val as EditorChoice)}
							/>
						</div>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="启用网络搜索 WebSearch"
								checked={webSearchEnabled}
								disabled={pending || busy}
								onChange={(event) => setWebSearchEnabled(event.target.checked)}
							/>
							<span>启用网络搜索（WebSearch：DeepSeek 模型自动使用免费内置搜索；其他模型走 DeepSeek Search API，约 $0.75 / 1000 次）</span>
						</label>
						{webSearchEnabled && (
							<div className="live-setting-sub">
								<label className="field-label">
									DeepSeek Search API Key
									<input
										type="password"
										aria-label="DeepSeek Search API Key"
										value={webSearchApiKey}
										disabled={pending || busy}
										placeholder={
											clearWebSearchKey
												? "保存后清除专用 Key"
												: settings.webSearchApiKeyConfigured
													? "已配置专用 Key（留空保持不变）"
													: settings.configuredProviders.includes("deepseek")
														? "留空将自动复用已配置的 DeepSeek 模型 Key"
														: "填写 DeepSeek API Key（sk-...）"
										}
										onChange={(event) => {
											setWebSearchApiKey(event.target.value);
											if (clearWebSearchKey) setClearWebSearchKey(false);
										}}
									/>
								</label>
								{settings.webSearchApiKeyConfigured && !clearWebSearchKey && (
									<button
										type="button"
										className="cc-mini-btn"
										disabled={pending || busy}
										onClick={() => {
											setWebSearchApiKey("");
											setClearWebSearchKey(true);
										}}
									>
										清除专用 Search Key
									</button>
								)}
							</div>
						)}
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="开启 macOS 命令沙箱"
								checked={sandbox}
								disabled={pending || busy || (!sandbox && sandboxInfo?.supported === false)}
								onChange={(event) => setSandbox(event.target.checked)}
							/>
							<span>macOS Seatbelt 命令沙箱与内置文件保护</span>
						</label>
						{sandbox && (
							<div className="live-setting-sub">
								<label className="live-setting-toggle">
									<input
										type="checkbox"
										aria-label="禁止 Bash 命令访问网络"
										checked={sandboxOffline}
										disabled={pending || busy}
										onChange={(event) => setSandboxOffline(event.target.checked)}
									/>
									<span>禁止 Bash 命令访问网络</span>
								</label>
								<small>适用于模型的 Bash 和单次命令。交互终端、MCP、Hooks 和模型连接使用各自的权限。</small>
							</div>
						)}
						{sandboxInfo && !sandboxInfo.supported && (
							<p className="subtle-note">当前运行环境不支持嵌套 Seatbelt 沙箱：{sandboxInfo.reason}</p>
						)}
					</div>
				)}
				{activeSection === "budget" && (
					<div className="cc-settings-card">
						<div className="live-settings-intro">
							<h3>费用预算与桌面通知</h3>
							<p className="subtle-note">设置单会话累计消费熔断阈值、账户余额止损底线与后台提醒。</p>
						</div>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="任务桌面通知"
								checked={notifications}
								disabled={pending || busy}
								onChange={(event) => setNotifications(event.target.checked)}
							/>
							<span>窗口未聚焦时发送任务完成/待审批系统通知</span>
						</label>
						<label className="field-label">
							单个会话费用上限（美元，可选）
							<input
								type="number"
								aria-label="单个会话费用上限"
								min={0.01}
								step="0.01"
								placeholder="不限制"
								value={maxCostText}
								disabled={pending || busy}
								onChange={(event) => setMaxCostText(event.target.value)}
							/>
							<small>按模型返回的用量和价格累计，包含子 Agent。达到上限后当前回合停止，之后的消息不再发送。服务商没有提供价格时无法统计，可改用下面的余额底线。</small>
						</label>
						<label className="field-label">
							账户余额底线（可选）
							<input
								type="number"
								aria-label="账户余额底线"
								min={0.01}
								step="0.01"
								placeholder="不检查"
								value={minBalanceText}
								disabled={pending || busy}
								onChange={(event) => setMinBalanceText(event.target.value)}
							/>
							<small>适用于 DeepSeek、OpenRouter（需给 Key 设额度）、Kimi 和硅基流动的官方地址。发送前和每轮结束后查询服务商余额，降到底线时停止。金额按服务商的结算币种计算（DeepSeek 一般为人民币）。服务商更新余额有延迟，属于事后止损；查询失败时不会拦截。</small>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="状态栏显示账户余额"
								checked={statusBalance}
								disabled={pending || busy}
								onChange={(event) => setStatusBalance(event.target.checked)}
							/>
							<span>状态栏显示账户余额（支持余额查询的服务商，每分钟最多查询一次）</span>
						</label>
					</div>
				)}
				{activeSection === "agents" && (
					<div className="cc-settings-card">
						<div className="live-settings-intro">
							<h3>Agent 编排与自动化</h3>
							<p className="subtle-note">配置子 Agent 并发、嵌套深度、Worktree 沙箱限制、定时唤醒与多成员协作。</p>
						</div>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="停用全部 Hooks"
								checked={disableAllHooks}
								disabled={pending || busy}
								onChange={(event) => setDisableAllHooks(event.target.checked)}
							/>
							<span>停用全部 Hooks（.claude/settings.json 与 .pi/hooks.json 中的 Hook 都不再运行）</span>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="子 Agent 默认后台运行"
								checked={subagentBackground}
								disabled={pending}
								onChange={(event) => setSubagentBackground(event.target.checked)}
							/>
							<span>子 Agent 默认后台运行（结果完成后自动送回主会话；非 Git 项目中的可写子 Agent 仍在前台运行）</span>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="允许 fork 子 Agent"
								checked={forkSubagent}
								disabled={pending}
								onChange={(event) => setForkSubagent(event.target.checked)}
							/>
							<span>允许模型使用 fork 方式继承当前对话上下文创建子 Agent</span>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="隔离可写 worktree 子 Agent Bash"
								checked={confineSubagentBash}
								disabled={pending}
								onChange={(event) => setConfineSubagentBash(event.target.checked)}
							/>
							<span>可写 worktree 子 Agent 在 macOS 上默认启用 Seatbelt，将 Bash 写操作限制在 worktree 目录内</span>
						</label>
						<div className="cc-settings-grid-2">
							<label className="field-label">
								前台子 Agent 最长等待（分钟）
								<input
									type="number"
									min={0}
									max={1440}
									step={1}
									value={foregroundMinutes}
									disabled={pending}
									onChange={(event) => setForegroundMinutes(event.target.value)}
								/>
								<small>超时自动转入后台；0 表示一直等待。</small>
							</label>
							<label className="field-label">
								最大嵌套深度（1–3）
								<input
									type="number"
									aria-label="子 Agent 最大嵌套深度"
									min={1}
									max={3}
									step={1}
									value={maxSubagentDepthText}
									disabled={pending}
									onChange={(event) => setMaxSubagentDepthText(event.target.value)}
								/>
								<small>默认 1（仅主会话委派）；2–3 允许递归委派。</small>
							</label>
						</div>
						<label className="field-label">
							每个父会话最大并发子 Agent 数（1–20）
							<input
								type="number"
								aria-label="最大并发子 Agent 数"
								min={1}
								max={20}
								step={1}
								value={maxConcurrentText}
								disabled={pending}
								onChange={(event) => setMaxConcurrentText(event.target.value)}
							/>
							<small>默认为 8；超过限制后模型需等待已有子 Agent 完成。</small>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="启用定时唤醒与 /loop 自动任务"
								checked={cronEnabled}
								disabled={pending}
								onChange={(event) => setCronEnabled(event.target.checked)}
							/>
							<span>启用定时唤醒与 /loop 自动任务（Cron / ScheduleWakeup）</span>
						</label>
						<p className="subtle-note cc-settings-callout" role="note">
							注意：开启定时唤醒后，到点且会话空闲时会自动触发模型回合，<strong>会自动消耗额度</strong>；任务默认 7 天后自动过期，对子 Agent 禁用。
						</p>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="实验性 Agent Teams 多成员协作"
								checked={agentTeams}
								disabled={pending || busy}
								onChange={(event) => setAgentTeams(event.target.checked)}
							/>
							<span>启用实验性 Agent Teams 多成员协作（TeamCreate / TeamDelete 与结构化团队消息）</span>
						</label>
						<div className="field-label">
							本地诊断日志
							<div>
								<button
									type="button"
									className="secondary-button"
									onClick={() => void window.pi.openLogDirectory().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}
								>
									打开日志目录
								</button>
							</div>
							<small>崩溃和引擎错误记录在本机，已去除密钥和用户目录，不含对话内容，不会上传。</small>
						</div>
					</div>
				)}
				{activeSection === "routing" && (
					<div className="cc-settings-card">
						<div className="live-settings-intro">
							<h3>模型路由与独立评审</h3>
							<p className="subtle-note">为容灾回退、Explore / Plan / Review 子角色与代码质量鉴定分别指定最优模型。</p>
						</div>
						<div className="field-label">
							备用模型（主模型过载时仅接手当前回合）
							<SelectPopover
								ariaLabel="备用模型"
								field
								direction="down"
								value={fallbackModel}
								disabled={pending}
								options={[
									{ value: "", label: "不使用" },
									...(fallbackModel && !models.some((m) => `${m.provider}/${m.id}` === fallbackModel)
										? [{ value: fallbackModel, label: `${fallbackModel}（当前不可用）` }]
										: []),
									...models.map((m) => ({
										value: `${m.provider}/${m.id}`,
										label: `${m.name || m.id} · ${m.provider}`,
									})),
								]}
								onChange={(val) => setFallbackModel(val)}
							/>
							<small>主模型因过载、限流或服务端错误在自动重试后仍失败时，切换到这里的模型并继续一次。</small>
						</div>
						<fieldset className="live-routing">
							<legend>{theme === "grail" ? "圣杯鉴定" : "质量鉴定"}</legend>
							<div className="field-label">
								评审模型
								<SelectPopover
									ariaLabel="鉴定评审模型"
									field
									direction="down"
									value={grailModel}
									disabled={pending}
									options={[
										{ value: "", label: "跟随当前会话" },
										...(grailModel && !models.some((m) => `${m.provider}/${m.id}` === grailModel)
											? [{ value: grailModel, label: `${grailModel}（当前不可用）` }]
											: []),
										...models.map((m) => ({
											value: `${m.provider}/${m.id}`,
											label: `${m.name || m.id} · ${m.provider}`,
										})),
									]}
									onChange={(val) => setGrailModel(val)}
								/>
								<small>建议选当前最强、且不同于写代码的模型。鉴定只在你主动发起时运行，结果不会发给写代码的 Agent。</small>
							</div>
							<div className="cc-settings-grid-2">
								<label className="field-label">
									单次鉴定费用上限（美元）
									<input
										type="number"
										aria-label="单次鉴定费用上限"
										min={0.01}
										max={1000}
										step="0.01"
										placeholder="默认 2"
										value={grailCostText}
										disabled={pending}
										onChange={(event) => setGrailCostText(event.target.value)}
									/>
								</label>
								<label className="field-label">
									鉴定超时（秒）
									<input
										type="number"
										aria-label="鉴定超时"
										min={30}
										max={7200}
										step="1"
										placeholder="默认 900"
										value={grailTimeoutText}
										disabled={pending}
										onChange={(event) => setGrailTimeoutText(event.target.value)}
									/>
								</label>
							</div>
						</fieldset>
						<fieldset className="live-routing">
							<legend>子 Agent 模型路由</legend>
							<small>
								内置 Explore / Plan / Review 子 Agent 在调用和定义都没指定模型时使用这里的模型；选"继承主会话"或所选模型当前不可用时，沿用父会话模型。
							</small>
							{MODEL_ROUTING_ROLES.map((role) => {
								const value = routing[role];
								const known = !value || models.some((m) => `${m.provider}/${m.id}` === value);
								return (
									<div className="field-label" key={role}>
										{ROUTING_LABELS[role].title}
										<SelectPopover
											ariaLabel={`${ROUTING_LABELS[role].title} 模型`}
											field
											direction="down"
											value={value}
											disabled={pending}
											options={[
												{ value: "", label: "继承主会话模型" },
												...(!known ? [{ value, label: `${value}（当前不可用）` }] : []),
												...models.map((m) => ({
													value: `${m.provider}/${m.id}`,
													label: `${m.name || m.id} · ${m.provider}`,
												})),
											]}
											onChange={(val) => setRouting((current) => ({ ...current, [role]: val }))}
										/>
										<small>{ROUTING_LABELS[role].hint}</small>
									</div>
								);
							})}
						</fieldset>
					</div>
				)}
				</div>
				<div className="cc-settings-footer">
					{savedMessage && <p role="status" className="subtle-note">{savedMessage}</p>}
					{testResult && (
						<div
							className={testResult.success ? "live-notice" : "live-error"}
							role={testResult.success ? "status" : "alert"}
						>
							<span>
								{testResult.message}
								{testResult.success && testResult.model ? ` · ${testResult.model}` : ""}
								{testResult.success && testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs} ms` : ""}
							</span>
						</div>
					)}
					{balance && (
						<div
							className={balance.success ? "live-notice" : "live-error"}
							role={balance.success ? "status" : "alert"}
						>
							<span>{balanceText(balance)}</span>
						</div>
					)}
					{busy && connectionChanged && <p className="subtle-note">连接改动需等当前任务结束后保存。</p>}
					{error && (
						<div className="live-error" role="alert">
							{error}
						</div>
					)}
					<p className="subtle-note live-settings-security">
						密钥仅在本机加密保存。测试会发送一条模型请求，可能产生用量。
					</p>
					<div className="dialog-actions live-settings-actions">
						{!connectionOnly && activeSection === "connection" && <>
						<button
							type="button"
							className="secondary-button"
							disabled={pending}
							onClick={() => void testConnection()}
						>
							{testing ? "正在测试…" : "测试连接"}
						</button>
						<button
							type="button"
							className="secondary-button"
							disabled={pending || !hasKey}
							onClick={() => void checkBalance()}
						>
							{checkingBalance ? "正在查询…" : "查询余额"}
						</button>
						</>}
						<span />
						<button type="button" disabled={pending} className="secondary-button" onClick={() => void requestClose()}>
							取消
						</button>
						<button disabled={pending} className="primary-button">
							{saving ? "正在保存…" : connectionOnly ? (testing ? "正在测试…" : "测试并连接") : connectionChanged && useAsDefault ? "保存并使用" : "保存设置"}
						</button>
					</div>
				</div>
				</div>
			</form>
		</Modal>
		{confirmation}
		</>
	);
}

function balanceText(result: ProviderBalanceResult): string {
	if (!result.supported || !result.success) return result.message ?? "余额查询失败。";
	const money = (currency: string, amount: number) =>
		`${currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
	const parts = (result.balances ?? []).map((item) => `余额 ${money(item.currency, item.amount)}`);
	if (result.usage !== undefined) parts.push(`该 Key 累计用量 $${result.usage.toFixed(2)}`);
	if (result.available === false) parts.push("服务商表示余额已不足以调用");
	if (result.note) parts.push(result.note);
	return parts.join("，") || "服务商没有返回余额。";
}
