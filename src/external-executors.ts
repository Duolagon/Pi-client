import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { classifyExternalError, redactDiagnostic } from "./external-errors.ts";
import { acpExecutorDefinition, acpRestoreMethod, externalExecutorDefinitions, isExternalProvider } from "./external-registry.ts";
import { JsonLineProcess } from "./external-rpc.ts";
import type { ExternalExecutor, ExternalExecutorInput, ExternalProvider } from "./external-types.ts";

const exec = promisify(execFile);
export { isExternalProvider };
export interface ExternalExecutorSetting { enabled: boolean; executable?: string }
export type ExternalExecutorSettings = Partial<Record<ExternalProvider, ExternalExecutorSetting>>;

export function validateExecutorInput(value: unknown): ExternalExecutorInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("执行器设置必须为对象。");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["id", "executable", "enabled"].includes(key)) || !isExternalProvider(input.id)) throw new Error("未知执行器。");
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须为 boolean。");
	if (input.executable !== undefined && input.executable !== null && (typeof input.executable !== "string" || !isAbsolute(input.executable) || input.executable.includes("\0"))) throw new Error("执行文件必须是本机绝对路径。");
	return input as unknown as ExternalExecutorInput;
}

export async function executablePath(path: string): Promise<string> {
	const canonical = await realpath(path);
	const installer = /^(?:npm|npx|uv|uvx|bunx|pnpm|yarn)(?:-cli\.js|\.(?:exe|cmd|bat|ps1))?$/i;
	if (installer.test(basename(path)) || installer.test(basename(canonical)))
		throw new Error("请选择已安装的 Agent CLI，而不是包管理器或临时安装命令。");
	if (!(await stat(canonical)).isFile()) throw new Error("执行文件不是普通文件。");
	await access(canonical, constants.X_OK);
	return canonical;
}

function probeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) =>
		!/^PI_(?:DESKTOP|CODING)_/i.test(key) && !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PASSWORD|PASSWD|^AWS_|GOOGLE_APPLICATION_CREDENTIALS)/i.test(key)));
}

/** Resolve local executable files by trusted command names; never use an installer as a launcher. */
export async function discoverExecutors(settings: ExternalExecutorSettings, env: NodeJS.ProcessEnv): Promise<ExternalExecutor[]> {
	const directories = [...new Set([...(env.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path)), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin")])];
	const probeEnv = probeEnvironment(env);
	return Promise.all(externalExecutorDefinitions.map(async (definition): Promise<ExternalExecutor> => {
		const { id, label, capabilities, installCommand } = definition;
		const cliEnv = { ...probeEnv, ...acpExecutorDefinition(id)?.acp.env };
		const setting = settings[id];
		const result: ExternalExecutor = {
			id, label, enabled: setting?.enabled ?? definition.enabledByDefault, available: false, capabilities, installCommand,
		};
		const names = process.platform === "win32"
			? definition.commands.flatMap((command) => [command + ".exe", command])
			: definition.commands;
		const candidates = setting?.executable ? [setting.executable] : directories.flatMap((path) => names.map((name) => join(path, name)));
		if (id === "codex" && !setting?.executable && process.platform === "darwin") candidates.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
		for (const candidate of candidates) {
			try {
				const executable = await executablePath(candidate);
				const { stdout, stderr } = await exec(executable, ["--version"], { env: cliEnv, timeout: 8000, maxBuffer: 65536 });
				result.executable = executable;
				result.version = redactDiagnostic((stdout.trim() || stderr.trim()).split("\n")[0], env).slice(0, 300) || undefined;
				result.compatibility = "unverified";
				result.available = true;
				return result;
			} catch (error) {
				if (setting?.executable) result.error = redactDiagnostic(error instanceof Error ? error.message : String(error), env).slice(0, 1000);
			}
		}
		result.error ??= "未在本机找到可运行的 " + label + "，请安装官方 CLI 或配置执行文件绝对路径。";
		return result;
	}));
}

/** Local protocol check, with an empty working directory and no session or model request. */
export async function checkExecutorCompatibility(executor: ExternalExecutor, env: NodeJS.ProcessEnv): Promise<ExternalExecutor> {
	if (!executor.executable) return executor;
	const cwd = await mkdtemp(join(tmpdir(), "pi-executor-probe-"));
	const acp = acpExecutorDefinition(executor.id)?.acp;
	const probeEnv = { ...probeEnvironment(env), ...acp?.env };
	let rpc: JsonLineProcess | undefined;
	let capabilities = executor.capabilities;
	try {
		if (executor.capabilities.transport === "sdk") {
			const { stdout, stderr } = await exec(executor.executable, ["--help"], { cwd, env: probeEnv, timeout: 5000, maxBuffer: 65536 });
			const help = stdout + "\n" + stderr;
			if (!["--input-format", "--output-format", "stream-json"].every((flag) => help.includes(flag)))
				throw new Error("当前 Claude Code CLI 未公布 SDK 所需的 stream-json 输入和输出选项");
		} else {
			if (executor.capabilities.transport === "acp" && !acp) throw new Error("缺少 ACP 启动配置");
			rpc = new JsonLineProcess({
				executable: executor.executable, args: acp ? [...acp.args] : ["app-server", "--listen", "stdio://", "--disable", "multi_agent", "--strict-config"],
				cwd, env: probeEnv, onNotification: () => {},
				onRequest: async () => { throw new Error("兼容性检查不提供客户端工具"); },
			});
			const clientInfo = { name: "pi_desktop", title: "Pi Desktop", version: "0.1.0" };
			const result = await rpc.request<Record<string, unknown> | null>("initialize",
				acp ? { protocolVersion: 1, clientInfo, clientCapabilities: {} } : { clientInfo, capabilities: { experimentalApi: false } }, 5000);
			if (!result || typeof result !== "object" || Array.isArray(result))
				throw new Error("initialize 未返回有效的协议响应");
			if (acp && result.protocolVersion !== 1)
				throw new Error("此版本无法握手为 ACP v1");
			if (acp) capabilities = { ...capabilities, continuation: Boolean(acpRestoreMethod(result.agentCapabilities)) };
		}
		return { ...executor, capabilities, available: true, compatibility: "compatible", error: undefined };
	} catch (error) {
		const message = redactDiagnostic(error instanceof Error ? error.message : String(error), env).slice(0, 700);
		if (classifyExternalError(error, executor.id) === "auth")
			return { ...executor, compatibility: "unverified", error: "请先在本机 CLI 登录后再检查兼容性。" };
		return { ...executor, available: false, compatibility: "incompatible", error: "CLI 与当前客户端不兼容：" + message + "。请升级官方 CLI 后重试。" };
	} finally {
		await rpc?.close();
		await rm(cwd, { recursive: true, force: true });
	}
}
