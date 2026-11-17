import { useEffect, useState } from "react";
import { Bot, Plus, Save, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { AgentDefinition, AgentSaveInput, ThinkingLevel } from "../shared.ts";

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
	const [modelText, setModelText] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
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
		setModelText(agent.model ? `${agent.model.provider}/${agent.model.id}` : "");
		setThinkingLevel(agent.thinkingLevel ?? "");
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
		setBusy(true);
		setError("");
		try {
			const list = await window.pi.agents.save({
				...form,
				tools: toolsText
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
				model: modelText.trim() || undefined,
				thinkingLevel: thinkingLevel || undefined,
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

	const remove = async () => {
		if (!selected || builtin || !selected.removable) return;
		if (!window.confirm(`删除 Agent ${selected.name}？`)) return;
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
						<button type="button" className="cc-mini-btn" onClick={() => { setSelected(null); setForm(emptyForm()); setToolsText(""); setModelText(""); setThinkingLevel(""); setError(""); }}>
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
							<Bot size={14} />
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
							工具（逗号分隔，留空 = 全部）
							<input
								value={toolsText}
								disabled={busy || builtin}
								placeholder="read, grep, find, ls"
								onChange={(event) => setToolsText(event.target.value)}
							/>
						</label>
						<label className="field-label">
							模型（provider/model-id，留空继承）
							<input
								value={modelText}
								disabled={busy || builtin}
								placeholder="anthropic/claude-opus-5-5"
								onChange={(event) => setModelText(event.target.value)}
							/>
						</label>
					</div>
					<div className="cc-agent-row">
						<label className="field-label">
							思考强度
							<select
								value={thinkingLevel}
								disabled={busy || builtin}
								onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel | "")}
							>
								{thinkingOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						<label className="field-label">
							保存位置
							<select
								value={form.scope}
								disabled={busy || builtin}
								onChange={(event) => setForm((value) => ({ ...value, scope: event.target.value as AgentSaveInput["scope"] }))}
							>
								<option value="project">项目 .pi/agents</option>
								<option value="user">用户 ~/.pi/agent/agents</option>
							</select>
						</label>
					</div>
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
		</Modal>
	);
}
