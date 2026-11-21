import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { Command, PermissionMode, Project, SandboxStatus, Snapshot, ThinkingLevel } from "../shared.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { SandboxControl } from "./SandboxControl.tsx";
import { CommandSealIcon } from "./GrailIcons.tsx";

type Image = NonNullable<Extract<Command, { type: "prompt" }>["images"]>[number];
interface Attachment {
	name: string;
	text?: string;
	image?: Image;
}
const DEFAULT_DESKTOP_KEYBINDINGS = { submit: "Enter" };
const PERMISSION_LABEL: Record<PermissionMode, string> = {
	ask: "手动确认",
	acceptEdits: "接受编辑",
	plan: "计划模式",
	auto: "跳过确认（危险）",
	read: "只读模式",
};
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
export type BuiltinSlashAction =
	| "compact"
	| "new"
	| "permissions"
	| "mcp"
	| "hooks"
	| "skills"
	| "context"
	| "btw"
	| "rewind"
	| "tasks"
	| "agents"
	| "sessions"
	| "cost"
	| "plan"
	| "memory"
	| "status"
	| "init"
	| "preview"
	| "loop"
	| "batch"
	| "sandbox";

const BUILTIN_SLASH_COMMANDS: { name: BuiltinSlashAction; description: string }[] = [
	{ name: "compact", description: "压缩上下文（支持 /compact <聚焦指令>）" },
	{ name: "context", description: "查看上下文占用构成与自动压缩设置" },
	{ name: "btw", description: "不污染主会话的侧边快问（/btw <问题>）" },
	{ name: "loop", description: "定时自动循环执行提示词（/loop 5m <任务>，会自动消耗额度）" },
	{ name: "batch", description: "并行分解并批量执行仓库改动（bundled skill）" },
	{ name: "sandbox", description: "查看或切换 macOS Seatbelt 命令沙箱与离线隔离" },
	{ name: "new", description: "新建会话" },
	{ name: "plan", description: "进入/退出引擎级计划模式（只读调研+输出方案）" },
	{ name: "rewind", description: "打开 Git 检查点与代码回滚" },
	{ name: "permissions", description: "管理细粒度权限规则与团队导入导出" },
	{ name: "mcp", description: "查看工具清单与 MCP 服务" },
	{ name: "hooks", description: "管理 Claude 兼容生命周期 Hooks" },
	{ name: "skills", description: "查看与新建 Skills 指令技能" },
	{ name: "tasks", description: "查看后台任务、子 Agent 与 Worktree" },
	{ name: "agents", description: "查看或创建自定义子 Agent" },
	{ name: "sessions", description: "查看会话分支树与导入 CLI 历史" },
	{ name: "memory", description: "编辑项目记忆与 .claude/rules 规则" },
	{ name: "status", description: "查看当前模型、上下文与工具挂载状态" },
	{ name: "init", description: "AI 分析仓库并生成 AGENTS.md 项目指南" },
	{ name: "preview", description: "打开本地应用网页预览面板" },
	{ name: "cost", description: "查看当前会话 Token 与费用统计" },
];

/**
 * Claude Code built-in commands with no Pi Desktop equivalent. Sending them as
 * prompts would only make the model answer the literal text, so the composer
 * stops them instead. Pi commands, skills and templates with the same name win.
 */
const CLAUDE_ONLY_COMMANDS = new Set([
	"add-dir", "advisor", "agents-view", "autocompact", "background", "branch", "bug", "chrome", "copy",
	"desktop", "diff", "doctor", "effort", "exit", "export", "fast", "feedback", "fork", "goal", "help", "ide",
	"insights", "install-github-app", "keybindings", "login", "logout", "mobile", "model", "output-style",
	"plugin", "pr-comments", "privacy-settings", "quit", "recap", "release-notes", "remote-control", "rename",
	"resume", "review", "run", "schedule", "security-review", "simplify", "stats", "statusline",
	"subtask", "teleport", "terminal-setup", "theme", "upgrade", "usage", "verify", "vim", "voice", "workflows",
	"config", "code-review",
]);

