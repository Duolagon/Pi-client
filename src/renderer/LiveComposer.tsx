import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Brain, File, Folder, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { Command, FileEntry, FileReferenceAvailability, Message, PermissionMode, Project, SandboxStatus, Snapshot, ThinkingLevel } from "../shared.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { SandboxControl } from "./SandboxControl.tsx";
import { CommandSealIcon } from "./GrailIcons.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { fileReferences, insertFileReference, isDesktopWorkspaceContext, referenceQuery, removeFileReference, visiblePromptText } from "../file-references.ts";
import "./composer-controls.css";

import { draftPrompt, maximumImageDataLength, type ComposerAttachment, type ComposerDraft, type Prompt } from "../composer-draft.ts";

const DEFAULT_DESKTOP_KEYBINDINGS = { submit: "Enter" };
const CYCLABLE_PERMISSIONS: PermissionMode[] = ["ask", "acceptEdits", "plan", "read"];
const REFERENCE_STATUS_LABEL: Record<FileReferenceAvailability, string> = {
	ready: "发送时可读取",
	untrusted: "项目尚未授权载入",
	unavailable: "无法自动载入",
};
const PERMISSION_LABEL: Record<PermissionMode, string> = {
	ask: "手动确认",
	acceptEdits: "接受编辑",
	plan: "计划模式",
	auto: "全部放行",
	dontAsk: "不询问（未放行即拒绝）",
	read: "只读模式",
};
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
	| "sandbox"
	| "theme"
	| "rename"
	| "copy"
	| "export"
	| "fork"
	| "doctor"
	| "output-style"
	| "stats"
	| "add-dir"
	| "goal"
	| "verify"
	| "grail";

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
	{ name: "stats", description: "查看近 30 天各模型的 Token 用量与费用统计" },
	{ name: "doctor", description: "诊断本机运行环境（模型连接、代理、沙箱、Git 等）" },
	{ name: "output-style", description: "切换输出风格（/output-style explanatory|learning|default）" },
	{ name: "theme", description: "切换主题（/theme light|dark|grail|system）" },
	{ name: "rename", description: "重命名当前会话（/rename <名称>）" },
	{ name: "copy", description: "复制最后一条回复（/copy 2 复制倒数第 2 条）" },
	{ name: "export", description: "把当前会话导出为文件" },
	{ name: "fork", description: "复制当前会话为新分支继续（别名 /branch）" },
	{ name: "add-dir", description: "附加工作目录并放行读写与沙箱（/add-dir <目录> 或 /add-dir rm <目录>）" },
	{ name: "grail", description: "鉴定本次需求的全部改动（测试、作弊扫描、独立评审；结果不发给 Agent）" },
	{ name: "goal", description: "设定目标自动续跑（/goal [--max-turns 8] [--max-cost 2] <目标>，/goal stop 停止）" },
	{ name: "verify", description: "让模型用 PreviewCheck 自动验证本地网页（启动服务、操作 DOM、截图与检查报错）" },
];

/** Builtins that accept an argument after the name, plus Claude Code aliases. */
const BUILTIN_WITH_ARGS = new Set<BuiltinSlashAction>(["theme", "rename", "copy", "export", "fork", "output-style", "add-dir", "goal", "verify"]);
const BUILTIN_ALIASES: Record<string, BuiltinSlashAction> = { branch: "fork" };
/** Argument-free builtins added later that also yield to a Pi command or skill of the same name. */
const YIELDING_BUILTINS = new Set<BuiltinSlashAction>(["doctor", "stats", "grail"]);

/**
 * Claude Code built-in commands with no Pi Desktop equivalent. Sending them as
 * prompts would only make the model answer the literal text, so the composer
 * stops them instead. Pi commands, skills and templates with the same name win.
 */
