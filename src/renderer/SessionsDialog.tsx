import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, Bot, Copy, GitBranch, GitFork, Import, Sparkles, User } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import type { CliSessionHistoryItem, Conversation, SessionTreeResult, Snapshot } from "../shared.ts";

type TreeNode = SessionTreeResult["tree"][number];

interface ParsedTreeNode {
	kind: "user" | "assistant" | "compaction" | "branch" | "custom" | "meta";
	badge: string;
	text: string;
	time?: string;
	internal: boolean;
}

function formatNodeTime(raw: unknown): string | undefined {
	if (typeof raw === "number" && raw > 0) {
		return new Date(raw).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
	}
	if (typeof raw === "string" && raw) {
		const ts = Date.parse(raw);
		if (Number.isFinite(ts)) {
			return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
		}
	}
	return undefined;
}

function extractMessagePreview(content: unknown): string {
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim().slice(0, 96);
	if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "object" && block !== null && "text" in block && typeof (block as { text?: unknown }).text === "string") {
				const trimmed = (block as { text: string }).text.replace(/\s+/g, " ").trim();
				if (trimmed && !trimmed.startsWith("<desktop-workspace-context>")) return trimmed.slice(0, 96);
			}
		}
		for (const block of content) {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall") {
				const name = (block as { name?: unknown }).name;
				if (typeof name === "string") return `调用工具 ${name}`;
			}
		}
	}
	return "";
}

function describeNode(node: TreeNode): ParsedTreeNode {
	const entry = node.entry;
	const time = formatNodeTime((entry as { timestamp?: unknown }).timestamp);
	if (entry.type === "message") {
		const msg = entry.message;
		const role = msg.role;
		const preview = "content" in msg ? extractMessagePreview(msg.content) : "";
		if (role === "user") {
			return { kind: "user", badge: "用户", text: preview || "(附件或空消息)", time, internal: false };
		}
		if (role === "assistant") {
			return { kind: "assistant", badge: "助手", text: preview || "(工具步骤)", time, internal: false };
		}
		if (role === "compactionSummary") {
			return { kind: "compaction", badge: "压缩摘要", text: preview || "已生成上下文摘要", time, internal: false };
		}
		if (role === "branchSummary") {
			return { kind: "branch", badge: "分支摘要", text: preview || "分支合并摘要", time, internal: false };
		}
		if (role === "bashExecution") {
			const cmd = "command" in msg && typeof msg.command === "string" ? msg.command : "";
			return { kind: "custom", badge: "终端", text: cmd ? `$ ${cmd.slice(0, 80)}` : "命令执行", time, internal: false };
		}
		return { kind: "meta", badge: role, text: preview || role, time, internal: true };
	}
	if (entry.type === "compaction") {
		return { kind: "compaction", badge: "压缩", text: "上下文压缩节点", time, internal: false };
	}
	if (entry.type === "branch_summary") {
		return { kind: "branch", badge: "分支", text: "分支摘要节点", time, internal: false };
	}
	const metaLabels: Record<string, string> = {
		model_change: "切换模型",
		thinking_level_change: "思考强度变更",
		session_info: "会话初始化",
		custom_message: "扩展事件",
	};
	return {
		kind: "meta",
		badge: "系统",
		text: metaLabels[entry.type] ?? entry.type,
		time,
		internal: true,
	};
}

function nodeIcon(kind: ParsedTreeNode["kind"]): ReactNode {
	if (kind === "user") return <User size={12} aria-hidden="true" />;
	if (kind === "assistant") return <Sparkles size={12} aria-hidden="true" />;
	if (kind === "compaction") return <Archive size={12} aria-hidden="true" />;
	if (kind === "branch") return <GitBranch size={12} aria-hidden="true" />;
	return null;
}

interface VisibleTreeNode {
	node: TreeNode;
	info: ParsedTreeNode;
	children: VisibleTreeNode[];
}

type RailSegment = "line" | "empty" | "mid" | "last" | "cont";

