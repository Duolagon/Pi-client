import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface ModelRequest {
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

/** Serve disposable model protocols over loopback without external credentials or requests. */
export async function createModelEndpoint(replyTo?: (request: ModelRequest) => string | Promise<string>) {
	const requests: ModelRequest[] = [];
	let failure: string | undefined;
	let text = "WIRE_OK";
	let stalled = false;
	let notifyRequest: () => void = () => {};
	const requested = new Promise<void>((resolve) => {
		notifyRequest = resolve;
	});
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += String(chunk);
		// The local HTTP body is the fixture's wire trust boundary.
		const parsed: unknown = JSON.parse(body);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			response.writeHead(400).end();
			return;
		}
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const modelRequest: ModelRequest = { path, headers: request.headers, body: parsed as Record<string, unknown> };
		requests.push(modelRequest);
		notifyRequest();
		if (stalled) return;
		if (failure) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { type: "authentication_error", message: failure } }));
			return;
		}
		const content = replyTo ? await replyTo(modelRequest) : text;
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (path === "/v1/messages") {
			for (const event of [
				{
					type: "message_start",
					message: { id: "msg_desktop_test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			])
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		} else if (path === "/v1/responses") {
			const item = {
				type: "message",
				id: "msg_desktop_test",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: content, annotations: [] }],
			};
			for (const event of [
				{ type: "response.created", response: { id: "resp_desktop_test" } },
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: "resp_desktop_test", status: "completed" } },
			])
				response.write(`data: ${JSON.stringify(event)}\n\n`);
		} else if (path === "/v1/chat/completions" || path === "/chat/completions") {
			for (const chunk of [
				{ id: "chatcmpl_desktop_test", choices: [{ index: 0, delta: { content } }] },
				{
					id: "chatcmpl_desktop_test",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				},
			])
				response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.write("data: [DONE]\n\n");
		}
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Loopback model server did not bind a port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		requested,
		fail: (message: string | undefined) => {
			failure = message;
		},
		replyWith: (value: string) => {
			text = value;
		},
		stall: () => {
			stalled = true;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}
