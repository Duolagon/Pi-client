import { useEffect, useState } from "react";
import { Bot, Plus, Save, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { useConfirmation } from "./ConfirmationDialog.tsx";
import { SelectPopover } from "./SelectPopover.tsx";
import type {
	AgentDefinition,
	AgentMemoryScope,
	AgentPermissionMode,
	AgentSaveInput,
	ThinkingLevel,
} from "../shared.ts";

const thinkingOptions: { value: ThinkingLevel | ""; label: string }[] = [
	{ value: "", label: "继承父会话" },
	{ value: "off", label: "off" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
];

const permissionModeOptions: { value: AgentPermissionMode | ""; label: string }[] = [
	{ value: "", label: "继承当前会话" },
	{ value: "default", label: "default（手动确认）" },
	{ value: "acceptEdits", label: "acceptEdits（自动允许编辑）" },
	{ value: "plan", label: "plan（仅调研/规划）" },
	{ value: "dontAsk", label: "dontAsk（未授权操作自动拒绝）" },
	{ value: "bypassPermissions", label: "bypassPermissions（仅父会话 auto 时沿用）" },
	{ value: "read", label: "read（只读）" },
];

const memoryOptions: { value: AgentMemoryScope | ""; label: string }[] = [
	{ value: "", label: "无持久化记忆" },
	{ value: "user", label: "user (~/.pi/agent/agent-memory)" },
	{ value: "project", label: "project (.claude/agent-memory)" },
	{ value: "local", label: "local (.claude/agent-memory-local)" },
];

function emptyForm(): AgentSaveInput {
	return { name: "", description: "", prompt: "", tools: [], scope: "project" };
}

export function AgentsDialog({
	project,
	close,
	fail,
	onNotice,
}: {
	project?: string;
	close: () => void;
	fail: (error: unknown) => void;
	onNotice: (message: string) => void;
}) {
	const [agents, setAgents] = useState<AgentDefinition[]>([]);
	const [selected, setSelected] = useState<AgentDefinition | null>(null);
	const [form, setForm] = useState<AgentSaveInput>(emptyForm());
	const [toolsText, setToolsText] = useState("");
	const [disallowedToolsText, setDisallowedToolsText] = useState("");
	const [modelText, setModelText] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
	const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | "">("");
	const [maxTurnsText, setMaxTurnsText] = useState("");
	const [skillsText, setSkillsText] = useState("");
	const [mcpServersText, setMcpServersText] = useState("");
	const [colorText, setColorText] = useState("");
	const [omitClaudeMd, setOmitClaudeMd] = useState(false);
	const [memory, setMemory] = useState<AgentMemoryScope | "">("");
	const [isolation, setIsolation] = useState<"" | "worktree" | "shared">("");
	const [background, setBackground] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	const load = async (selectName?: string) => {
		if (!project) {
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const list = await window.pi.agents.list(project);
			setAgents(list);
			const next = list.find((agent) => agent.name === selectName) ?? list.find((agent) => agent.name === selected?.name);
			if (next) select(next);
		} catch (cause) {
			fail(cause);
		} finally {
			setLoading(false);
		}
	};

	const select = (agent: AgentDefinition) => {
		setSelected(agent);
		setError("");
		setForm({
			name: agent.name,
			description: agent.description,
			prompt: agent.prompt,
			tools: agent.tools ?? [],
			scope: agent.scope === "user" ? "user" : "project",
		});
		setToolsText((agent.tools ?? []).join(", "));
		setDisallowedToolsText((agent.disallowedTools ?? []).join(", "));
		setModelText(agent.model ? `${agent.model.provider}/${agent.model.id}` : (agent.modelAlias ?? ""));
		setThinkingLevel(agent.thinkingLevel ?? "");
		setPermissionMode(agent.permissionMode ?? "");
		setMaxTurnsText(agent.maxTurns ? String(agent.maxTurns) : "");
		setSkillsText((agent.skills ?? []).join(", "));
		setMcpServersText((agent.mcpServers ?? []).join(", "));
		setColorText(agent.color ?? "");
		setOmitClaudeMd(Boolean(agent.omitClaudeMd));
		setMemory(agent.memory ?? "");
		setIsolation(agent.isolation ?? "");
		setBackground(Boolean(agent.background));
	};

	useEffect(() => {
		void load();
	}, [project]);

	if (!project)
		return (
			<Modal title="Agents 与子 Agent" close={close}>
				<div className="simple-dialog">
					<p className="subtle-note">打开一个项目后可以查看和管理项目级 Agent。</p>
				</div>
			</Modal>
		);

	const builtin = selected?.scope === "builtin";
	const claudeSource = Boolean(selected?.source?.includes("/.claude/agents/"));

	const save = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form.name.trim() || !form.description.trim() || !form.prompt.trim()) {
			setError("请填写名称、描述和系统提示词。");
			return;
		}
		const maxTurnsParsed = maxTurnsText.trim() ? Number(maxTurnsText.trim()) : undefined;
		if (maxTurnsParsed !== undefined && (!Number.isSafeInteger(maxTurnsParsed) || maxTurnsParsed < 1 || maxTurnsParsed > 200)) {
			setError("最大轮次须为 1–200 的整数。");
			return;
		}
		const splitList = (raw: string) =>
			raw
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
		const tools = splitList(toolsText);
		const disallowedTools = splitList(disallowedToolsText);
		const skills = splitList(skillsText);
		const mcpServers = splitList(mcpServersText);
		setBusy(true);
		setError("");
		try {
			const list = await window.pi.agents.save({
				...form,
				tools,
				...(disallowedTools.length ? { disallowedTools } : {}),
				model: modelText.trim() || undefined,
				thinkingLevel: thinkingLevel || undefined,
				permissionMode: permissionMode || undefined,
				maxTurns: maxTurnsParsed,
				...(skills.length ? { skills } : {}),
				...(mcpServers.length ? { mcpServers } : {}),
				...(colorText.trim() ? { color: colorText.trim() } : {}),
				...(omitClaudeMd ? { omitClaudeMd: true } : {}),
				memory: memory || undefined,
				isolation: isolation || undefined,
				...(background ? { background: true } : {}),
				project,
			});
			setAgents(list);
			const next = list.find((agent) => agent.name === form.name.trim());
			if (next) select(next);
			onNotice(`已保存 Agent ${form.name.trim()}。`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const { confirm, confirmation } = useConfirmation();
	const remove = async () => {
		if (!selected || builtin || !selected.removable) return;
		if (!await confirm({ title: "删除 Agent", message: `移除「${selected.name}」的自定义定义。`, confirmLabel: "删除", destructive: true })) return;
		setBusy(true);
		setError("");
		try {
			const list = await window.pi.agents.remove({
				name: selected.name,
				scope: selected.scope === "user" ? "user" : "project",
				project,
			});
			setAgents(list);
			const next = list.find((agent) => agent.name === "general-purpose");
			if (next) select(next);
			onNotice(`已删除 Agent ${selected.name}。`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title="Agents 与子 Agent" close={close} wide>
			<div className="cc-agents">
				<div className="cc-agent-list">
					<div className="cc-agent-list-head">
						<span>可用 Agent ({agents.length})</span>
						<button
							type="button"
							className="cc-mini-btn"
							onClick={() => {
								setSelected(null);
								setForm(emptyForm());
								setToolsText("");
								setDisallowedToolsText("");
								setModelText("");
								setThinkingLevel("");
								setPermissionMode("");
								setMaxTurnsText("");
								setSkillsText("");
								setMcpServersText("");
								setColorText("");
								setOmitClaudeMd(false);
								setMemory("");
								setIsolation("");
								setBackground(false);
								setError("");
							}}
						>
							<Plus size={13} /> 新建
						</button>
					</div>
					{loading && <p className="subtle-note">正在加载…</p>}
					{agents.map((agent) => (
						<button
							type="button"
							key={agent.name}
							className={`cc-agent-item ${selected?.name === agent.name ? "active" : ""}`}
							onClick={() => select(agent)}
						>
							<Bot size={14} style={agent.color ? { color: agent.color } : undefined} />
							<span className="cc-agent-item-main">
								<strong>{agent.name}</strong>
								<small>{agent.description}</small>
							</span>
							<span className={`cc-agent-tag ${agent.scope}`}>{agent.scope === "builtin" ? "内置" : agent.readOnly ? "只读" : "可写"}</span>
						</button>
					))}
				</div>
				<form className="cc-agent-editor" onSubmit={(event) => void save(event)}>
					<div className="cc-agent-editor-head">
						<div>
							<strong>{builtin ? "内置 Agent（只读）" : selected ? "编辑 Agent" : "新建 Agent"}</strong>
							{selected?.source && <small>{selected.source}</small>}
						</div>
						{selected && !builtin && selected.removable && (
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void remove()}>
								<Trash2 size={13} /> 删除
							</button>
						)}
					</div>
					{claudeSource && (
						<p className="cc-agent-note">此定义来自 .claude/agents；保存会在 .pi/agents 创建同名覆盖，原文件不变。</p>
					)}
					<label className="field-label">
						Agent 名称
						<input
							value={form.name}
							disabled={busy || builtin || Boolean(selected)}
							placeholder="reviewer"
							onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
						/>
					</label>
					<label className="field-label">
						描述（模型据此决定何时委派）
						<input
							value={form.description}
							disabled={busy || builtin}
							placeholder="Reviews changes for correctness and missing tests"
							onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
						/>
					</label>
					<div className="cc-agent-row">
						<label className="field-label">
							工具白名单（逗号分隔，留空 = 全部）
							<input
								value={toolsText}
								disabled={busy || builtin}
								placeholder="read, grep, find, ls"
								onChange={(event) => setToolsText(event.target.value)}
							/>
						</label>
						<label className="field-label">
							禁用工具 disallowedTools
							<input
								value={disallowedToolsText}
								disabled={busy || builtin}
								placeholder="Write, Edit, Bash"
								onChange={(event) => setDisallowedToolsText(event.target.value)}
							/>
						</label>
					</div>
					<div className="cc-agent-row">
						<label className="field-label">
							模型（provider/id 或 sonnet / opus / haiku）
							<input
								value={modelText}
								disabled={busy || builtin}
								placeholder="sonnet 或 anthropic/claude-opus-5-5"
								onChange={(event) => setModelText(event.target.value)}
							/>
						</label>
						<div className="field-label">
							思考强度 / effort
							<SelectPopover
								ariaLabel="思考强度 / effort"
								field
								direction="down"
								value={thinkingLevel}
								disabled={busy || builtin}
								options={thinkingOptions.map((option) => ({ value: option.value, label: option.label }))}
								onChange={(val) => setThinkingLevel(val as ThinkingLevel | "")}
							/>
						</div>
					</div>
					<div className="cc-agent-row">
						<div className="field-label">
							权限模式
							<SelectPopover
								ariaLabel="Agent 权限模式"
								field
								direction="down"
								value={permissionMode}
								disabled={busy || builtin}
								options={permissionModeOptions.map((option) => ({ value: option.value, label: option.label }))}
								onChange={(val) => setPermissionMode(val as AgentPermissionMode | "")}
							/>
						</div>
						<div className="field-label">
							保存位置
							<SelectPopover
								ariaLabel="保存位置"
								field
								direction="down"
								value={form.scope}
								disabled={busy || builtin}
								options={[
									{ value: "project", label: "项目 .pi/agents" },
									{ value: "user", label: "用户 ~/.pi/agent/agents" },
								]}
								onChange={(val) => setForm((value) => ({ ...value, scope: val as AgentSaveInput["scope"] }))}
							/>
						</div>
					</div>
					{!builtin && (
						<details className="live-settings-section">
							<summary>Claude Code 高级兼容配置（Skills / Memory / 轮次 / 隔离）</summary>
							<div className="live-settings-section-content">
								<div className="cc-agent-row">
									<label className="field-label">
										预加载 Skills（逗号分隔）
										<input
											value={skillsText}
											disabled={busy}
											placeholder="api-conventions, security-audit"
											onChange={(event) => setSkillsText(event.target.value)}
										/>
									</label>
									<label className="field-label">
										最大轮次 maxTurns
										<input
											type="number"
											min="1"
											max="200"
											value={maxTurnsText}
											disabled={busy}
											placeholder="不限"
											onChange={(event) => setMaxTurnsText(event.target.value)}
										/>
									</label>
								</div>
								<div className="cc-agent-row">
									<div className="field-label">
										持久化记忆 memory
										<SelectPopover
											ariaLabel="持久化记忆 memory"
											field
											direction="down"
											value={memory}
											disabled={busy}
											options={memoryOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
											onChange={(val) => setMemory(val as AgentMemoryScope | "")}
										/>
									</div>
									<div className="field-label">
										隔离方式 isolation
										<SelectPopover
											ariaLabel="隔离方式 isolation"
											field
											direction="down"
											value={isolation}
											disabled={busy}
											options={[
												{ value: "", label: "自动（只读共享 / 可写 Worktree）" },
												{ value: "worktree", label: "worktree" },
												{ value: "shared", label: "shared（仅只读可用）" },
											]}
											onChange={(val) => setIsolation(val as "" | "worktree" | "shared")}
										/>
									</div>
								</div>
								<div className="cc-agent-row">
									<label className="field-label">
										MCP 服务器名称 mcpServers（逗号分隔）
										<input
											value={mcpServersText}
											disabled={busy}
											placeholder="github, postgres"
											onChange={(event) => setMcpServersText(event.target.value)}
										/>
									</label>
									<label className="field-label">
										主题色 color（名称或 #RRGGBB）
										<input
											value={colorText}
											disabled={busy}
											placeholder="blue 或 #3b82f6"
											onChange={(event) => setColorText(event.target.value)}
										/>
									</label>
								</div>
								<label className="live-setting-toggle">
									<input type="checkbox" checked={background} disabled={busy} onChange={(event) => setBackground(event.target.checked)} />
									<span>默认后台运行（background: true）</span>
								</label>
								<label className="live-setting-toggle">
									<input type="checkbox" checked={omitClaudeMd} disabled={busy} onChange={(event) => setOmitClaudeMd(event.target.checked)} />
									<span>不注入 CLAUDE.md / AGENTS.md 上下文（omitClaudeMd）</span>
								</label>
							</div>
						</details>
					)}
					{selected?.definitionError && (
						<p className="cc-agent-error" role="alert">配置冲突：{selected.definitionError}</p>
					)}
					{selected?.hooks && selected.hooks.length > 0 && (
						<p className="cc-agent-note">此 Agent 定义包含 {selected.hooks.length} 个作用域专属 Hook（随此 Agent 生命周期触发）。</p>
					)}
					<label className="field-label cc-agent-prompt">
						系统提示词
						<textarea
							value={form.prompt}
							disabled={busy || builtin}
							rows={10}
							placeholder="You are a code reviewer. Inspect the requested diff, report correctness bugs and missing tests. Do not edit files."
							onChange={(event) => setForm((value) => ({ ...value, prompt: event.target.value }))}
						/>
					</label>
					{(form.tools?.length ?? 0) === 0 && toolsText.trim() === "" && !builtin && (
						<p className="cc-agent-note">留空工具表示 Agent 可使用全部工具，并按可写 Agent 在 Worktree 中运行。</p>
					)}
					{error && <p className="cc-agent-error" role="alert">{error}</p>}
					<div className="dialog-actions">
						{!builtin && (
							<button type="submit" className="primary-button" disabled={busy}>
								<Save size={13} /> 保存 Agent
							</button>
						)}
					</div>
				</form>
			</div>
			{confirmation}
		</Modal>
	);
}
