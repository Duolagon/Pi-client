import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	PermissionAction,
	PermissionCommandSelector,
	PermissionDecision,
	PermissionRule,
	PermissionToolCall,
	RuntimePermissionPolicy,
} from "./permission-types.ts";

const readingTools = new Set(["read", "grep", "find", "ls"]);
const editTools = new Set(["edit", "write", "NotebookEdit"]);
const harmlessDesktopTools = new Set(["AgentExecutors", "TaskOutput", "TaskList", "TaskStop", "WorktreeList", "TodoWrite", "AskUserQuestion", "ExitPlanMode"]);
const pathTools = new Set([...readingTools, "edit", "write", "NotebookEdit"]);
const wrappers = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".", "env", "sudo", "doas", "exec", "command", "xargs"]);

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 4096): string {
	if (typeof value !== "string" || !value || value.length > max || value.includes("\0"))
		throw new Error(`${label}无效。`);
	return value;
}

function keys(record: Record<string, unknown>, allowed: string[], label: string): void {
	if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(`${label}包含未知字段。`);
}

/** Validate stored or IPC-supplied rules instead of trusting TypeScript at a data boundary. */
export function validatePermissionRule(value: unknown): PermissionRule {
	const record = object(value, "权限规则");
	keys(record, ["id", "scope", "project", "conversationId", "action", "tool", "path", "command"], "权限规则");
	const id = text(record.id, "规则标识", 200);
	if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("规则标识无效。");
	if (!["global", "project", "conversation"].includes(record.scope as string)) throw new Error("权限作用域无效。");
	if (!["allow", "ask", "deny"].includes(record.action as string)) throw new Error("权限动作无效。");
	const tool = text(record.tool, "工具选择器", 300);
	if (!/^[a-zA-Z0-9_.:?*-]+$/.test(tool)) throw new Error("工具选择器无效。");
	const project = record.project === undefined ? undefined : text(record.project, "项目目录");
	if (project !== undefined && !isAbsolute(project)) throw new Error("权限项目目录必须为绝对路径。");
	const conversationId = record.conversationId === undefined ? undefined : text(record.conversationId, "会话标识", 200);
	if (conversationId && !/^[a-zA-Z0-9._-]+$/.test(conversationId)) throw new Error("会话标识无效。");
	if (record.scope === "project" && !project) throw new Error("项目规则必须指定项目目录。");
	if (record.scope === "conversation" && !conversationId) throw new Error("会话规则必须指定会话标识。");
	if (record.scope === "global" && (project !== undefined || conversationId !== undefined))
		throw new Error("全局规则不能指定项目或会话。");
	const path = record.path === undefined ? undefined : text(record.path, "路径选择器");
	let command: PermissionCommandSelector | undefined;
	if (record.command !== undefined) {
		const selector = object(record.command, "命令选择器");
		if (selector.type === "exact") {
			keys(selector, ["type", "value"], "命令选择器");
			const value = text(selector.value, "命令", 16384);
			const parsed = parseShell(value);
			if (parsed.opaque || parsed.compound || parsed.commands.length !== 1)
				throw new Error("命令规则仅接受一个无动态展开的直接命令。");
			command = { type: "exact", value };
		} else if (selector.type === "prefix") {
			keys(selector, ["type", "argv"], "命令选择器");
			if (!Array.isArray(selector.argv) || selector.argv.length < 2 || selector.argv.length > 100)
				throw new Error("命令前缀必须包含可执行文件和至少一个参数。");
			const argv = selector.argv.map((item) => text(item, "命令参数", 4096));
			if (argv[0].includes(" ") || wrappers.has(argv[0].split("/").at(-1)!))
				throw new Error("命令前缀不能使用 Shell 包装器。");
			command = { type: "prefix", argv };
		} else throw new Error("命令选择器类型无效。");
	}
	return {
		id,
		scope: record.scope as PermissionRule["scope"],
		action: record.action as PermissionAction,
		tool,
		...(project !== undefined ? { project } : {}),
		...(conversationId !== undefined ? { conversationId } : {}),
		...(path !== undefined ? { path } : {}),
		...(command !== undefined ? { command } : {}),
	};
}

