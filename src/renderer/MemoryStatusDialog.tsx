import { useEffect, useState } from "react";
import { Archive, BookOpen, Info, Layers, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { ContextBreakdown, ContextMemorySource, DesktopToolInfo, Snapshot } from "../shared.ts";

export function MemoryStatusDialog({
	initialTab = "memory",
	snapshot,
	gitBranch,
	onInitPrompt,
	onCompact,
	onToggleAutoCompaction,
	onToggleAutoRetry,
	onNotice,
	close,
	fail,
}: {
	initialTab?: "memory" | "context" | "status";
	snapshot: Snapshot;
	gitBranch?: string;
	onInitPrompt: () => void;
	onCompact?: (instructions?: string) => Promise<void>;
	onToggleAutoCompaction?: (enabled: boolean) => Promise<void>;
	onToggleAutoRetry?: (enabled: boolean) => Promise<void>;
	onNotice: (msg: string) => void;
	close: () => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"memory" | "context" | "status">(initialTab);
	const [report, setReport] = useState<ContextBreakdown | null>(null);
	const [sources, setSources] = useState<ContextMemorySource[]>([]);
	const [activePath, setActivePath] = useState<string>("AGENTS.md");
	const [draft, setDraft] = useState("");
	const [newRuleName, setNewRuleName] = useState("");
	const [saving, setSaving] = useState(false);
	const [compactInstructions, setCompactInstructions] = useState("");
	const [tools, setTools] = useState<DesktopToolInfo[]>([]);

	const refreshReport = async () => {
		if (!snapshot.active) return;
		const [ctx, toolList] = await Promise.all([
			window.pi.contextReport().catch(() => null),
			window.pi.tools.list(snapshot.active.id).catch(() => []),
		]);
		if (ctx) {
			setReport(ctx);
			setSources(ctx.sources);
			const preferred =
				ctx.sources.find((s) => s.relativePath === activePath) ??
				ctx.sources.find((s) => s.relativePath === "AGENTS.md") ??
				ctx.sources[0];
			if (preferred) {
				setActivePath(preferred.relativePath);
				setDraft(preferred.content);
			}
		} else {
			const fallback = await window.pi.readMemory();
			const mapped: ContextMemorySource[] = fallback.map((m) => ({
				id: m.file,
				relativePath: m.file,
				path: m.path,
				scope: "project",
				exists: m.exists,
				editable: true,
				bytes: m.content.length,
				estimatedTokens: Math.ceil(m.content.length / 3.5),
				content: m.content,
				imports: [],
			}));
			setSources(mapped);
			const preferred = mapped.find((s) => s.relativePath === "AGENTS.md") ?? mapped[0];
			if (preferred) {
				setActivePath(preferred.relativePath);
				setDraft(preferred.content);
			}
		}
		setTools(toolList);
	};

	useEffect(() => {
		void refreshReport().catch(fail);
	}, [snapshot.active?.id]);

	const activeSource = sources.find((s) => s.relativePath === activePath);

	const switchSource = (rel: string) => {
		setActivePath(rel);
		const found = sources.find((item) => item.relativePath === rel);
		setDraft(found?.content ?? "");
	};

	const saveMemory = async () => {
		setSaving(true);
		try {
			const updated = await window.pi.writeMemoryFile(activePath, draft);
			setSources((prev) => {
				const exists = prev.some((s) => s.relativePath === updated.relativePath);
				return exists ? prev.map((s) => (s.relativePath === updated.relativePath ? updated : s)) : [...prev, updated];
			});
			onNotice(`已保存 ${activePath}`);
		} catch (error) {
			fail(error);
		} finally {
			setSaving(false);
		}
	};

	const createRule = async () => {
		const slug = newRuleName.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.md$/i, "");
		if (!slug) return;
		const rel = `.claude/rules/${slug}.md`;
		setSaving(true);
		try {
			const template = `---\npaths: src/**\n---\n\n# ${slug}\n\n`;
			const created = await window.pi.writeMemoryFile(rel, template);
			setSources((prev) => [...prev, created]);
			setActivePath(created.relativePath);
			setDraft(created.content);
			setNewRuleName("");
			onNotice(`已创建规则 ${rel}`);
		} catch (error) {
			fail(error);
		} finally {
			setSaving(false);
		}
	};

	const deleteRule = async () => {
		if (!activePath.includes("/rules/")) return;
		setSaving(true);
		try {
			const next = await window.pi.deleteMemoryRule(activePath);
			setReport(next);
			setSources(next.sources);
			const fallback = next.sources.find((s) => s.relativePath === "AGENTS.md") ?? next.sources[0];
			if (fallback) {
				setActivePath(fallback.relativePath);
				setDraft(fallback.content);
			}
			onNotice(`已删除 ${activePath}`);
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
	const restricted = snapshot.settings.permission === "read" || snapshot.settings.permission === "plan";
	const mcpCount = tools.filter((t) => t.source === "mcp").length;
	const activeToolsCount = tools.filter((t) => t.enabled && t.modelVisible).length;

	const totalWindow = report?.contextWindow ?? ctxUsage?.contextWindow ?? 128000;
	const pctInstructions = report ? Math.min(100, (report.estimatedInstructionsTokens / Math.max(1, totalWindow)) * 100) : 0;
	const pctTools = report ? Math.min(100 - pctInstructions, (report.estimatedToolsTokens / Math.max(1, totalWindow)) * 100) : 0;
	const pctConv = report ? Math.min(100 - pctInstructions - pctTools, (report.conversationTokens / Math.max(1, totalWindow)) * 100) : 0;

	return (
		<Modal title="项目记忆与会话状态" close={close} wide>
			<div className="simple-dialog">
				<div className="cc-modal-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
						<BookOpen size={14} /> 项目记忆 (/memory)
					</button>
					<button type="button" role="tab" aria-selected={tab === "context"} onClick={() => setTab("context")}>
						<Layers size={14} /> 上下文分析 (/context)
					</button>
					<button type="button" role="tab" aria-selected={tab === "status"} onClick={() => setTab("status")}>
						<Info size={14} /> 运行状态 (/status)
					</button>
				</div>

				{tab === "memory" && (
					<div className="cc-controls-body">
						<div className="cc-rewind-head">
							<div className="cc-memory-switch">
								{sources.map((entry) => (
									<button
										type="button"
										key={entry.id}
										className={`cc-mini-btn ${activePath === entry.relativePath ? "active" : ""}`}
										onClick={() => switchSource(entry.relativePath)}
										title={entry.path}
									>
										{entry.relativePath} {entry.exists ? `(${entry.estimatedTokens}t)` : "(新建)"}
									</button>
								))}
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
						<div className="cc-rule-create-bar">
							<input
								aria-label="新建规则文件名"
								placeholder="新增规则名 (保存到 .claude/rules/<name>.md)…"
								value={newRuleName}
								onChange={(e) => setNewRuleName(e.target.value)}
								disabled={!snapshot.active || restricted}
							/>
							<button
								type="button"
								className="cc-mini-btn"
								disabled={saving || !newRuleName.trim() || !snapshot.active || restricted}
								onClick={() => void createRule()}
							>
								<Plus size={12} /> 新建规则
							</button>
							{activePath.includes("/rules/") && activeSource?.exists && (
								<button type="button" className="cc-mini-btn danger" disabled={saving || restricted} onClick={() => void deleteRule()}>
									<Trash2 size={12} /> 删除此规则
								</button>
							)}
						</div>
						{activeSource && activeSource.imports.length > 0 && (
							<div className="cc-imports-row">
								<span className="subtle-note">@import 引用：</span>
								{activeSource.imports.map((imp) => (
									<span key={imp.target} className={`cc-source-tag ${imp.exists ? "" : "muted"}`}>
										@{imp.target} · {imp.exists ? "已解析" : "缺失"}
									</span>
								))}
							</div>
						)}
						{activeSource?.pathsPattern && (
							<p className="subtle-note">作用域 paths 匹配：{activeSource.pathsPattern}</p>
						)}
						<textarea
							className="cc-memory-editor"
							aria-label={`编辑 ${activePath}`}
							placeholder={`在此编写 ${activePath} 项目规范、构建命令与架构约定…`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							disabled={!snapshot.active || restricted || activeSource?.editable === false}
						/>
						<div className="dialog-actions">
							<button type="button" className="secondary-button" onClick={close}>
								关闭
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={saving || !snapshot.active || restricted || activeSource?.editable === false}
								onClick={() => void saveMemory()}
							>
								<Save size={13} />{" "}
								{restricted
									? "只读或 Plan 模式下不可保存"
									: activeSource?.editable === false
										? "全局只读视图"
										: `保存 ${activePath}`}
							</button>
						</div>
					</div>
				)}

				{tab === "context" && (
					<div className="cc-controls-body">
						<div className="cc-context-meter-wrap">
							<div className="cc-context-head">
								<strong>
									上下文占用 {report ? `${Math.round(report.percent)}%` : "-"}（
									{(report?.totalTokens ?? ctxUsage?.tokens ?? 0).toLocaleString()} / {totalWindow.toLocaleString()} tokens）
								</strong>
								<span>可用余量 {(report?.remainingTokens ?? 0).toLocaleString()} tokens</span>
							</div>
							<div className="cc-context-bar" aria-label="上下文分段占用条">
								<div className="cc-ctx-seg inst" style={{ width: `${Math.max(1, pctInstructions)}%` }} title="指令与记忆文件" />
								<div className="cc-ctx-seg tools" style={{ width: `${Math.max(1, pctTools)}%` }} title="激活工具与 MCP Schema" />
								<div className="cc-ctx-seg conv" style={{ width: `${Math.max(0, pctConv)}%` }} title="对话与工具输出" />
							</div>
							<div className="cc-context-legend">
								<span><i className="inst" /> 指令与规则 (~{report?.estimatedInstructionsTokens ?? 0} tok)</span>
								<span><i className="tools" /> 工具与 MCP (~{report?.estimatedToolsTokens ?? 0} tok · {report?.activeToolsCount ?? activeToolsCount} 工具)</span>
								<span><i className="conv" /> 对话消息 ({report?.conversationTokens ?? 0} tok)</span>
								<span>缓存命中率：{report?.cacheHitPercent ?? 0}%</span>
							</div>
						</div>

						<div className="cc-context-controls">
							<label className="live-setting-toggle">
								<input
									type="checkbox"
									checked={report?.autoCompactionEnabled ?? true}
									onChange={(e) => void onToggleAutoCompaction?.(e.target.checked).then(() => refreshReport())}
								/>
								自动上下文压缩（autoCompaction）
							</label>
							<label className="live-setting-toggle">
								<input
									type="checkbox"
									checked={report?.autoRetryEnabled ?? true}
									onChange={(e) => void onToggleAutoRetry?.(e.target.checked).then(() => refreshReport())}
								/>
								瞬态错误自动重试（autoRetry）
							</label>
						</div>

						<div className="cc-compact-row">
							<input
								aria-label="自定义压缩指令"
								placeholder="可选压缩保留指令（例如：仅保留接口契约、待修 Bug 与当前文件路径）…"
								value={compactInstructions}
								onChange={(e) => setCompactInstructions(e.target.value)}
							/>
							<button
								type="button"
								className="primary-button"
								disabled={!snapshot.active || snapshot.messages.length === 0 || !onCompact}
								onClick={() => void onCompact?.(compactInstructions.trim() || undefined).then(() => { setCompactInstructions(""); close(); })}
							>
								<Archive size={13} /> 立即 /compact 压缩
							</button>
						</div>

						{report && report.optimizationTips.length > 0 && (
							<div className="cc-context-tips">
								<strong>优化建议：</strong>
								<ul>
									{report.optimizationTips.map((tip) => (
										<li key={tip}>{tip}</li>
									))}
								</ul>
							</div>
						)}
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
								<small>思考：{snapshot.state?.thinkingLevel ?? "off"}{snapshot.settings.sandbox ? " · Seatbelt 沙箱" : ""}</small>
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