export function LiveComposer({
	snapshot,
	activeProject,
	draft,
	setDraft,
	running,
	changing,
	planMode,
	onTogglePlanMode,
	send,
	stop,
	command,
	setPermission,
	onSelectProject,
	onOpenProject,
	sandboxStatus,
	sandboxOpen,
	setSandboxOpen,
	onUpdateSandbox,
	openSettings,
	onBuiltinSlash,
	onCompactInstructions,
	onBtw,
	onLoop,
	onFocusSubagentPanel,
	inputRef,
	fail,
}: {
	snapshot: Snapshot;
	activeProject?: Project;
	draft: string;
	setDraft: (value: string) => void;
	running: boolean;
	changing: boolean;
	planMode?: boolean;
	onTogglePlanMode?: () => void;
	send: (prompt: Extract<Command, { type: "prompt" }>) => Promise<unknown>;
	stop: () => void;
	command: (value: Command) => Promise<void>;
	setPermission: (value: PermissionMode) => void;
	onSelectProject: (path: string) => void;
	onOpenProject: () => void;
	sandboxStatus: SandboxStatus | null;
	sandboxOpen: boolean;
	setSandboxOpen: (open: boolean) => void;
	onUpdateSandbox: (next: { sandbox: boolean; sandboxOffline: boolean }) => Promise<void>;
	openSettings: () => void;
	onBuiltinSlash: (action: BuiltinSlashAction) => void;
	onCompactInstructions?: (instructions: string) => void;
	onBtw?: (question: string) => void;
	onLoop?: (args: string) => void;
	/** Focus the sub-agent panel above the composer when ArrowUp is pressed on an empty input. */
	onFocusSubagentPanel?: () => boolean;
	inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
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
	const [skillsIndex, setSkillsIndex] = useState(0);
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
			if (event.key === "Escape") {
				setSkillsOpen(false);
				textarea.current?.focus();
			}
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
	const unknownConfirmed = useRef("");
	const submit = async () => {
		const trimmed = draft.trim();
		if (trimmed.startsWith("/") && !attachments.length) {
			const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
			const cmdName = match?.[1]?.toLowerCase() ?? "";
			const argText = match?.[2]?.trim() ?? "";
			if (cmdName === "clear") {
				setDraft("");
				onBuiltinSlash("new");
				return;
			}
			if (cmdName === "compact" && argText && onCompactInstructions) {
				setDraft("");
				onCompactInstructions(argText);
				return;
			}
			if (cmdName === "btw" && argText && onBtw) {
				setDraft("");
				onBtw(argText);
				return;
			}
			if (cmdName === "loop" && argText && onLoop) {
				setDraft("");
				onLoop(argText);
				return;
			}
			if (cmdName === "batch" && argText && !snapshot.commands.some((c) => c.name.toLowerCase() === "skill:batch")) {
				if (disabled) return;
				setDraft("");
				setSending(true);
				try {
					await send(
						promptInput(
							`[Bundled /batch Skill]\n请先分析需求与仓库结构，将下述批量任务拆解为 5–30 个互不重叠的独立子单元，先使用 TodoCreate 写入共享任务清单，再使用并行 Agent(isolation="worktree") 或 WorkflowRun(parallel, phase, budget) 隔离执行并在最后汇总结果：\n\n${argText}`,
							[],
						),
					);
				} catch {
				} finally {
					setSending(false);
				}
				return;
			}
			const builtin = BUILTIN_SLASH_COMMANDS.find((c) => c.name === cmdName);
			if (builtin && trimmed === `/${cmdName}`) {
				setDraft("");
				onBuiltinSlash(builtin.name);
				return;
			}
			const piCommand = snapshot.commands.some((c) => c.name.toLowerCase() === cmdName);
			// Claude Code invokes skills as /name; Pi registers them as /skill:name.
			const skill = !piCommand && snapshot.commands.find((c) => c.name.toLowerCase() === `skill:${cmdName}`);
			if (skill) {
				if (disabled) return;
				setSending(true);
				try {
					await send(promptInput(`/${skill.name}${argText ? ` ${argText}` : ""}`, []));
				} catch {
					/* The controller keeps the draft and displays the failure. */
				} finally {
					setSending(false);
				}
				return;
			}
			if (!piCommand && CLAUDE_ONLY_COMMANDS.has(cmdName)) {
				if (cmdName === "resume") {
					setDraft("");
					onBuiltinSlash("sessions");
					return;
				}
				if (cmdName === "config") {
					setDraft("");
					openSettings();
					return;
				}
				if ((cmdName === "model" || cmdName === "effort") && !argText) {
					const current = cmdName === "model"
						? `${snapshot.state?.model?.name ?? snapshot.state?.model?.id ?? "未连接"}；用 /model <名称> 切换，例如 /model opus`
						: `${snapshot.state?.thinkingLevel ?? "off"}；可选 ${snapshot.thinkingLevels.join(" / ") || "无"}`;
					fail(new Error(`当前${cmdName === "model" ? "模型" : "思考强度"}：${current}。`));
					return;
				}
				if (cmdName === "model" && argText) {
					const wanted = argText.toLowerCase();
					// Like Claude Code, an alias such as "opus" selects the newest matching model.
					const candidates = snapshot.models
						.filter((m) => m.id.toLowerCase().includes(wanted) || (m.name ?? "").toLowerCase().includes(wanted))
						.sort((a, b) =>
							Number(/\d{8}$/.test(b.id)) - Number(/\d{8}$/.test(a.id)) ||
							a.id.localeCompare(b.id, undefined, { numeric: true }),
						);
					const model =
						snapshot.models.find((m) => m.id.toLowerCase() === wanted || `${m.provider}/${m.id}`.toLowerCase() === wanted) ??
						candidates.at(-1);
					if (!model) {
						fail(new Error(`没有匹配“${argText}”的模型。可用模型见输入框下方的模型选择器。`));
						return;
					}
					setDraft("");
					await command({ type: "set_model", provider: model.provider, modelId: model.id }).catch(fail);
					return;
				}
				if (cmdName === "effort" && argText) {
					const level = snapshot.thinkingLevels.find((l) => l === argText.toLowerCase());
					if (!level) {
						fail(new Error(`当前模型支持的思考强度：${snapshot.thinkingLevels.join(" / ") || "无"}。`));
						return;
					}
					setDraft("");
					await command({ type: "set_thinking_level", level }).catch(fail);
					return;
				}
				fail(new Error(`/${cmdName} 是 Claude Code 命令，Pi Desktop 暂不支持，未发送给模型。输入 / 查看可用命令。`));
				return;
			}
			// A command-shaped name that nothing recognises is probably a typo. Paths such as
			// /Users/me/file contain a slash and are sent as normal text.
			const known = piCommand || Boolean(skill) || Boolean(builtin) ||
				["clear", "compact", "btw", "loop", "batch"].includes(cmdName);
			if (!known && /^[a-z0-9][a-z0-9:_-]*$/i.test(cmdName) && unknownConfirmed.current !== trimmed) {
				unknownConfirmed.current = trimmed;
				fail(new Error(`没有 /${cmdName} 这个命令，未发送。输入 / 查看可用命令；再按一次 Enter 会把这段文字原样发给模型。`));
				return;
			}
		}
		unknownConfirmed.current = "";
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
	const selected =
		snapshot.state?.model &&
		snapshot.models.some((m) => m.provider === snapshot.state?.model?.provider && m.id === snapshot.state?.model?.id)
			? snapshot.state.model
			: undefined;
	const slashMatch = !slashDismissed ? /^\/([^\s\n]*)$/.exec(draft) : null;
	const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : "";
	const mergedCommands = [
		...BUILTIN_SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, source: "builtin" as const })),
		...snapshot.commands.filter((c) => !BUILTIN_SLASH_COMMANDS.some((b) => b.name === c.name)),
	];
	const slashOptions = slashMatch
		? mergedCommands.filter((item) => item.name.toLowerCase().includes(slashQuery))
		: [];
	const activeSlashIndex = slashOptions.length ? Math.min(slashIndex, slashOptions.length - 1) : 0;
	const selectSlash = (name: string) => {
		const builtin = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
		if (builtin && name !== "plan" && name !== "btw") {
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
		// A folder stays open (no trailing space) so the menu lists its files next.
		setDraft(`${draft.slice(0, prefixLen)}@${path}${path.endsWith("/") ? "" : " "}`);
		setAtDismissed(false);
		setAtIndex(0);
		textarea.current?.focus();
	};
	useEffect(() => {
		if (slashOptions.length) document.getElementById(`cc-slash-${activeSlashIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [activeSlashIndex, slashOptions.length]);
	useEffect(() => {
		if (atOptions.length) document.getElementById(`cc-at-${activeAtIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [activeAtIndex, atOptions.length]);
	const skillNeedle = skillsFilter.trim().toLowerCase();
	const skillMatches = snapshot.commands.filter((item) =>
		`${item.name} ${item.description ?? ""}`.toLowerCase().includes(skillNeedle),
	);
	const activeSkill = skillMatches.length ? Math.min(skillsIndex, skillMatches.length - 1) : 0;
	const pickSkill = (name: string) => {
		setDraft(`/${name} `);
		setSkillsOpen(false);
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
							id={`cc-slash-${idx}`}
							className={`cc-slash-item ${idx === activeSlashIndex ? "active" : ""}`}
							onMouseEnter={() => setSlashIndex(idx)}
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
							id={`cc-at-${idx}`}
							className={`cc-slash-item ${idx === activeAtIndex ? "active" : ""}`}
							onMouseEnter={() => setAtIndex(idx)}
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
							<span key={`${item.name}-${index}`} title={item.name}>
								<span className="cl-attachment-name">{item.name}</span>
								<button
									type="button"
									aria-label={`移除附件 ${item.name}`}
									onClick={() => {
										updateAttachments(attachmentList.current.filter((_, at) => at !== index));
										textarea.current?.focus();
									}}
								>
									<X size={13} />
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					ref={(el) => {
						textarea.current = el;
						if (inputRef) inputRef.current = el;
					}}
					aria-label="输入任务"
					value={draft}
					onBlur={() => {
						// Menu items use onMouseDown + preventDefault, so this only fires for clicks elsewhere.
						if (slashOptions.length) setSlashDismissed(true);
						if (atOptions.length) setAtDismissed(true);
					}}
					style={{ minHeight: "62px", maxHeight: "200px" }}
					placeholder={
						snapshot.active
							? hasModel
								? snapshot.settings.theme === "grail"
									? "向圣杯许愿，或在咏唱中补充指令…"
									: "描述任务，或在运行中补充指令…"
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
							const order: PermissionMode[] = ["ask", "acceptEdits", "plan", "auto", "read"];
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
						if (event.key === "ArrowUp" && draft === "" && historyCursor.current === -1 && onFocusSubagentPanel?.()) {
							event.preventDefault();
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
					<div className="cl-composer-row-left">
						<button className="cl-icon-btn" type="button" aria-label="添加附件" title="添加图片或代码附件" onClick={() => fileInput.current?.click()}>
							<Paperclip size={16} />
						</button>
						<WorkspacePicker
							variant="composer"
							projects={snapshot.projects}
							activeProject={activeProject}
							disabled={changing}
							onSelectProject={onSelectProject}
							onOpenProject={onOpenProject}
						/>
						<label className="cl-pill cl-pill-inline">
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
							<label className="cl-pill cl-pill-inline">
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
					</div>
					<div className="cl-composer-row-right">
						<span className="cl-composer-hint">
							{running ? "补充指令将进入引导队列" : "Enter 发送"}
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
								{snapshot.settings.theme === "grail" ? <CommandSealIcon width={17} height={17} /> : <ArrowUp size={17} />}
							</button>
						)}
					</div>
				</div>
			</form>
			<div className="cl-composer-bar">
				<div className="cl-pills">
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
					<SandboxControl
						enabled={Boolean(snapshot.settings.sandbox)}
						offline={Boolean(snapshot.settings.sandbox && snapshot.settings.sandboxOffline)}
						status={sandboxStatus}
						projectPath={activeProject?.path}
						disabled={changing || running}
						open={sandboxOpen}
						onOpenChange={setSandboxOpen}
						onChange={onUpdateSandbox}
					/>
					{onTogglePlanMode && (
						<button
							type="button"
							className={`cl-pill cc-plan-pill ${planMode ? "active" : ""}`}
							aria-pressed={planMode}
							onClick={onTogglePlanMode}
							disabled={changing || running}
							title="切换 Plan 计划模式（先只读调研与出方案，确认后再执行）"
						>
							Plan
						</button>
					)}
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
									setSkillsIndex(0);
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
										autoFocus data-autofocus
										onChange={(event) => {
											setSkillsFilter(event.target.value);
											setSkillsIndex(0);
										}}
										onKeyDown={(event) => {
											if (event.nativeEvent.isComposing || !skillMatches.length) return;
											if (event.key === "ArrowDown" || event.key === "ArrowUp") {
												event.preventDefault();
												const next = (activeSkill + (event.key === "ArrowDown" ? 1 : -1) + skillMatches.length) % skillMatches.length;
												setSkillsIndex(next);
												document.getElementById(`cc-skill-${next}`)?.scrollIntoView({ block: "nearest" });
											} else if (event.key === "Enter") {
												event.preventDefault();
												pickSkill(skillMatches[activeSkill].name);
											}
										}}
									/>
									<div className="cc-skills-items" role="listbox" aria-label="技能与命令">
										{skillMatches.length === 0 && <p className="cc-search-empty">没有匹配的技能或命令</p>}
										{skillMatches.map((item, idx) => (
												<button
													type="button"
													key={`${item.source}-${item.name}`}
													id={`cc-skill-${idx}`}
													role="option"
													aria-selected={idx === activeSkill}
													className={idx === activeSkill ? "active" : undefined}
													onMouseEnter={() => setSkillsIndex(idx)}
													onClick={() => pickSkill(item.name)}
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