export function validateRuntimePolicy(value: unknown): RuntimePermissionPolicy {
	const record = object(value, "运行时权限配置");
	keys(record, ["version", "mode", "rules", "disabledTools", "project"], "运行时权限配置");
	if (record.version !== 1 || !["ask", "acceptEdits", "auto", "read", "plan"].includes(record.mode as string))
		throw new Error("运行时权限版本或模式无效。");
	if (!Array.isArray(record.rules) || record.rules.length > 2000) throw new Error("权限规则列表无效。");
	if (!Array.isArray(record.disabledTools) || record.disabledTools.length > 10000) throw new Error("停用工具列表无效。");
	const rules = record.rules.map(validatePermissionRule);
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("权限规则标识重复。");
	const disabledTools = record.disabledTools.map((item) => {
		const name = text(item, "停用工具名称", 300);
		if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new Error("停用工具名称无效。");
		return name;
	});
	const project = text(record.project, "运行时项目目录");
	if (!isAbsolute(project)) throw new Error("运行时项目目录必须为绝对路径。");
	return { version: 1, mode: record.mode as RuntimePermissionPolicy["mode"], rules, disabledTools, project };
}

/** The file is deliberately read for every call so revocation also stops stale tool calls. */
export async function loadRuntimePermissionPolicy(
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
): Promise<RuntimePermissionPolicy> {
	if (env.PI_DESKTOP_POLICY_FILE) {
		if (!isAbsolute(env.PI_DESKTOP_POLICY_FILE)) throw new Error("运行时权限文件必须为绝对路径。");
		const content = await readFile(env.PI_DESKTOP_POLICY_FILE, "utf8");
		if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("运行时权限配置过大。");
		return validateRuntimePolicy(JSON.parse(content));
	}
	const mode = env.PI_DESKTOP_PERMISSION_MODE ?? "ask";
	return validateRuntimePolicy({ version: 1, mode, rules: [], disabledTools: [], project: cwd });
}

/** Canonicalize the nearest existing ancestor, including a symlink before a new file. */
export async function canonicalPermissionPath(path: string, project: string): Promise<string> {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	let candidate = resolve(project, expanded);
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(candidate), ...missing.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw error;
			missing.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			candidate = parent;
		}
	}
}

/** Keep target normalization in step with the pinned Pi 1.5.2 native file tools. */
function nativeToolPath(input: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
		if (drive) path = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
	if (path.startsWith("file://")) path = fileURLToPath(path);
	return path;
}

