import { useEffect, useState } from "react";
import type {
	ConnectionInput,
	ConnectionMode,
	ConnectionProtocol,
	ConnectionTestResult,
	DesktopAPI,
	PermissionMode,
	Provider,
	ProviderPreset,
	SandboxStatus,
	Settings,
	Snapshot,
} from "../shared.ts";
import { Modal } from "../prototype/ui.tsx";

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
		modelId: mode === "preset" && unknownModel ? preset.defaultModelId : modelId,
		baseUrl: stored?.baseUrl ?? "",
		api: stored?.api ?? preset.models.find((model) => model.id === modelId)?.api ?? preset.api,
	};
}

export function SettingsDialog({
	settings,
	presets,
	busy,
	close,
	apply,
}: {
	settings: Settings;
	presets: ProviderPreset[];
	busy: boolean;
	close: () => void;
	apply: (snapshot: Snapshot) => void;
	fail: (error: unknown) => void;
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
	const [sandboxInfo, setSandboxInfo] = useState<SandboxStatus | null>(null);
	const [provider, setProvider] = useState<Provider>(initialProvider);
	const [mode, setMode] = useState<ConnectionMode>(initial.mode);
	const [agentDir, setAgentDir] = useState(settings.agentDir ?? "");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
	const [modelId, setModelId] = useState(initial.modelId);
	const [api, setApi] = useState<ConnectionProtocol>(initial.api);
	const [customModel, setCustomModel] = useState(!initialPreset.models.some((model) => model.id === initial.modelId));
	const [advanced, setAdvanced] = useState(initial.mode === "custom");
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState("");
	const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
	useEffect(() => {
		let mounted = true;
		void window.pi.sandboxStatus().then((status) => { if (mounted) setSandboxInfo(status); }).catch(() => {});
		return () => { mounted = false; };
	}, []);
	const preset = presets.find((item) => item.provider === provider)!;
	const original = connectionValues(settings, preset);
	const model = preset.models.find((item) => item.id === modelId);
	const pending = saving || testing;
	const storedKey = settings.configuredProviders.includes(provider);
	const hasKey = Boolean(apiKey.trim()) || storedKey;
	const generalSettingsChanged =
		permission !== settings.permission ||
		theme !== settings.theme ||
		sandbox !== Boolean(settings.sandbox) ||
		notifications !== (settings.notifications !== false) ||
		agentDir.trim() !== (settings.agentDir ?? "");
	const connectionChanged =
		Boolean(apiKey.trim()) ||
		mode !== original.mode ||
		modelId.trim() !== original.modelId ||
		(mode === "custom" && (baseUrl.trim() !== original.baseUrl || api !== original.api)) ||
		(hasKey && settings.defaultModel?.provider !== `desktop-${provider}`);
	const connectionInput: ConnectionInput = {
		provider,
		mode,
		apiKey: apiKey.trim() || undefined,
		modelId: modelId.trim() || undefined,
		...(mode === "custom" ? { baseUrl: baseUrl.trim(), api } : {}),
	};
	const clearResult = () => {
		setError("");
		setTestResult(null);
	};
	const selectProvider = (next: Provider) => {
		const nextPreset = presets.find((item) => item.provider === next)!;
		const values = connectionValues(settings, nextPreset);
		setProvider(next);
		setMode(values.mode);
		setApiKey("");
		setBaseUrl(values.baseUrl);
		setModelId(values.modelId);
		setApi(values.api);
		setCustomModel(!nextPreset.models.some((item) => item.id === values.modelId));
		setAdvanced(values.mode === "custom");
		clearResult();
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
		if (mode === "custom" && connectionChanged && !modelId.trim()) {
			setAdvanced(true);
			setError("请填写自定义接口的模型 ID，或恢复官方预设。");
			return;
		}
		if (!hasKey && mode === "preset" && (connectionChanged || !generalSettingsChanged)) {
			setError(`请填写 ${preset.name} 的 API Key。`);
			return;
		}
		setSaving(true);
		try {
			const update: Parameters<DesktopAPI["saveSettings"]>[0] = { permission, theme, sandbox, notifications };
			if (agentDir.trim() !== (settings.agentDir ?? "")) update.agentDir = agentDir.trim();
			if (connectionChanged) Object.assign(update, connectionInput);
			const next = await window.pi.saveSettings(update);
			apply(next);
			setApiKey("");
			if (next.engineError) {
				setError(`设置已保存，但模型暂不可用：${next.engineError}`);
				return;
			}
			close();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	const testConnection = async () => {
		clearResult();
		if (mode === "custom" && !modelId.trim()) {
			setAdvanced(true);
			setError("请填写自定义接口的模型 ID，或恢复官方预设。");
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
	return (
		<Modal
			title="设置与模型连接"
			close={() => {
				if (!pending) close();
			}}
		>
			<form
				className="simple-dialog live-settings"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<div className="live-settings-intro">
					<h3>连接模型服务</h3>
					<p className="subtle-note">选择服务商并填写 API Key，即可使用预设模型。已有 Pi 配置会自动读取。</p>
				</div>
				<label className="field-label">
					模型服务商
					<select
						aria-label="模型服务商"
						value={provider}
						disabled={pending}
						onChange={(event) => selectProvider(event.target.value as Provider)}
					>
						{presets.map((item) => (
							<option key={item.provider} value={item.provider}>
								{item.name}
								{settings.configuredProviders.includes(item.provider) ? " · 已连接" : ""}
							</option>
						))}
					</select>
				</label>
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
				<label className="field-label">
					默认模型
					<select
						aria-label="默认模型"
						value={customModel ? "" : modelId}
						disabled={pending}
						onChange={(event) => {
							const value = event.target.value;
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
					>
						{preset.models.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
								{item.id === preset.defaultModelId ? "（推荐）" : ""}
							</option>
						))}
						<option value="">自定义模型…</option>
					</select>
				</label>
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
				<details
					className="live-settings-section"
					open={advanced}
					onToggle={(event) => setAdvanced(event.currentTarget.open)}
				>
					<summary>高级设置{mode === "custom" ? " · 自定义接口" : ""}</summary>
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
							使用自定义接口或模型
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
								<label className="field-label">
									接口协议
									<select
										aria-label="接口协议"
										value={api}
										disabled={pending}
										onChange={(event) => {
											setApi(event.target.value as ConnectionProtocol);
											clearResult();
										}}
									>
										{protocols.map((item) => (
											<option key={item.value} value={item.value}>
												{item.label}
											</option>
										))}
									</select>
								</label>
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
				</details>
				<details className="live-settings-section">
					<summary>权限与外观</summary>
					<div className="live-settings-section-content">
						<label className="field-label">
							默认权限
							<select
								value={permission}
								disabled={pending || busy}
								onChange={(event) => setPermission(event.target.value as PermissionMode)}
							>
								<option value="ask">手动确认：写文件和运行工具前询问</option>
								<option value="acceptEdits">接受编辑：项目内文件编辑自动允许，命令仍按规则询问</option>
								<option value="plan">计划模式：只读调研、子 Agent 与写入 .pi/plans/，批准后实施</option>
								<option value="auto">跳过确认（危险）：除规则外不再询问，命令以本机权限运行</option>
								<option value="read">只读：仅允许读取与搜索</option>
							</select>
						</label>
						<label className="field-label">
							外观
							<select
								value={theme}
								disabled={pending}
								onChange={(event) => setTheme(event.target.value as Settings["theme"])}
							>
								<option value="light">浅色</option>
								<option value="dark">深色</option>
								<option value="system">跟随系统</option>
							</select>
						</label>
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="开启 macOS 命令沙箱"
								checked={sandbox}
								disabled={pending || busy || sandboxInfo?.supported === false}
								onChange={(event) => setSandbox(event.target.checked)}
							/>
							macOS Seatbelt 命令沙箱（将 Bash 写操作隔离至当前项目与临时目录）
						</label>
						{sandboxInfo && !sandboxInfo.supported && (
							<p className="subtle-note">当前运行环境不支持嵌套 Seatbelt 沙箱：{sandboxInfo.reason}</p>
						)}
						<label className="live-setting-toggle">
							<input
								type="checkbox"
								aria-label="任务桌面通知"
								checked={notifications}
								disabled={pending || busy}
								onChange={(event) => setNotifications(event.target.checked)}
							/>
							窗口未聚焦时发送任务完成/待审批系统通知
						</label>
					</div>
				</details>
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
				{busy && <p className="live-error">请先停止当前任务，再修改连接和权限。</p>}
				{error && (
					<div className="live-error" role="alert">
						{error}
					</div>
				)}
				<p className="subtle-note live-settings-security">
					密钥仅在本机加密保存。测试会发送一条模型请求，可能产生用量。
				</p>
				<div className="dialog-actions live-settings-actions">
					<button
						type="button"
						className="secondary-button"
						disabled={pending || busy}
						onClick={() => void testConnection()}
					>
						{testing ? "正在测试…" : "测试连接"}
					</button>
					<span />
					<button type="button" disabled={pending} className="secondary-button" onClick={close}>
						取消
					</button>
					<button disabled={pending || busy} className="primary-button">
						{saving ? "正在保存…" : !hasKey && generalSettingsChanged && !connectionChanged ? "保存设置" : "保存并使用"}
					</button>
				</div>
			</form>
		</Modal>
	);
}