function buildVisibleTree(nodes: TreeNode[], showInternal: boolean, leafId?: string | null): VisibleTreeNode[] {
	const out: VisibleTreeNode[] = [];
	for (const node of nodes) {
		const info = describeNode(node);
		const visibleChildren = buildVisibleTree(node.children, showInternal, leafId);
		const keep = showInternal || !info.internal || (leafId === node.entry.id && visibleChildren.length === 0);
		if (keep) {
			out.push({ node, info, children: visibleChildren });
		} else {
			out.push(...visibleChildren);
		}
	}
	return out;
}

function collectActiveLineage(nodes: TreeNode[], leafId?: string | null): Set<string> {
	const lineage = new Set<string>();
	if (!leafId) return lineage;
	const dfs = (node: TreeNode): boolean => {
		if (node.entry.id === leafId) {
			lineage.add(node.entry.id);
			return true;
		}
		for (const child of node.children) {
			if (dfs(child)) {
				lineage.add(node.entry.id);
				return true;
			}
		}
		return false;
	};
	for (const root of nodes) dfs(root);
	return lineage;
}

export function SessionsDialog({
	conversationId,
	project,
	orphanedSubagents = [],
	allSubagents = [],
	onSelectConversation,
	onSnapshot,
	onEditorText,
	close,
	fail,
}: {
	conversationId?: string;
	project?: string;
	/** Sub-agent conversations whose parent conversation was deleted. */
	orphanedSubagents?: Conversation[];
	/** All sub-agent conversations (for discovery outside the folded sidebar). */
	allSubagents?: Conversation[];
	onSelectConversation?: (id: string) => void;
	onSnapshot: (snapshot: Snapshot) => void;
	onEditorText?: (text: string) => void;
	close: () => void;
	fail: (error: unknown) => void;
}) {
	const [tab, setTab] = useState<"tree" | "cli" | "subagents">("tree");
	const [treeData, setTreeData] = useState<SessionTreeResult | null>(null);
	const [treeLoading, setTreeLoading] = useState<boolean>(Boolean(conversationId));
	const [showInternal, setShowInternal] = useState(false);
	const [cliSessions, setCliSessions] = useState<CliSessionHistoryItem[]>([]);
	const [busy, setBusy] = useState(false);

	const loadTree = async () => {
		if (!conversationId) {
			setTreeLoading(false);
			return;
		}
		setTreeLoading(true);
		try {
			const res = await window.pi.sessions.tree(conversationId);
			setTreeData(res);
		} catch (error) {
			fail(error);
		} finally {
			setTreeLoading(false);
		}
	};

	const loadCli = async () => {
		try {
			const res = await window.pi.sessions.history({ project });
			setCliSessions(res.sessions);
		} catch (error) {
			fail(error);
		}
	};

	useEffect(() => {
		void loadTree();
		void loadCli();
	}, [conversationId, project]);

	const navigate = async (targetId: string) => {
		setBusy(true);
		try {
			const res = await window.pi.sessions.navigate({ conversationId, targetId });
			if (!res.cancelled) {
				onSnapshot(res.snapshot);
				if (res.editorText && onEditorText) {
					onEditorText(res.editorText);
					close();
					return;
				}
				await loadTree();
			}
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const cloneSession = async () => {
		setBusy(true);
		try {
			const res = await window.pi.sessions.clone({ conversationId, activate: true });
			if (!res.cancelled) {
				onSnapshot(res.snapshot);
				close();
			}
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const forkFrom = async (entryId: string) => {
		setBusy(true);
		try {
			const res = await window.pi.sessions.fork({ conversationId, entryId, activate: true });
			if (!res.cancelled) {
				onSnapshot(res.snapshot);
				close();
			}
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const importCli = async (token: string) => {
		setBusy(true);
		try {
			const res = await window.pi.sessions.importHistory({ token, activate: true });
			onSnapshot(res.snapshot);
			close();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};

	const activeLineage = useMemo(() => collectActiveLineage(treeData?.tree ?? [], treeData?.leafId), [treeData]);
	const visibleRoots = useMemo(() => buildVisibleTree(treeData?.tree ?? [], showInternal, treeData?.leafId), [treeData, showInternal]);

	const renderVisibleChain = (chainStart: VisibleTreeNode, ancestorRails: Array<"line" | "empty">, branchHead?: "mid" | "last"): ReactNode[] => {
		const out: ReactNode[] = [];
		let current: VisibleTreeNode | undefined = chainStart;
		let isFirstInBranch = true;
		while (current) {
			const nodeRef: VisibleTreeNode = current;
			const { node, info, children } = nodeRef;
			const isLeaf = treeData?.leafId === node.entry.id;
			const inLineage = activeLineage.has(node.entry.id);
			const splits = children.length > 1;
			const rails: RailSegment[] = [...ancestorRails];
			if (branchHead) {
				if (isFirstInBranch) {
					rails.push(branchHead);
				} else {
					rails.push(branchHead === "mid" ? "line" : "empty");
					rails.push("cont");
				}
			}
			out.push(
				<div
					key={node.entry.id}
					className={`cc-tree-node kind-${info.kind} ${inLineage ? "in-lineage" : ""} ${isLeaf ? "active" : ""}`.trim()}
				>
					{rails.length > 0 && (
						<span className="cc-tree-rails" aria-hidden="true">
							{rails.map((seg, i) => (
								<span key={i} className={`cc-tree-rail is-${seg}`} />
							))}
						</span>
					)}
					<div className="cc-tree-node-main">
						<span className={`cc-tree-role-badge role-${info.kind}`}>
							{nodeIcon(info.kind)}
							<span>{info.badge}</span>
						</span>
						<span className="cc-tree-node-text" title={info.text}>{info.text}</span>
						{splits && <span className="cc-source-tag">{children.length} 个分支</span>}
						{isLeaf && <span className="cc-source-tag cc-leaf-tag">当前位置</span>}
						{!isLeaf && inLineage && <span className="cc-source-tag muted">当前主线</span>}
						{info.time && <time className="cc-tree-node-time">{info.time}</time>}
					</div>
					<div className="cc-tool-ctrl-actions">
						{!isLeaf && (
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void navigate(node.entry.id)}>
								跳转
							</button>
						)}
						{!info.internal && (
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void forkFrom(node.entry.id)} title="从此节点分叉新会话">
								<GitFork size={12} /> 分叉
							</button>
						)}
					</div>
				</div>,
			);
			isFirstInBranch = false;
			if (children.length === 1) {
				current = children[0];
			} else {
				if (children.length > 1) {
					const nextAncestors: Array<"line" | "empty"> = branchHead
						? [...ancestorRails, branchHead === "mid" ? "line" : "empty"]
						: ancestorRails;
					children.forEach((child, idx) => {
						const isLast = idx === children.length - 1;
						out.push(...renderVisibleChain(child, nextAncestors, isLast ? "last" : "mid"));
					});
				}
				current = undefined;
			}
		}
		return out;
	};

	const renderedTree = useMemo(() => {
		if (!visibleRoots.length) return [];
		if (visibleRoots.length === 1) return renderVisibleChain(visibleRoots[0], []);
		return visibleRoots.flatMap((root, idx) =>
			renderVisibleChain(root, [], idx === visibleRoots.length - 1 ? "last" : "mid"),
		);
	}, [visibleRoots, activeLineage, busy, treeData?.leafId]);

	return (
		<Modal title="会话分支树与 CLI 历史导入 (/sessions)" close={close} wide>
			<div className="simple-dialog">
			<SlidingTabList className="cc-modal-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === "tree"} onClick={() => setTab("tree")}>
					会话分支树
				</button>
				<button type="button" role="tab" aria-selected={tab === "cli"} onClick={() => setTab("cli")}>
					Pi CLI 历史 ({cliSessions.length})
				</button>
				<button type="button" role="tab" aria-selected={tab === "subagents"} onClick={() => setTab("subagents")}>
					<Bot size={13} /> 子 Agent ({allSubagents.length})
				</button>
			</SlidingTabList>

			<div key={tab} className="cc-tab-panel">
			{tab === "tree" && (
				<div className="cc-controls-body">
					<div className="cc-rewind-head">
						<span className="subtle-note">浏览对话时间线与分叉节点，支持跳转到任意历史轮次或克隆当前分支。</span>
						<div className="cc-tool-ctrl-actions">
							<label className="live-setting-toggle cc-inline-switch">
								<input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
								<span>显示系统事件</span>
							</label>
							<button type="button" className="secondary-button" disabled={busy || !conversationId} onClick={() => void cloneSession()}>
								<Copy size={13} /> 克隆当前分支
							</button>
						</div>
					</div>
					<div className="cc-list-scroll cc-session-tree-list">
						{treeLoading && !treeData ? (
							<div className="cc-skeleton-stack" role="status">
								<p className="subtle-note cc-shimmer-text">正在读取会话分支树…</p>
								<span className="cc-skeleton-card" aria-hidden="true" />
								<span className="cc-skeleton-card" aria-hidden="true" />
							</div>
						) : renderedTree.length > 0 ? (
							renderedTree
						) : (
							<p className="subtle-note">当前会话暂无对话节点。</p>
						)}
					</div>
				</div>
			)}

			{tab === "cli" && (
				<div className="cc-controls-body">
					<div className="cc-list-scroll">
						{cliSessions.map((item) => (
							<div key={item.token} className="cc-tool-ctrl-row">
								<div className="cc-tool-ctrl-info">
									<div className="cc-tool-ctrl-name">
										<strong>{item.title || item.sourceSessionId}</strong>
										<span className="cc-source-tag">{item.messageCount} 条消息</span>
										{item.importedConversationId && <span className="cc-source-tag">已导入</span>}
									</div>
									<p className="cc-tool-ctrl-desc">{item.project}</p>
								</div>
								<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void importCli(item.token)}>
									<Import size={13} /> {item.importedConversationId ? "打开" : "导入"}
								</button>
							</div>
						))}
						{!cliSessions.length && <p className="subtle-note">未发现可导入的 Pi CLI 历史会话。</p>}
					</div>
				</div>
			)}

			{tab === "subagents" && (
				<div className="cc-controls-body">
					<div className="cc-list-scroll">
						{orphanedSubagents.length > 0 && (
							<div className="cc-subagent-group-label">孤儿子 Agent（父会话已删除）</div>
						)}
						{orphanedSubagents.map((item) => (
							<div key={item.id} className="cc-tool-ctrl-row">
								<div className="cc-tool-ctrl-info">
									<div className="cc-tool-ctrl-name">
										<strong>{item.title}</strong>
										<span className="cc-source-tag">孤儿</span>
									</div>
									<p className="cc-tool-ctrl-desc">{item.project}</p>
								</div>
								{onSelectConversation && (
									<button
										type="button"
										className="cc-mini-btn"
										disabled={busy}
										onClick={() => {
											onSelectConversation(item.id);
											close();
										}}
									>
										打开
									</button>
								)}
							</div>
						))}
						{allSubagents.filter((s) => !orphanedSubagents.some((o) => o.id === s.id)).map((item) => (
							<div key={item.id} className="cc-tool-ctrl-row">
								<div className="cc-tool-ctrl-info">
									<div className="cc-tool-ctrl-name">
										<strong>{item.title}</strong>
										<span className="cc-source-tag muted">子 Agent</span>
									</div>
									<p className="cc-tool-ctrl-desc">{item.project}</p>
								</div>
								{onSelectConversation && (
									<button
										type="button"
										className="cc-mini-btn"
										disabled={busy}
										onClick={() => {
											onSelectConversation(item.id);
											close();
										}}
									>
										打开
									</button>
								)}
							</div>
						))}
						{!allSubagents.length && <p className="subtle-note">暂无子 Agent 会话。</p>}
					</div>
				</div>
			)}
			</div>
			</div>
		</Modal>
	);
}
