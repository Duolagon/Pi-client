import { request as httpRequest } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { MAX_PROGRESS_LINE_BYTES } from "./delegation-limits.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PROGRESS_LINES = 10_000;

/**
 * POST JSON to the desktop's loopback tool host and wait for its answer without a client
 * timeout. Pi installs a global fetch dispatcher whose headers/body timeouts follow
 * `httpIdleTimeoutMs` (5 minutes by default); a foreground Agent call legitimately waits
 * longer than that, and a client timeout would look like the parent aborting the call.
 * Only `signal` (Pi's own tool abort) ends the request early.
 */
export function postLoopbackJson(
	origin: string,
	path: string,
	token: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
	return postLoopbackNdjson(origin, path, token, body, undefined, signal, false);
}

/**
 * POST JSON with `accept: application/x-ndjson` for streaming progress updates on
 * long-running Agent / SendMessage calls. Falls back seamlessly to plain JSON responses
 * (such as validation/auth errors or non-streaming tools).
 */
export function postLoopbackNdjson(
	origin: string,
	path: string,
	token: string,
	body: unknown,
	onProgress?: (progress: unknown) => void,
	signal?: AbortSignal,
	stream = true,
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const url = new URL(path, origin);
		const payload = Buffer.from(JSON.stringify(body), "utf8");
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const request = httpRequest(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: "POST",
				// A dedicated connection: no keep-alive pool and no agent socket timeout.
				agent: false,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"content-length": String(payload.length),
					...(stream ? { accept: "application/x-ndjson, application/json" } : {}),
				},
				...(signal ? { signal } : {}),
			},
			(response) => {
				const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
				if (stream && contentType === "application/x-ndjson") {
					const decoder = new StringDecoder("utf8");
					let buffer = "";
					let finalResult: { ok: boolean; data?: unknown; error?: string } | undefined;
					let progressCount = 0;
					const processLine = (rawLine: string) => {
						const line = rawLine.trim();
						if (!line) return;
						let parsed: unknown;
						try {
							parsed = JSON.parse(line);
						} catch {
							throw new Error("Invalid desktop tool stream line");
						}
						if (!parsed || typeof parsed !== "object") throw new Error("Invalid desktop tool stream payload");
						const record = parsed as Record<string, unknown>;
						if (record.type === "progress") {
							if (Buffer.byteLength(line, "utf8") <= MAX_PROGRESS_LINE_BYTES && progressCount < MAX_PROGRESS_LINES) {
								progressCount++;
								onProgress?.(record.progress);
							}
							return;
						}
						if (record.type === "result") {
							finalResult = {
								ok: record.ok === true,
								...(record.data !== undefined ? { data: record.data } : {}),
								...(typeof record.error === "string" ? { error: record.error } : {}),
							};
							return;
						}
					};
					response.on("data", (chunk: Buffer) => {
						buffer += decoder.write(chunk);
						if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
							response.destroy(new Error("Desktop tool response is too large"));
							return;
						}
						let newline = buffer.indexOf("\n");
						while (newline !== -1) {
							const line = buffer.slice(0, newline);
							buffer = buffer.slice(newline + 1);
							try {
								processLine(line);
							} catch (error) {
								response.destroy(error instanceof Error ? error : new Error(String(error)));
								return;
							}
							newline = buffer.indexOf("\n");
						}
					});
					response.once("error", (error) => finish(() => reject(error)));
					response.once("aborted", () => finish(() => reject(new Error("Desktop tool stream aborted"))));
					response.once("end", () => {
						try {
							buffer += decoder.end();
							if (buffer.trim()) processLine(buffer);
							if (!finalResult) {
								finish(() => reject(new Error("Desktop tool stream ended before returning a result")));
								return;
							}
							finish(() => resolve({ status: response.statusCode ?? 0, body: finalResult }));
						} catch (error) {
							finish(() => reject(error instanceof Error ? error : new Error("Invalid desktop tool response")));
						}
					});
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_RESPONSE_BYTES) {
						response.destroy(new Error("Desktop tool response is too large"));
						return;
					}
					chunks.push(chunk);
				});
				response.once("error", (error) => finish(() => reject(error)));
				response.once("end", () => {
					try {
						finish(() => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					} catch {
						finish(() => reject(new Error("Invalid desktop tool response")));
					}
				});
			},
		);
		request.once("error", (error) => finish(() => reject(error)));
		request.end(payload);
	});
}
