/**
 * Parser and command builder for `.claude/launch.json` dev-server configurations.
 *
 * Supports Claude Code's `configurations` format (`runtimeExecutable` + `runtimeArgs`,
 * or shorthand `command`), validates loopback URLs and workspace-contained `cwd`, and
 * blocks dangerous environment overrides.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LaunchConfiguration {
	name: string;
	runtimeExecutable?: string;
	runtimeArgs?: string[];
	command?: string;
	port?: number;
	url?: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface LaunchConfigResult {
	path: string;
	exists: boolean;
	configurations: LaunchConfiguration[];
	warnings: string[];
}

const MAX_LAUNCH_FILE_BYTES = 64 * 1024;
const BLOCKED_ENV_KEYS = new Set(["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE"]);

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateLocalPreviewUrl(raw: string): URL {
	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
		throw new Error("网页验证仅支持本机开发地址（localhost / 127.0.0.1 / [::1]）。");
	}
	return url;
}

export function launchConfigUrl(config: LaunchConfiguration): string | undefined {
	if (config.url) return validateLocalPreviewUrl(config.url).href;
	if (config.port !== undefined) return `http://127.0.0.1:${config.port}/`;
	return undefined;
}

export function buildLaunchShellCommand(config: LaunchConfiguration): string {
	const envParts: string[] = [];
	if (config.env) {
		for (const [key, value] of Object.entries(config.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || BLOCKED_ENV_KEYS.has(key.toUpperCase())) continue;
			envParts.push(`${key}=${shellQuote(value)}`);
		}
	}
	const prefix = envParts.length ? `${envParts.join(" ")} ` : "";
	if (config.runtimeExecutable) {
		const argv = [config.runtimeExecutable, ...(config.runtimeArgs ?? [])].map(shellQuote).join(" ");
		return `${prefix}${argv}`;
	}
	if (config.command) {
		return `${prefix}${config.command}`;
	}
	throw new Error(`启动配置 "${config.name}" 缺少 runtimeExecutable 或 command。`);
}

export async function readLaunchConfigurations(projectDir: string): Promise<LaunchConfigResult> {
	const canonicalProject = await realpath(projectDir);
	const filePath = join(canonicalProject, ".claude", "launch.json");
	let info;
	try {
		info = await stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: filePath, exists: false, configurations: [], warnings: [] };
		}
		throw error;
	}
	if (!info.isFile()) return { path: filePath, exists: false, configurations: [], warnings: [".claude/launch.json 不是普通文件。"] };
	if (info.size > MAX_LAUNCH_FILE_BYTES) {
		throw new Error(".claude/launch.json 超过 64 KiB 上限。");
	}
	const raw = await readFile(filePath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(".claude/launch.json 不是有效的 JSON。");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(".claude/launch.json 根节点必须是对象。");
	}
	const list = (parsed as { configurations?: unknown }).configurations;
	if (!Array.isArray(list)) {
		return { path: filePath, exists: true, configurations: [], warnings: ["configurations 字段缺失或不是数组。"] };
	}

	const configurations: LaunchConfiguration[] = [];
	const warnings: string[] = [];
	const seenNames = new Set<string>();

	for (const [index, entry] of list.slice(0, 32).entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			warnings.push(`第 ${index + 1} 项配置格式无效，已跳过。`);
			continue;
		}
		const rec = entry as Record<string, unknown>;
		const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 100) : "";
		if (!name || seenNames.has(name)) {
			warnings.push(`第 ${index + 1} 项配置缺少唯一名称，已跳过。`);
			continue;
		}
		const runtimeExecutable = typeof rec.runtimeExecutable === "string" && rec.runtimeExecutable.trim()
			? rec.runtimeExecutable.trim().slice(0, 512)
			: undefined;
		const runtimeArgs = Array.isArray(rec.runtimeArgs)
			? rec.runtimeArgs.filter((a): a is string => typeof a === "string").slice(0, 64).map((a) => a.slice(0, 2048))
			: undefined;
		const command = typeof rec.command === "string" && rec.command.trim()
			? rec.command.trim().slice(0, 4096)
			: undefined;
		if (!runtimeExecutable && !command) {
			warnings.push(`配置 "${name}" 缺少 runtimeExecutable 或 command，已跳过。`);
			continue;
		}
		let port: number | undefined;
		if (rec.port !== undefined) {
			if (typeof rec.port === "number" && Number.isSafeInteger(rec.port) && rec.port >= 1 && rec.port <= 65535) {
				port = rec.port;
			} else {
				warnings.push(`配置 "${name}" 的 port 无效，已忽略。`);
			}
		}
		let url: string | undefined;
		if (typeof rec.url === "string" && rec.url.trim()) {
			try {
				url = validateLocalPreviewUrl(rec.url.trim()).href;
			} catch {
				warnings.push(`配置 "${name}" 的 url 不是本机地址，已忽略。`);
			}
		}
		let cwd: string | undefined;
		if (typeof rec.cwd === "string" && rec.cwd.trim()) {
			const candidate = resolve(canonicalProject, rec.cwd.trim());
			const resolvedCwd = await realpath(candidate).catch(() => "");
			if (resolvedCwd && inside(canonicalProject, resolvedCwd)) {
				cwd = resolvedCwd;
			} else {
				warnings.push(`配置 "${name}" 的 cwd 超出项目目录，已跳过。`);
				continue;
			}
		}
		let env: Record<string, string> | undefined;
		if (rec.env && typeof rec.env === "object" && !Array.isArray(rec.env)) {
			const cleanEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
				if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
				if (v.length <= 4096 && !v.includes("\0")) cleanEnv[k] = v;
			}
			if (Object.keys(cleanEnv).length) env = cleanEnv;
		}
		seenNames.add(name);
		configurations.push({
			name,
			...(runtimeExecutable ? { runtimeExecutable } : {}),
			...(runtimeArgs ? { runtimeArgs } : {}),
			...(command ? { command } : {}),
			...(port !== undefined ? { port } : {}),
			...(url ? { url } : {}),
			...(cwd ? { cwd } : {}),
			...(env ? { env } : {}),
		});
	}

	return { path: filePath, exists: true, configurations, warnings };
}
