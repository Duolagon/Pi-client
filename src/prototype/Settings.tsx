import { useState } from "react";
import {
	Palette,
	Cpu,
	ShieldCheck,
	Puzzle,
	Keyboard,
	Monitor,
	Sun,
	Moon,
	Check,
	ChevronRight,
	CircleHelp,
} from "lucide-react";
import { Modal } from "./ui";
import { modes, type Mode } from "./data";
export type Theme = "light" | "dark" | "system";
interface Props {
	close: () => void;
	theme: Theme;
	setTheme: (theme: Theme) => void;
	mode: Mode;
	setMode: (mode: Mode) => void;
	notify: (message: string) => void;
}
export function Settings({ close, theme, setTheme, mode, setMode, notify }: Props) {
	const [tab, setTab] = useState("appearance");
	const [provider, setProvider] = useState("Anthropic");
	const [notifications, setNotifications] = useState(true);
	const tabs = [
		{ id: "appearance", name: "外观", icon: Palette },
		{ id: "models", name: "模型与连接", icon: Cpu },
		{ id: "permissions", name: "权限", icon: ShieldCheck },
		{ id: "extensions", name: "扩展", icon: Puzzle },
		{ id: "shortcuts", name: "快捷键", icon: Keyboard },
	];
	return (
		<Modal title="设置" close={close} wide>
			<div className="settings-layout">
				<nav aria-label="设置分类">
					{tabs.map((item) => (
						<button className={tab === item.id ? "selected" : ""} key={item.id} onClick={() => setTab(item.id)}>
							<item.icon size={16} />
							{item.name}
						</button>
					))}
					<div className="settings-version">
						Pi Desktop
						<br />
						0.1.0 · 界面原型
					</div>
				</nav>
				<div className="settings-content">
					{tab === "appearance" && (
						<>
							<h3>外观</h3>
							<p className="settings-description">让工作区看起来更像你喜欢的样子。</p>
							<h4>主题</h4>
							<div className="theme-options">
								{(
									[
										{ value: "light", label: "浅色", icon: Sun },
										{ value: "dark", label: "深色", icon: Moon },
										{ value: "system", label: "跟随系统", icon: Monitor },
									] as const
								).map((item) => (
									<button
										key={item.value}
										className={theme === item.value ? "selected" : ""}
										onClick={() => setTheme(item.value)}
										aria-pressed={theme === item.value}
									>
										<div className={`theme-sample ${item.value}`}>
											<i />
											<div>
												<b />
												<b />
												<b />
												<em />
											</div>
										</div>
										<span>
											<item.icon size={14} />
											{item.label}
											{theme === item.value && <Check size={13} />}
										</span>
									</button>
								))}
							</div>
							<div className="setting-row">
								<div>
									<strong>界面语言</strong>
									<p>菜单和控件的显示语言</p>
								</div>
								<span>简体中文</span>
							</div>
							<div className="setting-row">
								<div>
									<strong>任务完成通知</strong>
									<p>原型中预览通知开关</p>
								</div>
								<button
									className={`switch ${notifications ? "on" : ""}`}
									role="switch"
									aria-checked={notifications}
									aria-label="任务完成通知"
									onClick={() => setNotifications(!notifications)}
								>
									<i />
								</button>
							</div>
						</>
					)}
					{tab === "models" && (
						<>
							<h3>模型与连接</h3>
							<p className="settings-description">连接模型服务商，或复用 Pi 的已有配置。</p>
							<div className="prototype-info">
								<CircleHelp size={15} />
								<span>当前为连接界面预览，无需输入真实密钥。</span>
							</div>
							<label className="field-label">
								服务商
								<select value={provider} onChange={(event) => setProvider(event.target.value)}>
									{["Anthropic", "OpenAI", "Google", "OpenRouter", "自定义兼容接口"].map((name) => (
										<option key={name}>{name}</option>
									))}
								</select>
							</label>
							<label className="field-label">
								API 地址
								<input
									placeholder={
										provider === "Anthropic"
											? "https://api.anthropic.com"
											: provider === "OpenAI"
												? "https://api.openai.com/v1"
												: "https://api.example.com/v1"
									}
								/>
							</label>
							<label className="field-label">
								API Key
								<input type="password" disabled placeholder="原型阶段不采集或保存 API Key" />
							</label>
							<div className="settings-button-row">
								<span>正式版将使用系统安全存储</span>
								<button className="secondary-button" onClick={() => notify("连接界面预览已确认；原型未发起网络请求。")}>
									测试连接
								</button>
							</div>
							<div className="setting-row">
								<div>
									<strong>复用 Pi 配置</strong>
									<p>读取已有的模型与授权设置</p>
								</div>
								<span className="tag">待接入</span>
							</div>
						</>
					)}
					{tab === "permissions" && (
						<>
							<h3>权限</h3>
							<p className="settings-description">选择你希望参与任务执行的程度。</p>
							<div className="permission-options">
								{modes.map((item) => (
									<button
										key={item.name}
										onClick={() => setMode(item.name)}
										className={mode === item.name ? "selected" : ""}
									>
										<span className="radio-circle">{mode === item.name && <i />}</span>
										<span>
											<strong>{item.name}</strong>
											<small>{item.description}</small>
										</span>
									</button>
								))}
							</div>
							<div className="prototype-info">
								<ShieldCheck size={15} />
								<span>原型仅演示授权流程，不会运行命令或修改项目文件。</span>
							</div>
						</>
					)}
					{tab === "extensions" && (
						<>
							<h3>扩展</h3>
							<p className="settings-description">将你的开发习惯带入 Pi。</p>
							{[
								{ title: "Skills", text: "可重复使用的任务与工作流", count: "3 个示例" },
								{ title: "MCP 服务", text: "连接外部工具和数据源", count: "待接入" },
								{ title: "项目指令", text: "AGENTS.md · 项目约定与偏好", count: "示例" },
							].map((item) => (
								<button
									key={item.title}
									className="extension-row"
									onClick={() => notify(`${item.title}：正式版将提供配置和管理功能。`)}
								>
									<Puzzle size={18} />
									<div>
										<strong>{item.title}</strong>
										<p>{item.text}</p>
									</div>
									<span>{item.count}</span>
									<ChevronRight size={14} />
								</button>
							))}
						</>
					)}
					{tab === "shortcuts" && (
						<>
							<h3>快捷键</h3>
							<p className="settings-description">减少切换，保持专注。</p>
							{[
								["新建会话", "⌘ N"],
								["搜索会话", "⌘ K"],
								["打开设置", "⌘ ,"],
								["显示 / 隐藏侧栏", "⌘ B"],
								["显示 / 隐藏终端", "⌘ `"],
								["发送消息", "Enter"],
								["输入框换行", "Shift Enter"],
								["关闭对话框或菜单", "Esc"],
							].map(([title, key]) => (
								<div className="shortcut-row" key={title}>
									<span>{title}</span>
									<kbd>{key}</kbd>
								</div>
							))}
						</>
					)}
				</div>
			</div>
			<footer className="settings-footer">
				<span>外观与权限选择会保存在本机</span>
				<button className="primary-button" onClick={close}>
					完成
				</button>
			</footer>
		</Modal>
	);
}
