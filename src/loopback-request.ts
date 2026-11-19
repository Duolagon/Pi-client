import { request as httpRequest } from "node:http";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const url = new URL(path, origin);
		const payload = Buffer.from(JSON.stringify(body), "utf8");
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
				},
				...(signal ? { signal } : {}),
			},
			(response) => {
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
				response.once("error", reject);
				response.once("end", () => {
					try {
						resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
					} catch {
						reject(new Error("Invalid desktop tool response"));
					}
				});
			},
		);
		request.once("error", reject);
		request.end(payload);
	});
}
