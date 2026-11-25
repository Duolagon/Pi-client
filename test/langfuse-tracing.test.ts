import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { DesktopService } from "../src/backend.ts";
import { createPiTracing, takeLangfuseEnvironment } from "../src/langfuse-tracing.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const publicKey = "pk-local-trace-fixture";
const secretKey = "sk-local-trace-fixture";
const modelKey = "local-model-fixture-only";
const userMarker = "fixture-private-user-prompt";
const outputMarker = "fixture-private-model-output";
const errorMarker = "fixture-private-provider-error";
const tracePath = "/api/public/otel/v1/traces";

interface WireSpan {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status?: { code: number };
	attributes: { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }[];
}

async function requestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks);
	return (request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString("utf8");
}

async function createEndpoint(failOnRequest?: number) {
	const traces: { body: string; authorization?: string; spans: WireSpan[] }[] = [];
	const modelRequests: string[] = [];
	const errors: unknown[] = [];
	const server = createServer(async (request, response) => {
		try {
			const body = await requestBody(request);
			if (request.url === tracePath) {
				const parsed = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[] };
				const spans = parsed.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
				traces.push({ body, authorization: request.headers.authorization, spans });
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			assert.equal(request.url, "/chat/completions");
			assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
			modelRequests.push(body);
			if (modelRequests.length === failOnRequest) {
				response.writeHead(401, { "content-type": "application/json" })
					.end(JSON.stringify({ error: { message: errorMarker, type: "authentication_error" } }));
				return;
			}
			const useTool = modelRequests.length === 1;
			const delta = useTool ? { tool_calls: [{ index: 0, id: "call-local-fixture", type: "function",
				function: { name: "read", arguments: JSON.stringify({ path: "seed.txt" }) } }] } : { content: outputMarker };
			const id = `local-model-response-${modelRequests.length}`;
			const chunk = (value: Record<string, unknown>) => response.write(`data: ${JSON.stringify({ id, ...value })}\n\n`);
			response.writeHead(200, { "content-type": "text/event-stream" });
			chunk({ choices: [{ index: 0, delta }] });
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 31, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 17, cache_write_tokens: 3 } } });
			response.end("data: [DONE]\n\n");
		} catch (error) {
			errors.push(error);
			response.writeHead(400).end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { baseUrl: `http://127.0.0.1:${address.port}`, traces, modelRequests, errors,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
				server.closeAllConnections();
			});
		} };
}

function attribute(span: WireSpan, key: string): string | number | undefined {
	const value = span.attributes.find((item) => item.key === key)?.value;
	return value?.stringValue ?? value?.intValue ?? value?.doubleValue;
}

async function prompt(service: DesktopService, message: string): Promise<void> {
	let complete: () => void = () => {};
	const settled = new Promise<void>((resolve) => { complete = resolve; });
	const unsubscribe = service.subscribe(({ event }) => { if (event.type === "agent_settled") complete(); });
	const timeout = AbortSignal.timeout(15_000);
	const timedOut = () => complete();
	timeout.addEventListener("abort", timedOut, { once: true });
	try {
		await service.command({ type: "prompt", message });
		await settled;
		timeout.throwIfAborted();
	} finally {
		timeout.removeEventListener("abort", timedOut);
		unsubscribe();
	}
}

test("Langfuse uses opt-in host configuration and removes credentials from child environments", () => {
	const env = { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey,
		LANGFUSE_BASE_URL: "http://127.0.0.1:1", LANGFUSE_LOG_LEVEL: "DEBUG", PATH: "/usr/bin" };
	const settings = takeLangfuseEnvironment(env);
	assert.deepEqual(env, { PATH: "/usr/bin" });
	assert.equal(settings.LANGFUSE_PUBLIC_KEY, publicKey);
	assert.equal(settings.LANGFUSE_SECRET_KEY, secretKey);
	assert.equal(settings.LANGFUSE_BASE_URL, "http://127.0.0.1:1");
	let configurationErrors = 0;
	const error = () => { configurationErrors++; };
	assert.equal(createPiTracing({}, error), undefined);
	assert.equal(configurationErrors, 0);
	assert.equal(createPiTracing({ LANGFUSE_PUBLIC_KEY: publicKey }, error), undefined);
	assert.equal(createPiTracing({ LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey }, error), undefined);
	assert.equal(createPiTracing({ ...settings, LANGFUSE_BASE_URL: "ftp://127.0.0.1:1" }, error), undefined);
	assert.equal(createPiTracing({ ...settings, LANGFUSE_BASE_URL: "http://user:password@127.0.0.1:1" }, error), undefined);
	assert.equal(configurationErrors, 4);
});

