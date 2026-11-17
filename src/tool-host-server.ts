import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { validateToolInvocation, type DesktopToolInvocation, type ToolHostContext } from "./tool-control-types.ts";

export interface ToolHostServerOptions {
	handle: (request: DesktopToolInvocation, context: ToolHostContext) => Promise<unknown>;
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
		if (request.method !== "POST" || request.url !== "/invoke") return reply(404, { ok: false, error: "Not found" });
		if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
			return reply(415, { ok: false, error: "Expected application/json" });
		const supplied = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
		const known = supplied && [...this.owners.keys()].find((token) => timingSafeEqual(Buffer.from(token), Buffer.from(supplied)));
		const conversationId = known && this.owners.get(known);
		if (!known || !conversationId) return reply(401, { ok: false, error: "Unauthorized tool session" });
		const controller = new AbortController();
		const calls = this.inflight.get(known) ?? new Set<AbortController>();
		calls.add(controller);
		this.inflight.set(known, calls);
		const disconnected = () => { if (!response.writableEnded) controller.abort(new Error("Tool caller disconnected")); };
		request.once("aborted", disconnected);
		response.once("close", disconnected);
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
			let invocation: DesktopToolInvocation;
			try { invocation = validateToolInvocation(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
			catch (error) { return reply(400, { ok: false, error: error instanceof Error ? error.message : "Invalid request" }); }
			const data = await this.options.handle(invocation, { conversationId, toolCallId: invocation.toolCallId, signal: controller.signal });
			if (!controller.signal.aborted) reply(200, { ok: true, data });
		} catch (error) {
			if (!controller.signal.aborted) reply(400, { ok: false, error: error instanceof Error ? error.message : "Tool request failed" });
		} finally {
			request.off("aborted", disconnected);
			response.off("close", disconnected);
			calls.delete(controller);
			if (!calls.size) this.inflight.delete(known);
		}
	}
}
