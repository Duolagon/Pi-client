import { useEffect, useState } from "react";
import { BookOpen, Info, Save, Sparkles } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { DesktopToolInfo, MemoryFileEntry, Snapshot } from "../shared.ts";

export function MemoryStatusDialog({
	initialTab = "memory",
	snapshot,
	gitBranch,
	onInitPrompt,
	onNotice,
	close,
	fail,
}: {
	initialTab?: "memory" | "status";
	snapshot: Snapshot;
	gitBranch?: string;
	onInitPrompt: () => void;
	onNotice: (msg: string) => void;
	close: () => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"memory" | "status">(initialTab);
	const [files, setFiles] = useState<MemoryFileEntry[]>([]);
	const [activeFile, setActiveFile] = useState<"AGENTS.md" | "CLAUDE.md">("AGENTS.md");
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [tools, setTools] = useState<DesktopToolInfo[]>([]);

	useEffect(() => {
		let mounted = true;
		if (snapshot.active) {
			void window.pi
				.readMemory()
				.then((list) => {
					if (!mounted) return;
					setFiles(list);
					const preferred = list.find((item) => item.exists) ?? list[0];
					if (preferred) {
						setActiveFile(preferred.file);
						setDraft(preferred.content);
					}
				})
				.catch(fail);
			void window.pi.tools.list(snapshot.active.id).then((list) => {
				if (mounted) setTools(list);
			}).catch(() => {});
		}
		return () => {
			mounted = false;
		};
	}, [snapshot.active?.id]);

	const switchFile = (file: "AGENTS.md" | "CLAUDE.md") => {
		setActiveFile(file);
		const found = files.find((item) => item.file === file);
		setDraft(found?.content ?? "");
	};

	const saveMemory = async () => {
		setSaving(true);
		try {
			const updated = await window.pi.writeMemory(activeFile, draft);
			setFiles((prev) => prev.map((item) => (item.file === activeFile ? updated : item)));
			onNotice(`已保存 ${activeFile}`);
		} catch (error) {
			fail(error);
		} finally {
			setSaving(false);
		}
	};

	const stats = snapshot.stats;
	const ctxUsage =
		stats?.contextUsage && typeof stats.contextUsage === "object"
			? (stats.contextUsage as { percent?: number; tokens?: number; contextWindow?: number })
			: undefined;
	const readOnly = snapshot.settings.permission === "read";
	const mcpCount = tools.filter((t) => t.source === "mcp").length;
	const activeToolsCount = tools.filter((t) => t.enabled && t.modelVisible).length;

	return (
		<Modal title="项目记忆与会话状态" close={close} wide>
			<div className="simple-dialog">
				<div className="cc-modal-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
						<BookOpen size={14} /> 项目记忆 (/memory)
					</button>
					<button type="button" role="tab" aria-selected={tab === "status"} onClick={() => setTab("status")}>
						<Info size={14} /> 运行状态 (/status)
					</button>
				</div>

				{tab === "memory" && (
					<div className="cc-controls-body">
						<div className="cc-rewind-head">
							<div className="cc-memory-switch">
								{(["AGENTS.md", "CLAUDE.md"] as const).map((name) => {
									const entry = files.find((f) => f.file === name);
									return (
										<button
											type="button"
											key={name}
											className={`cc-mini-btn ${activeFile === name ? "active" : ""}`}
											onClick={() => switchFile(name)}
										>
											{name} {entry?.exists ? "" : "(新建)"}
										</button>
									);
								})}
							</div>
							<button
								type="button"
								className="secondary-button"
								onClick={() => {
									onInitPrompt();
									close();
								}}
								disabled={!snapshot.active}
							>
								<Sparkles size={13} /> /init AI 生成指南
							</button>
						</div>
						<textarea
							className="cc-memory-editor"
							aria-label={`编辑 ${activeFile}`}
							placeholder={`在此编写 ${activeFile} 项目规范、构建命令与架构约定…`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							disabled={!snapshot.active || readOnly}
						/>
						<div className="dialog-actions">
							<button type="button" className="secondary-button" onClick={close}>
								关闭
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={saving || !snapshot.active || readOnly}
								onClick={() => void saveMemory()}
							>
								<Save size={13} /> {readOnly ? "只读模式不可保存" : `保存 ${activeFile}`}
							</button>
						</div>
					</div>
				)}

				{tab === "status" && (
					<div className="cc-controls-body">
						<div className="cc-status-grid">
							<div className="cc-status-card">
								<span>当前模型</span>
								<strong>{snapshot.state?.model?.name || snapshot.state?.model?.id || "未连接"}</strong>
								<small>{snapshot.state?.model?.provider ?? "-"}</small>
							</div>
							<div className="cc-status-card">
								<span>权限与思考强度</span>
								<strong>{snapshot.settings.permission}</strong>
								<small>思考：{snapshot.state?.thinkingLevel ?? "off"}</small>
							</div>
							<div className="cc-status-card">
								<span>上下文使用</span>
								<strong>{ctxUsage?.percent !== undefined ? `${Math.round(ctxUsage.percent)}%` : "-"}</strong>
								<small>
									{ctxUsage?.tokens !== undefined ? `${ctxUsage.tokens} / ${ctxUsage.contextWindow ?? "?"} tokens` : "等待统计"}
								</small>
							</div>
							<div className="cc-status-card">
								<span>费用与 Token 汇总</span>
								<strong>{stats ? `$${stats.cost.toFixed(4)}` : "$0.0000"}</strong>
								<small>
									{stats ? `in ${stats.tokens.input} · out ${stats.tokens.output} · cache ${stats.tokens.cacheRead}` : "-"}
								</small>
							</div>
							<div className="cc-status-card">
								<span>工作目录与分支</span>
								<strong>{gitBranch || "非 Git 仓库"}</strong>
								<small>{snapshot.active?.project ?? "未打开项目"}</small>
							</div>
							<div className="cc-status-card">
								<span>工具与 MCP 挂载</span>
								<strong>{activeToolsCount} 个模型可见工具</strong>
								<small>总计 {tools.length} 个工具 · MCP {mcpCount} 个</small>
							</div>
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
}
