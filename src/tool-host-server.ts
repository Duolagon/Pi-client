import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_CONCURRENT_TOOL_CALLS_PER_TOKEN, MAX_PROGRESS_LINE_BYTES } from "./delegation-limits.ts";
import { validateToolInvocation, type DesktopToolInvocation, type ToolHostContext } from "./tool-control-types.ts";

const NDJSON_HEADERS = {
	"content-type": "application/x-ndjson; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};
function acceptsNdjson(header: string | undefined): boolean {
	if (!header) return false;
	return header
		.split(",")
		.some((part) => part.split(";")[0].trim().toLowerCase() === "application/x-ndjson");
}

export interface HookBridgeRequest {
	/** `max_turns` lets a child mark its own limit stop before it aborts its run. */
	phase: "pre" | "post" | "permission" | "compact" | "stop" | "max_turns";
	toolName?: string;
	toolCallId: string;
	toolInput?: Record<string, unknown>;
	toolResponse?: unknown;
	isError?: boolean;
	error?: string;
	trigger?: "manual" | "auto";
	customInstructions?: string;
	stopHookActive?: boolean;
	lastAssistantMessage?: string;
}

export interface ToolHostServerOptions {
	handle: (request: DesktopToolInvocation, context: ToolHostContext) => Promise<unknown>;
	handleHook?: (request: HookBridgeRequest, context: ToolHostContext) => Promise<unknown>;
	handlePlanExit?: (
		request: { title?: string; plan?: string; toolCallId: string },
		context: ToolHostContext,
	) => Promise<unknown>;
}

/** Session-bound loopback bridge. Tokens never travel through the renderer or model arguments. */
export class ToolHostServer {
	private server?: Server;
	private starting?: Promise<string>;
	private baseUrl?: string;
	private closed = false;
	private owners = new Map<string, string>();
	private inflight = new Map<string, Set<AbortController>>();
	private options: ToolHostServerOptions;
	constructor(options: ToolHostServerOptions) { this.options = options; }

	start(): Promise<string> {
		if (this.closed) return Promise.reject(new Error("Tool host is closed"));
		if (this.starting) return this.starting;
		this.starting = new Promise<string>((resolve, reject) => {
			const server = createServer((request, response) => { void this.receive(request, response); });
			this.server = server;
			server.headersTimeout = 10000;
			server.requestTimeout = 15000;
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") return reject(new Error("Invalid tool host address"));
				this.baseUrl = `http://127.0.0.1:${address.port}`;
				resolve(this.baseUrl);
			});
		});
		return this.starting;
	}

	register(conversationId: string): { token: string; url: string } {
		if (this.closed || !this.baseUrl) throw new Error("Start the tool host before registering a session");
		if (!conversationId || conversationId.length > 300 || conversationId.includes("\0")) throw new Error("Invalid session");
		const token = randomBytes(32).toString("hex");
		this.owners.set(token, conversationId);
		return { token, url: this.baseUrl };
	}

	revoke(token: string): void {
		this.owners.delete(token);
		for (const controller of this.inflight.get(token) ?? []) controller.abort(new Error("Session bridge revoked"));
		this.inflight.delete(token);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const token of [...this.owners.keys()]) this.revoke(token);
		await this.starting?.catch(() => {});
		const server = this.server;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const reply = (status: number, result: unknown) => {
			if (response.destroyed || response.writableEnded) return;
			response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
			response.end(JSON.stringify(result));
		};
		if (this.closed) return reply(503, { ok: false, error: "Tool host is closed" });
		if (request.headers.origin !== undefined || request.headers.host !== new URL(this.baseUrl!).host)
			return reply(403, { ok: false, error: "Browser requests are not allowed" });
		if (request.method !== "POST" || (request.url !== "/invoke" && request.url !== "/hook" && request.url !== "/plan-exit"))
			return reply(404, { ok: false, error: "Not found" });
		if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
			return reply(415, { ok: false, error: "Expected application/json" });
		const supplied = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
		const known = supplied && [...this.owners.keys()].find((token) => timingSafeEqual(Buffer.from(token), Buffer.from(supplied)));
		const conversationId = known && this.owners.get(known);
		if (!known || !conversationId) return reply(401, { ok: false, error: "Unauthorized tool session" });
		const calls = this.inflight.get(known) ?? new Set<AbortController>();
		if (calls.size >= MAX_CONCURRENT_TOOL_CALLS_PER_TOKEN) {
			return reply(429, { ok: false, error: "Too many concurrent tool calls" });
		}
		const controller = new AbortController();
		calls.add(controller);
		this.inflight.set(known, calls);
		const onRevoked = () => {
			if (!response.writableEnded && !response.destroyed) response.destroy();
		};
		controller.signal.addEventListener("abort", onRevoked, { once: true });
		const disconnected = () => { if (!response.writableEnded) controller.abort(new Error("Tool caller disconnected")); };
		request.once("aborted", disconnected);
		response.once("close", disconnected);
		let streamed = false;
		try {
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				bytes += chunk.length;
				if (bytes > 3 * 1024 * 1024) {
					reply(413, { ok: false, error: "Tool request is too large" });
					request.resume();
					return;
				}
				chunks.push(Buffer.from(chunk));
			}
			if (controller.signal.aborted || this.owners.get(known) !== conversationId) return;
			const parsedBody: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (request.url === "/hook") {
				const rec = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? (parsedBody as Record<string, unknown>) : null;
				const phase = rec?.phase;
				const validPhase = phase === "pre" || phase === "post" || phase === "permission" || phase === "compact" || phase === "stop" || phase === "max_turns";
				const toolCallId = typeof rec?.toolCallId === "string" && rec.toolCallId && rec.toolCallId.length <= 300 ? rec.toolCallId : undefined;
				if (!rec || !validPhase || !toolCallId) return reply(400, { ok: false, error: "Invalid hook payload" });
				if (phase === "pre" || phase === "post" || phase === "permission") {
					if (typeof rec.toolName !== "string" || !rec.toolName || rec.toolName.length > 300 || !rec.toolInput || typeof rec.toolInput !== "object" || Array.isArray(rec.toolInput))
						return reply(400, { ok: false, error: "Invalid hook payload" });
				}
				const data = this.options.handleHook
					? await this.options.handleHook(
							{
								phase,
								toolCallId,
								toolName: typeof rec.toolName === "string" ? rec.toolName : undefined,
								toolInput: rec.toolInput as Record<string, unknown> | undefined,
								toolResponse: rec.toolResponse,
								isError: typeof rec.isError === "boolean" ? rec.isError : undefined,
								error: typeof rec.error === "string" ? rec.error.slice(0, 8192) : undefined,
								trigger: rec.trigger === "manual" || rec.trigger === "auto" ? rec.trigger : undefined,
								customInstructions: typeof rec.customInstructions === "string" ? rec.customInstructions.slice(0, 16384) : undefined,
								stopHookActive: typeof rec.stopHookActive === "boolean" ? rec.stopHookActive : undefined,
								lastAssistantMessage: typeof rec.lastAssistantMessage === "string" ? rec.lastAssistantMessage.slice(0, 65536) : undefined,
							},
							{ conversationId, toolCallId, signal: controller.signal },
						)
					: { blocked: false };
				if (!controller.signal.aborted) reply(200, { ok: true, data });
				return;
			}
			if (request.url === "/plan-exit") {
				const rec = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? (parsedBody as Record<string, unknown>) : null;
				if (!rec || typeof rec.toolCallId !== "string" || !rec.toolCallId || rec.toolCallId.length > 300 || (rec.title !== undefined && typeof rec.title !== "string") || (rec.plan !== undefined && typeof rec.plan !== "string"))
					return reply(400, { ok: false, error: "Invalid plan exit payload" });
				const data = this.options.handlePlanExit
					? await this.options.handlePlanExit(
							{
								title: typeof rec.title === "string" ? rec.title.slice(0, 200) : undefined,
								plan: typeof rec.plan === "string" ? rec.plan.slice(0, 512 * 1024) : undefined,
								toolCallId: rec.toolCallId,
							},
							{ conversationId, toolCallId: rec.toolCallId, signal: controller.signal },
						)
					: { saved: false };
				if (!controller.signal.aborted) reply(200, { ok: true, data });
				return;
			}
			let invocation: DesktopToolInvocation;
			try { invocation = validateToolInvocation(parsedBody); }
			catch (error) { return reply(400, { ok: false, error: error instanceof Error ? error.message : "Invalid request" }); }
			const streamable = (invocation.tool === "Agent" || invocation.tool === "SendMessage") && acceptsNdjson(request.headers.accept);
			const writeNdjsonLine = (payload: unknown, maxBytes?: number): boolean => {
				if (controller.signal.aborted || response.destroyed || response.writableEnded || this.owners.get(known) !== conversationId) return false;
				const line = JSON.stringify(payload);
				if (maxBytes !== undefined && Buffer.byteLength(line, "utf8") > maxBytes) return false;
				if (!streamed) {
					response.writeHead(200, NDJSON_HEADERS);
					streamed = true;
				}
				response.write(`${line}\n`);
				return true;
			};
			const onProgress = streamable
				? (progress: unknown) => {
					writeNdjsonLine({ type: "progress", progress }, MAX_PROGRESS_LINE_BYTES);
				}
				: undefined;
			const data = await this.options.handle(invocation, {
				conversationId, toolCallId: invocation.toolCallId, signal: controller.signal,
				...(invocation.batch ? { batch: invocation.batch } : {}),
				...(onProgress ? { onProgress } : {}),
			});
			if (controller.signal.aborted || this.owners.get(known) !== conversationId) return;
			if (streamable) {
				if (!response.destroyed && !response.writableEnded) {
					if (!streamed) {
						response.writeHead(200, NDJSON_HEADERS);
						streamed = true;
					}
					response.end(`${JSON.stringify({ type: "result", ok: true, data })}\n`);
				}
				return;
			}
			reply(200, { ok: true, data });
		} catch (error) {
			if (!controller.signal.aborted) {
				const message = error instanceof Error ? error.message : "Tool request failed";
				if (streamed && !response.destroyed && !response.writableEnded) {
					response.end(`${JSON.stringify({ type: "result", ok: false, error: message })}\n`);
				} else {
					reply(400, { ok: false, error: message });
				}
			}
		} finally {
			controller.signal.removeEventListener("abort", onRevoked);
			request.off("aborted", disconnected);
			response.off("close", disconnected);
			calls.delete(controller);
			if (!calls.size) this.inflight.delete(known);
		}
	}
}