test("DesktopService exports related turn, generation, and tool spans with usage and without request content", { timeout: 45_000 }, async (t) => {
	const fixture = await createCoreFixture();
	t.after(fixture.cleanup);
	const endpoint = await createEndpoint(3);
	t.after(endpoint.close);
	const tracing = createPiTracing({ LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey,
		LANGFUSE_BASE_URL: endpoint.baseUrl }, () => assert.fail("Invalid test tracing configuration"));
	assert.ok(tracing);
	const env = { ...fixture.env, HOME: fixture.root };
	takeLangfuseEnvironment(env);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(import.meta.dirname, "../src/permission-extension.ts"),
		env,
		initialProject: fixture.project,
		providerBaseUrls: { deepseek: endpoint.baseUrl },
		encrypt: (value) => Buffer.from(value).toString("base64"),
		decrypt: (value) => Buffer.from(value, "base64").toString(),
		tracing,
	});
	try {
		assert.equal((await service.initialize()).engineStatus, "ready");
		const saved = await service.saveSettings({ permission: "ask", theme: "light", provider: "deepseek", apiKey: modelKey });
		assert.equal(saved.state?.model?.id, "deepseek-flash");
		const sessionId = saved.active?.id;
		assert.ok(sessionId);
		await prompt(service, userMarker);
		await prompt(service, `${userMarker} second turn`);
		await service.close();
		assert.deepEqual(endpoint.errors, []);
		assert.equal(endpoint.modelRequests.length, 3);
		assert.ok(endpoint.modelRequests[0].includes(userMarker));
		assert.ok(endpoint.modelRequests[1].includes("seed-content"));

		const spans = endpoint.traces.flatMap((item) => item.spans);
		const roots = spans.filter((span) => span.name === "pi.agent-turn");
		assert.equal(roots.length, 2);
		const success = roots.find((span) => attribute(span, "pi.outcome") === "success");
		const failure = roots.find((span) => attribute(span, "pi.outcome") === "error");
		assert.ok(success && failure);
		assert.notEqual(success.traceId, failure.traceId);
		const traceSession = (span: WireSpan) => attribute(span, "session.id") ?? attribute(span, "langfuse.session.id");
		const safeSessionId = traceSession(success);
		assert.match(String(safeSessionId), /^[0-9a-f]{32}$/);
		assert.notEqual(safeSessionId, sessionId);
		assert.equal(traceSession(failure), safeSessionId);
		const children = (root: WireSpan) => spans.filter((span) => span.parentSpanId === root.spanId);
		const generation = children(success).filter((span) => span.name === "pi.model-call");
		const tool = children(success).find((span) => span.name === "pi.tool.read");
		assert.equal(generation.length, 2);
		assert.ok(tool);
		assert.equal(attribute(tool, "langfuse.observation.type"), "tool");
		assert.equal(attribute(tool, "pi.outcome"), "success");
		for (const span of [...generation, tool]) {
			assert.equal(span.traceId, success.traceId);
			assert.ok(BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano));
		}
		for (const span of generation) {
			assert.equal(attribute(span, "langfuse.observation.type"), "generation");
			assert.equal(attribute(span, "gen_ai.provider.name"), "desktop-deepseek");
			assert.equal(attribute(span, "gen_ai.response.model"), "deepseek-flash");
			assert.equal(Number(attribute(span, "gen_ai.usage.input_tokens")), 31);
			assert.equal(Number(attribute(span, "gen_ai.usage.output_tokens")), 7);
			assert.equal(Number(attribute(span, "gen_ai.usage.cache_read.input_tokens")), 17);
			assert.deepEqual(JSON.parse(String(attribute(span, "langfuse.observation.usage_details"))),
				{ input: 11, output: 7, input_cached_tokens: 17, input_cache_write_tokens: 3, total: 38 });
			assert.ok(Number(attribute(span, "gen_ai.usage.cost")) > 0);
		}
		const failedGeneration = children(failure).find((span) => span.name === "pi.model-call");
		assert.ok(failedGeneration);
		assert.equal(failedGeneration.traceId, failure.traceId);
		assert.equal(attribute(failedGeneration, "pi.outcome"), "error");
		for (const item of endpoint.traces) {
			assert.equal(item.authorization, `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`);
			for (const hidden of [userMarker, outputMarker, errorMarker, "seed.txt", "seed-content", modelKey, secretKey, sessionId, fixture.project, endpoint.baseUrl])
				assert.ok(!item.body.includes(hidden), "Trace exports must not carry sensitive inputs, outputs, errors, or identifiers");
		}
	} finally {
		await service.close();
	}
});

test("DesktopService sends side question history to the model and exports only the visible exchange", { timeout: 45_000 }, async (t) => {
	const fixture = await createCoreFixture();
	t.after(fixture.cleanup);
	const endpoint = await createEndpoint();
	t.after(endpoint.close);
	const tracing = createPiTracing({ LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey,
		LANGFUSE_BASE_URL: endpoint.baseUrl, LANGFUSE_CAPTURE_CONTENT: "1" }, () => assert.fail("Invalid test tracing configuration"));
	assert.ok(tracing);
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(import.meta.dirname, "../src/permission-extension.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
		providerBaseUrls: { deepseek: endpoint.baseUrl },
		encrypt: (value) => Buffer.from(value).toString("base64"),
		decrypt: (value) => Buffer.from(value, "base64").toString(),
		tracing,
	});
	const question = "fixture side question";
	try {
		assert.equal((await service.initialize()).engineStatus, "ready");
		const saved = await service.saveSettings({ permission: "ask", theme: "light", provider: "deepseek", apiKey: modelKey });
		await prompt(service, userMarker);
		const result = await service.askBtw(question, saved.active?.id);
		assert.equal(result.answer, outputMarker);
	} finally {
		await service.close();
	}
	assert.deepEqual(endpoint.errors, []);
	assert.equal(endpoint.modelRequests.length, 3);
	assert.ok(endpoint.modelRequests[2].includes(userMarker));
	assert.ok(endpoint.modelRequests[2].includes(question));
	const spans = endpoint.traces.flatMap((item) => item.spans);
	const root = spans.find((span) => span.name === "pi.btw");
	assert.ok(root);
	const children = spans.filter((span) => span.parentSpanId === root.spanId);
	assert.deepEqual(children.map((span) => span.name), ["pi.model-call"]);
	for (const span of [root, ...children]) {
		assert.equal(attribute(span, "langfuse.observation.input"), JSON.stringify([{ role: "user", content: question }]));
		assert.equal(attribute(span, "langfuse.observation.output"), JSON.stringify([{ role: "assistant", content: outputMarker }]));
		assert.ok(!JSON.stringify(span).includes(userMarker));
	}
});
