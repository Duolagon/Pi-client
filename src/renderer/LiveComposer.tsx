import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { Command, PermissionMode, Snapshot, ThinkingLevel } from "../shared.ts";

type Image = NonNullable<Extract<Command, { type: "prompt" }>["images"]>[number];
interface Attachment {
	name: string;
	text?: string;
	image?: Image;
}
const DEFAULT_DESKTOP_KEYBINDINGS = { submit: "Enter" };
const PERMISSION_LABEL: Record<PermissionMode, string> = { ask: "手动确认", auto: "自动执行", read: "只读模式" };
// Keep attachment checks aligned with the main process prompt wire limits.
const maximumImageDataLength = 10 * 1024 * 1024;
function promptInput(draft: string, attachments: Attachment[]): Extract<Command, { type: "prompt" }> {
	const images = attachments.flatMap((item) => (item.image ? [item.image] : []));
	if (images.length > 10) throw new Error("每条任务最多添加 10 张图片，请移除多余图片。");
	if (images.some((image) => image.data.length > maximumImageDataLength))
		throw new Error("图片编码后超过 10 MB，请压缩图片后重试。");
	const message =
		draft.trim() +
		attachments
			.filter((item) => item.text !== undefined)
			.map((item) => `\n\n附件 ${item.name}：\n${item.text}`)
			.join("");
	if (message.length > 2 * 1024 * 1024)
		throw new Error("任务正文与文本附件合计超过 2 MB，请精简内容后重试。");
	return { type: "prompt", message: message || "请查看这些图片。", images };
}
export type BuiltinSlashAction = "compact" | "new" | "permissions" | "mcp" | "rewind" | "tasks" | "sessions" | "cost" | "plan";

const BUILTIN_SLASH_COMMANDS: { name: BuiltinSlashAction; description: string }[] = [
	{ name: "compact", description: "压缩当前会话上下文" },
	{ name: "new", description: "新建会话" },
	{ name: "rewind", description: "打开 Git 检查点与代码回滚" },
	{ name: "permissions", description: "管理细粒度权限规则" },
	{ name: "mcp", description: "查看工具清单与 MCP 服务" },
	{ name: "tasks", description: "查看后台任务、子 Agent 与 Worktree" },
	{ name: "sessions", description: "查看会话分支树与导入 CLI 历史" },
	{ name: "cost", description: "查看当前会话 Token 与费用统计" },
	{ name: "plan", description: "以只读计划模式调研并输出方案" },
];

