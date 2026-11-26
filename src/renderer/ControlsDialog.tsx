import { useEffect, useState } from "react";
import { BookMarked, Cpu, Download, Play, Plus, ShieldCheck, Trash2, Upload, Webhook, Wrench } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import { SelectPopover } from "./SelectPopover.tsx";
import type {
	DesktopAPI,
	DesktopToolInfo,
	HookEntry,
	HookEventName,
	HookHandlerType,
	HookRunResult,
	PermissionAction,
	PermissionRule,
	PermissionScope,
	PermissionSettings,
	SkillDefinitionEntry,
} from "../shared.ts";

type ExecutorStatus = Awaited<ReturnType<DesktopAPI["externalAgents"]["executors"]>>[number];
export type ControlsTab = "tools" | "permissions" | "hooks" | "skills" | "executors";

const HOOK_EVENTS: HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"SessionEnd",
	"Notification",
];

export function ControlsDialog({
	conversationId,
	project,
	initialTab = "tools",
	onNotice,
	hooksDisabled = false,
	close,
	fail,
}: {
	conversationId?: string;
	project?: string;
	initialTab?: ControlsTab;
	onNotice?: (message: string) => void;
	/** Settings switch that stops every hook from running. */
	hooksDisabled?: boolean;
	close: () => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<ControlsTab>(initialTab);
	const [tools, setTools] = useState<DesktopToolInfo[]>([]);
	const [perms, setPerms] = useState<PermissionSettings | null>(null);
	const [hooks, setHooks] = useState<HookEntry[]>([]);
	const [skills, setSkills] = useState<SkillDefinitionEntry[]>([]);
	const [executors, setExecutors] = useState<ExecutorStatus[]>([]);
	const [filter, setFilter] = useState("");
	const [scope, setScope] = useState<PermissionScope>("project");
	const [loading, setLoading] = useState(true);

	// Permission rule form
	const [ruleTool, setRuleTool] = useState("bash");
	const [ruleAction, setRuleAction] = useState<PermissionAction>("allow");
	const [rulePath, setRulePath] = useState("");
	const [ruleCmd, setRuleCmd] = useState("");
	const [syncMsg, setSyncMsg] = useState("");
	const [savingLocalCompute, setSavingLocalCompute] = useState(false);
	const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
	useEffect(() => {
		if (!armedDeleteId) return;
		const timer = window.setTimeout(() => setArmedDeleteId(null), 3200);
		return () => window.clearTimeout(timer);
	}, [armedDeleteId]);

	// Hook form
	const [hookEvent, setHookEvent] = useState<HookEventName>("PreToolUse");
	const [hookType, setHookType] = useState<HookHandlerType>("command");
	const [hookMatcher, setHookMatcher] = useState("");
	const [hookCommand, setHookCommand] = useState("");
	const [hookUrl, setHookUrl] = useState("");
	const [hookEnvVars, setHookEnvVars] = useState("");
	const [hookScope, setHookScope] = useState<"project" | "user">(project ? "project" : "user");
	const [hookTestResult, setHookTestResult] = useState<HookRunResult | null>(null);

	// Skill form
	const [skillName, setSkillName] = useState("");
	const [skillDesc, setSkillDesc] = useState("");
	const [skillBody, setSkillBody] = useState("");
	const [skillScope, setSkillScope] = useState<"project" | "user">(project ? "project" : "user");

	const [execPaths, setExecPaths] = useState<Record<string, string>>({});

	const load = async (silent = false) => {
		if (!silent) setLoading(true);
		try {
			const [toolList, permSettings, execList, hookList, skillList] = await Promise.all([
				window.pi.tools.list(conversationId),
				window.pi.permissions.list(conversationId),
				window.pi.externalAgents.executors(),
				window.pi.hooks.list(project).catch(() => []),
				window.pi.skills.list(project).catch(() => []),
			]);
			setTools(toolList);
			setPerms(permSettings);
			setExecutors(execList);
			setHooks(hookList);
			setSkills(skillList);
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
	}, [conversationId, project]);

	const toggleExecutor = async (exec: ExecutorStatus) => {
		try {
			setExecutors(await window.pi.externalAgents.configure({ id: exec.id, enabled: !exec.enabled }));
		} catch (error) {
			fail(error);
		}
	};

	const setLocalComputeBlocked = async (blocked: boolean) => {
		if (!conversationId) return;
		setSavingLocalCompute(true);
		try {
			setPerms(await window.pi.permissions.setProjectLocalCompute(conversationId, blocked));
		} catch (error) {
			fail(error);
		} finally {
			setSavingLocalCompute(false);
		}
	};

	const saveExecutorPath = async (id: ExecutorStatus["id"], pathValue: string | null) => {
		try {
			setExecutors(await window.pi.externalAgents.configure({ id, executable: pathValue }));
			setExecPaths((prev) => ({ ...prev, [id]: "" }));
		} catch (error) {
			fail(error);
		}
	};

	const toggleTool = async (tool: DesktopToolInfo, enabled: boolean | null) => {
		try {
			setTools(
				await window.pi.tools.setEnabled({
					name: tool.name,
					enabled,
					scope: scope === "project" && !project ? "global" : scope,
					conversationId,
					project,
				}),
			);
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
			setPerms(await window.pi.permissions.upsert(rule));
			setRulePath("");
			setRuleCmd("");
		} catch (error) {
			fail(error);
		}
	};

	const removeRule = async (id: string) => {
		try {
			setPerms(await window.pi.permissions.remove(id));
		} catch (error) {
			fail(error);
		}
	};

	const importClaudeRules = async () => {
		try {
			const res = await window.pi.importClaudePermissions();
			setPerms(await window.pi.permissions.list(conversationId));
			const skipped = res.skipped ?? [];
			const msg = `已从 .claude/settings.json 导入 ${res.imported ?? 0} 条规则` +
				(skipped.length ? `；${skipped.length} 条无法等价转换、未导入：${skipped.slice(0, 5).join("，")}${skipped.length > 5 ? " 等" : ""}` : "");
			setSyncMsg(msg);
			onNotice?.(msg);
		} catch (error) {
			fail(error);
		}
	};

	const exportClaudeRules = async () => {
		try {
			const res = await window.pi.exportClaudePermissions();
			const msg = `已导出 ${res.exported ?? 0} 条项目规则到 ${res.path}`;
			setSyncMsg(msg);
			onNotice?.(msg);
		} catch (error) {
			fail(error);
		}
	};

	const addHook = async (event: React.FormEvent) => {
		event.preventDefault();
		if (hookType === "http" ? !hookUrl.trim() : !hookCommand.trim()) return;
		const allowedEnvVars = hookEnvVars
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
		try {
			const next = await window.pi.hooks.save({
				event: hookEvent,
				handlerType: hookType,
				matcher: hookMatcher.trim() || undefined,
				...(hookType === "http"
					? { url: hookUrl.trim(), ...(allowedEnvVars.length ? { allowedEnvVars } : {}) }
					: { command: hookCommand.trim() }),
				scope: project ? hookScope : "user",
				project,
			});
			setHooks(next);
			setHookMatcher("");
			setHookCommand("");
			setHookUrl("");
			setHookEnvVars("");
			onNotice?.("已保存 Hook");
		} catch (error) {
			fail(error);
		}
	};

	const deleteHook = async (entry: HookEntry) => {
		if (entry.scope === "agent") return;
		try {
			setHooks(await window.pi.hooks.remove({ id: entry.id, scope: entry.scope, project }));
		} catch (error) {
			fail(error);
		}
	};

	const runTestHook = async () => {
		try {
			const res = await window.pi.hooks.test({
				event: hookEvent,
				toolName: hookMatcher.trim() || "bash",
				toolInput: { command: "echo test" },
				prompt: "hook test",
				agentType: hookMatcher.trim() || "Explore",
				trigger: "manual",
				notificationType: "permission_prompt",
				project,
			});
			setHookTestResult(res);
		} catch (error) {
			fail(error);
		}
	};

	const addSkill = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!skillName.trim() || !skillDesc.trim() || !skillBody.trim()) return;
		try {
			const next = await window.pi.skills.save({
				name: skillName.trim(),
				description: skillDesc.trim(),
				body: skillBody.trim(),
				scope: project ? skillScope : "user",
				project,
			});
			setSkills(next);
			setSkillName("");
			setSkillDesc("");
			setSkillBody("");
			onNotice?.("已创建 Skill");
		} catch (error) {
			fail(error);
		}
	};

	const deleteSkill = async (item: SkillDefinitionEntry) => {
		if (item.scope === "bundled" || !item.editable) return;
		try {
			setSkills(await window.pi.skills.remove({ name: item.name, scope: item.scope, project }));
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
				<div className="cc-controls-head-row">
					<SlidingTabList className="cc-modal-tabs" role="tablist">
						<button type="button" role="tab" aria-selected={tab === "tools"} onClick={() => setTab("tools")}>
							<Wrench size={14} /> 工具与 MCP ({tools.length})
						</button>
						<button type="button" role="tab" aria-selected={tab === "permissions"} onClick={() => setTab("permissions")}>
							<ShieldCheck size={14} /> 权限规则 ({perms?.rules.length ?? 0})
						</button>
						<button type="button" role="tab" aria-selected={tab === "hooks"} onClick={() => setTab("hooks")}>
							<Webhook size={14} /> Hooks ({hooks.length})
						</button>
						<button type="button" role="tab" aria-selected={tab === "skills"} onClick={() => setTab("skills")}>
							<BookMarked size={14} /> Skills ({skills.length})
						</button>
						<button type="button" role="tab" aria-selected={tab === "executors"} onClick={() => setTab("executors")}>
							<Cpu size={14} /> 外部执行器 ({executors.filter((e) => e.available).length}/{executors.length})
						</button>
					</SlidingTabList>
					{loading && (
						<span className="cc-controls-sync-pill cc-shimmer-text" role="status" aria-live="polite">
							同步中…
						</span>
					)}
				</div>

				{(tab === "tools" || tab === "permissions") && (
					<div className="cc-modal-scope">
						<span>作用域：</span>
						<SelectPopover
							ariaLabel="规则作用域"
							direction="down"
							value={scope}
							options={[
								{ value: "conversation", label: "当前会话", disabled: !conversationId },
								{ value: "project", label: "当前项目", disabled: !project },
								{ value: "global", label: "全局默认" },
							]}
							onChange={(val) => setScope(val as PermissionScope)}
						/>
					</div>
				)}

				<div key={tab} className="cc-tab-panel">
				{tab === "tools" && (
					<div className="cc-controls-body">
						<input
							className="cc-filter-input"
							aria-label="过滤工具"
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
											{tool.deferred && <span className="cc-source-tag muted">延迟加载</span>}
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
											role="switch"
											aria-checked={tool.enabled}
											className={`cc-toggle-btn cc-switch-pill ${tool.enabled ? "on" : "off"}`}
											onClick={() => void toggleTool(tool, !tool.enabled)}
										>
											<span className="cc-switch-track" aria-hidden="true">
												<span className="cc-switch-thumb" />
											</span>
											<span>{tool.enabled ? "已启用" : "已停用"}</span>
										</button>
									</div>
								</div>
							))}
							{loading && !tools.length && (
								<div className="cc-skeleton-stack" aria-hidden="true">
									<span className="cc-skeleton-card" />
									<span className="cc-skeleton-card" />
								</div>
							)}
							{!loading && !filteredTools.length && <p className="subtle-note">没有匹配的工具。</p>}
						</div>
					</div>
				)}

				{tab === "permissions" && perms && (
					<div className="cc-controls-body">
						{project && conversationId && (
							<label className="live-setting-toggle cc-perm-sync-toggle">
								<input type="checkbox" checked={perms.effective.blockLocalCompute === true}
									disabled={savingLocalCompute}
									onChange={(event) => void setLocalComputeBlocked(event.target.checked)} />
								<span>拦截已识别的本机推理与评测命令（此项目）</span>
							</label>
						)}
						<form className="cc-rule-form" onSubmit={(e) => void addRule(e)}>
							<SelectPopover
								ariaLabel="规则动作"
								direction="down"
								value={ruleAction}
								options={[
									{ value: "allow", label: "允许 (allow)" },
									{ value: "ask", label: "询问 (ask)" },
									{ value: "deny", label: "禁止 (deny)" },
								]}
								onChange={(val) => setRuleAction(val as PermissionAction)}
							/>
							<input aria-label="工具匹配" placeholder="工具 (如 bash, read, mcp__*)" value={ruleTool} onChange={(e) => setRuleTool(e.target.value)} />
							<input aria-label="路径匹配" placeholder="路径 glob (可选，如 **/.env)" value={rulePath} onChange={(e) => setRulePath(e.target.value)} />
							<input aria-label="命令匹配" placeholder="命令前缀 (可选，如 npm test)" value={ruleCmd} onChange={(e) => setRuleCmd(e.target.value)} />
							<button type="submit" className="primary-button">
								<Plus size={14} /> 添加
							</button>
						</form>
						{project && (
							<div className="cc-perm-sync-bar">
								<button type="button" className="cc-mini-btn" onClick={() => void importClaudeRules()}>
									<Download size={12} /> 导入 .claude/settings.json
								</button>
								<button type="button" className="cc-mini-btn" onClick={() => void exportClaudeRules()}>
									<Upload size={12} /> 导出项目规则到 .claude/settings.json
								</button>
								{syncMsg && <span className="subtle-note">{syncMsg}</span>}
							</div>
						)}
						<div className="cc-list-scroll">
							{perms.rules.map((rule) => (
								<div key={rule.id} className="cc-rule-row">
									<span className={`cc-action-badge ${rule.action}`}>{rule.action}</span>
									<span className="cc-rule-main">
										<code>{rule.tool}</code>
										{rule.path && <span className="cc-rule-extra">path: {rule.path}</span>}
										{rule.domain && <span className="cc-rule-extra">domain: {rule.domain}</span>}
										{rule.command && (
											<span className="cc-rule-extra">
												cmd: {rule.command.type === "exact" ? rule.command.value : `${rule.command.argv.join(" ")} *`}
											</span>
										)}
									</span>
									<span className="cc-source-tag">{rule.scope}</span>
									{armedDeleteId === `rule:${rule.id}` ? (
										<div className="cc-tool-ctrl-actions">
											<button type="button" className="cc-mini-btn" onClick={() => setArmedDeleteId(null)}>取消</button>
											<button type="button" className="cc-mini-btn danger" onClick={() => { setArmedDeleteId(null); void removeRule(rule.id); }}>
												确认删除
											</button>
										</div>
									) : (
										<button type="button" className="cc-mini-btn danger" aria-label={`删除规则 ${rule.id}`} onClick={() => setArmedDeleteId(`rule:${rule.id}`)}>
											<Trash2 size={13} />
										</button>
									)}
								</div>
							))}
							{!perms.rules.length && <p className="subtle-note">暂无自定义权限规则，当前按默认模式（{perms.effective.mode}）执行。</p>}
						</div>
					</div>
				)}

				{tab === "hooks" && (
					<div className="cc-controls-body">
						<form className="cc-hook-form cc-hook-form-wide" onSubmit={(e) => void addHook(e)}>
							<SelectPopover
								ariaLabel="Hook 事件"
								direction="down"
								value={hookEvent}
								options={HOOK_EVENTS.map((ev) => ({ value: ev, label: ev }))}
								onChange={(val) => setHookEvent(val as HookEventName)}
							/>
							<SelectPopover
								ariaLabel="Hook 类型"
								direction="down"
								value={hookType}
								options={[
									{ value: "command", label: "Shell 命令" },
									{ value: "http", label: "HTTP Webhook" },
								]}
								onChange={(val) => setHookType(val as HookHandlerType)}
							/>
							<SelectPopover
								ariaLabel="Hook 作用域"
								direction="down"
								value={hookScope}
								options={[
									{ value: "project", label: "当前项目 (.pi/hooks.json)", disabled: !project },
									{ value: "user", label: "全局用户" },
								]}
								onChange={(val) => setHookScope(val as "project" | "user")}
							/>
							<input aria-label="Hook 匹配器" placeholder="Matcher 正则 (可选，如 Bash|Write)" value={hookMatcher} onChange={(e) => setHookMatcher(e.target.value)} />
							{hookType === "http" ? (
								<>
									<input aria-label="Hook URL" type="url" placeholder="https://example.com/hook" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
									<input aria-label="允许的环境变量" placeholder="允许 Header 变量 (逗号分隔，可选)" value={hookEnvVars} onChange={(e) => setHookEnvVars(e.target.value)} />
								</>
							) : (
								<input aria-label="Hook 命令" placeholder="Shell 命令（stdin 接收 Claude Hook JSON）" value={hookCommand} onChange={(e) => setHookCommand(e.target.value)} />
							)}
							<button type="submit" className="primary-button">
								<Plus size={14} /> 添加 Hook
							</button>
							<button type="button" className="secondary-button" onClick={() => void runTestHook()} title="按当前事件模拟执行匹配 Hooks">
								<Play size={13} /> 测试触发
							</button>
						</form>
						{hookTestResult && (
							<div className="cc-hook-test-out">
								执行 {hookTestResult.executedCount} 个 Hook · {hookTestResult.blocked ? `已拦截：${hookTestResult.reason}` : "放行"}
								{hookTestResult.additionalContext ? ` · 上下文：${hookTestResult.additionalContext}` : ""}
							</div>
						)}
						{hooksDisabled && (
							<p className="subtle-note cc-settings-current">已在设置中停用全部 Hooks，下面的 Hook 暂不运行。</p>
						)}
						<p className="subtle-note">兼容 ~/.claude/settings*.json 与受信任项目的 .claude/settings*.json、.pi/hooks.json；支持 command 与 http handler。</p>
						<div className="cc-list-scroll">
							{hooks.map((item) => (
								<div key={item.id} className="cc-rule-row">
									<span className="cc-source-tag">{item.event}</span>
									<span className="cc-source-tag muted">{item.handlerType === "http" ? "HTTP" : "CMD"}</span>
									<span className="cc-rule-main" title={item.sourceFile}>
										<code>{item.handlerType === "http" ? item.url : item.command}</code>
										{item.matcher && <span className="cc-rule-extra">matcher: {item.matcher}</span>}
									</span>
									<span className="cc-source-tag muted">{item.scope}</span>
									{item.editable && (
										armedDeleteId === `hook:${item.id}` ? (
											<div className="cc-tool-ctrl-actions">
												<button type="button" className="cc-mini-btn" onClick={() => setArmedDeleteId(null)}>取消</button>
												<button type="button" className="cc-mini-btn danger" onClick={() => { setArmedDeleteId(null); void deleteHook(item); }}>
													确认删除
												</button>
											</div>
										) : (
											<button type="button" className="cc-mini-btn danger" aria-label={`删除 Hook ${item.id}`} onClick={() => setArmedDeleteId(`hook:${item.id}`)}>
												<Trash2 size={13} />
											</button>
										)
									)}
								</div>
							))}
							{!hooks.length && <p className="subtle-note">尚未配置声明式 Hooks。</p>}
						</div>
					</div>
				)}

				{tab === "skills" && (
					<div className="cc-controls-body">
						<form className="cc-skill-form" onSubmit={(e) => void addSkill(e)}>
							<div className="cc-skill-form-row">
								<input aria-label="Skill 名称" placeholder="名称 (小写字母/数字/连字符，如 lint-check)" value={skillName} onChange={(e) => setSkillName(e.target.value)} />
								<SelectPopover
									ariaLabel="Skill 作用域"
									direction="down"
									align="right"
									value={skillScope}
									options={[
										{ value: "project", label: "当前项目 (.pi/skills)", disabled: !project },
										{ value: "user", label: "用户全局" },
									]}
									onChange={(val) => setSkillScope(val as "project" | "user")}
								/>
							</div>
							<input aria-label="Skill 描述" placeholder="简述何时使用此 Skill…" value={skillDesc} onChange={(e) => setSkillDesc(e.target.value)} />
							<textarea aria-label="Skill 指令正文" rows={3} placeholder="SKILL.md 正文步骤与要求…" value={skillBody} onChange={(e) => setSkillBody(e.target.value)} />
							<div className="cc-skill-form-actions">
								<button type="submit" className="primary-button" disabled={!skillName.trim() || !skillDesc.trim() || !skillBody.trim()}>
									<Plus size={14} /> 保存 Skill
								</button>
							</div>
						</form>
						<div className="cc-list-scroll">
							{skills.map((item) => (
								<div key={item.id} className="cc-tool-ctrl-row">
									<div className="cc-tool-ctrl-info">
										<div className="cc-tool-ctrl-name">
											<strong>/{item.name}</strong>
											<span className="cc-source-tag">{item.scope} · {item.kind}</span>
											<span className="cc-source-tag muted">~{item.estimatedTokens} tok</span>
										</div>
										<p className="cc-tool-ctrl-desc">{item.description}</p>
									</div>
									{item.editable && (
										<button
											type="button"
											className={`cc-mini-btn danger ${armedDeleteId === `skill:${item.id}` ? "is-armed" : ""}`.trim()}
											aria-label={armedDeleteId === `skill:${item.id}` ? `确认删除 Skill ${item.name}` : `删除 Skill ${item.name}`}
											title={armedDeleteId === `skill:${item.id}` ? "再次点击确认删除此 Skill 文件" : "删除 Skill"}
											onClick={() => {
												const key = `skill:${item.id}`;
												if (armedDeleteId !== key) {
													setArmedDeleteId(key);
													return;
												}
												setArmedDeleteId(null);
												void deleteSkill(item);
											}}
										>
											<Trash2 size={13} />
											{armedDeleteId === `skill:${item.id}` && <span>确认删除</span>}
										</button>
									)}
								</div>
							))}
							{!skills.length && <p className="subtle-note">未发现自定义 Skills 或 .claude/commands。</p>}
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
												role="switch"
												aria-checked={exec.enabled}
												className={`cc-toggle-btn cc-switch-pill ${exec.enabled ? "on" : "off"}`}
												onClick={() => void toggleExecutor(exec)}
											>
												<span className="cc-switch-track" aria-hidden="true">
													<span className="cc-switch-thumb" />
												</span>
												<span>{exec.enabled ? "已启用" : "已停用"}</span>
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
			</div>
		</Modal>
	);
}
