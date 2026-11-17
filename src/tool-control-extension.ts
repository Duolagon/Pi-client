import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	desktopModelToolNames, validateDesktopToolInput, validateToolOverrides,
	type DesktopModelToolName, type DesktopToolInfo, type ToolControlRequest,
	type ToolControlResponse, type ToolOverrides,
} from "./tool-control-types.ts";

const nativeTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
const safeChildTools = new Set(["read", "grep", "find", "ls", "AgentExecutors", "TaskOutput", "TaskStop", "TaskList", "WorktreeList"]);

type JsonSchema = ToolDefinition["parameters"];
function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
	return { type: "object", properties, required, additionalProperties: false } as JsonSchema;
}
const boundedText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const taskId = boundedText(200);
const toolSchemas: Record<DesktopModelToolName, JsonSchema> = {
	Agent: schema({
		executor: { type: "string", enum: ["pi", "codex", "claude", "kimi"] },
		description: boundedText(160), prompt: boundedText(2 * 1024 * 1024),
		subagent_type: { type: "string", enum: ["Explore", "Plan", "general-purpose"] },
		run_in_background: { type: "boolean" }, isolation: { type: "string", enum: ["worktree", "shared"] },
		worktree_id: taskId,
	}, ["description", "prompt", "subagent_type"]),
	AgentSend: schema({ task_id: taskId, message: boundedText(2 * 1024 * 1024), run_in_background: { type: "boolean" } }, ["task_id", "message"]),
	AgentExecutors: schema({}),
	TaskOutput: schema({ task_id: taskId, block: { type: "boolean" }, timeout: { type: "integer", minimum: 0, maximum: 60000 } }, ["task_id"]),
	TaskStop: schema({ task_id: taskId }, ["task_id"]), TaskList: schema({}),
	WorktreeCreate: schema({ base_ref: boundedText(1000) }), WorktreeList: schema({}),
	WorktreeMerge: schema({ worktree_id: taskId }, ["worktree_id"]),
	WorktreeRemove: schema({ worktree_id: taskId }, ["worktree_id"]),
};
const descriptions: Record<DesktopModelToolName, string> = {
	Agent: "Delegate an independent task to a subagent with its own context. Use executor=pi (default), codex, claude, or kimi; first use AgentExecutors to inspect locally available engines and their permission capabilities. Proactively delegate focused research or implementation with a self-contained prompt. Explore and Plan require enforced read-only support; general-purpose writes in an isolated Git worktree. Use run_in_background=true for independent parallel work, then TaskOutput to collect results. Foreground calls wait. No automatic merge. Use AgentSend to continue an external agent's native conversation after it completes.",
	AgentSend: "Continue an external Codex/Claude/Kimi child conversation with another self-contained instruction or a message from another collaborator. The task must belong to this parent and its previous turn must be finished. Preserves native session and worktree; cannot change executor, project or permissions. Use run_in_background for asynchronous collaboration.",
	AgentExecutors: "Discover available local Codex, Claude Code and Kimi Code executors, versions, enabled status and supported permissions before delegating. Does not run a model or expose credentials.",
	TaskOutput: "Read the status, bounded result, and approval count of a child task created by this conversation. Set block=true to wait up to timeout milliseconds (maximum 60000); a still-running response is not a failure. Use the returned task_id to poll again.",
	TaskStop: "Cancel a child task created by this conversation. Already completed changes remain available for review; stopping does not undo them or remove its worktree.",
	TaskList: "List child tasks delegated by this conversation, including their status and worktree identifiers. Other conversations' tasks are inaccessible.",
	WorktreeCreate: "Create an isolated Git worktree for this conversation's repository, optionally at base_ref. Returns a worktree_id that Agent can use. This does not move the main conversation or change its working directory.",
	WorktreeList: "List application-managed worktrees for this conversation's repository. Inspect identifiers and status before delegating, merging, or removing a worktree.",
	WorktreeMerge: "Fast-forward merge an owned, idle worktree into its original repository. Never force merges or discards dirty files. Review its changes first; returns a blocked reason when a safe fast-forward is unavailable.",
	WorktreeRemove: "Remove an owned, idle, clean worktree using the host's safety checks. Never force-removes dirty files. Branch retention is reported in the result.",
};

