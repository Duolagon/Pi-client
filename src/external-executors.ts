import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ExternalExecutor, ExternalExecutorInput, ExternalProvider } from "./external-types.ts";

const exec = promisify(execFile);
export const externalProviders: ExternalProvider[] = ["codex", "claude", "kimi"];
export interface ExternalExecutorSetting { enabled: boolean; executable?: string }
export type ExternalExecutorSettings = Partial<Record<ExternalProvider, ExternalExecutorSetting>>;

export function validateExecutorInput(value: unknown): ExternalExecutorInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("执行器设置必须为对象。");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["id", "executable", "enabled"].includes(key)) || !externalProviders.includes(input.id as ExternalProvider)) throw new Error("未知执行器。");
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须为 boolean。");
	if (input.executable !== undefined && input.executable !== null && (typeof input.executable !== "string" || !isAbsolute(input.executable) || input.executable.includes("\0"))) throw new Error("执行文件必须是本机绝对路径。");
	return input as unknown as ExternalExecutorInput;
}

export async function executablePath(path: string): Promise<string> {
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isFile()) throw new Error("执行文件不是普通文件。");
	await access(canonical, constants.X_OK);
	return canonical;
}

/** Resolve only configured local executables; never start a model or read auth files. */
export async function discoverExecutors(settings: ExternalExecutorSettings, env: NodeJS.ProcessEnv): Promise<ExternalExecutor[]> {
	return Promise.all(externalProviders.map(async (id): Promise<ExternalExecutor> => {
		const setting = settings[id];
		const result: ExternalExecutor = {
			id, enabled: setting?.enabled ?? true, available: false,
			capabilities: { transport: id === "codex" ? "app-server" : id === "claude" ? "sdk" : "acp", continuation: true, approvals: true, cancellation: true, readOnly: id !== "kimi", fineGrainedPolicy: id === "claude", approvalSemantics: id === "claude" ? "per-tool-hook" : "native" },
		};
		const names = id === "kimi" ? ["kimi", "kimicode"] : [id];
		const directories = [...new Set([...(env.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path)), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin")])];
		const candidates = setting?.executable ? [setting.executable] : directories.flatMap((path) => names.map((name) => join(path, name)));
		if (id === "codex" && !setting?.executable && process.platform === "darwin") candidates.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
		for (const candidate of candidates) {
			try {
				const executable = await executablePath(candidate);
				const { stdout } = await exec(executable, ["--version"], { env, timeout: 8000, maxBuffer: 65536 });
				result.executable = executable;
				result.version = stdout.trim().split("\n")[0].slice(0, 300);
				result.available = true;
				return result;
			} catch (error) { if (setting?.executable) result.error = error instanceof Error ? error.message : String(error); }
		}
		result.error ??= `未在本机找到 ${id}，请安装官方 CLI 或配置执行文件绝对路径。`;
		return result;
	}));
}
