import { createHmac } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DesktopEvent } from "./shared.ts";

const scope = "pi-desktop";
const configurationKeys = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_HOST", "LANGFUSE_BASEURL",
	"LANGFUSE_TRACING_ENVIRONMENT", "LANGFUSE_RELEASE"] as const;

/** Consume host configuration before any Pi engines, hooks, or terminals inherit the environment. */
export function takeLangfuseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const settings: NodeJS.ProcessEnv = {};
	for (const key of configurationKeys) {
		settings[key] = env[key];
		delete env[key];
	}
	// SDK debug logs can include the collector address and public key.
	delete env.LANGFUSE_LOG_LEVEL;
	delete env.LANGFUSE_DEBUG;
	return settings;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function identifier(value: unknown): string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]{0,119}$/i.test(value) ? value : "unknown";
}

type Outcome = "success" | "error" | "aborted";
type Source = "agent" | "btw" | "grail";
type Generation = { span: Span; firstOutput?: number };
type Run = { root: Span; attributes: Attributes; generation?: Generation; tools: Map<string, Span> };

function end(span: Span, outcome: Outcome): void {
	span.setAttribute("pi.outcome", outcome);
	if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
	span.end();
}

export class PiTracing {
	private readonly runs = new Map<string, Run>();
	private readonly provider: BasicTracerProvider;
	private readonly sessionKey: string;
	private readonly tracer;
	private closed = false;

	constructor(provider: BasicTracerProvider, sessionKey: string) {
		this.provider = provider;
		this.sessionKey = sessionKey;
		this.tracer = provider.getTracer(scope);
	}

	observe(id: string, event: DesktopEvent["event"], sessionId: string, parentId?: string, failed?: boolean, source: Source = "agent"): void {
		switch (event.type) {
			case "agent_start": this.startRun(id, sessionId, parentId, source); break;
			case "turn_start": this.startGeneration(id); break;
			case "message_update":
				if (["text_delta", "thinking_delta", "toolcall_start"].includes(event.assistantMessageEvent.type)) this.firstOutput(id);
				break;
			case "message_end":
				if (event.message.role === "assistant") this.finishGeneration(id, event.message);
				break;
			case "tool_execution_start": this.startTool(id, event.toolCallId, event.toolName); break;
			case "tool_execution_end": this.finishTool(id, event.toolCallId, event.isError); break;
			case "agent_settled": this.finishRun(id, event.aborted ? "aborted" : failed ? "error" : "success"); break;
			case "desktop_error": this.finishRun(id, "error"); break;
		}
	}

	startRun(id: string, sessionId: string, parentId?: string, source: Source = "agent"): void {
		if (this.closed) return;
		this.finishRun(id, "aborted");
		const parent = parentId && this.runs.get(parentId);
		const attributes = {
			"langfuse.session.id": createHmac("sha256", this.sessionKey).update(sessionId).digest("hex").slice(0, 32),
			"pi.client": scope,
			"langfuse.observation.metadata.feature": source,
		};
		const name = source === "agent" ? (parentId ? "pi.subagent" : "pi.agent-turn") : `pi.${source}`;
		const root = this.tracer.startSpan(name, {
			attributes: { ...attributes, "langfuse.observation.type": "agent" },
		}, parent ? trace.setSpan(ROOT_CONTEXT, parent.root) : ROOT_CONTEXT);
		this.runs.set(id, { root, attributes, tools: new Map() });
	}

	startGeneration(id: string): void {
		const run = this.runs.get(id);
		if (!run) return;
		if (run.generation) end(run.generation.span, "aborted");
		run.generation = { span: this.child(run, "pi.model-call", "generation") };
	}

	firstOutput(id: string): void {
		const generation = this.runs.get(id)?.generation;
		if (generation) generation.firstOutput ??= Date.now();
	}