export function LiveComposer({
	snapshot,
	draft,
	setDraft,
	running,
	changing,
	send,
	stop,
	command,
	setPermission,
	openSettings,
	onBuiltinSlash,
	fail,
}: {
	snapshot: Snapshot;
	draft: string;
	setDraft: (value: string) => void;
	running: boolean;
	changing: boolean;
	send: (prompt: Extract<Command, { type: "prompt" }>) => Promise<void>;
	stop: () => void;
	command: (value: Command) => Promise<void>;
	setPermission: (value: PermissionMode) => void;
	openSettings: () => void;
	onBuiltinSlash: (action: BuiltinSlashAction) => void;
	fail: (error: unknown) => void;
}) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [sending, setSending] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [atIndex, setAtIndex] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);
	const [projectFiles, setProjectFiles] = useState<string[]>([]);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [skillsFilter, setSkillsFilter] = useState("");
	const skillsRef = useRef<HTMLDivElement>(null);
	const promptHistory = useRef<string[]>([]);
	const historyCursor = useRef<number>(-1);
	const attachmentList = useRef<Attachment[]>([]);
	const currentDraft = useRef(draft);
	currentDraft.current = draft;
	const active = useRef(true);
	useEffect(() => {
		if (!skillsOpen) return;
		const onDown = (event: MouseEvent) => {
			if (skillsRef.current && !skillsRef.current.contains(event.target as Node)) {
				setSkillsOpen(false);
			}
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSkillsOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [skillsOpen]);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const fileInput = useRef<HTMLInputElement>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const input = textarea.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
	}, [draft]);
	const hasModel = snapshot.models.length > 0 && Boolean(snapshot.state?.model);
	const disabled = changing || sending || snapshot.engineStatus !== "ready" || !snapshot.active || !hasModel;
	const updateAttachments = (items: Attachment[]) => {
		attachmentList.current = items;
		setAttachments(items);
	};
	const attach = async (files: File[]) => {
		try {
			const added: Attachment[] = [];
			for (const file of files) {
				if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请缩小后再添加。`);
				if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
					if (4 * Math.ceil(file.size / 3) > maximumImageDataLength)
						throw new Error(`${file.name} 编码后超过 10 MB，请压缩图片后再添加。`);
					if (
						attachmentList.current.filter((item) => item.image).length + added.filter((item) => item.image).length >= 10
					)
						throw new Error("每条任务最多添加 10 张图片，请移除多余图片。");
					const data = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result).split(",")[1]);
						reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
						reader.readAsDataURL(file);
					});
					added.push({ name: file.name, image: { type: "image", mimeType: file.type, data } });
				} else {
					if (file.size > 1024 * 1024 || file.type === "application/pdf")
						throw new Error(`${file.name} 暂不支持。请添加不超过 1 MB 的文本或代码文件。`);
					const text = await file.text();
					if (text.includes("\0")) throw new Error(`${file.name} 是二进制文件，无法作为文本添加。`);
					added.push({ name: file.name, text });
				}
			}
			if (!active.current) return;
			const next = [...attachmentList.current, ...added];
			promptInput(currentDraft.current, next);
			updateAttachments(next);
		} catch (error) {
			if (active.current) fail(error);
		}
	};
	const submit = async () => {
		const trimmed = draft.trim();
		if (trimmed.startsWith("/") && !attachments.length) {
			const cmdName = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
			if (cmdName === "clear") {
				setDraft("");
				onBuiltinSlash("new");
				return;
			}
			const builtin = BUILTIN_SLASH_COMMANDS.find((c) => c.name === cmdName);
			if (builtin && trimmed === `/${cmdName}`) {
				setDraft("");
				onBuiltinSlash(builtin.name);
				return;
			}
		}
		if (disabled || (!trimmed && !attachments.length)) return;
		let input: Extract<Command, { type: "prompt" }>;
		try {
			input = promptInput(draft, attachments);
		} catch (error) {
			fail(error);
			return;
		}
		if (trimmed && promptHistory.current[promptHistory.current.length - 1] !== trimmed) {
			promptHistory.current.push(trimmed);
		}
		historyCursor.current = -1;
		setSending(true);
		const submitted = new Set(attachments);
		try {
			await send(input);
			if (active.current) updateAttachments(attachmentList.current.filter((item) => !submitted.has(item)));
		} catch {
			/* The controller keeps the draft and displays the failure. */
		} finally {
			setSending(false);
		}
	};
	const selected = snapshot.state?.model;
	const slashMatch = !slashDismissed ? /^\/([^\s\n]*)$/.exec(draft) : null;
	const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : "";
	const mergedCommands = [
		...BUILTIN_SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, source: "builtin" as const })),
		...snapshot.commands.filter((c) => !BUILTIN_SLASH_COMMANDS.some((b) => b.name === c.name)),
	];
	const slashOptions = slashMatch
		? mergedCommands.filter((item) => item.name.toLowerCase().includes(slashQuery)).slice(0, 8)
		: [];
	const activeSlashIndex = slashOptions.length ? Math.min(slashIndex, slashOptions.length - 1) : 0;
	const selectSlash = (name: string) => {
		const builtin = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
		if (builtin && name !== "plan") {
			setDraft("");
			setSlashDismissed(false);
			setSlashIndex(0);
			onBuiltinSlash(builtin.name);
			return;
		}
		setDraft(`/${name} `);
		setSlashDismissed(false);
		setSlashIndex(0);
		textarea.current?.focus();
	};

	// @ file reference autocomplete
	const atMatch = !atDismissed && !slashMatch ? /(?:^|\s)@([^\s\n]*)$/.exec(draft) : null;
	const atQuery = atMatch ? atMatch[1].toLowerCase() : "";
	useEffect(() => {
		if (!atMatch || !snapshot.active) return;
		let cancelled = false;
		const ignored = new Set([".git", "node_modules", "dist", "release", ".next", "coverage"]);
		const collect = async () => {
			const paths: string[] = [];
			const queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
			while (queue.length > 0 && paths.length < 400 && !cancelled) {
				const current = queue.shift()!;
				try {
					const entries = await window.pi.files(current.dir);
					for (const entry of entries) {
						if (ignored.has(entry.name)) continue;
						paths.push(entry.directory ? `${entry.path}/` : entry.path);
						if (entry.directory && current.depth < 3 && paths.length < 400) {
							queue.push({ dir: entry.path, depth: current.depth + 1 });
						}
						if (paths.length >= 400) break;
					}
				} catch {
					/* ignore unreadable directory */
				}
			}
			if (!cancelled) setProjectFiles(paths);
		};
		void collect();
		return () => {
			cancelled = true;
		};
	}, [Boolean(atMatch), snapshot.active?.project]);

	const atOptions = atMatch
		? projectFiles.filter((p) => p.toLowerCase().includes(atQuery)).slice(0, 8)
		: [];
	const activeAtIndex = atOptions.length ? Math.min(atIndex, atOptions.length - 1) : 0;
	const selectAtFile = (path: string) => {
		if (!atMatch) return;
		const prefixLen = draft.length - atMatch[1].length - 1;
		setDraft(`${draft.slice(0, prefixLen)}@${path} `);
		setAtDismissed(false);
		setAtIndex(0);
		textarea.current?.focus();
	};
	const stats = snapshot.stats;
	const contextPct =
		stats?.contextUsage && typeof stats.contextUsage === "object" && "percent" in stats.contextUsage
			? (stats.contextUsage as { percent?: number }).percent
			: undefined;

	return (
		<div className="cl-composer">
			{slashOptions.length > 0 && (
				<div className="cc-slash-menu" role="listbox" aria-label="斜杠命令">
					{slashOptions.map((item, idx) => (
						<button
							type="button"
							key={`${item.source}-${item.name}`}
							role="option"
							aria-selected={idx === activeSlashIndex}
							className={`cc-slash-item ${idx === activeSlashIndex ? "active" : ""}`}
							onMouseDown={(event) => {
								event.preventDefault();
								selectSlash(item.name);
							}}
						>
							<span className="cc-slash-name">/{item.name}</span>
							{item.description && <span className="cc-slash-desc">{item.description}</span>}
						</button>
					))}
				</div>
			)}
			{atOptions.length > 0 && (
				<div className="cc-slash-menu" role="listbox" aria-label="引用项目文件">
					{atOptions.map((filePath, idx) => (
						<button
							type="button"
							key={filePath}
							role="option"
							aria-selected={idx === activeAtIndex}
							className={`cc-slash-item ${idx === activeAtIndex ? "active" : ""}`}
							onMouseDown={(event) => {
								event.preventDefault();
								selectAtFile(filePath);
							}}
						>
							<span className="cc-slash-name">@{filePath}</span>
						</button>
					))}
				</div>
			)}
			<form
				className="cl-composer-box"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					void attach(Array.from(event.dataTransfer.files));
				}}
			>
				{attachments.length > 0 && (
					<div className="cl-attachments">
						{attachments.map((item, index) => (
							<span key={`${item.name}-${index}`}>
								{item.name}
								<button
									type="button"
									aria-label={`移除附件 ${item.name}`}
										onClick={() => updateAttachments(attachmentList.current.filter((_, at) => at !== index))}
								>
									<X size={13} />
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					ref={textarea}
					aria-label="输入任务"
					value={draft}
					style={{ minHeight: "62px", maxHeight: "200px" }}
					placeholder={
						snapshot.active
							? hasModel
								? "描述任务，或在运行中补充指令…"
								: "先在设置中连接 Pi 的模型配置"
							: "先打开项目文件夹"
					}
					onChange={(event) => {
						setSlashDismissed(false);
						setAtDismissed(false);
						setSlashIndex(0);
						setAtIndex(0);
						setDraft(event.target.value);
					}}
					onPaste={(event) => {
						if (event.clipboardData.files.length) {
							event.preventDefault();
							void attach(Array.from(event.clipboardData.files));
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Tab" && event.shiftKey && !changing && !running) {
							event.preventDefault();
							const order: PermissionMode[] = ["ask", "auto", "read"];
							const next = order[(order.indexOf(snapshot.settings.permission) + 1) % order.length];
							setPermission(next);
							return;
						}
						if (slashOptions.length > 0) {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setSlashIndex((idx) => (idx + 1) % slashOptions.length);
								return;
							}
							if (event.key === "ArrowUp") {
								event.preventDefault();
								setSlashIndex((idx) => (idx - 1 + slashOptions.length) % slashOptions.length);
								return;
							}
							if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)) {
								event.preventDefault();
								selectSlash(slashOptions[activeSlashIndex].name);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setSlashDismissed(true);
								return;
							}
						}
						if (atOptions.length > 0) {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setAtIndex((idx) => (idx + 1) % atOptions.length);
								return;
							}
							if (event.key === "ArrowUp") {
								event.preventDefault();
								setAtIndex((idx) => (idx - 1 + atOptions.length) % atOptions.length);
								return;
							}
							if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)) {
								event.preventDefault();
								selectAtFile(atOptions[activeAtIndex]);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setAtDismissed(true);
								return;
							}
						}
						if (event.key === "Escape" && running) {
							event.preventDefault();
							stop();
							return;
						}
						if (event.key === "ArrowUp" && !draft.includes("\n") && promptHistory.current.length > 0) {
							const cursor = historyCursor.current === -1 ? promptHistory.current.length - 1 : Math.max(0, historyCursor.current - 1);
							if (draft === "" || historyCursor.current !== -1) {
								event.preventDefault();
								historyCursor.current = cursor;
								setDraft(promptHistory.current[cursor]);
								return;
							}
						}
						if (event.key === "ArrowDown" && historyCursor.current !== -1 && !draft.includes("\n")) {
							event.preventDefault();
							if (historyCursor.current >= promptHistory.current.length - 1) {
								historyCursor.current = -1;
								setDraft("");
							} else {
								historyCursor.current += 1;
								setDraft(promptHistory.current[historyCursor.current]);
							}
							return;
						}
						if (event.key === DEFAULT_DESKTOP_KEYBINDINGS.submit && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				<div className="cl-composer-row">
					<button className="cl-icon-btn" type="button" aria-label="添加附件" onClick={() => fileInput.current?.click()}>
						<Paperclip size={17} />
					</button>
					<span className="cl-composer-hint">
						{running ? "发送补充指令会进入 Pi 的引导队列" : "Enter 发送 · Shift Enter 换行"}
					</span>
					{running ? (
						<button type="button" className="cl-send stop" aria-label="停止任务" onClick={stop}>
							<Square size={13} fill="currentColor" />
						</button>
					) : (
						<button
							type="submit"
							className="cl-send"
							aria-label="发送任务"
							disabled={disabled || (!draft.trim() && !attachments.length)}
						>
							<ArrowUp size={17} />
						</button>
					)}
				</div>
			</form>
			<div className="cl-composer-bar">
				<div className="cl-pills">
					<label className="cl-pill">
						<span className="cl-pill-select">
							<select
								aria-label="选择模型"
								value={selected ? `${selected.provider}\0${selected.id}` : ""}
								disabled={changing || running || !snapshot.models.length}
								onChange={(event) => {
									const [provider, modelId] = event.target.value.split("\0");
									void command({ type: "set_model", provider, modelId });
								}}
							>
								<option value="" disabled>
									未连接模型
								</option>
								{snapshot.models.map((model) => (
									<option key={`${model.provider}/${model.id}`} value={`${model.provider}\0${model.id}`}>
										{model.name || model.id}
									</option>
								))}
							</select>
						</span>
					</label>
					{snapshot.thinkingLevels.length > 0 && (
						<label className="cl-pill">
							<Brain size={13} />
							<span className="cl-pill-select">
								<select
									aria-label="思考强度"
									value={snapshot.state?.thinkingLevel ?? "off"}
									disabled={changing || running || !snapshot.thinkingLevels.length}
									onChange={(event) =>
										void command({ type: "set_thinking_level", level: event.target.value as ThinkingLevel })
									}
								>
									{snapshot.thinkingLevels.map((level) => (
										<option key={level}>{level}</option>
									))}
								</select>
							</span>
						</label>
					)}
					<label className={`cl-pill cc-perm-pill cc-perm-${snapshot.settings.permission}`}>
						<span className={`cc-perm-dot ${snapshot.settings.permission}`} aria-hidden="true" />
						<ShieldCheck size={13} />
						<span className="cl-pill-select">
							<select
								aria-label="权限模式"
								value={snapshot.settings.permission}
								disabled={changing || running}
								onChange={(event) => setPermission(event.target.value as PermissionMode)}
							>
								{(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((mode) => (
									<option key={mode} value={mode}>
										{PERMISSION_LABEL[mode]}
									</option>
								))}
							</select>
						</span>
					</label>
				</div>
				<div className="cc-bar-right">
					{stats && (stats.tokens.total > 0 || contextPct !== undefined) && (
						<span className="cc-stats-pill" title={`输入 ${stats.tokens.input} · 输出 ${stats.tokens.output}`}>
							{contextPct !== undefined ? `Ctx ${Math.round(contextPct)}%` : `${Math.round(stats.tokens.total / 1000)}k tok`}
							{stats.cost > 0 ? ` · $${stats.cost.toFixed(3)}` : ""}
						</span>
					)}
					{snapshot.commands.length > 0 && (
						<div className="cl-skills" ref={skillsRef}>
							<button
								type="button"
								className={`cc-skills-trigger ${skillsOpen ? "open" : ""}`}
								aria-expanded={skillsOpen}
								onClick={() => {
									setSkillsFilter("");
									setSkillsOpen((open) => !open);
								}}
							>
								Skills · {snapshot.commands.length}
							</button>
							{skillsOpen && (
								<div className="cl-skills-list" role="region" aria-label="Skills 列表">
									<input
										className="cc-skills-filter"
										placeholder="搜索技能或命令…"
										aria-label="搜索技能或命令"
										value={skillsFilter}
										autoFocus
										onChange={(event) => setSkillsFilter(event.target.value)}
									/>
									<div className="cc-skills-items">
										{snapshot.commands
											.filter((item) =>
												`${item.name} ${item.description ?? ""}`.toLowerCase().includes(skillsFilter.trim().toLowerCase()),
											)
											.map((item) => (
												<button
													type="button"
													key={`${item.source}-${item.name}`}
													onClick={() => {
														setDraft(`/${item.name} `);
														setSkillsOpen(false);
														textarea.current?.focus();
													}}
													title={item.description}
												>
													<span className="cc-skill-name">/{item.name}</span>
													<span className="cc-skill-desc">{item.description || item.source}</span>
												</button>
											))}
									</div>
								</div>
							)}
						</div>
					)}
					{!snapshot.commands.length && (
						<button type="button" className="cl-config" onClick={openSettings}>
							配置
						</button>
					)}
				</div>
			</div>
			<input
				ref={fileInput}
				type="file"
				multiple
				className="visually-hidden"
				aria-label="选择附件"
				onChange={(event) => {
					void attach(Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
			/>
		</div>
	);
}
