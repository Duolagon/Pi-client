import { useEffect, useRef, useState } from "react";
import {
	ArrowUp,
	Plus,
	ChevronDown,
	ShieldCheck,
	Lightbulb,
	Check,
	X,
	Paperclip,
	FileText,
	Square,
	Sparkles,
	Mic,
	Brain,
	FolderOpen,
	Monitor,
} from "lucide-react";
import { Menu, IconButton } from "./ui";
import { models, modes, fileTree, type Mode } from "./data";
interface Props {
	send: (text: string) => void;
	busy: boolean;
	stop: () => void;
	mode: Mode;
	setMode: (mode: Mode) => void;
	model: string;
	setModel: (model: string) => void;
	project: string;
	isNew: boolean;
	openProject: () => void;
	notify: (text: string) => void;
}
export function Composer({
	send,
	busy,
	stop,
	mode,
	setMode,
	model,
	setModel,
	project,
	isNew,
	openProject,
	notify,
}: Props) {
	const [text, setText] = useState("");
	const [menu, setMenu] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<string[]>([]);
	const [effort, setEffort] = useState("High");
	const input = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!menu) return;
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Element && !event.target.closest(".menu-anchor")) setMenu(null);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", escape);
		};
	}, [menu]);
	const submit = () => {
		if (!text.trim()) return;
		send(text.trim() + (attachments.length ? `\n\n参考文件：${attachments.join("、")}` : ""));
		setText("");
		setAttachments([]);
	};
	const attach = (name: string) => {
		setAttachments((files) => [...new Set([...files, name])]);
		setMenu(null);
		input.current?.focus();
	};
	const chooseFile = () => {
		setMenu(null);
		fileInput.current?.click();
	};
	return (
		<div className={`composer-wrap ${isNew ? "on-home" : ""}`}>
			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					Array.from(event.dataTransfer.files).forEach((file) => attach(file.name));
				}}
			>
				{attachments.length > 0 && (
					<div className="attachments">
						{attachments.map((name) => (
							<span key={name}>
								<FileText size={13} />
								{name}
								<button
									aria-label={`移除 ${name}`}
									onClick={() => setAttachments((files) => files.filter((file) => file !== name))}
									type="button"
								>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					ref={input}
					aria-label="输入任务"
					placeholder={isNew ? "今天想构建什么？" : "继续提问，或输入 / 使用命令…"}
					value={text}
					rows={isNew ? 3 : 2}
					onChange={(event) => {
						setText(event.target.value);
						if (event.target.value.endsWith("@")) setMenu("files");
						else if (event.target.value === "/") setMenu("commands");
					}}
					onPaste={(event) => {
						if (!event.clipboardData.files.length) return;
						event.preventDefault();
						Array.from(event.clipboardData.files).forEach((file) => attach(file.name || "粘贴的截图.png"));
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
						if (event.key === "Escape") setMenu(null);
					}}
				/>
				<div className="composer-bottom">
					<div className="composer-left">
						<div className="menu-anchor">
							<IconButton icon={Plus} label="添加文件与上下文" onClick={() => setMenu(menu === "add" ? null : "add")} />
							{menu === "add" && (
								<Menu label="添加上下文">
									<button type="button" onClick={chooseFile}>
										<Paperclip size={15} />
										上传文件或图片
									</button>
									<button type="button" onClick={() => setMenu("files")}>
										<FileText size={15} />
										引用项目文件<span>@</span>
									</button>
									<button type="button" onClick={() => setMenu("commands")}>
										<Sparkles size={15} />
										Skills 与命令<span>/</span>
									</button>
								</Menu>
							)}
							{menu === "files" && (
								<Menu label="选择项目文件">
									<div className="menu-caption">引用项目文件</div>
									{fileTree
										.filter((file) => !file.folder)
										.slice(0, 6)
										.map((file) => (
											<button
												type="button"
												key={file.name}
												onClick={() => {
													attach(file.name);
													setText((value) => (value.endsWith("@") ? value.slice(0, -1) : value));
												}}
											>
												<FileText size={14} />
												{file.name}
											</button>
										))}
								</Menu>
							)}
							{menu === "commands" && (
								<Menu label="斜杠命令">
									{["/plan 制定实现计划", "/review 审查当前修改", "/compact 压缩会话上下文"].map((command) => (
										<button
											type="button"
											key={command}
											onClick={() => {
												setText(`${command.split(" ")[0]} `);
												setMenu(null);
												input.current?.focus();
											}}
										>
											<Sparkles size={14} />
											{command}
										</button>
									))}
								</Menu>
							)}
						</div>
						<span className="composer-hint">{busy ? "可继续输入，调整执行方向" : "⌘ ↵ 发送 · Shift ↵ 换行"}</span>
					</div>
					<div className="composer-right">
						<IconButton
							icon={Mic}
							label="语音输入预览"
							onClick={() => notify("语音输入交互占位，正式版接入系统麦克风。")}
						/>
						{busy ? (
							<button className="send-button stop" type="button" aria-label="停止任务" onClick={stop}>
								<Square size={13} fill="currentColor" />
							</button>
						) : (
							<button className="send-button" type="submit" aria-label="发送任务" disabled={!text.trim()}>
								<ArrowUp size={17} />
							</button>
						)}
					</div>
				</div>
			</form>
			<div className="composer-controls">
				<div className="environment-controls">
					<button onClick={() => notify("当前原型使用本地环境；远程与云端能力在后续阶段接入。")}>
						<Monitor size={13} />
						本地
						<ChevronDown size={11} />
					</button>
					<button onClick={openProject}>
						<FolderOpen size={13} />
						{project}
						<ChevronDown size={11} />
					</button>
				</div>
				<div className="model-controls">
					<div className="menu-anchor">
						<button className="text-picker" onClick={() => setMenu(menu === "model" ? null : "model")}>
							{model}
							<ChevronDown size={11} />
						</button>
						{menu === "model" && (
							<Menu label="选择模型">
								<div className="menu-caption">模型 · 原型选项</div>
								{models.map((item) => (
									<button
										key={item.name}
										onClick={() => {
											setModel(item.name);
											setMenu(null);
										}}
									>
										<span className="model-monogram">{item.provider[0]}</span>
										<span className="menu-rich">
											<strong>{item.name}</strong>
											<small>{item.note}</small>
										</span>
										{model === item.name && <Check size={14} />}
									</button>
								))}
							</Menu>
						)}
					</div>
					<div className="menu-anchor">
						<button className="effort-picker" onClick={() => setMenu(menu === "effort" ? null : "effort")}>
							{effort}
							<ChevronDown size={10} />
						</button>
						{menu === "effort" && (
							<Menu label="思考强度">
								{["Low", "Medium", "High", "Max"].map((level) => (
									<button
										key={level}
										onClick={() => {
											setEffort(level);
											setMenu(null);
										}}
									>
										<Brain size={14} />
										{level}
										{level === effort && <Check size={13} />}
									</button>
								))}
							</Menu>
						)}
					</div>
					<span className="control-divider" />
					<div className="menu-anchor">
						<button
							className={`permission-picker ${mode === "计划模式" ? "planning" : ""}`}
							onClick={() => setMenu(menu === "mode" ? null : "mode")}
						>
							{mode === "计划模式" ? <Lightbulb size={13} /> : <ShieldCheck size={13} />}
							{mode}
							<ChevronDown size={11} />
						</button>
						{menu === "mode" && (
							<Menu label="权限模式">
								<div className="menu-caption">选择权限模式</div>
								{modes.map((item) => (
									<button
										key={item.name}
										onClick={() => {
											setMode(item.name);
											setMenu(null);
										}}
									>
										<span className="menu-rich">
											<strong>{item.name}</strong>
											<small>{item.description}</small>
										</span>
										{mode === item.name && <Check size={14} />}
									</button>
								))}
							</Menu>
						)}
					</div>
				</div>
			</div>
			<input
				ref={fileInput}
				type="file"
				multiple
				className="visually-hidden"
				aria-label="选择附件"
				onChange={(event) => {
					Array.from(event.target.files ?? []).forEach((file) => attach(file.name));
					event.target.value = "";
				}}
			/>
		</div>
	);
}
