import { access, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_AGENT_MCP_SERVERS } from "./delegation-limits.ts";
import { knownRemoteOperation } from "./remote-operation.ts";
import { isProtectedFileToolPath } from "./sandbox.ts";
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
const harmlessDesktopTools = new Set(["AgentExecutors", "TaskOutput", "TaskList", "TaskStop", "WorktreeList", "TodoWrite", "TodoCreate", "TodoGet", "TodoUpdate", "TodoList", "CronList", "BashOutput", "KillShell", "StructuredOutput", "AskUserQuestion", "ExitPlanMode", "LSP"]);
const pathTools = new Set([...readingTools, "edit", "write", "NotebookEdit"]);
const wrappers = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".", "env", "sudo", "doas", "exec", "command", "xargs"]);
/** Pass-through process wrappers that Claude Code strips before matching command rules. */
const processWrappers = new Set(["timeout", "time", "nice", "nohup", "stdbuf"]);

function executableName(word: string): string {
	return word.split("/").at(-1)!;
}

/** Remove leading `timeout 5`, `nice -n 10`, `nohup`, `time`, `stdbuf -oL` so rules match the real command. */
function stripProcessWrappers(argv: string[]): string[] {
	let words = argv;
	for (let guard = 0; guard < 8 && words.length; guard++) {
		const name = executableName(words[0]);
		if (!processWrappers.has(name)) break;
		let index = 1;
		if (name === "timeout") {
			while (index < words.length && words[index].startsWith("-")) {
				// -s SIGNAL / -k DURATION take a separate value unless attached.
				if (/^-(?:s|k)$|^--(?:signal|kill-after)$/.test(words[index])) index++;
				index++;
			}
			index++; // duration
		} else if (name === "nice") {
			while (index < words.length && words[index].startsWith("-")) {
				if (words[index] === "-n" || words[index] === "--adjustment") index++;
				index++;
			}
		} else if (name === "stdbuf" || name === "time") {
			while (index < words.length && words[index].startsWith("-")) index++;
		}
		words = words.slice(index);
	}
	return words;
}

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
	keys(record, ["id", "scope", "project", "conversationId", "delegatedOnly", "action", "tool", "path", "command", "domain", "agentType"], "权限规则");
	const id = text(record.id, "规则标识", 200);
	if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("规则标识无效。");
	if (!["global", "project", "conversation"].includes(record.scope as string)) throw new Error("权限作用域无效。");
	if (!["allow", "ask", "deny"].includes(record.action as string)) throw new Error("权限动作无效。");
	if (record.delegatedOnly !== undefined && typeof record.delegatedOnly !== "boolean")
		throw new Error("委派树权限标志无效。");
	if (record.delegatedOnly === true && record.scope !== "conversation")
		throw new Error("委派树权限规则必须为会话作用域。");
	const tool = text(record.tool, "工具选择器", 300);
	const inlineAgent = /^Agent\(([^()]+)\)$/.exec(tool);
	if (inlineAgent) {
		if (!/^[a-zA-Z0-9_.*?*-]+$/.test(inlineAgent[1])) throw new Error("工具选择器无效。");
	} else if (!/^[a-zA-Z0-9_.:?*-]+$/.test(tool)) {
		throw new Error("工具选择器无效。");
	}
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
			if (!Array.isArray(selector.argv) || selector.argv.length < 1 || selector.argv.length > 100)
				throw new Error("命令前缀必须包含可执行文件。");
			const argv = selector.argv.map((item) => text(item, "命令参数", 4096));
			if (argv[0].includes(" ") || wrappers.has(executableName(argv[0])) || processWrappers.has(executableName(argv[0])))
				throw new Error("命令前缀不能使用 Shell 或进程包装器。");
			command = { type: "prefix", argv };
		} else throw new Error("命令选择器类型无效。");
	}
	let domain: string | undefined;
	if (record.domain !== undefined) {
		domain = text(record.domain, "域名", 253).toLowerCase();
		if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(domain))
			throw new Error("域名选择器无效。");
		if (path !== undefined || command !== undefined) throw new Error("域名规则不能同时指定路径或命令。");
	}
	let agentType: string | undefined;
	if (record.agentType !== undefined) {
		agentType = text(record.agentType, "代理类型", 100);
		if (!/^[a-zA-Z0-9_.*?*-]+$/.test(agentType)) throw new Error("代理类型选择器无效。");
		if (inlineAgent || path !== undefined || command !== undefined || domain !== undefined)
			throw new Error("代理类型规则不能同时指定路径、命令、域名或内联 Agent(...)。");
	}
	if (inlineAgent && (path !== undefined || command !== undefined || domain !== undefined))
		throw new Error("Agent(...) 规则不能同时指定路径、命令或域名。");
	return {
		id,
		scope: record.scope as PermissionRule["scope"],
		action: record.action as PermissionAction,
		tool,
		...(project !== undefined ? { project } : {}),
		...(conversationId !== undefined ? { conversationId } : {}),
		...(record.delegatedOnly === true ? { delegatedOnly: true } : {}),
		...(path !== undefined ? { path } : {}),
		...(command !== undefined ? { command } : {}),
		...(domain !== undefined ? { domain } : {}),
		...(agentType !== undefined ? { agentType } : {}),
	};
}

