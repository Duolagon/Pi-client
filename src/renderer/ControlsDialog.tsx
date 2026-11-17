import { useEffect, useState } from "react";
import { Cpu, Plus, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type {
	DesktopAPI,
	DesktopToolInfo,
	PermissionAction,
	PermissionRule,
	PermissionScope,
	PermissionSettings,
} from "../shared.ts";

type ExecutorStatus = Awaited<ReturnType<DesktopAPI["externalAgents"]["executors"]>>[number];

export function ControlsDialog({
	conversationId,
	project,
	initialTab = "tools",
	close,
	fail,
}: {
	conversationId?: string;
	project?: string;
	initialTab?: "tools" | "permissions" | "executors";
	close: () => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"tools" | "permissions" | "executors">(initialTab);
	const [tools, setTools] = useState<DesktopToolInfo[]>([]);
	const [perms, setPerms] = useState<PermissionSettings | null>(null);
	const [executors, setExecutors] = useState<ExecutorStatus[]>([]);
	const [filter, setFilter] = useState("");
	const [scope, setScope] = useState<PermissionScope>("project");
	const [loading, setLoading] = useState(true);

	// New permission rule form
	const [ruleTool, setRuleTool] = useState("bash");
	const [ruleAction, setRuleAction] = useState<PermissionAction>("allow");
	const [rulePath, setRulePath] = useState("");
	const [ruleCmd, setRuleCmd] = useState("");

	const load = async (silent = false) => {
		if (!silent) setLoading(true);
		try {
			const [toolList, permSettings, execList] = await Promise.all([
				window.pi.tools.list(conversationId),
				window.pi.permissions.list(conversationId),
				window.pi.externalAgents.executors(),
			]);
			setTools(toolList);
			setPerms(permSettings);
			setExecutors(execList);
		} catch (error) {
			fail(error);
		} finally {
			if (!silent) setLoading(false);
		}
	};

	useEffect(() => {
		let mounted = true;
		void load(false);
		const unsub = window.pi.tools.onEvent(() => {
			if (mounted) void load(true);
		});
		return () => {
			mounted = false;
			unsub();
		};
	}, [conversationId]);

	const [execPaths, setExecPaths] = useState<Record<string, string>>({});

	const toggleExecutor = async (exec: ExecutorStatus) => {
		try {
			const next = await window.pi.externalAgents.configure({ id: exec.id, enabled: !exec.enabled });
			setExecutors(next);
		} catch (error) {
			fail(error);
		}
	};

	const saveExecutorPath = async (id: ExecutorStatus["id"], pathValue: string | null) => {
		try {
			const next = await window.pi.externalAgents.configure({ id, executable: pathValue });
			setExecutors(next);
			setExecPaths((prev) => ({ ...prev, [id]: "" }));
		} catch (error) {
			fail(error);
		}
	};

	const toggleTool = async (tool: DesktopToolInfo, enabled: boolean | null) => {
		try {
			const next = await window.pi.tools.setEnabled({
				name: tool.name,
				enabled,
				scope: scope === "project" && !project ? "global" : scope,
				conversationId,
				project,
			});
			setTools(next);
		} catch (error) {
			fail(error);
		}
	};

	const addRule = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!ruleTool.trim()) return;
		const effectiveScope: PermissionScope = scope === "project" && !project ? "global" : scope;
		const rule: PermissionRule = {
			id: `ui-${Date.now().toString(36)}`,
			scope: effectiveScope,
			project: effectiveScope === "project" ? project : undefined,
			conversationId: effectiveScope === "conversation" ? conversationId : undefined,
			action: ruleAction,
			tool: ruleTool.trim(),
			path: rulePath.trim() || undefined,
			command: ruleCmd.trim()
				? ruleCmd.trim().includes(" ")
					? { type: "prefix", argv: ruleCmd.trim().split(/\s+/) }
					: { type: "exact", value: ruleCmd.trim() }
				: undefined,
		};
		try {
			const next = await window.pi.permissions.upsert(rule);
			setPerms(next);
			setRulePath("");
			setRuleCmd("");
		} catch (error) {
			fail(error);
		}
	};

	const removeRule = async (id: string) => {
		try {
			const next = await window.pi.permissions.remove(id);
			setPerms(next);
		} catch (error) {
			fail(error);
		}
	};

	const filteredTools = tools.filter((t) =>
		`${t.name} ${t.source} ${t.namespace ?? ""} ${t.description}`.toLowerCase().includes(filter.toLowerCase()),
	);

	return (
		<Modal title="工具、MCP 与权限规则" close={close} wide>
			<div className="simple-dialog">
			<div className="cc-modal-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === "tools"} onClick={() => setTab("tools")}>
					<Wrench size={14} /> 工具与 MCP ({tools.length})
				</button>
				<button type="button" role="tab" aria-selected={tab === "permissions"} onClick={() => setTab("permissions")}>
					<ShieldCheck size={14} /> 权限规则 ({perms?.rules.length ?? 0})
				</button>
				<button type="button" role="tab" aria-selected={tab === "executors"} onClick={() => setTab("executors")}>
					<Cpu size={14} /> 外部执行器 ({executors.filter((e) => e.available).length}/{executors.length})
				</button>
			</div>

			<div className="cc-modal-scope">
				<span>作用域：</span>
				<select aria-label="规则作用域" value={scope} onChange={(e) => setScope(e.target.value as PermissionScope)}>
					<option value="conversation" disabled={!conversationId}>
						当前会话
					</option>
					<option value="project" disabled={!project}>
						当前项目
					</option>
					<option value="global">全局默认</option>
				</select>
			</div>

			{loading && <p className="subtle-note">正在加载…</p>}

			{tab === "tools" && (
				<div className="cc-controls-body">
					<input
						className="cc-filter-input"
						placeholder="过滤工具名称、MCP 服务或描述…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
					<div className="cc-list-scroll">
						{filteredTools.map((tool) => (
							<div key={tool.name} className="cc-tool-ctrl-row">
								<div className="cc-tool-ctrl-info">
									<div className="cc-tool-ctrl-name">
										<strong>{tool.name}</strong>
										<span className="cc-source-tag">{tool.namespace || tool.source}</span>
										{!tool.modelVisible && <span className="cc-source-tag muted">deferred</span>}
									</div>
									<p className="cc-tool-ctrl-desc">{tool.description}</p>
								</div>
								<div className="cc-tool-ctrl-actions">
									{tool.override !== undefined && (
										<button
											type="button"
											className="cc-mini-btn"
											title="恢复继承默认"
											onClick={() => void toggleTool(tool, null)}
										>
											恢复默认
										</button>
									)}
									<button
										type="button"
										className={`cc-toggle-btn ${tool.enabled ? "on" : "off"}`}
										onClick={() => void toggleTool(tool, !tool.enabled)}
									>
										{tool.enabled ? "已启用" : "已停用"}
									</button>
								</div>
							</div>
						))}
						{!loading && !filteredTools.length && <p className="subtle-note">没有匹配的工具。</p>}
					</div>
				</div>
			)}

			{tab === "permissions" && perms && (
				<div className="cc-controls-body">
					<form className="cc-rule-form" onSubmit={(e) => void addRule(e)}>
						<select aria-label="规则动作" value={ruleAction} onChange={(e) => setRuleAction(e.target.value as PermissionAction)}>
							<option value="allow">允许 (allow)</option>
							<option value="ask">询问 (ask)</option>
							<option value="deny">禁止 (deny)</option>
						</select>
						<input aria-label="工具匹配" placeholder="工具 (如 bash, read, mcp__*)" value={ruleTool} onChange={(e) => setRuleTool(e.target.value)} />
						<input aria-label="路径匹配" placeholder="路径 glob (可选，如 **/.env)" value={rulePath} onChange={(e) => setRulePath(e.target.value)} />
						<input aria-label="命令匹配" placeholder="命令前缀 (可选，如 npm test)" value={ruleCmd} onChange={(e) => setRuleCmd(e.target.value)} />
						<button type="submit" className="primary-button">
							<Plus size={14} /> 添加
						</button>
					</form>
					<div className="cc-list-scroll">
						{perms.rules.map((rule) => (
							<div key={rule.id} className="cc-rule-row">
								<span className={`cc-action-badge ${rule.action}`}>{rule.action}</span>
								<span className="cc-rule-main">
									<code>{rule.tool}</code>
									{rule.path && <span className="cc-rule-extra">path: {rule.path}</span>}
									{rule.command && (
										<span className="cc-rule-extra">
											cmd: {rule.command.type === "exact" ? rule.command.value : rule.command.argv.join(" ")}
										</span>
									)}
								</span>
								<span className="cc-source-tag">{rule.scope}</span>
								<button type="button" className="cc-mini-btn danger" aria-label={`删除规则 ${rule.id}`} onClick={() => void removeRule(rule.id)}>
									<Trash2 size={13} />
								</button>
							</div>
						))}
						{!perms.rules.length && <p className="subtle-note">暂无自定义权限规则，当前按默认模式（{perms.effective.mode}）执行。</p>}
					</div>
				</div>
			)}

			{tab === "executors" && (
				<div className="cc-controls-body">
					<div className="cc-list-scroll">
						{executors.map((exec) => (
							<div key={exec.id} className="cc-exec-card">
								<div className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>{exec.id}</strong>
											<span className={`cc-action-badge ${exec.available ? "allow" : "deny"}`}>
												{exec.available ? "可用" : "未检测到"}
											</span>
											{exec.version && <span className="cc-source-tag">{exec.version}</span>}
											<span className="cc-source-tag muted">{exec.capabilities.transport}</span>
										</div>
										<p className="cc-tool-ctrl-desc">
											{exec.error || exec.executable || "可通过 Agent 工具的 executor 参数直接委派"}
										</p>
									</div>
									<div className="cc-tool-ctrl-actions">
										<button
											type="button"
											className={`cc-toggle-btn ${exec.enabled ? "on" : "off"}`}
											onClick={() => void toggleExecutor(exec)}
										>
											{exec.enabled ? "已启用" : "已停用"}
										</button>
									</div>
								</div>
								<form
									className="cc-exec-path-row"
									onSubmit={(event) => {
										event.preventDefault();
										const val = (execPaths[exec.id] ?? "").trim();
										if (val) void saveExecutorPath(exec.id, val);
									}}
								>
									<input
										aria-label={`${exec.id} 可执行文件路径`}
										placeholder={exec.executable || `自定义 ${exec.id} 绝对路径…`}
										value={execPaths[exec.id] ?? ""}
										onChange={(event) => setExecPaths((prev) => ({ ...prev, [exec.id]: event.target.value }))}
									/>
									<button type="submit" className="cc-mini-btn" disabled={!(execPaths[exec.id] ?? "").trim()}>
										应用路径
									</button>
									{exec.executable && (
										<button type="button" className="cc-mini-btn" onClick={() => void saveExecutorPath(exec.id, null)}>
											恢复自动探测
										</button>
									)}
								</form>
							</div>
						))}
					</div>
				</div>
			)}
			</div>
		</Modal>
	);
}