	finishGeneration(id: string, message: Pick<AssistantMessage, "model" | "provider" | "usage" | "stopReason" | "timestamp">): void {
		const run = this.runs.get(id);
		if (!run) return;
		const generation = run.generation;
		// A retry can emit a finalized assistant response without a new RPC turn_start.
		const span = generation?.span ?? this.child(run, "pi.model-call", "generation", message.timestamp);
		run.generation = undefined;
		const usage = message.usage;
		span.setAttributes({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": identifier(message.provider),
			"gen_ai.request.model": identifier(message.model),
			"gen_ai.response.model": identifier(message.model),
			"gen_ai.response.finish_reasons": [identifier(message.stopReason)],
		});
		if (usage) {
			const input = count(usage.input), output = count(usage.output);
			const read = count(usage.cacheRead), write = count(usage.cacheWrite);
			const total = input + output + read + write;
			if (total) span.setAttributes({
				"gen_ai.usage.input_tokens": input + read + write,
				"gen_ai.usage.output_tokens": output,
				"gen_ai.usage.cache_read.input_tokens": read,
				"gen_ai.usage.cache_creation.input_tokens": write,
				"langfuse.observation.usage_details": JSON.stringify({ input, output, input_cached_tokens: read, input_cache_write_tokens: write, total }),
			});
			const cost = usage.cost;
			if (cost && count(cost.total) > 0) span.setAttributes({
				"gen_ai.usage.cost": cost.total,
				"langfuse.observation.cost_details": JSON.stringify({ input: count(cost.input), output: count(cost.output),
					input_cached_tokens: count(cost.cacheRead), input_cache_write_tokens: count(cost.cacheWrite), total: cost.total }),
				"langfuse.observation.metadata.cost_source": "pi-reported",
			});
		}
		if (generation?.firstOutput) span.setAttribute("langfuse.observation.completion_start_time", new Date(generation.firstOutput).toISOString());
		end(span, message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "success");
	}

	startTool(id: string, callId: string, name: string): void {
		const run = this.runs.get(id);
		if (!run || run.tools.has(callId)) return;
		// The child execution supplies its own agent observation.
		if (name === "Agent" || name === "AgentTeams") return;
		run.tools.set(callId, this.child(run, `pi.tool.${identifier(name)}`, "tool"));
	}

	finishTool(id: string, callId: string, isError: boolean): void {
		const run = this.runs.get(id);
		const span = run?.tools.get(callId);
		if (!span) return;
		run?.tools.delete(callId);
		end(span, isError ? "error" : "success");
	}

	finishRun(id: string, outcome: Outcome): void {
		const run = this.runs.get(id);
		if (!run) return;
		this.runs.delete(id);
		if (run.generation) end(run.generation.span, outcome === "success" ? "aborted" : outcome);
		for (const span of run.tools.values()) end(span, outcome === "success" ? "aborted" : outcome);
		end(run.root, outcome);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const id of this.runs.keys()) this.finishRun(id, "aborted");
		await this.provider.shutdown();
	}

	private child(run: Run, name: string, type: string, startTime?: number): Span {
		return this.tracer.startSpan(name, {
			attributes: { ...run.attributes, "langfuse.observation.type": type },
			...(startTime && startTime > 0 && startTime <= Date.now() ? { startTime } : {}),
		}, trace.setSpan(ROOT_CONTEXT, run.root));
	}
}

export function createPiTracing(env: NodeJS.ProcessEnv, onConfigurationError: () => void): PiTracing | undefined {
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim(), secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey && !secretKey) return;
	const configuredUrl = env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || env.LANGFUSE_BASEURL?.trim();
	const baseUrl = configuredUrl ? URL.parse(configuredUrl.replace("\\:", ":")) : null;
	if (!publicKey || !secretKey || !baseUrl || !["http:", "https:"].includes(baseUrl.protocol) ||
		baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
		onConfigurationError();
		return;
	}
	try {
		const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl: baseUrl.href.replace(/\/+$/, ""),
			environment: env.LANGFUSE_TRACING_ENVIRONMENT || "pi-desktop",
			release: env.LANGFUSE_RELEASE, mediaUploadEnabled: false,
			shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === scope,
		});
		return new PiTracing(new BasicTracerProvider({spanProcessors: [processor]}), secretKey);
	} catch {
		onConfigurationError();
		return;
	}
}
