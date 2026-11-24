import { useEffect, useState } from "react";
import { Plug, Plus, Save, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { useConfirmation } from "./ConfirmationDialog.tsx";
import { SelectPopover } from "./SelectPopover.tsx";
import type { McpSaveInput, McpServerInfo } from "../shared.ts";

function emptyForm(): McpSaveInput {
	return { name: "", scope: "project", transport: "stdio", command: "", args: [], enabled: true };
}

export function McpDialog({
	project,
	close,
	fail,
	onNotice,
	onChanged,
	onOAuth,
}: {
	project?: string;
	close: () => void;
	fail: (error: unknown) => void;
	onNotice: (message: string) => void;
	onChanged: () => void;
	onOAuth?: (name: string) => Promise<void>;
}) {
	const [servers, setServers] = useState<McpServerInfo[]>([]);
	const [selected, setSelected] = useState<McpServerInfo | null>(null);
	const [form, setForm] = useState<McpSaveInput>(emptyForm());
	const [argsText, setArgsText] = useState("");
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
			const list = await window.pi.mcp.list(project);
			setServers(list);
			const next = list.find((item) => item.name === selectName) ?? list.find((item) => item.name === selected?.name);
			if (next) select(next);
		} catch (cause) {
			fail(cause);
		} finally {
			setLoading(false);
		}
	};

	const select = (server: McpServerInfo) => {
		setSelected(server);
		setError("");
		setForm({
			name: server.name,
			scope: server.scope === "user" ? "user" : "project",
			transport: server.transport,
			command: server.transport === "stdio" ? (server.command ?? "") : undefined,
			args: server.args ?? [],
			url: server.transport === "http" ? (server.url ?? "") : undefined,
			description: server.description ?? "",
			enabled: server.enabled,
		});
		setArgsText((server.args ?? []).join("\n"));
	};

	useEffect(() => {
		void load();
	}, [project]);

	if (!project)
		return (
			<Modal title="MCP 服务器" close={close}>
				<div className="simple-dialog">
					<p className="subtle-note">打开一个项目后可以管理用户级与项目级 MCP 服务器。</p>
				</div>
			</Modal>
		);

	const overrideOnly = Boolean(selected?.overridden && form.scope === "project");
	const save = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form.name.trim()) {
			setError("请填写服务器名称。");
			return;
		}
		if (!overrideOnly && form.transport === "stdio" && !form.command?.trim()) {
			setError("stdio 服务器需要命令。");
			return;
		}
		if (!overrideOnly && form.transport === "http" && !form.url?.trim()) {
			setError("HTTP 服务器需要地址。");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const payload: McpSaveInput = {
				name: form.name.trim(),
				scope: form.scope,
				transport: form.transport,
				enabled: form.enabled,
				overrideOnly,
				project,
				...(overrideOnly
					? {}
					: form.transport === "stdio"
						? {
								command: form.command?.trim() || undefined,
								args: argsText
									.split("\n")
									.map((item) => item.trim())
									.filter(Boolean),
							}
						: { url: form.url?.trim() || undefined }),
				...(form.description?.trim() ? { description: form.description.trim() } : {}),
			};
			const list = await window.pi.mcp.save(payload);
			setServers(list);
			const next = list.find((item) => item.name === form.name.trim());
			if (next) select(next);
			onNotice(`MCP 服务器 ${form.name.trim()} 已保存，当前会话已重载。`);
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const { confirm, confirmation } = useConfirmation();
	const remove = async () => {
		if (!selected) return;
		if (!await confirm({ title: "删除 MCP 服务器", message: `移除「${selected.name}」（${selected.scope}）的配置。`, confirmLabel: "删除", destructive: true })) return;
		setBusy(true);
		setError("");
		try {
			const list = await window.pi.mcp.remove({ name: selected.name, scope: selected.scope, project });
			setServers(list);
			if (list[0]) select(list[0]);
			else {
				setSelected(null);
				setForm(emptyForm());
				setArgsText("");
			}
			onNotice(`MCP 服务器 ${selected.name} 已删除，当前会话已重载。`);
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title="MCP 服务器" close={close} wide>
			<div className="cc-agents">
				<div className="cc-agent-list">
					<div className="cc-agent-list-head">
						<span>服务器 ({servers.length})</span>
						<button
							type="button"
							className="cc-mini-btn"
							onClick={() => {
								setSelected(null);
								setForm(emptyForm());
								setArgsText("");
								setError("");
							}}
						>
							<Plus size={13} /> 新建
						</button>
					</div>
					{loading && <p className="subtle-note">正在加载…</p>}
					{servers.map((server) => (
						<button
							type="button"
							key={`${server.scope}-${server.name}`}
							className={`cc-agent-item ${selected?.name === server.name && selected?.scope === server.scope ? "active" : ""}`}
							onClick={() => select(server)}
						>
							<Plug size={14} />
							<span className="cc-agent-item-main">
								<strong>{server.name}</strong>
								<small>
									{server.transport === "stdio" ? server.command : server.url}
									{server.description ? ` · ${server.description}` : ""}
								</small>
							</span>
							<span className={`cc-agent-tag ${server.enabled ? "project" : ""}`}>
								{server.scope === "user" ? "用户" : "项目"}
								{server.overridden ? "覆盖" : ""}
								{server.enabled ? "" : "·停用"}
							</span>
						</button>
					))}
					{!loading && !servers.length && <p className="subtle-note">尚无 MCP 服务器。添加一个 stdio 或 HTTP 服务器后，Pi 会在下次会话启动时连接。</p>}
				</div>
				<form className="cc-agent-editor" onSubmit={(event) => void save(event)}>
					<div className="cc-agent-editor-head">
						<div>
							<strong>{selected ? "编辑 MCP 服务器" : "新建 MCP 服务器"}</strong>
							{selected?.source && <small>{selected.source}</small>}
						</div>
						{selected?.transport === "http" && selected.enabled && onOAuth && (
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={async () => {
								setBusy(true);
								setError("");
								try {
									await onOAuth(selected.name);
								} catch (error) {
									setError(error instanceof Error ? error.message : String(error));
								} finally {
									setBusy(false);
								}
							}}>OAuth 登录</button>
						)}
						{selected && (
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void remove()}>
								<Trash2 size={13} /> 删除
							</button>
						)}
					</div>
					<div className="cc-agent-row">
						<label className="field-label">
							名称
							<input
								value={form.name}
								disabled={busy || Boolean(selected)}
								placeholder="filesystem"
								onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
							/>
						</label>
						<div className="field-label">
							作用域
							<SelectPopover
								ariaLabel="作用域"
								field
								direction="down"
								value={form.scope}
								disabled={busy}
								options={[
									{ value: "project", label: "项目 .pi/mcp.json" },
									{ value: "user", label: "用户 ~/.pi/agent/mcp.json" },
								]}
								onChange={(val) => setForm((value) => ({ ...value, scope: val as McpSaveInput["scope"] }))}
							/>
						</div>
					</div>
					<div className="cc-agent-row">
						<div className="field-label">
							传输方式
							<SelectPopover
								ariaLabel="传输方式"
								field
								direction="down"
								value={form.transport}
								disabled={busy || overrideOnly}
								options={[
									{ value: "stdio", label: "stdio" },
									{ value: "http", label: "HTTP" },
								]}
								onChange={(val) => setForm((value) => ({ ...value, transport: val as McpSaveInput["transport"] }))}
							/>
						</div>
						<div className="field-label">
							状态
							<SelectPopover
								ariaLabel="服务器状态"
								field
								direction="down"
								value={form.enabled === false ? "off" : "on"}
								disabled={busy}
								options={[
									{ value: "on", label: "启用" },
									{ value: "off", label: "停用" },
								]}
								onChange={(val) => setForm((value) => ({ ...value, enabled: val === "on" }))}
							/>
						</div>
					</div>
					{form.transport === "stdio" ? (
						<>
							<label className="field-label">
								命令（一个可执行文件）
								<input
									value={form.command ?? ""}
									disabled={busy}
									placeholder="npx"
									onChange={(event) => setForm((value) => ({ ...value, command: event.target.value }))}
								/>
							</label>
							<label className="field-label cc-agent-prompt">
								参数（每行一个）
								<textarea
									value={argsText}
									disabled={busy}
									rows={4}
									placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
									onChange={(event) => setArgsText(event.target.value)}
								/>
							</label>
						</>
					) : (
						<label className="field-label">
							URL
							<input
								value={form.url ?? ""}
								disabled={busy || overrideOnly}
								placeholder="https://example.com/mcp"
								onChange={(event) => setForm((value) => ({ ...value, url: event.target.value }))}
							/>
						</label>
					)}
					<label className="field-label">
						描述（可选）
						<input
							value={form.description ?? ""}
							disabled={busy}
							placeholder="Search and read project documentation"
							onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
						/>
					</label>
					{overrideOnly && (
						<p className="cc-agent-note">这是项目覆盖条目：只修改启停和描述，命令、URL 与认证信息继续继承用户级服务器。</p>
					)}
					<p className="cc-agent-note">
						保存会重启当前项目会话以重新加载 MCP。OAuth 型服务器请先在终端运行 <code>pi mcp login &lt;server&gt;</code>；项目级服务器还需要项目信任。
					</p>
					{error && <p className="cc-agent-error" role="alert">{error}</p>}
					<div className="dialog-actions">
						<button type="submit" className="primary-button" disabled={busy}>
							<Save size={13} /> 保存并重载
						</button>
					</div>
				</form>
			</div>
			{confirmation}
		</Modal>
	);
}