function requestHost(input: Record<string, unknown>): string | undefined {
	if (typeof input.url !== "string") return;
	try {
		return new URL(input.url).hostname.toLowerCase().replace(/\.$/, "") || undefined;
	} catch {
		return;
	}
}

/**
 * Allow rules match only the named host (or an explicit `*.` wildcard); deny
 * and ask rules also cover subdomains so a narrower host cannot slip past.
 */
function domainMatches(rule: PermissionRule, host: string | undefined): boolean {
	if (host === undefined) return rule.action !== "allow";
	const domain = rule.domain!;
	if (domain.startsWith("*.")) return host.endsWith(domain.slice(1));
	return host === domain || (rule.action !== "allow" && host.endsWith(`.${domain}`));
}

function agentTypeMatches(rule: PermissionRule, pattern: string, type: string | undefined): boolean {
	if (type === undefined) return rule.action !== "allow";
	return segmentMatches(pattern, type);
}

export function validateRuntimePolicy(value: unknown): RuntimePermissionPolicy {
	const record = object(value, "运行时权限配置");
	keys(record, ["version", "mode", "dontAsk", "rules", "disabledTools", "allowedMcpServers", "project", "additionalDirs", "sandbox"], "运行时权限配置");
	if (record.version !== 1 || !["ask", "acceptEdits", "auto", "read", "plan"].includes(record.mode as string))
		throw new Error("运行时权限版本或模式无效。");
	if (record.dontAsk !== undefined && typeof record.dontAsk !== "boolean")
		throw new Error("运行时 dontAsk 配置无效。");
	if (record.sandbox !== undefined && typeof record.sandbox !== "boolean")
		throw new Error("运行时沙箱配置无效。");
	if (!Array.isArray(record.rules) || record.rules.length > 2000) throw new Error("权限规则列表无效。");
	if (!Array.isArray(record.disabledTools) || record.disabledTools.length > 10000) throw new Error("停用工具列表无效。");
	const rules = record.rules.map(validatePermissionRule);
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("权限规则标识重复。");
	const disabledTools = record.disabledTools.map((item) => {
		const name = text(item, "停用工具名称", 300);
		if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new Error("停用工具名称无效。");
		return name;
	});
	let allowedMcpServers: string[] | undefined;
	if (record.allowedMcpServers !== undefined) {
		if (!Array.isArray(record.allowedMcpServers) || record.allowedMcpServers.length > MAX_AGENT_MCP_SERVERS)
			throw new Error("允许的 MCP 服务器列表无效。");
		allowedMcpServers = record.allowedMcpServers.map((item) => {
			const name = text(item, "MCP 服务器名称", 64);
			if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("MCP 服务器名称无效。");
			return name;
		});
	}
	const project = text(record.project, "运行时项目目录");
	if (!isAbsolute(project)) throw new Error("运行时项目目录必须为绝对路径。");
	let additionalDirs: string[] | undefined;
	if (record.additionalDirs !== undefined) {
		if (!Array.isArray(record.additionalDirs)) throw new Error("运行时附加目录列表无效。");
		additionalDirs = record.additionalDirs.map((item) => {
			const path = text(item, "运行时附加目录");
			if (!isAbsolute(path)) throw new Error("运行时附加目录必须为绝对路径。");
			return path;
		});
	}
	return {
		version: 1,
		mode: record.mode as RuntimePermissionPolicy["mode"],
		...(record.dontAsk === true ? { dontAsk: true } : {}),
		rules,
		disabledTools,
		...(allowedMcpServers !== undefined ? { allowedMcpServers } : {}),
		project,
		...(additionalDirs !== undefined ? { additionalDirs } : {}),
		...(record.sandbox !== undefined ? { sandbox: record.sandbox } : {}),
	};
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
	if (mode === "dontAsk") return validateRuntimePolicy({ version: 1, mode: "ask", dontAsk: true, rules: [], disabledTools: [], project: cwd });
	return validateRuntimePolicy({ version: 1, mode, rules: [], disabledTools: [], project: cwd });
}