function hostConfig(): { url: string; token: string } | undefined {
	const url = process.env.PI_DESKTOP_HOST_URL;
	const token = process.env.PI_DESKTOP_HOST_TOKEN;
	if (!url && !token) return;
	if (!url || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid desktop tool host configuration");
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port ||
		parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
		throw new Error("Desktop tools require a loopback host");
	return { url: parsed.origin, token };
}

/** Extend the real Pi session; this is not a renderer-side simulation of model tools. */
export default function toolControl(pi: ExtensionAPI): void {
	const directory = process.env.PI_DESKTOP_TOOLS_DIR;
	const token = process.env.PI_DESKTOP_TOOLS_TOKEN;
	const command = process.env.PI_DESKTOP_TOOLS_COMMAND;
	const toolsFile = process.env.PI_DESKTOP_TOOLS_FILE;
	const baselineFile = process.env.PI_DESKTOP_TOOLS_BASELINE_FILE;
	const readOnlyChild = process.env.PI_DESKTOP_READ_ONLY_CHILD === "1";
	const child = process.env.PI_DESKTOP_CHILD === "1" || readOnlyChild;
	const host = hostConfig();
	if (!directory && !token && !command && !toolsFile && !host) return;
	if (!directory || !isAbsolute(directory) || !token || !/^[a-f0-9]{64}$/.test(token) ||
		!command || !/^desktop-tools-[a-f0-9]{32}$/.test(command) || !toolsFile || !isAbsolute(toolsFile) || (baselineFile && !isAbsolute(baselineFile)))
		throw new Error("Invalid desktop tool control configuration");

	if (host) {
		for (const name of desktopModelToolNames) {
			pi.registerTool({
				name, label: name, description: descriptions[name], promptSnippet: descriptions[name].split(". ")[0],
				promptGuidelines: name === "Agent" ? ["Delegate independent focused research or implementation when it can progress separately; collect the child's result and review worktree changes before merging."] : undefined,
				parameters: toolSchemas[name], exposure: "model-only", defaultActive: !["Agent", "AgentSend"].includes(name) || !child,
				executionMode: ["Agent", "AgentSend", "TaskOutput"].includes(name) ? "parallel" : "sequential",
				prepareArguments: (input) => validateDesktopToolInput(name, input),
				async execute(toolCallId, input, signal, onUpdate) {
					const params = validateDesktopToolInput(name, input);
					if (child && ["Agent", "AgentSend"].includes(name)) throw new Error("Subagents cannot delegate further tasks");
					if (readOnlyChild && !safeChildTools.has(name)) throw new Error("This subagent is read-only");
					signal?.throwIfAborted();
					onUpdate?.({ content: [{ type: "text", text: name === "Agent" ? "Delegating task…" : `Running ${name}…` }], details: { tool: name, toolCallId } });
					const response = await fetch(`${host.url}/invoke`, {
						method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
						body: JSON.stringify({ tool: name, toolCallId, input: params }), signal, redirect: "error",
					});
					const result: unknown = await response.json();
					if (!result || typeof result !== "object" || !("ok" in result)) throw new Error("Invalid desktop tool response");
					const record = result as { ok: boolean; data?: unknown; error?: string };
					if (!response.ok || record.ok !== true) throw new Error(record.error ?? `Desktop tool failed (${response.status})`);
					return { content: [{ type: "text", text: JSON.stringify(record.data ?? null) }], details: record.data };
				},
			});
		}
	}
	const config = async (): Promise<ToolOverrides> => validateToolOverrides(JSON.parse(await readFile(toolsFile, "utf8")));
	let previousOverrides: Record<string, boolean> = {};
	const baseline = new Map<string, boolean>();
	let loadedBaseline = false;
	let application: Promise<void> = Promise.resolve();
	function apply(): Promise<ToolOverrides> {
		const action = application.then(applySettings);
		application = action.then(() => {}, () => {});
		return action;
	}
	async function applySettings(): Promise<ToolOverrides> {
		if (!loadedBaseline && baselineFile) {
			try {
				const saved = JSON.parse(await readFile(baselineFile, "utf8"));
				if (!saved || saved.version !== 1 || Object.keys(saved).some((key) => !["version", "baseline"].includes(key))) throw new Error("Invalid tool baseline");
				const parsed = validateToolOverrides({ overrides: saved.baseline });
				for (const [name, enabled] of Object.entries(parsed.overrides)) baseline.set(name, enabled);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		loadedBaseline = true;
		const settings = await config();
		const all = pi.getAllTools();
		const active = new Set(pi.getActiveTools());
		for (const name of new Set([...Object.keys(previousOverrides), ...baseline.keys()])) {
			if (!(name in settings.overrides)) {
				if (baseline.get(name)) active.add(name); else active.delete(name);
				baseline.delete(name);
			}
		}
		for (const [name, enabled] of Object.entries(settings.overrides)) {
			if (!all.some((item) => item.name === name)) continue;
			if (!(name in previousOverrides) && !baseline.has(name)) baseline.set(name, active.has(name));
			if (enabled) active.add(name); else active.delete(name);
		}
		if (child) { active.delete("Agent"); active.delete("AgentSend"); }
		if (readOnlyChild) for (const name of active) if (!safeChildTools.has(name)) active.delete(name);
		previousOverrides = settings.overrides;
		pi.setActiveTools([...active]);
		if (baselineFile) {
			await writeFile(`${baselineFile}.tmp`, JSON.stringify({ version: 1, baseline: Object.fromEntries(baseline) }), { mode: 0o600 });
			await rename(`${baselineFile}.tmp`, baselineFile);
		}
		return settings;
	}
	function inventory(settings: ToolOverrides): DesktopToolInfo[] {
		const active = new Set(pi.getActiveTools());
		return pi.getAllTools().map((tool) => describeTool(tool, active, settings.overrides, child, readOnlyChild));
	}
	pi.on("session_start", async () => { await apply(); });
	pi.on("before_agent_start", async () => { await apply(); });
	// The active set changes what is declared to the model. A fresh guard also denies stale or nested calls.
	pi.on("tool_call", async (event) => {
		try {
			const settings = await config();
			if (settings.overrides[event.toolName] === false || (child && ["Agent", "AgentSend"].includes(event.toolName)) ||
				(readOnlyChild && !safeChildTools.has(event.toolName))) return { block: true, reason: "此工具已被客户端禁用。" };
		} catch { return { block: true, reason: "无法读取工具启停设置，已阻止执行。" }; }
	});
	const expectedToken = Buffer.from(token);
	pi.registerCommand(command, {
		description: "Desktop internal tool control",
		handler: async (args, ctx) => {
			const match = /^([a-f0-9]{64}) ([a-f0-9-]{36})$/.exec(args);
			if (!match || !timingSafeEqual(Buffer.from(match[1]), expectedToken)) throw new Error("Desktop tool control requires a host request");
			const requestId = match[2];
			const respond = (result: ToolControlResponse) => writeFile(join(directory, "response.json"), JSON.stringify(result), { mode: 0o600 });
			try {
				const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8")) as ToolControlRequest;
				if (ctx.mode !== "rpc" || !request || request.requestId !== requestId ||
					Object.keys(request).some((key) => !(request.operation === "notify" ? ["requestId", "operation", "result"] : ["requestId", "operation"]).includes(key)) ||
					!["list", "apply", "notify"].includes(request.operation)) throw new Error("Invalid tool control request");
				if (request.operation === "notify") {
					const content = JSON.stringify(request.result);
					if (!content || Buffer.byteLength(content, "utf8") > 512 * 1024) throw new Error("Invalid background task result");
					pi.sendMessage({ customType: "desktop_task_result", content, display: true, details: request.result }, { triggerTurn: true, deliverAs: "followUp" });
					await respond({ requestId, ok: true, tools: [] });
					return;
				}
				const settings = request.operation === "apply" ? await apply() : await config();
				await respond({ requestId, ok: true, tools: inventory(settings) });
			} catch (error) {
				await respond({ requestId, ok: false, error: error instanceof Error ? error.message : "Tool control failed" });
			}
		},
	});
}

function describeTool(tool: ToolInfo, active: Set<string>, overrides: Record<string, boolean>, child: boolean, readOnlyChild: boolean): DesktopToolInfo {
	const sourcePath = tool.sourceInfo?.path;
	const source: DesktopToolInfo["source"] = tool.name.startsWith("mcp__") ? "mcp" :
		desktopModelToolNames.includes(tool.name as DesktopModelToolName) && sourcePath?.includes("tool-control-extension") ? "desktop" :
		nativeTools.has(tool.name) && sourcePath?.startsWith("builtin:") || sourcePath?.startsWith("builtin:") ? "builtin" : "extension";
	const blocked = overrides[tool.name] === false || child && ["Agent", "AgentSend"].includes(tool.name) || readOnlyChild && !safeChildTools.has(tool.name);
	const modelVisible = active.has(tool.name) && tool.exposure !== "hidden";
	return {
		name: tool.name, description: tool.description, parameters: tool.parameters, source, sourcePath,
		exposure: tool.exposure, namespace: tool.namespace?.name,
		enabled: !blocked && tool.exposure !== "hidden" && (modelVisible || tool.exposure === "codemode" || tool.exposure === "deferred"),
		modelVisible,
		...(overrides[tool.name] !== undefined ? { override: overrides[tool.name] } : {}),
	};
}
