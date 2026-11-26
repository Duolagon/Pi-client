import { privateMemoryLabel, rulePaths, scopedRule, truncatedInstruction } from "./project-memory.ts";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import { open, realpath, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DesktopToolInfo } from "./tool-control-types.ts";
import type { Message, RpcSessionState, SessionStats } from "./shared.ts";

export interface ContextMemorySource {
	id: string;
	relativePath: string;
	path: string;
	scope: "user" | "project" | "local" | "rule" | "desktop";
	exists: boolean;
	editable: boolean;
	bytes: number;
	estimatedTokens: number;
	content: string;
	previewTruncated?: boolean;
	promptState?: "native" | "included" | "truncated" | "conditional" | "untrusted" | "not-observed";
	pathsPattern?: string;
	imports: { target: string; exists: boolean }[];
}

export interface ContextBreakdown {
	contextWindow: number | null;
	totalTokens: number | null;
	percent: number | null;
	remainingTokens: number | null;
	estimatedInstructionsTokens: number;
	estimatedToolsTokens: number;
	conversationTokens: number | null;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheHitPercent: number;
	cost: number;
	activeToolsCount: number;
	deferredToolNames: string[];
	mcpToolsCount: number;
	messageCount: number;
	autoCompactionEnabled: boolean | null;
	compactionThreshold: number | null;
	autoRetryEnabled: boolean;
	optimizationTips: string[];
	sources: ContextMemorySource[];
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function estimateTokens(text: string): number {
	return text ? Math.ceil(Buffer.byteLength(text, "utf8") / 3.5) : 0;
}

async function resolveImports(content: string, baseDir: string, project: string): Promise<{ target: string; exists: boolean }[]> {
	const refs = new Set<string>();
	const regex = /(?:^|[\s(])@([A-Za-z0-9_./-]{2,200})/g;
	for (const match of content.matchAll(regex)) {
		const target = match[1];
		if (target.endsWith(".") || target.includes("://")) continue;
		if (target.includes("/") || /\.(md|txt|json|ts|tsx|js|mjs|yaml|yml)$/i.test(target)) refs.add(target);
	}
	const results: { target: string; exists: boolean }[] = [];
	for (const target of [...refs].slice(0, 30)) {
		const candidate = resolve(baseDir, target);
		if (!inside(project, candidate)) {
			results.push({ target, exists: false });
			continue;
		}
		const ok = await stat(candidate).then((info) => info.isFile(), () => false);
		results.push({ target, exists: ok });
	}
	return results;
}

async function readSource(
	id: string,
	relativePath: string,
	fullPath: string,
	scope: ContextMemorySource["scope"],
	editable: boolean,
	boundaryRoot: string,
	project: string,
): Promise<ContextMemorySource> {
	try {
		const real = await realpath(fullPath);
		if (!inside(boundaryRoot, real)) {
			return { id, relativePath, path: fullPath, scope, exists: false, editable: false, bytes: 0, estimatedTokens: 0, content: "", imports: [] };
		}
		const info = await stat(real);
		if (!info.isFile()) {
			return { id, relativePath, path: fullPath, scope, exists: false, editable, bytes: 0, estimatedTokens: 0, content: "", imports: [] };
		}
		const maxPreviewBytes = 256 * 1024;
		let content: string;
		const handle = await open(real, "r");
		try {
			const buffer = Buffer.alloc(Math.min(info.size, maxPreviewBytes));
			const { bytesRead } = await handle.read(buffer);
			content = buffer.toString("utf8", 0, bytesRead).replace(/\uFFFD$/, "");
		} finally {
			await handle.close();
		}
		const previewTruncated = info.size > maxPreviewBytes;
		return {
			id,
			relativePath,
			path: fullPath,
			scope,
			exists: true,
			editable: editable && !previewTruncated,
			bytes: info.size,
			estimatedTokens: Math.ceil(info.size / 3.5),
			content,
			...(previewTruncated ? { previewTruncated: true } : {}),
			pathsPattern: scope === "rule" ? scopedRule(content).patterns.join(", ") || undefined : undefined,
			imports: await resolveImports(content, dirname(real), project),
		};
	} catch {
		return { id, relativePath, path: fullPath, scope, exists: false, editable, bytes: 0, estimatedTokens: 0, content: "", imports: [] };
	}
}

async function collectRules(project: string, dirRel: string): Promise<ContextMemorySource[]> {
	return Promise.all((await rulePaths(project, dirRel)).map((rel) =>
		readSource(rel, rel, join(project, rel), "rule", true, project, project),
	));
}

export function validateWritableMemoryRelativePath(rel: string): string {
	const trimmed = rel.trim().replaceAll("\\", "/");
	const allowedRoots = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"]);
	if (allowedRoots.has(trimmed)) return trimmed;
	if (
		/^\.(?:claude|pi)\/rules\/(?:[A-Za-z0-9._-]{1,120}\/){0,8}[A-Za-z0-9._-]{1,120}\.md$/.test(trimmed) &&
		!trimmed.split("/").some((segment) => segment === "." || segment === "..")
	) {
		return trimmed;
	}
	throw new Error("仅允许编辑根目录 AGENTS.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md 或 .claude/rules/*.md。");
}

export async function writeProjectMemoryFile(project: string, relativePath: string, content: string): Promise<ContextMemorySource> {
	const root = await realpath(project).catch(() => project);
	const valid = validateWritableMemoryRelativePath(relativePath);
	const parts = valid.split("/");
	const target = (await managedFile(root, parts.slice(0, -1), parts.at(-1)!, true))!;
	await writeManagedFile(target, content);
	return readSource(valid, valid, target, valid.includes("/rules/") ? "rule" : valid === "CLAUDE.local.md" ? "local" : "project", true, root, root);
}

export async function deleteProjectMemoryRule(project: string, relativePath: string): Promise<void> {
	const root = await realpath(project).catch(() => project);
	const valid = validateWritableMemoryRelativePath(relativePath);
	if (!valid.includes("/rules/")) throw new Error("仅支持删除规则文件。");
	const parts = valid.split("/");
	const target = await managedFile(root, parts.slice(0, -1), parts.at(-1)!, false);
	if (target) await rm(target, { force: true });
}

export async function buildContextReport(params: {
	project: string;
	privateMemory?: string;
	agentDir: string;
	home?: string;
	projectTrusted?: boolean;
	stats?: SessionStats;
	state?: RpcSessionState;
	compactionReserveTokens?: number;
	tools: DesktopToolInfo[];
	messages: Message[];
}): Promise<ContextBreakdown> {
	const { stats, state, tools, messages } = params;
	const project = await realpath(params.project).catch(() => params.project);
	const agentDir = await realpath(params.agentDir).catch(() => params.agentDir);
	const claudeHome = join(params.home ?? homedir(), ".claude");
	const claudeDir = await realpath(claudeHome).catch(() => claudeHome);
	const sources: ContextMemorySource[] = [
		...(params.privateMemory ? [await readSource(privateMemoryLabel, privateMemoryLabel, params.privateMemory, "desktop", true, dirname(params.privateMemory), project)] : []),
		await readSource("user-pi-agents", "~/.pi/agent/AGENTS.md", join(agentDir, "AGENTS.md"), "user", false, agentDir, project),
		await readSource("user-claude", "~/.claude/CLAUDE.md", join(claudeDir, "CLAUDE.md"), "user", false, claudeDir, project),
		await readSource("AGENTS.md", "AGENTS.md", join(project, "AGENTS.md"), "project", true, project, project),
		await readSource("AGENTS.override.md", "AGENTS.override.md", join(project, "AGENTS.override.md"), "project", true, project, project),
		await readSource("CLAUDE.md", "CLAUDE.md", join(project, "CLAUDE.md"), "project", true, project, project),
		await readSource("CLAUDE.local.md", "CLAUDE.local.md", join(project, "CLAUDE.local.md"), "local", true, project, project),
		...(await collectRules(project, ".claude/rules")),
		...(await collectRules(project, ".pi/rules")),
	];

	const activeTools = tools.filter((t) => t.enabled && t.modelVisible);
	const mcpToolsCount = activeTools.filter((t) => t.source === "mcp").length;
	// Pi emits patches to the active prompt. Count the latest effective instruction
	// sections rather than assuming every file in the editor was included in the request.
	const sections = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) sections.delete(name);
			else sections.set(name, text);
		}
	}
	const nativeInstructions = sections.get("project_context") ?? "";
	const desktopInstructions = sections.get("desktop_project_memory") ?? "";
	for (const source of sources) {
		if (!source.exists) continue;
		const isUserClaude = source.id === "user-claude";
		const marker = `\n\n## ${source.relativePath}\n`;
		const start = isUserClaude ? desktopInstructions.indexOf("# 用户记忆（~/.claude/CLAUDE.md）") : desktopInstructions.indexOf(marker);
		if (nativeInstructions.includes(`<project_instructions path="${source.path}">`)) source.promptState = "native";
		else if (params.projectTrusted === false && source.scope !== "user") source.promptState = "untrusted";
		else if (source.pathsPattern) source.promptState = "conditional";
		else if (start >= 0) {
			const body = desktopInstructions.slice(start + (isUserClaude ? 0 : marker.length));
			const nextSource = body.indexOf("\n\n## ");
			source.promptState = (nextSource < 0 ? body : body.slice(0, nextSource)).includes(truncatedInstruction) ? "truncated" : "included";
		} else source.promptState = "not-observed";
	}
	const estimatedInstructionsTokens = estimateTokens(nativeInstructions) + estimateTokens(desktopInstructions);
	const estimatedToolsTokens = activeTools.reduce((sum, t) => sum + estimateTokens(t.description + JSON.stringify(t.parameters ?? {})), 0);

	const ctxUsage = stats?.contextUsage;
	const contextWindow = ctxUsage?.contextWindow ?? state?.model?.contextWindow ?? null;
	// The runtime leaves usage unknown immediately after compaction. The billing
	// total sums every request and cannot stand in for the current model context.
	const totalTokens = ctxUsage?.tokens ?? null;
	const percent = ctxUsage?.percent ?? null;
	const remainingTokens = totalTokens === null || contextWindow === null ? null : Math.max(0, contextWindow - totalTokens);
	const conversationTokens = totalTokens === null ? null : Math.max(0, totalTokens - estimatedInstructionsTokens - estimatedToolsTokens);

	const inputTokens = stats?.tokens.input ?? 0;
	const cacheReadTokens = stats?.tokens.cacheRead ?? 0;
	const cacheWriteTokens = stats?.tokens.cacheWrite ?? 0;
	const outputTokens = stats?.tokens.output ?? 0;
	const cacheHitPercent = cacheReadTokens + inputTokens > 0
		? Math.round((cacheReadTokens / (cacheReadTokens + inputTokens)) * 100)
		: 0;

	const tips: string[] = [];
	if (percent !== null && percent >= 75) tips.push("上下文占用已达 75%，可以用 /compact 手动压缩早期对话。");
	if (mcpToolsCount >= 15) tips.push(`当前已向模型暴露 ${mcpToolsCount} 个 MCP 工具 Schema，可在“工具与 MCP”中按需关闭暂不用的服务器/工具。`);
	if (estimatedInstructionsTokens >= 4000) tips.push("项目记忆与规则文件合计约占较多 Token，建议将路径专用约定拆分到 .claude/rules/*.md（附 paths 过滤）。");
	if (!sources.some((s) => (s.relativePath === "AGENTS.md" || s.relativePath === "CLAUDE.md") && s.exists)) {
		tips.push("项目尚无 AGENTS.md 或 CLAUDE.md，可使用 /init 让 Pi 自动扫描并生成项目规范指南。");
	}
	if (!tips.length && totalTokens !== null) tips.push("上下文结构健康：指令精简、工具数量合理。");

	const autoCompactionEnabled = state?.autoCompactionEnabled ?? null;
	const compactionThreshold = contextWindow !== null && params.compactionReserveTokens !== undefined
		? contextWindow - params.compactionReserveTokens
		: null;
	const autoRetryEnabled = Boolean((state as { autoRetryEnabled?: boolean } | undefined)?.autoRetryEnabled ?? true);

	return {
		contextWindow,
		totalTokens,
		percent,
		remainingTokens,
		estimatedInstructionsTokens,
		estimatedToolsTokens,
		conversationTokens,
		cacheReadTokens,
		cacheWriteTokens,
		inputTokens,
		outputTokens,
		cacheHitPercent,
		cost: stats?.cost ?? 0,
		activeToolsCount: activeTools.length,
		deferredToolNames: tools.filter((tool) => tool.enabled && tool.deferred).map((tool) => tool.name),
		mcpToolsCount,
		messageCount: messages.length,
		autoCompactionEnabled,
		compactionThreshold,
		autoRetryEnabled,
		optimizationTips: tips,
		sources,
	};
}