/** Canonicalize the nearest existing ancestor, including a symlink before a new file. */
export async function canonicalPermissionPath(path: string, project: string): Promise<string> {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	let candidate = resolve(project, expanded);
	const missing: string[] = [];
	let followedLinks = 0;
	for (;;) {
		try {
			return resolve(await realpath(candidate), ...missing.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			// A dangling symlink can still be the destination of a successful write.
			const link = await readlink(candidate).catch((linkError: NodeJS.ErrnoException) => {
				if (!["ENOENT", "ENOTDIR", "EINVAL"].includes(linkError.code ?? "")) throw linkError;
			});
			if (link !== undefined) {
				if (++followedLinks > 40) throw new Error("无法解析文件路径中的符号链接。");
				candidate = resolve(dirname(candidate), link);
				continue;
			}
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

const commandAssignments = /^[a-zA-Z_][a-zA-Z0-9_]*=/;
const inlineShells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const argvWrappers = new Set(["env", "command", "exec", "sudo", "doas", "xargs"]);
const wrapperValueOptions = new Set(["-u", "--unset", "-C", "--chdir", "-g", "-I", "-L", "-n", "-P"]);

/** Inspect literal invocations even in a command chain or a shell wrapper. Unknown scripts remain ordinary Bash. */
function remoteShellOperation(commands: string[][], depth = 0): string | undefined {
	if (depth >= 5) return;
	for (const command of commands) {
		let argv = command;
		for (let wrapper = 0; wrapper < 8 && argv.length; wrapper++) {
			if (commandAssignments.test(argv[0]) || ["if", "then", "else", "do", "!", "{"].includes(argv[0])) {
				argv = argv.slice(1);
				continue;
			}
			argv = stripProcessWrappers(argv);
			if (!argv.length) break;
			const executable = executableName(argv[0]);
			if (argvWrappers.has(executable)) {
				let index = 1;
				while (argv[index]?.startsWith("-") && argv[index] !== "--") index += wrapperValueOptions.has(argv[index]) ? 2 : 1;
				if (argv[index] === "--") index++;
				argv = argv.slice(index);
				continue;
			}
			if (inlineShells.has(executable) || executable === "eval") {
				const selector = argv.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
				const body = executable === "eval" ? argv.slice(1).join(" ") : selector > 0 ? argv[selector + 1] : undefined;
				const operation = body && remoteShellOperation(parseShell(body).commands, depth + 1);
				if (operation) return operation;
				break;
			}
			if (/^python(?:[23](?:\.\d+)?)?$/.test(executable) && argv[1] === "-m" && argv[2] === "kaggle") argv = argv.slice(2);
			const operation = knownRemoteOperation(argv);
			if (operation) return operation;
			break;
		}
	}
}

function commandMatches(selector: PermissionCommandSelector, rawArgv: string[], action: PermissionAction): boolean {
	const expected = selector.type === "prefix" ? selector.argv : parseShell(selector.value).commands[0];
	const argv = stripProcessWrappers(rawArgv);
	if (!argv.length) return false;
	// Deny/ask rules also catch `/bin/rm` for `rm`; allow rules stay literal.
	const first = action !== "allow" && !expected[0].includes("/") ? executableName(argv[0]) : argv[0];
	return [first, ...argv.slice(1)].length >= expected.length &&
		expected.every((word, index) => (index === 0 ? first : argv[index]) === word) &&
		(selector.type === "prefix" || argv.length === expected.length);
}

/**
 * Remove grep/find/ls result lines whose file a deny or ask path rule covers,
 * so a recursive search cannot reveal a file that `read` would refuse.
 */
export async function redactSearchOutput(
	policy: RuntimePermissionPolicy,
	toolName: string,
	input: unknown,
	text: string,
): Promise<{ text: string; removed: number }> {
	const rules = policy.rules.filter(
		(rule) => rule.action !== "allow" && rule.path !== undefined && !rule.command && !rule.domain && segmentMatches(rule.tool, toolName),
	);
	if ((!rules.length && !policy.sandbox) || !["grep", "find", "ls"].includes(toolName)) return { text, removed: 0 };
	const project = await canonicalPermissionPath(policy.project, policy.project);
	const home = policy.sandbox ? await canonicalPermissionPath(homedir(), project) : undefined;
	const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const root = await nativeToolTarget(typeof record.path === "string" ? record.path : ".", project, false);
	let removed = 0;
	const kept: string[] = [];
	const checked = new Map<string, boolean>();
	for (const line of text.split("\n")) {
		let relativePath: string | undefined;
		if (toolName === "grep") relativePath = /^(.+?)(?::\d+: |-\d+- )/.exec(line)?.[1];
		else if (line.trim() && !line.startsWith("[")) relativePath = line.replace(/\/$/, "");
		if (relativePath !== undefined) {
			const target = relativePath === "" ? root : resolve(root, relativePath);
			let hidden = checked.get(target);
			if (hidden === undefined) {
				const resolved = home === undefined ? target : await canonicalPermissionPath(target, project).catch(() => null);
				hidden = (home !== undefined && (
					resolved === null || isProtectedFileToolPath(target, home) || isProtectedFileToolPath(resolved, home)
				)) || (await Promise.all(rules.map((rule) => pathMatches(rule.path!, target, project)))).some(Boolean);
				checked.set(target, hidden);
			}
			if (hidden) {
				removed++;
				continue;
			}
		}
		kept.push(line);
	}
	return { text: kept.join("\n"), removed };
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
	const extraDirs = policy.additionalDirs?.length
		? await Promise.all(policy.additionalDirs.map((dir) => canonicalPermissionPath(dir, project)))
		: [];
	const allowedRoots = [project, ...extraDirs];
	const inAllowedRoots = (target: string) => allowedRoots.some((root) => contained(root, target));
	const inExtraDirs = (target: string) => extraDirs.some((root) => contained(root, target));
	if (policy.disabledTools.includes(call.toolName)) return { action: "deny", reason: "该工具已停用。" };
	if (call.toolName === "ExitPlanMode" && policy.mode !== "plan")
		return { action: "deny", reason: "请先进入计划模式，再提交计划。" };
	if (policy.allowedMcpServers !== undefined && call.toolName.startsWith("mcp__")) {
		const rest = call.toolName.slice(5);
		const sepIndex = rest.indexOf("__");
		const server = sepIndex >= 0 ? rest.slice(0, sepIndex) : rest;
		if (!policy.allowedMcpServers.includes(server)) {
			return { action: "deny", reason: `此子 Agent 未授权使用 MCP 服务器 ${server}。` };
		}
	}
	const input = call.input && typeof call.input === "object" && !Array.isArray(call.input)
		? (call.input as Record<string, unknown>)
		: {};
	const readModeSafeDelegation =
		(call.toolName === "SendMessage" || call.toolName === "AgentSend") ||
		(call.toolName === "Agent" &&
			input.fork !== true &&
			typeof input.subagent_type === "string" &&
			input.subagent_type !== "general-purpose" &&
			input.subagent_type !== "fork");
	const previewReadOnly =
		call.toolName === "PreviewCheck" &&
		(input.action === "list_configs" || input.action === "server_logs" ||
			((input.action === undefined || input.action === "check") &&
				(input.actions === undefined || (Array.isArray(input.actions) && input.actions.length === 0))));
	if (policy.mode === "read" && !readingTools.has(call.toolName) && !harmlessDesktopTools.has(call.toolName) && call.toolName !== "WebSearch" && !previewReadOnly && !readModeSafeDelegation)
		return { action: "deny", reason: "当前为只读模式，此工具不可执行。" };
	let targets: string[] = [];
	const pathInput = call.toolName === "NotebookEdit" ? input.notebook_path : input.path;
	const rawPath = typeof pathInput === "string" ? pathInput : undefined;
	const notebookPath = call.toolName === "NotebookEdit" && rawPath !== undefined ? resolve(project, rawPath) : undefined;
	if (notebookPath !== undefined) targets = [await canonicalPermissionPath(notebookPath, project)];
	else if (rawPath !== undefined) targets = [pathTools.has(call.toolName)
		? await nativeToolTarget(rawPath, project, call.toolName === "read")
		: await canonicalPermissionPath(rawPath, project)];
	else if (pathTools.has(call.toolName)) {
		if (["read", "edit", "write", "NotebookEdit"].includes(call.toolName)) return { action: "deny", reason: "工具缺少有效的文件路径。" };
		targets = [project];
	}
	if (policy.sandbox && pathTools.has(call.toolName)) {
		const home = await canonicalPermissionPath(homedir(), project);
		const lexicalTarget = notebookPath ?? (rawPath === undefined ? project : resolve(project, nativeToolPath(rawPath)));
		if (isProtectedFileToolPath(lexicalTarget, homedir()) || targets.some((target) => isProtectedFileToolPath(target, home)))
			return { action: "deny", reason: "文件保护已拦截敏感凭据路径。", targets };
		if (editTools.has(call.toolName) && !targets.every(inAllowedRoots))
			return { action: "deny", reason: "文件工具只能写入当前工作区和附加目录。", targets };
	}
	let writingPlanFile = false;
	if (policy.mode === "plan") {
		const planDirs = await Promise.all([
			canonicalPermissionPath(".pi/plans", project),
			canonicalPermissionPath(".claude/plans", project),
		]);
		const inPlanDir = (target: string) => planDirs.some((dir) => contained(dir, target) && target !== dir);
		writingPlanFile = (call.toolName === "write" || call.toolName === "edit") && targets.length > 0 && targets.every(inPlanDir);
		// An omitted type and "fork" both start a writable general-purpose child.
		const agentType = input.subagent_type ?? "general-purpose";
		const isSafePlanAgent = call.toolName === "Agent" && agentType !== "general-purpose" && agentType !== "fork" && input.fork !== true;
		const allowedInPlan =
			readingTools.has(call.toolName) ||
			harmlessDesktopTools.has(call.toolName) ||
			call.toolName === "WebFetch" ||
			call.toolName === "WebSearch" ||
			previewReadOnly ||
			writingPlanFile ||
			isSafePlanAgent;
		if (!allowedInPlan) {
			return { action: "deny", reason: "Plan 模式下此工具不可执行，仅允许只读调研或编写计划文件（.pi/plans/）。", ...(targets.length ? { targets } : {}) };
		}
	}
	// The bash tool's run_in_background path; it must never be weaker than a foreground bash call.
	if (call.toolName === "BashBackground") {
		if (typeof input.command !== "string" || !input.command.trim()) return { action: "deny", reason: "后台命令缺少 command。" };
		return evaluatePermission(policy, { toolName: "bash", input: { command: input.command, run_in_background: true } });
	}
	if (call.toolName === "Monitor") {
		if (typeof input.command === "string" && input.command.trim()) {
			if (policy.disabledTools.includes("bash")) {
				return { action: "deny", reason: "Bash 工具已停用，无法启动命令监听。" };
			}
			return evaluatePermission(policy, { toolName: "bash", input: { command: input.command, run_in_background: true } });
		}
		if (typeof input.url === "string" && input.url.trim()) {
			let parsed: URL;
			try {
				parsed = new URL(input.url.trim());
			} catch {
				return { action: "deny", reason: "Monitor WebSocket URL 格式无效。" };
			}
			const cleanHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
			const isLoopback = cleanHost === "127.0.0.1" || cleanHost === "localhost" || cleanHost === "::1";
			if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && isLoopback)) {
				return { action: "deny", reason: "Monitor 仅允许 wss:// 或本机 loopback (127.0.0.1 / localhost / [::1]) 的 ws:// 地址。" };
			}
		}
	}
	const shell = call.toolName === "bash" && typeof input.command === "string" ? parseShell(input.command) : undefined;
	const remoteOperation = shell && remoteShellOperation(shell.commands);
	const autoForeground = policy.mode === "auto" && !policy.dontAsk && input.run_in_background !== true;
	const agentType = call.toolName === "Agent"
		? input.fork === true
			? "fork"
			: typeof input.subagent_type === "string"
				? input.subagent_type
				: input.subagent_type === undefined
					? "general-purpose"
					: undefined
		: undefined;
	const matches: { rule: PermissionRule; conservative: boolean }[] = [];
	for (const rule of policy.rules) {
		const inlineAgent = /^Agent\(([^()]+)\)$/.exec(rule.tool);
		const ruleToolPattern = inlineAgent ? "Agent" : rule.tool;
		const ruleAgentPattern = rule.agentType ?? inlineAgent?.[1];
		if (!segmentMatches(ruleToolPattern, call.toolName)) continue;
		if (rule.domain !== undefined && !domainMatches(rule, requestHost(input))) continue;
		if (ruleAgentPattern !== undefined && !agentTypeMatches(rule, ruleAgentPattern, agentType)) continue;
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
			else if (!shell.commands.some((argv) => commandMatches(rule.command!, argv, rule.action))) continue;
		}
		matches.push({ rule, conservative });
	}
	for (const action of ["deny", "ask", "allow"] as const) {
		const match = matches.find((candidate) => candidate.rule.action === action);
		if (match && (!remoteOperation || action === "deny" || autoForeground)) {
			if (action === "ask" && policy.dontAsk) {
				return {
					action: "deny",
					ruleId: match.rule.id,
					reason: `dontAsk 模式自动拒绝需确认规则 ${match.rule.id}。`,
					...(targets.length ? { targets } : {}),
				};
			}
			return {
				action,
				ruleId: match.rule.id,
				reason: match.conservative ? `复杂 Shell 语法无法安全排除规则 ${match.rule.id}，按规则保守处理。` : `匹配权限规则 ${match.rule.id}。`,
				...(targets.length ? { targets } : {}),
				...(remoteOperation ? { remoteMutation: true as const } : {}),
			};
		}
	}
	const result = (action: PermissionAction, reason: string): PermissionDecision => {
		if (action === "ask" && policy.dontAsk)
			return { action: "deny", reason: `dontAsk 模式自动拒绝未预授权的操作：${reason}`, ...(targets.length ? { targets } : {}) };
		return { action, reason, ...(targets.length ? { targets } : {}) };
	};
	if (remoteOperation) {
		if (input.run_in_background === true)
			return { ...result("deny", `${remoteOperation} 会修改远端状态，请在前台执行。`), remoteMutation: true };
		const decision = autoForeground
			? result("allow", "全部放行模式。")
			: result("ask", `${remoteOperation} 会修改远端状态，需要你单次确认。`);
		return { ...decision, remoteMutation: true };
	}
	if (policy.mode === "read" && call.toolName === "Agent" && (input.subagent_type === "Explore" || input.subagent_type === "Plan"))
		return result("allow", "只读模式：允许只读探索/规划子 Agent。");
	if (policy.mode === "plan") {
		if (writingPlanFile) return result("allow", "Plan 模式：允许编辑计划文件。");
		if (call.toolName === "Agent" && (input.subagent_type === "Explore" || input.subagent_type === "Plan"))
			return result("allow", "Plan 模式：允许只读探索/规划子 Agent。");
	}
	if (policy.mode === "auto") return result("allow", "自动执行模式。");
	if (policy.mode === "acceptEdits" && editTools.has(call.toolName) && targets.length && targets.every(inAllowedRoots))
		return result("allow", "接受编辑模式：项目及附加目录内文件编辑自动允许。");
	if (editTools.has(call.toolName) && targets.length && extraDirs.length > 0 && targets.every(inExtraDirs))
		return result("allow", "附加目录（/add-dir）已放行读写。");
	if (shell && (shell.compound || shell.opaque)) return result("ask", "复杂 Shell 命令需要单次确认。不能通过字面命令授权推断其副作用。");
	if (readingTools.has(call.toolName) && targets.every(inAllowedRoots))
		return result("allow", "项目或附加目录内的读取工具。");
	if (harmlessDesktopTools.has(call.toolName)) return result("allow", "只读任务状态或任务取消操作。");
	if (call.toolName === "WebSearch") return result("allow", "网络搜索（只读）。");
	if (previewReadOnly) return result("allow", "本机网页隔离预览与检查。");
	if (call.toolName === "CronCreate" || call.toolName === "CronDelete" || call.toolName === "ScheduleWakeup") {
		return result("allow", "定时唤醒日程管理。");
	}
	if (call.toolName === "TeamCreate" || call.toolName === "TeamDelete") {
		return result("allow", "Agent Team 团队管理。");
	}
	if (call.toolName === "WorkflowRun") {
		return result("allow", "工作流引擎执行（受工作流审批卡片与沙箱控制）。");
	}
	return result("ask", targets.some((target) => !inAllowedRoots(target)) ? "访问项目目录外的路径需要确认。" : "此工具操作需要确认。");
}
