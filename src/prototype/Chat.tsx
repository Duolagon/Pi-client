import { useState } from "react";
import {
	Check,
	ChevronDown,
	ChevronRight,
	FileCode2,
	Terminal,
	Copy,
	GitFork,
	ArrowRight,
	Search,
	Layout,
	Bug,
	ShieldCheck,
	Clock,
	Square,
} from "lucide-react";
import { PiMark, IconButton, Tag } from "./ui";
import type { Mode, Session, Panel } from "./data";
interface Props {
	session: Session;
	approve: () => void;
	reject: () => void;
	panel: (panel: Panel) => void;
	notify: (message: string) => void;
	suggestion: (text: string) => void;
	mode: Mode;
	fork: () => void;
}
export function Chat({ session, approve, reject, panel, notify, suggestion, mode, fork }: Props) {
	const [toolsOpen, setToolsOpen] = useState(false);
	const isNew = session.custom && session.messages.length === 0;
	const isDemo = session.id === "search";
	const working = session.status === "working";
	const approved = session.status === "done";
	const copy = () => {
		if (!navigator.clipboard) {
			notify("此预览环境不支持剪贴板，请直接选择文字复制。");
			return;
		}
		void navigator.clipboard
			.writeText("已为会话列表添加搜索功能，支持实时筛选与无结果状态。")
			.then(() => notify("已复制回复"))
			.catch(() => notify("剪贴板不可用，请直接选择文字复制。"));
	};
	if (isNew)
		return (
			<div className="home-content">
				<PiMark />
				<h1>一起，把想法变成代码。</h1>
				<p>选择项目，描述任务，Pi 会与你一起完成。</p>
				<div className="starter-grid">
					{[
						{
							icon: Search,
							title: "了解项目",
							description: "梳理代码架构和运行方式",
							prompt: "请先梳理这个项目的架构，说明核心模块和运行方式。",
						},
						{
							icon: Layout,
							title: "实现功能",
							description: "从想法到可用的实现",
							prompt: "请为会话列表增加搜索功能，先给出实现计划。",
						},
						{
							icon: Bug,
							title: "排查问题",
							description: "定位原因并验证修复",
							prompt: "请检查项目中可能存在的问题，并提出修复建议。",
						},
					].map((item) => (
						<button key={item.title} onClick={() => suggestion(item.prompt)}>
							<item.icon size={18} />
							<strong>{item.title}</strong>
							<span>{item.description}</span>
							<ArrowRight size={14} />
						</button>
					))}
				</div>
				<span className="home-footnote">本地工作区 · 你的代码始终在你的电脑上</span>
			</div>
		);
	return (
		<div className="chat-content">
			<div className="conversation-date">
				今天<span>·</span>本地会话
			</div>
			<div className="user-message">
				<p>
					{isDemo
						? "帮我给左侧会话列表加一个搜索功能，支持按标题实时筛选，并处理没有结果的情况。"
						: session.custom
							? session.messages[0]
							: session.id === "theme"
								? "给客户端增加深色主题，支持跟随系统外观。"
								: session.id === "rpc"
									? "梳理 Pi 的 RPC 会话生命周期，说明如何处理流式事件与取消。"
									: session.id === "welcome"
										? "请帮我了解这个项目的架构。"
										: session.title}
				</p>
			</div>
			<div className="assistant-message">
				<div className="assistant-header">
					<PiMark small />
					<strong>Pi</strong>
					<span>{working ? "正在处理" : session.status === "approval" ? "等待你的确认" : "编码助手"}</span>
				</div>
				{isDemo ? (
					<>
						<p>我会沿用现有侧栏的结构，加入轻量的搜索入口，并让筛选结果随输入实时更新。</p>
						<div className="task-progress">
							<div>
								<Check size={13} />
								<span>检查会话列表与现有组件</span>
							</div>
							<div>
								<Check size={13} />
								<span>实现标题筛选和空结果状态</span>
							</div>
							<div className={!approved ? "pending" : ""}>
								{approved ? <Check size={13} /> : <Clock size={13} />}
								<span>运行类型检查，验证修改</span>
								{!approved && <small>待确认</small>}
							</div>
						</div>
						<button className="tool-summary" onClick={() => setToolsOpen(!toolsOpen)} aria-expanded={toolsOpen}>
							{toolsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
							<span>读取了 4 个文件，修改了 3 个文件</span>
							<span className="diff-count">
								<b>+83</b>
								<i>−12</i>
							</span>
						</button>
						{toolsOpen && (
							<div className="tool-details">
								<div>
									<FileCode2 size={13} />
									读取 SessionList.tsx、App.tsx 等文件
									<Check size={12} />
								</div>
								<div>
									<FileCode2 size={13} />
									更新 SessionList.tsx
									<Check size={12} />
								</div>
								<div>
									<FileCode2 size={13} />
									创建 SearchInput.tsx
									<Check size={12} />
								</div>
								<div>
									<FileCode2 size={13} />
									更新 sidebar.css
									<Check size={12} />
								</div>
							</div>
						)}
						<p>搜索交互已完成：</p>
						<ul className="response-list">
							<li>按会话标题实时筛选，不区分大小写。</li>
							<li>保留项目分组，支持一键清空搜索。</li>
							<li>没有匹配结果时，显示清晰的空状态。</li>
						</ul>
						<button className="changes-card" onClick={() => panel("changes")}>
							<div className="changes-card-icon">
								<FileCode2 size={18} />
							</div>
							<div>
								<strong>查看代码修改</strong>
								<span>
									3 个文件
									<span className="diff-count">
										<b>+83</b>
										<i>−12</i>
									</span>
								</span>
							</div>
							<ChevronRight size={16} />
						</button>
					</>
				) : session.custom ? (
					<>
						<p>
							{mode === "计划模式"
								? "我会先探索项目，再按照以下步骤整理方案，等待你确认后执行。"
								: "我会先阅读相关代码，确认现有模式，再实现修改并验证。"}
						</p>
						<div className="task-progress">
							<div>
								<Check size={13} />
								检查项目结构与相关文件
							</div>
							<div>{approved ? <Check size={13} /> : <Clock size={13} />}制定实现与验证方案</div>
							<div className={approved ? "" : "pending"}>
								{approved ? <Check size={13} /> : <Clock size={13} />}
								{mode === "计划模式" ? "等待审核计划" : "完成修改并检查结果"}
							</div>
						</div>
						<p className="subtle-note">这是界面交互演示，回复与执行过程使用预设数据。</p>
					</>
				) : (
					<>
						<p>
							{session.id === "rpc"
								? "Pi 的 RPC 模式通过 JSONL 交换命令和事件。桌面客户端可保持一个长期运行的子进程，订阅回复、工具执行和会话状态。"
								: session.id === "theme"
									? "已整理深色主题的实现方案。界面使用统一的颜色变量，支持浅色、深色和跟随系统三种外观。"
									: "已完成项目结构的初步梳理。Pi 将模型 API、Agent 循环、终端界面和编码工具拆分为独立模块，桌面端可以通过 RPC 复用编码能力。"}
						</p>
						<div className="info-note">
							<FileCode2 size={16} />
							<span>
								{session.id === "theme"
									? "可在设置 → 外观中预览深色主题"
									: "此会话使用原型示例内容，可从侧栏切换其他场景。"}
							</span>
						</div>
					</>
				)}
				{session.status === "approval" && (
					<div className="approval-card">
						<div className="approval-heading">
							<ShieldCheck size={17} />
							<strong>运行命令前需要你的确认</strong>
							<Tag>演示</Tag>
						</div>
						<p>检查代码格式与 TypeScript 类型，验证本次修改。</p>
						<div className="command-block">
							<Terminal size={14} />
							<code>npm run check</code>
							<span>pi /</span>
						</div>
						<div className="approval-footer">
							<span>仅批准本次操作</span>
							<button className="secondary-button" onClick={reject}>
								拒绝
							</button>
							<button className="primary-button" onClick={approve}>
								允许执行
								<ArrowRight size={13} />
							</button>
						</div>
					</div>
				)}
				{working && (
					<div className="working-state" role="status">
						<span className="spinner" />
						{isDemo ? "正在运行代码检查…" : "正在探索项目并整理方案…"}
						<span>演示执行</span>
					</div>
				)}
				{approved && (isDemo || session.custom) && (
					<div className="completion-note">
						<Check size={15} />
						<div>
							<strong>
								{mode === "计划模式" && session.custom ? "计划已准备好，等待你审核。" : "已完成，修改可以审核。"}
							</strong>
							<span>{isDemo ? "演示结果：格式与类型检查通过。" : "原型演示已完成，未修改实际项目文件。"}</span>
						</div>
					</div>
				)}
				{session.status === "stopped" && (
					<div className="stopped-note">
						<Square size={12} />
						<span>任务已停止。你可以补充要求后继续。</span>
					</div>
				)}
				<div className="message-actions">
					<IconButton icon={Copy} label="复制回复" onClick={copy} />
					<IconButton icon={GitFork} label="从这里分叉会话" onClick={fork} />
					<span>{working ? "执行中" : "刚刚"}</span>
					<span className="model-attribution">{isDemo ? "Claude Sonnet" : "Pi"} · 示例会话</span>
				</div>
			</div>
			{session.messages.slice(session.custom ? 1 : 0).map((text, index) => (
				<div key={`${session.id}-${index}`}>
					<div className="user-message">
						<p>{text}</p>
					</div>
					<div className="followup-note">
						<PiMark small />
						<p>
							{session.status === "working" && index === session.messages.length - (session.custom ? 2 : 1)
								? "收到，我会按新的要求继续调整。"
								: "已记录你的补充要求。此处展示继续对话的交互效果。"}
						</p>
					</div>
				</div>
			))}
		</div>
	);
}
