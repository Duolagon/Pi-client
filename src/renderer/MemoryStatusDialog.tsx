import { useEffect, useRef, useState } from "react";
import { Archive, BookOpen, Info, Layers, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import type { ContextBreakdown, ContextMemorySource, DesktopToolInfo, Snapshot } from "../shared.ts";

const promptStateLabels: Record<NonNullable<ContextMemorySource["promptState"]>, string> = {
	native: "最近回合由 Pi 原生加载",
	included: "最近回合已载入",
	truncated: "最近回合只载入前段，已截断",
	conditional: "按文件路径规则加载",
	untrusted: "项目未信任，桌面端跳过",
	"not-observed": "最近回合未见此来源",
};

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
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [confirmRuleDelete, setConfirmRuleDelete] = useState(false);
	const [compactInstructions, setCompactInstructions] = useState("");
	const [tools, setTools] = useState<DesktopToolInfo[]>([]);
	const [hoveredSeg, setHoveredSeg] = useState<"inst" | "tools" | "conv" | null>(null);
	const [reportRevision, setReportRevision] = useState(0);
	const loadedConversation = useRef<string | undefined>(undefined);
	const activeId = snapshot.active?.id;
	const stats = snapshot.stats;
	const ctxUsage = stats?.contextUsage;
	const model = snapshot.state?.model;
	const liveContext = tab === "context" ? ctxUsage : undefined;
	const liveModel = tab === "context" ? model : undefined;

	const refreshReport = async (conversationId: string, isCurrent: () => boolean) => {
		if (loadedConversation.current === conversationId) {
			const ctx = await window.pi.contextReport();
			if (isCurrent()) setReport(ctx);
			return;
		}
		const [ctx, toolList] = await Promise.all([
			window.pi.contextReport().catch(() => null),
			window.pi.tools.list(conversationId).catch(() => []),
		]);
		if (!isCurrent()) return;
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
			if (!isCurrent()) return;
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
		loadedConversation.current = conversationId;
	};

	useEffect(() => {
		if (!activeId) return;
		let current = true;
		if (loadedConversation.current !== activeId) {
			setReport(null);
			setLoading(true);
		}
		void refreshReport(activeId, () => current)
			.catch((error) => { if (current) fail(error); })
			.finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [activeId, liveModel?.provider, liveModel?.id, liveContext?.contextWindow, liveContext?.tokens, reportRevision]);

	const activeSource = sources.find((s) => s.relativePath === activePath);

	const switchSource = (rel: string) => {
		setActivePath(rel);
		setConfirmRuleDelete(false);
		const found = sources.find((item) => item.relativePath === rel);
		setDraft(found?.content ?? "");
	};

	const saveMemory = async () => {
		if (!activeSource?.editable || loading || saving) return;
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

	const restricted = snapshot.settings.permission === "read" || snapshot.settings.permission === "plan";
	const canEdit = !loading && !saving && !restricted && Boolean(activeSource?.editable);
	const mcpCount = tools.filter((t) => t.source === "mcp").length;
	const activeToolsCount = tools.filter((t) => t.enabled && t.modelVisible).length;
	const deferredToolNames = report?.deferredToolNames ?? tools.filter((tool) => tool.deferred).map((tool) => tool.name);

	const totalWindow = ctxUsage?.contextWindow ?? report?.contextWindow ?? model?.contextWindow ?? null;
	const totalTokens = ctxUsage ? ctxUsage.tokens : report?.totalTokens ?? null;
	const contextPercent = ctxUsage ? ctxUsage.percent : report?.percent ?? null;
	const remainingTokens = totalTokens !== null && totalWindow !== null ? Math.max(0, totalWindow - totalTokens) : null;
	const estimatedInstructions = report?.estimatedInstructionsTokens ?? 0;
	const estimatedTools = report?.estimatedToolsTokens ?? 0;
	const conversationTokens = totalTokens === null ? null : Math.max(0, totalTokens - estimatedInstructions - estimatedTools);
	const pctInstructions = totalWindow && totalTokens !== null ? Math.min(totalTokens, estimatedInstructions) / totalWindow * 100 : 0;
	const pctTools = totalWindow && totalTokens !== null ? Math.min(Math.max(0, totalTokens - estimatedInstructions), estimatedTools) / totalWindow * 100 : 0;
	const pctConv = totalWindow && conversationTokens !== null ? conversationTokens / totalWindow * 100 : 0;
	const autoCompactionEnabled = report?.autoCompactionEnabled ?? snapshot.state?.autoCompactionEnabled ?? null;
	const compactionThreshold = report?.compactionThreshold ?? null;
	const waitingForUsage = totalTokens === null && (ctxUsage?.tokens === null || snapshot.messages.some((message) => message.role === "compactionSummary"));
	const usageLabel = contextPercent !== null && totalTokens !== null && totalWindow !== null
		? `上下文占用 ${Math.round(contextPercent)}%（${totalTokens.toLocaleString()} / ${totalWindow.toLocaleString()} tokens）`
		: waitingForUsage ? "上下文占用待更新" : "暂无上下文用量";

	return (
		<Modal title="项目记忆与会话状态" close={close} wide>
			<div className="simple-dialog">
				<SlidingTabList className="cc-modal-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
						<BookOpen size={14} /> 项目记忆 (/memory)
					</button>
					<button type="button" role="tab" aria-selected={tab === "context"} onClick={() => setTab("context")}>
						<Layers size={14} /> 上下文分析 (/context)
					</button>
					<button type="button" role="tab" aria-selected={tab === "status"} onClick={() => setTab("status")}>
						<Info size={14} /> 运行状态 (/status)
					</button>
				</SlidingTabList>

				<div key={tab} className="cc-tab-panel">
				{tab === "memory" && (
					<div className="cc-controls-body">
						<div className="cc-rewind-head">
							<SlidingTabList variant="pill" className="cc-memory-switch">
								{sources.map((entry) => (
									<button
										type="button"
										key={entry.id}
										aria-pressed={activePath === entry.relativePath}
										className={`cc-mini-btn ${activePath === entry.relativePath ? "active" : ""}`}
										onClick={() => switchSource(entry.relativePath)}
										disabled={saving}
										title={entry.path}
									>
										{entry.relativePath} {entry.exists ? `(${entry.estimatedTokens}t)` : "(新建)"}
									</button>
								))}
							</SlidingTabList>
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
								disabled={loading || saving || !snapshot.active || restricted}
							/>
							<button
								type="button"
								className="cc-mini-btn"
								disabled={loading || saving || !newRuleName.trim() || !snapshot.active || restricted}
								onClick={() => void createRule()}
							>
								<Plus size={12} /> 新建规则
							</button>
							{activePath.includes("/rules/") && activeSource?.exists && (
								confirmRuleDelete ? (
									<>
										<button type="button" className="cc-mini-btn" disabled={saving} onClick={() => setConfirmRuleDelete(false)}>
											取消
										</button>
										<button
											type="button"
											className="cc-mini-btn danger"
											disabled={saving || restricted}
											onClick={() => {
												setConfirmRuleDelete(false);
												void deleteRule();
											}}
										>
											确认删除规则
										</button>
									</>
								) : (
									<button type="button" className="cc-mini-btn danger" disabled={saving || restricted} onClick={() => setConfirmRuleDelete(true)}>
										<Trash2 size={12} /> 删除此规则
									</button>
								)
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
						{activeSource?.promptState && <p className="subtle-note">{promptStateLabels[activeSource.promptState]}</p>}
						{activeSource?.previewTruncated && <p className="subtle-note">此处仅预览文件前 256 KiB。请在编辑器中修改完整文件。</p>}
						{loading && <p className="subtle-note" role="status">正在加载项目记忆…</p>}
						<textarea
							className="cc-memory-editor"
							aria-label={`编辑 ${activePath}`}
							placeholder={`在此编写 ${activePath} 项目规范、构建命令与架构约定…`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							disabled={!canEdit}
						/>
						<div className="dialog-actions">
							<button type="button" className="secondary-button" onClick={close}>
								关闭
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={!canEdit}
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
								<strong>{usageLabel}</strong>
								{remainingTokens !== null
									? <span>可用余量 {remainingTokens.toLocaleString()} tokens</span>
									: totalWindow !== null && <span>窗口 {totalWindow.toLocaleString()} tokens</span>}
							</div>
							{waitingForUsage && <span className="subtle-note">模型下次回复后会更新占用量。</span>}
							{totalTokens !== null && (
								<div className={`cc-context-bar ${hoveredSeg ? `has-hover hover-${hoveredSeg}` : ""}`.trim()} aria-label="上下文分段占用条">
									<div
										className="cc-ctx-seg inst"
										style={{ width: `${pctInstructions}%` }}
										title="指令与记忆文件"
										onMouseEnter={() => setHoveredSeg("inst")}
										onMouseLeave={() => setHoveredSeg(null)}
									/>
									<div
										className="cc-ctx-seg tools"
										style={{ width: `${pctTools}%` }}
										title="激活工具与 MCP Schema"
										onMouseEnter={() => setHoveredSeg("tools")}
										onMouseLeave={() => setHoveredSeg(null)}
									/>
									<div
										className="cc-ctx-seg conv"
										style={{ width: `${pctConv}%` }}
										title="对话与工具输出"
										onMouseEnter={() => setHoveredSeg("conv")}
										onMouseLeave={() => setHoveredSeg(null)}
									/>
								</div>
							)}
							<div className="cc-context-legend">
								<span
									className={hoveredSeg === "inst" ? "is-active" : undefined}
									onMouseEnter={() => setHoveredSeg("inst")}
									onMouseLeave={() => setHoveredSeg(null)}
								>
									<i className="inst" /> 指令与规则 (~{report?.estimatedInstructionsTokens ?? 0} tok)
								</span>
								<span
									className={hoveredSeg === "tools" ? "is-active" : undefined}
									onMouseEnter={() => setHoveredSeg("tools")}
									onMouseLeave={() => setHoveredSeg(null)}
								>
									<i className="tools" /> 工具与 MCP (~{report?.estimatedToolsTokens ?? 0} tok · {report?.activeToolsCount ?? activeToolsCount} 工具)
								</span>
								{deferredToolNames.length > 0 && (
									<span title={deferredToolNames.join("、")}>延迟加载 {deferredToolNames.length} 个工具</span>
								)}
								<span
									className={hoveredSeg === "conv" ? "is-active" : undefined}
									onMouseEnter={() => setHoveredSeg("conv")}
									onMouseLeave={() => setHoveredSeg(null)}
								>
									<i className="conv" /> 对话消息 {conversationTokens !== null ? `(${conversationTokens.toLocaleString()} tok)` : "（待统计）"}
								</span>
								<span>缓存命中率：{report?.cacheHitPercent ?? 0}%</span>
							</div>
						</div>

						<div className="cc-context-controls">
							<label className="live-setting-toggle">
								<input
									type="checkbox"
									checked={autoCompactionEnabled === true}
									disabled={autoCompactionEnabled === null || !onToggleAutoCompaction}
									onChange={(e) => void onToggleAutoCompaction?.(e.target.checked).then(() => setReportRevision((current) => current + 1)).catch(fail)}
								/>
								自动上下文压缩（autoCompaction）
							</label>
							<label className="live-setting-toggle">
								<input
									type="checkbox"
									checked={report?.autoRetryEnabled ?? true}
									onChange={(e) => void onToggleAutoRetry?.(e.target.checked).then(() => setReportRevision((current) => current + 1)).catch(fail)}
								/>
								瞬态错误自动重试（autoRetry）
							</label>
						</div>
						{autoCompactionEnabled && compactionThreshold !== null && (
							<span className="subtle-note">按容量自动压缩在占用超过 {compactionThreshold.toLocaleString()} tokens 时触发。</span>
						)}

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
									<strong>{contextPercent !== null ? `${Math.round(contextPercent)}%` : "待统计"}</strong>
								<small>
										{totalTokens !== null && totalWindow !== null ? `${totalTokens.toLocaleString()} / ${totalWindow.toLocaleString()} tokens` : "等待统计"}
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
			</div>
		</Modal>
	);
}