async function nativeToolTarget(path: string, project: string, read: boolean): Promise<string> {
	const normalized = resolve(project, nativeToolPath(path));
	if (read) {
		// Pi's Read tool tries these filename variants before it reads; they may themselves be symlinks.
		const variants = [
			normalized,
			normalized.replace(/ (AM|PM)\./gi, "\u202F$1."),
			normalized.normalize("NFD"),
			normalized.replace(/'/g, "\u2019"),
			normalized.normalize("NFD").replace(/'/g, "\u2019"),
		];
		for (const variant of variants) {
			if (await access(variant).then(() => true, () => false)) return canonicalPermissionPath(variant, project);
		}
	}
	return canonicalPermissionPath(normalized, project);
}

function segmentMatches(pattern: string, target: string): boolean {
	// Dynamic programming avoids exponential backtracking for user-supplied wildcard patterns.
	let previous = new Array<boolean>(target.length + 1).fill(false);
	previous[0] = true;
	for (const character of pattern) {
		const next = new Array<boolean>(target.length + 1).fill(false);
		next[0] = character === "*" && previous[0];
		for (let index = 1; index <= target.length; index++) {
			next[index] = character === "*"
				? previous[index] || next[index - 1]
				: previous[index - 1] && (character === "?" || character === target[index - 1]);
		}
		previous = next;
	}
	return previous[target.length];
}

function pathGlobMatches(pattern: string, target: string): boolean {
	const parts = target.split("/");
	let previous = new Array<boolean>(parts.length + 1).fill(false);
	previous[0] = true;
	for (const part of pattern.split("/")) {
		const next = new Array<boolean>(parts.length + 1).fill(false);
		next[0] = part === "**" && previous[0];
		for (let index = 1; index <= parts.length; index++) {
			next[index] = part === "**"
				? previous[index] || next[index - 1]
				: previous[index - 1] && segmentMatches(part, parts[index - 1]);
		}
		previous = next;
	}
	return previous[parts.length];
}

async function pathMatches(pattern: string, target: string, project: string): Promise<boolean> {
	const expanded = pattern === "~" ? homedir() : pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
	const absolute = resolve(project, expanded).split(sep).join("/");
	const wildcard = absolute.search(/[?*]/);
	if (wildcard < 0) return target === (await canonicalPermissionPath(expanded, project));
	const prefixEnd = absolute.lastIndexOf("/", wildcard);
	const prefix = absolute.slice(0, prefixEnd) || "/";
	const suffix = absolute.slice(prefixEnd + 1);
	const canonical = (await canonicalPermissionPath(prefix, project)).split(sep).join("/");
	return pathGlobMatches(`${canonical === "/" ? "" : canonical}/${suffix}`, target.split(sep).join("/"));
}

interface ShellCommand {
	commands: string[][];
	compound: boolean;
	opaque: boolean;
}

/** A deliberately narrow literal-shell recognizer; it does not attempt to parse shell programs. */
function parseShell(command: string): ShellCommand {
	const commands: string[][] = [];
	let argv: string[] = [];
	let token = "";
	let inToken = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let opaque = false;
	let compound = false;
	const finishToken = () => {
		if (inToken) argv.push(token);
		token = "";
		inToken = false;
	};
	const finishCommand = () => {
		finishToken();
		if (argv.length) commands.push(argv);
		argv = [];
	};
	for (const character of command) {
		if (escaped) {
			if (character === "\n") opaque = true;
			// Within double quotes, Bash keeps a backslash before characters other than these.
			if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(character)) token += "\\";
			token += character;
			inToken = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else {
				if (quote === '"' && (character === "$" || character === "`")) opaque = true;
				token += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			inToken = true;
		} else if (";&|\n\r".includes(character)) {
			compound = true;
			finishCommand();
		} else if (/\s/.test(character)) finishToken();
		else {
			if ("$`<>(){}*?[]~#".includes(character)) opaque = true;
			token += character;
			inToken = true;
		}
	}
	if (quote || escaped) opaque = true;
	finishCommand();
	for (const words of commands) {
		if (wrappers.has(words[0].split("/").at(-1)!) || /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(words[0])) opaque = true;
	}
	return { commands, compound, opaque };
}

function commandMatches(selector: PermissionCommandSelector, argv: string[]): boolean {
	const expected = selector.type === "prefix" ? selector.argv : parseShell(selector.value).commands[0];
	return expected.every((word, index) => argv[index] === word) && (selector.type === "prefix" || argv.length === expected.length);
}

function contained(project: string, path: string): boolean {
	const pathRelative = relative(project, path);
	return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative));
}

