import { useEffect, useState } from "react";
import { Bot, Copy, GitFork, Import } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { CliSessionHistoryItem, Conversation, SessionTreeResult, Snapshot } from "../shared.ts";

type TreeNode = SessionTreeResult["tree"][number];

function nodeSummary(node: TreeNode): string {
	const entry = node.entry;
	if (entry.type === "message") {
		const msg = entry.message;
		const role = msg.role;
		if ("content" in msg) {
			if (typeof msg.content === "string") return `[${role}] ${msg.content.slice(0, 80)}`;
			if (Array.isArray(msg.content)) {
				const textBlock = msg.content.find((b) => typeof b === "object" && b !== null && "text" in b) as { text?: string } | undefined;
				if (textBlock?.text) return `[${role}] ${textBlock.text.slice(0, 80)}`;
			}
		}
		return `[${role}]`;
	}
	return `[${entry.type}]`;
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
	const [cliSessions, setCliSessions] = useState<CliSessionHistoryItem[]>([]);
	const [busy, setBusy] = useState(false);

	const loadTree = async () => {
		if (!conversationId) return;
		try {
			const res = await window.pi.sessions.tree(conversationId);
			setTreeData(res);
		} catch (error) {
			fail(error);
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

	const renderNodes = (nodes: TreeNode[], depth = 0) =>
		nodes.map((node) => {
			const isLeaf = treeData?.leafId === node.entry.id;
			return (
				<div key={node.entry.id}>
					<div className={`cc-tree-node ${isLeaf ? "active" : ""}`} style={{ paddingLeft: `${8 + depth * 16}px` }}>
						<span className="cc-tree-node-text">{nodeSummary(node)}</span>
						<div className="cc-tool-ctrl-actions">
							{!isLeaf && (
								<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void navigate(node.entry.id)}>
									跳转
								</button>
							)}
							<button type="button" className="cc-mini-btn" disabled={busy} onClick={() => void forkFrom(node.entry.id)} title="从此节点分叉新会话">
								<GitFork size={12} /> 分叉
							</button>
						</div>
					</div>
					{node.children.length > 0 && renderNodes(node.children, depth + 1)}
				</div>
			);
		});

	return (
		<Modal title="会话分支树与 CLI 历史导入 (/sessions)" close={close} wide>
			<div className="simple-dialog">
			<div className="cc-modal-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === "tree"} onClick={() => setTab("tree")}>
					会话分支树
				</button>
				<button type="button" role="tab" aria-selected={tab === "cli"} onClick={() => setTab("cli")}>
					Pi CLI 历史 ({cliSessions.length})
				</button>
				<button type="button" role="tab" aria-selected={tab === "subagents"} onClick={() => setTab("subagents")}>
					<Bot size={13} /> 子 Agent ({allSubagents.length})
				</button>
			</div>

			{tab === "tree" && (
				<div className="cc-controls-body">
					<div className="cc-rewind-head">
						<span className="subtle-note">浏览会话分支，或克隆当前分支继续探索。</span>
						<button type="button" className="secondary-button" disabled={busy || !conversationId} onClick={() => void cloneSession()}>
							<Copy size={13} /> 克隆当前分支
						</button>
					</div>
					<div className="cc-list-scroll">
						{treeData?.tree.length ? renderNodes(treeData.tree) : <p className="subtle-note">当前会话暂无分支节点。</p>}
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
		</Modal>
	);
}
