import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonLineProcess } from "./external-rpc.ts";
import { codexModelList } from "./external-codex.ts";
import { configValues, kimiProfile } from "./external-kimi.ts";
import { discoverClaudeModels } from "./external-claude.ts";
import { classifyExternalError } from "./external-errors.ts";
import { isExternalModelId } from "./external-model-options.ts";
import type { ExternalExecutor, ExternalTask } from "./external-types.ts";
import { MULTI_EXECUTORS, type MultiExecutorId } from "./shared.ts";
import { ACCESS_LABELS, type ModelAccess, type NativeModel, type NativeSource } from "./multi-profiles.ts";

const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
interface DiscoveryOptions { env: NodeJS.ProcessEnv; nodeExecutable: string; helperPath: string }

async function probe(id: MultiExecutorId, executable: string, cwd: string, options: DiscoveryOptions): Promise<NativeModel[]> {
	const env = { ...options.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_DESKTOP_") || key.startsWith("PI_CODING_")) delete env[key];
	if (id === "claude") return discoverClaudeModels({ ...options, env, executable, cwd,
		policy: { version: 1, mode: "read", project: cwd, rules: [], disabledTools: [] },
		onEvent() {}, onPermission: async () => ({ decision: "deny" }) });
	const rpc = new JsonLineProcess({ executable, cwd, env: id === "kimi" ? { ...env, ...kimiProfile.env } : env,
		args: id === "codex" ? ["app-server", "--listen", "stdio://"] : [...kimiProfile.args],
		onNotification() {}, onRequest: async () => { throw new Error("模型发现只读取元数据。"); } });
	try {
		const clientInfo = { name: "pi_desktop", version: "0.2.0" };
		if (id === "codex") {
			await rpc.request("initialize", { clientInfo, capabilities: {} }, 8000);
			await rpc.notify("initialized", {});
			const config = await rpc.request<{ config?: { model_provider?: string; model?: string } }>("config/read", { includeLayers: false }, 3000).catch(() => undefined);
			const provider = config?.config?.model_provider;
			const account = await rpc.request<{ account?: { type: string } | null; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, 5000).catch(() => undefined);
			const { models } = await codexModelList(rpc, provider);
			return models.filter(item => !item.hidden).map(item => ({ id: String(item.model ?? item.id ?? ""),
				current: config?.config?.model ? config.config.model === item.model : item.isDefault === true,
				access: (!provider || provider === "openai") && account?.requiresOpenaiAuth && account.account === null ? "auth" : "listed",
				...((!provider || provider === "openai") && account?.account?.type === "chatgpt" ? { billing: "subscription" as const } : {}),
				efforts: strings(item.supportedReasoningEfforts).concat(list(item.supportedReasoningEfforts).map(v => String(v.reasoningEffort))) }));
		}
		const acp = await rpc.request<{ protocolVersion: number; agentCapabilities?: { sessionCapabilities?: { close?: object } } }>("initialize", { protocolVersion: 1, clientInfo, clientCapabilities: {} }, 8000);
		if (acp.protocolVersion !== 1) throw new Error("Unsupported ACP protocol");
		const session = await rpc.request<{ sessionId: string; configOptions?: unknown; models?: { currentModelId?: string; availableModels?: unknown } }>("session/new", { cwd, mcpServers: [] }, 10000);
		const configs = list(session.configOptions);
		const selector = configs.find(v => v.category === "model");
		const ids = selector ? configValues(selector.options) : [session.models?.currentModelId].filter((v): v is string => !!v);
		const thought = configs.find(v => v.category === "thought_level");
		const rows: NativeModel[] = [];
		const deadline = Date.now() + 6000;
		try {
			for (const model of ids) {
				const row: NativeModel = { id: model, efforts: [], access: "listed", current: (selector?.currentValue ?? session.models?.currentModelId) === model };
				rows.push(row);
				if (selector?.currentValue === model) row.efforts = configValues(thought?.options);
				else if (selector?.id && Date.now() < deadline && isExternalModelId(model, "kimi")) {
					// This changes only the disposable ACP session. Legacy set_model can change the CLI default.
					try {
						const response = await rpc.request<{ configOptions?: unknown }>("session/set_config_option",
							{ sessionId: session.sessionId, configId: selector.id, value: model }, Math.max(1, deadline - Date.now()));
						const current = list(response.configOptions);
						if (current.some(v => v.id === selector.id && v.currentValue === model))
							row.efforts = configValues(current.find(v => v.category === "thought_level")?.options);
					} catch (error) {
						const kind = classifyExternalError(error, "kimi");
						if (kind === "auth" || kind === "quota" || kind === "subscription") row.access = kind;
					}
				}
			}
			return rows;
		} finally {
			if (acp.agentCapabilities?.sessionCapabilities?.close) await rpc.request("session/close", { sessionId: session.sessionId }, 1000).catch(() => {});
		}
	} finally { await rpc.close(); }
}

/** Use only the newest conclusive observation for this exact native route. */
export function recentModelAccess(tasks: readonly ExternalTask[], executor: MultiExecutorId, model?: string): ModelAccess | undefined {
	if (!model) return undefined;
	let newest: { at: number; access: ModelAccess } | undefined;
	for (const task of tasks) {
		if (task.executor !== executor || task.model !== model || task.updatedAt <= (newest?.at ?? 0)) continue;
		const kind = task.status === "failed" ? task.accessFailure ?? classifyExternalError(new Error(task.error ?? ""), executor) : undefined;
		const access = task.status === "completed" ? "confirmed" : kind === "auth" || kind === "subscription" || kind === "quota" ? kind : undefined;
		if (access) newest = { at: task.updatedAt, access };
	}
	if (newest && Date.now() - newest.at < (newest.access === "confirmed" ? 7 * 86400000 : 15 * 60000)) return newest.access;
	return undefined;
}

export async function discoverMultiSources(executors: ExternalExecutor[], tasks: ExternalTask[], options: DiscoveryOptions): Promise<NativeSource[]> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-models-"));
	try {
		return await Promise.all(MULTI_EXECUTORS.map(async id => {
			const exe = executors.find(item => item.id === id);
			const source: NativeSource = { id, readOnly: !!exe?.capabilities.readOnly, models: [] };
			if (!exe?.enabled || !exe.available || !exe.executable) {
				source.issue = !exe?.available ? "未安装或版本不兼容" : "已停用";
				return source;
			}
			try {
				const rows = await probe(id, exe.executable, cwd, options);
				const seen = new Set<string>();
				for (const row of rows) {
					if (!isExternalModelId(row.id, id) || seen.has(row.id)) continue;
					seen.add(row.id);
					if (row.access === "listed") row.access = recentModelAccess(tasks, id, row.id) ?? "listed";
					row.efforts = strings(row.efforts).filter(v => /^[a-z][a-z0-9_-]{0,31}$/.test(v));
					source.models.push(row);
				}
				if (!source.models.length) source.issue = "CLI 未返回可选择的模型";
			} catch (error) {
				const kind = classifyExternalError(error, id);
				source.issue = ACCESS_LABELS[kind as ModelAccess] ?? "查询模型失败，可刷新重试";
			}
			return source;
		}));
	} finally { await rm(cwd, { recursive: true, force: true }); }
}