/** Evaluate declarative tool policy. Scopes must already have been selected by the host. */
export async function evaluatePermission(
	policy: RuntimePermissionPolicy,
	call: PermissionToolCall,
): Promise<PermissionDecision> {
	const project = await canonicalPermissionPath(policy.project, policy.project);
	if (policy.disabledTools.includes(call.toolName)) return { action: "deny", reason: "该工具已停用。" };
	if (policy.mode === "read" && !readingTools.has(call.toolName) && !harmlessDesktopTools.has(call.toolName))
		return { action: "deny", reason: "当前为只读模式，此工具不可执行。" };
	const input = call.input && typeof call.input === "object" && !Array.isArray(call.input)
		? (call.input as Record<string, unknown>)
		: {};
	let targets: string[] = [];
	const rawPath =
		typeof input.path === "string"
			? input.path
			: call.toolName === "NotebookEdit" && typeof input.notebook_path === "string"
				? input.notebook_path
				: undefined;
	if (typeof rawPath === "string") targets = [pathTools.has(call.toolName)
		? await nativeToolTarget(rawPath, project, call.toolName === "read")
		: await canonicalPermissionPath(rawPath, project)];
	else if (pathTools.has(call.toolName)) {
		if (["read", "edit", "write", "NotebookEdit"].includes(call.toolName)) return { action: "deny", reason: "工具缺少有效的文件路径。" };
		targets = [project];
	}
	let writingPlanFile = false;
	if (policy.mode === "plan") {
		const planDirs = await Promise.all([
			canonicalPermissionPath(".pi/plans", project),
			canonicalPermissionPath(".claude/plans", project),
		]);
		const inPlanDir = (target: string) => planDirs.some((dir) => contained(dir, target) && target !== dir);
		writingPlanFile = (call.toolName === "write" || call.toolName === "edit") && targets.length > 0 && targets.every(inPlanDir);
		const isSafePlanAgent = call.toolName === "Agent" && input.subagent_type !== "general-purpose";
		const allowedInPlan =
			readingTools.has(call.toolName) ||
			harmlessDesktopTools.has(call.toolName) ||
			call.toolName === "WebFetch" ||
			writingPlanFile ||
			isSafePlanAgent;
		if (!allowedInPlan) {
			return { action: "deny", reason: "Plan 模式下此工具不可执行，仅允许只读调研或编写计划文件（.pi/plans/）。", ...(targets.length ? { targets } : {}) };
		}
	}
	const shell = call.toolName === "bash" && typeof input.command === "string" ? parseShell(input.command) : undefined;
	const matches: { rule: PermissionRule; conservative: boolean }[] = [];
	for (const rule of policy.rules) {
		if (!segmentMatches(rule.tool, call.toolName)) continue;
		if (rule.path !== undefined) {
			if (!targets.length) continue;
			const pathResults = await Promise.all(targets.map((target) => pathMatches(rule.path!, target, project)));
			if (rule.action === "allow" ? !pathResults.every(Boolean) : !pathResults.some(Boolean)) continue;
		}
		let conservative = false;
		if (rule.command) {
			if (!shell) continue;
			if (shell.opaque) {
				if (rule.action === "allow") continue;
				// A shell program may hide a denied command in expansion, a wrapper, or redirection.
				conservative = true;
			} else if (rule.action === "allow" && shell.compound) continue;
			else if (!shell.commands.some((argv) => commandMatches(rule.command!, argv))) continue;
		}
		matches.push({ rule, conservative });
	}
	for (const action of ["deny", "ask", "allow"] as const) {
		const match = matches.find((candidate) => candidate.rule.action === action);
		if (match) return {
			action,
			ruleId: match.rule.id,
			reason: match.conservative ? `复杂 Shell 语法无法安全排除规则 ${match.rule.id}，按规则保守处理。` : `匹配权限规则 ${match.rule.id}。`,
			...(targets.length ? { targets } : {}),
		};
	}
	const result = (action: PermissionAction, reason: string): PermissionDecision => ({ action, reason, ...(targets.length ? { targets } : {}) });
	if (policy.mode === "plan") {
		if (writingPlanFile) return result("allow", "Plan 模式：允许编辑计划文件。");
		if (call.toolName === "Agent" && (input.subagent_type === "Explore" || input.subagent_type === "Plan"))
			return result("allow", "Plan 模式：允许只读探索/规划子 Agent。");
	}
	if (policy.mode === "auto") return result("allow", "自动执行模式。");
	if (policy.mode === "acceptEdits" && editTools.has(call.toolName) && targets.length && targets.every((target) => contained(project, target)))
		return result("allow", "接受编辑模式：项目内文件编辑自动允许。");
	if (shell && (shell.compound || shell.opaque)) return result("ask", "复杂 Shell 命令需要单次确认。不能通过字面命令授权推断其副作用。");
	if (readingTools.has(call.toolName) && targets.every((target) => contained(project, target)))
		return result("allow", "项目目录内的读取工具。");
	if (harmlessDesktopTools.has(call.toolName)) return result("allow", "只读任务状态或任务取消操作。");
	return result("ask", targets.some((target) => !contained(project, target)) ? "访问项目目录外的路径需要确认。" : "此工具操作需要确认。");
}