const CLAUDE_ONLY_COMMANDS = new Set([
	"advisor", "agents-view", "autocompact", "background", "bug", "chrome",
	"desktop", "diff", "effort", "exit", "fast", "feedback", "help", "ide",
	"insights", "install-github-app", "keybindings", "login", "logout", "mobile", "model",
	"plugin", "pr-comments", "privacy-settings", "quit", "recap", "release-notes", "remote-control",
	"resume", "run", "schedule", "statusline",
	"subtask", "teleport", "terminal-setup", "upgrade", "usage", "vim", "voice", "workflows",
	"config",
]);

export function LiveComposer({
	snapshot,
	activeProject,
	draft,
	messages,
	attachments,
	updateAttachments,
	setDraft,
	running,
	changing,
	send,
	stop,
	stopping,
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
	gitBranch,
	fail,
}: {
	snapshot: Snapshot;
	activeProject?: Project;
	draft: string;
	messages: readonly Message[];
	attachments: ComposerAttachment[];
	updateAttachments: (update: (items: ComposerAttachment[]) => ComposerAttachment[]) => void;
	setDraft: (value: string) => void;
	running: boolean;
	changing: boolean;
	send: (prompt: Prompt, input?: ComposerDraft, delivery?: Prompt["streamingBehavior"]) => Promise<unknown>;
	stop: () => void;
	stopping?: boolean;
	command: (value: Command) => Promise<void>;
	setPermission: (value: PermissionMode) => void;
	onSelectProject: (path: string) => void;
	onOpenProject: () => void;
	sandboxStatus: SandboxStatus | null;
	sandboxOpen: boolean;
	setSandboxOpen: (open: boolean) => void;
	onUpdateSandbox: (next: { sandbox: boolean; sandboxOffline: boolean }) => Promise<void>;
	openSettings: () => void;
	onBuiltinSlash: (action: BuiltinSlashAction, argument?: string) => void;
	onCompactInstructions?: (instructions: string) => void;
	onBtw?: (question: string) => void;
	onLoop?: (args: string) => void;
	/** Focus the sub-agent panel above the composer when ArrowUp is pressed on an empty input. */
	onFocusSubagentPanel?: () => boolean;
	inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
	/** Workspace git branch; absent when the project is not a git repository. */
	gitBranch?: string;
	fail: (error: unknown) => void;
}) {
	const [sending, setSending] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [atIndex, setAtIndex] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);
	const [fileResults, setFileResults] = useState<{ key: string; entries: FileEntry[]; error?: boolean }>();
	const [referenceStatus, setReferenceStatus] = useState<{ key: string; statuses: FileReferenceAvailability[] }>();
	const [selection, setSelection] = useState({ start: draft.length, end: draft.length });
	const [editorFocused, setEditorFocused] = useState(false);
	const [delivery, setDelivery] = useState<NonNullable<Prompt["streamingBehavior"]>>("followUp");
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [skillsFilter, setSkillsFilter] = useState("");
	const [skillsIndex, setSkillsIndex] = useState(0);
	const skillsRef = useRef<HTMLDivElement>(null);
	const promptHistory = useMemo(() => {
		const prompts: string[] = [];
		for (let index = messages.length - 1; index >= 0 && prompts.length < 100; index--) {
			const message = messages[index];
			if (message.role !== "user") continue;
			const text = (typeof message.content === "string"
				? visiblePromptText(message.content)
				: message.content.flatMap((block) => block.type === "text" && !isDesktopWorkspaceContext(block.text) ? [block.text] : []).join("\n")).trim();
			if (text && !text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]") && prompts.at(-1) !== text)
				prompts.push(text);
		}
		return prompts.reverse();
	}, [messages]);
	const historyCursor = useRef<number>(-1);
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
	const permissionMode = snapshot.active?.permissionMode ?? snapshot.settings.permission;
	const disabled = changing || sending || snapshot.engineStatus !== "ready" || !snapshot.active || !hasModel;
	const attach = async (files: File[]) => {
		try {
			const added: ComposerAttachment[] = [];
			for (const file of files) {
				if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请缩小后再添加。`);
				if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
					if (4 * Math.ceil(file.size / 3) > maximumImageDataLength)
						throw new Error(`${file.name} 编码后超过 10 MB，请压缩图片后再添加。`);
					if (added.filter((item) => item.image).length >= 10)
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
			updateAttachments((items) => {
				const next = [...items, ...added];
				draftPrompt({ text: currentDraft.current, attachments: next });
				return next;
			});
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
					await send(draftPrompt({
						text: `[Bundled /batch Skill]\n请先分析需求与仓库结构，将下述批量任务拆解为 5–30 个互不重叠的独立子单元，先使用 TodoCreate 写入共享任务清单，再使用并行 Agent(isolation="worktree") 或 WorkflowRun(parallel, phase, budget) 隔离执行并在最后汇总结果：\n\n${argText}`,
						attachments: [],
					}));
				} catch {
				} finally {
					setSending(false);
				}
				return;
			}
			// The commands added after Pi skills existed yield to a Pi command or skill of the same name.
			const shadowed = snapshot.commands.some(
				(c) => c.name.toLowerCase() === cmdName || c.name.toLowerCase() === `skill:${cmdName}`,
			);
			const aliased = BUILTIN_ALIASES[cmdName];
			const candidate = BUILTIN_SLASH_COMMANDS.find((c) => c.name === (aliased ?? cmdName));
			const yields = Boolean(candidate && (BUILTIN_WITH_ARGS.has(candidate.name) || YIELDING_BUILTINS.has(candidate.name)) && shadowed);
			const builtin = yields ? undefined : candidate;
			if (builtin && BUILTIN_WITH_ARGS.has(builtin.name)) {
				setDraft("");
				onBuiltinSlash(builtin.name, argText);
				return;
			}
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
					await send(draftPrompt({ text: `/${skill.name}${argText ? ` ${argText}` : ""}`, attachments: [] }));
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
				["clear", "compact", "btw", "loop", "batch"].includes(cmdName) || (cmdName in BUILTIN_ALIASES && !yields);
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
			input = draftPrompt({ text: draft, attachments });
		} catch (error) {
			fail(error);
			return;
		}
		historyCursor.current = -1;
		setSending(true);
		try {
			await send(input, { text: draft, attachments }, running ? delivery : undefined);
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
		const shadowedBuiltin = Boolean(
			builtin &&
				// Same yield rule as the submit path, so the menu reaches a same-named Pi command or skill.
				(BUILTIN_WITH_ARGS.has(builtin.name) || YIELDING_BUILTINS.has(builtin.name)) &&
				snapshot.commands.some((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`),
		);
		if (builtin && !shadowedBuiltin && name !== "plan" && name !== "btw" && name !== "rename" && name !== "theme") {
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

	// Match the token at the insertion point and keep the rest of the draft intact.
	const atMatch = editorFocused && !atDismissed && !slashMatch && selection.start === selection.end
		? referenceQuery(draft, selection.start)
		: undefined;
	const conversationId = snapshot.active?.id;
	const atQuery = atMatch?.query;
	const fileSearchKey = conversationId && atQuery !== undefined ? `${conversationId}\0${atQuery}` : undefined;
	useEffect(() => {
		if (!fileSearchKey || !conversationId || atQuery === undefined) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			void window.pi.searchFiles(conversationId, atQuery).then(
				(entries) => { if (!cancelled) setFileResults({ key: fileSearchKey, entries }); },
				() => { if (!cancelled) setFileResults({ key: fileSearchKey, entries: [], error: true }); },
			);
		}, 70);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [fileSearchKey, conversationId, atQuery]);

	const filesLoading = Boolean(fileSearchKey && fileResults?.key !== fileSearchKey);
	const atOptions = fileSearchKey && fileResults?.key === fileSearchKey ? fileResults.entries : [];
	const activeAtIndex = atOptions.length ? Math.min(atIndex, atOptions.length - 1) : 0;
	const selectAtFile = (file: FileEntry) => {
		if (!atMatch) return;
		const next = insertFileReference(draft, atMatch, file.path, file.directory);
		setDraft(next.text);
		setSelection({ start: next.cursor, end: next.cursor });
		setAtDismissed(!file.directory);
		setAtIndex(0);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(next.cursor, next.cursor);
		});
	};
	const removeReference = (ref: ReturnType<typeof fileReferences>[number]) => {
		const editor = textarea.current;
		const direction = editor?.selectionDirection;
		const next = removeFileReference(draft, ref, editor ? { start: editor.selectionStart, end: editor.selectionEnd } : selection);
		setDraft(next.text);
		setSelection(next.selection);
		setAtDismissed(true);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(next.selection.start, next.selection.end, direction);
		});
	};
	const references = useMemo(() => fileReferences(draft), [draft]);
	const referencePathKey = JSON.stringify(references.slice(0, 24).map(({ path }) => path));
	const referenceKey = JSON.stringify([conversationId, snapshot.trust?.decision, referencePathKey]);
	useEffect(() => {
		const paths = JSON.parse(referencePathKey) as string[];
		if (!conversationId || !paths.length) return;
		let active = true;
		void window.pi.checkFileReferences(conversationId, paths).then(
			(statuses) => { if (active) setReferenceStatus({ key: referenceKey, statuses }); },
			() => { if (active) setReferenceStatus({ key: referenceKey, statuses: paths.map(() => "unavailable") }); },
		);
		return () => { active = false; };
	}, [conversationId, referenceKey, referencePathKey]);

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

	return (
		<div className={`cl-composer${running ? " is-running" : ""}`}>
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
			{atMatch && (
				<div className="cc-slash-menu" id="cc-at-files" role="listbox" aria-label="引用项目文件" aria-busy={filesLoading}>
					{!atOptions.length && <div className="cc-reference-empty" role="status">
						{filesLoading ? "正在查找项目文件…" : fileResults?.error ? "无法查找项目文件" : "没有匹配的项目文件"}
					</div>}
					{atOptions.map((file, idx) => (
						<button
							type="button"
							key={file.path}
							role="option"
							aria-selected={idx === activeAtIndex}
							id={`cc-at-${idx}`}
							className={`cc-slash-item ${idx === activeAtIndex ? "active" : ""}`}
							onMouseEnter={() => setAtIndex(idx)}
							onMouseDown={(event) => {
								event.preventDefault();
								selectAtFile(file);
							}}
						>
							{file.directory ? <Folder size={13} /> : <File size={13} />}
							<span className="cc-slash-name">@{file.path}{file.directory ? "/" : ""}</span>
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
										updateAttachments((items) => items.filter((_, at) => at !== index));
										textarea.current?.focus();
									}}
								>
									<X size={13} />
								</button>
							</span>
						))}
					</div>
				)}
				{references.some((ref) => ref.from !== atMatch?.from) && (
					<div className="cl-attachments cc-reference-chips" role="list" aria-label="草稿的文件引用">
						{references.map((ref, index) => {
							if (ref.from === atMatch?.from) return null;
							const status = index >= 24 ? "超过单次引用上限" : referenceStatus?.key === referenceKey
								? REFERENCE_STATUS_LABEL[referenceStatus.statuses[index] ?? "unavailable"] : "检查中";
							return (
								<span key={ref.from} role="listitem" title={`${ref.path} · ${status}`}>
									<File size={12} aria-hidden="true" />
									<span className="cl-attachment-name">{ref.path}</span>
									<span className="cc-reference-status">{status}</span>
									<button type="button" aria-label={`移除引用 ${ref.path}`} onClick={() => removeReference(ref)}><X size={13} /></button>
								</span>
							);
						})}
					</div>
				)}
				<textarea
					ref={(el) => {
						textarea.current = el;
						if (inputRef) inputRef.current = el;
					}}
					aria-label="输入任务"
					value={draft}
					aria-controls={atMatch ? "cc-at-files" : undefined}
					aria-activedescendant={atOptions.length ? `cc-at-${activeAtIndex}` : undefined}
					onFocus={(event) => {
						setEditorFocused(true);
						setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
					}}
					onSelect={(event) => {
						const { selectionStart: start, selectionEnd: end } = event.currentTarget;
						setSelection((previous) => previous.start === start && previous.end === end ? previous : { start, end });
					}}
					onBlur={() => {
						setEditorFocused(false);
						// Menu items use onMouseDown + preventDefault, so this only fires for clicks elsewhere.
						if (slashOptions.length) setSlashDismissed(true);
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
						setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
							historyCursor.current = -1;
							setDraft(event.target.value);
					}}
					onPaste={(event) => {
						if (event.clipboardData.files.length) {
							event.preventDefault();
							void attach(Array.from(event.clipboardData.files));
						}
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Tab" && event.shiftKey && !changing && snapshot.active && !slashOptions.length && !atMatch) {
							event.preventDefault();
							const current = CYCLABLE_PERMISSIONS.indexOf(permissionMode);
							const next = CYCLABLE_PERMISSIONS[(current + 1) % CYCLABLE_PERMISSIONS.length];
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
							if ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)) {
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
							if ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)) {
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
						if (event.key === "Escape" && atMatch) {
							event.preventDefault();
							setAtDismissed(true);
							return;
						}
						if (event.key === "Enter" && !event.shiftKey && filesLoading) {
							event.preventDefault();
							return;
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
						if (event.key === "ArrowUp" && promptHistory.length > 0 && (draft === "" || historyCursor.current !== -1)) {
							const cursor = historyCursor.current === -1 ? promptHistory.length - 1 : Math.max(0, historyCursor.current - 1);
							event.preventDefault();
							historyCursor.current = cursor;
							setDraft(promptHistory[cursor]);
							return;
						}
						if (event.key === "ArrowDown" && historyCursor.current !== -1) {
							event.preventDefault();
							if (historyCursor.current >= promptHistory.length - 1) {
								historyCursor.current = -1;
								setDraft("");
							} else {
								historyCursor.current += 1;
								setDraft(promptHistory[historyCursor.current]);
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
						{running && (
							<>
								<label className="cc-composer-delivery">
									<select
										aria-label="补充指令发送时机"
										value={delivery}
										onChange={(event) => setDelivery(event.target.value as NonNullable<Prompt["streamingBehavior"]>)}
										disabled={disabled}
									>
										<option value="followUp">本轮结束后</option>
										<option value="steer">下一工具步骤</option>
									</select>
								</label>
								<button type="button" className="cl-send stop" aria-label="停止任务" title="停止本轮回复和本机后台命令（Esc）" onClick={stop} disabled={stopping}>
									<Square size={12} fill="currentColor" />
								</button>
							</>
						)}
						{!running && <span className="cl-composer-hint">Enter 发送</span>}
						<button
							type="submit"
							className="cl-send"
							aria-label={running ? "追加指令" : "发送任务"}
							title={running ? "追加指令（Enter）" : "发送任务（Enter）"}
							disabled={disabled || (!draft.trim() && !attachments.length)}
						>
							{snapshot.settings.theme === "grail" ? <CommandSealIcon width={17} height={17} /> : <ArrowUp size={17} />}
						</button>
					</div>
				</div>
			</form>
			<div className="cl-composer-bar">
				<div className="cl-pills">
					<label className={`cl-pill cc-perm-pill cc-perm-${permissionMode}`}>
						<span className={`cc-perm-dot ${permissionMode}`} aria-hidden="true" />
						<ShieldCheck size={13} />
						<span className="cl-pill-select">
							<select
								aria-label="权限模式"
								value={permissionMode}
								disabled={changing || !snapshot.active}
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
				</div>
				<div className="cc-bar-right">
					<StatusLine snapshot={snapshot} running={running} gitBranch={gitBranch} />
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
