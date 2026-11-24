import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { wrapDesktopWorkspaceContext } from "../src/file-references.ts";
import { createPiTracing } from "../src/langfuse-tracing.ts";
import type { DesktopEvent } from "../src/shared.ts";

const userText = "fixture-visible-user-prompt";
const firstAnswer = "fixture-visible-model-preamble";
const finalAnswer = "fixture-visible-model-answer";
const fakeToken = "sk-lf-10000000-0000-4000-8000-000000000001";
const workspaceText = "fixture-hidden-workspace-appendix";
const attachment = "Zml4dHVyZS1oaWRkZW4tYXR0YWNobWVudA==";
const thinking = "fixture-hidden-model-thinking";
const toolArgument = "fixture-hidden-tool-argument.txt";
const toolResult = "fixture-hidden-tool-result";

interface WireSpan {
	name: string;
	spanId: string;
	parentSpanId?: string;
	attributes: { key: string; value: { stringValue?: string } }[];
}

function attribute(span: WireSpan, key: string): string | undefined {
	return span.attributes.find((item) => item.key === key)?.value.stringValue;
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant", content, stopReason, api: "openai-completions", provider: "fixture", model: "fixture-model",
		timestamp: Date.now(), usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

async function collectRun(captureContent?: string): Promise<{ spans: WireSpan[]; body: string }> {
	const bodies: string[] = [];
	const spans: WireSpan[] = [];
	const errors: unknown[] = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.url, "/api/public/otel/v1/traces");
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const buffer = Buffer.concat(chunks);
			const body = (request.headers["content-encoding"] === "gzip" ? gunzipSync(buffer) : buffer).toString();
			const data = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[] };
			bodies.push(body);
			spans.push(...data.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)));
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		} catch (error) {
			errors.push(error);
			response.writeHead(400).end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const tracing = createPiTracing({
			LANGFUSE_PUBLIC_KEY: "pk-local-content-fixture",
			LANGFUSE_SECRET_KEY: "sk-local-content-fixture",
			LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
			...(captureContent === undefined ? {} : { LANGFUSE_CAPTURE_CONTENT: captureContent }),
		}, () => assert.fail("Invalid tracing fixture configuration"));
		assert.ok(tracing);
		const observe = (event: DesktopEvent["event"]) => tracing.observe("fixture-run", event, "fixture-session");
		const prompt: UserMessage = { role: "user", timestamp: Date.now(), content: [
			{ type: "text", text: `${userText} ${fakeToken}` },
			{ type: "text", text: wrapDesktopWorkspaceContext(workspaceText) },
			{ type: "image", data: attachment, mimeType: "image/png" },
		] };
		const initial = assistantMessage([
			{ type: "thinking", thinking },
			{ type: "text", text: firstAnswer },
			{ type: "toolCall", id: "local-tool-call", name: "read", arguments: { path: toolArgument } },
		], "toolUse");
		const final = assistantMessage([{ type: "text", text: finalAnswer }], "stop");
		try {
			observe({ type: "agent_start" });
			observe({ type: "turn_start" });
			observe({ type: "message_start", message: prompt });
			observe({ type: "message_end", message: prompt });
			observe({ type: "message_end", message: initial });
			observe({ type: "tool_execution_start", toolCallId: "local-tool-call", toolName: "read", args: { path: toolArgument } });
			observe({ type: "tool_execution_end", toolCallId: "local-tool-call", toolName: "read", result: toolResult, isError: false });
			observe({ type: "turn_start" });
			observe({ type: "message_end", message: final });
			observe({ type: "agent_end", messages: [prompt, initial, final], willRetry: false });
			observe({ type: "agent_settled", aborted: false });
		} finally {
			await tracing.close();
		}
		assert.deepEqual(errors, []);
		return { spans, body: bodies.join("\n") };
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
			server.closeAllConnections();
		});
	}
}

function rootAndGenerations(spans: WireSpan[]) {
	const root = spans.find((span) => span.name === "pi.agent-turn");
	assert.ok(root);
	const generations = spans.filter((span) => span.name === "pi.model-call");
	assert.equal(generations.length, 2);
	for (const generation of generations) assert.equal(generation.parentSpanId, root.spanId);
	return { root, generations };
}

const input = "langfuse.observation.input";
const output = "langfuse.observation.output";

test("Langfuse leaves observation inputs and outputs disabled by default", { timeout: 20_000 }, async () => {
	const { spans, body } = await collectRun();
	rootAndGenerations(spans);
	for (const span of spans) {
		assert.equal(attribute(span, input), undefined);
		assert.equal(attribute(span, output), undefined);
	}
	for (const text of [userText, firstAnswer, finalAnswer, fakeToken, workspaceText, attachment, thinking, toolArgument, toolResult]) {
		assert.ok(!body.includes(text), `Unexpected trace content: ${text}`);
	}
});

test("Langfuse captures recent visible messages when opted in and excludes private content", { timeout: 20_000 }, async () => {
	const { spans, body } = await collectRun("1");
	const { root, generations } = rootAndGenerations(spans);
	const rootInput = attribute(root, input);
	const rootOutput = attribute(root, output);
	assert.ok(rootInput && rootOutput);
	assert.ok(rootInput.includes(userText));
	assert.ok(rootOutput.includes(finalAnswer));
	const first = generations.find((span) => attribute(span, output)?.includes(firstAnswer));
	const second = generations.find((span) => attribute(span, output)?.includes(finalAnswer));
	assert.ok(first && second);
	assert.match(attribute(first, output) ?? "", /\bread\b/);
	const firstInput = JSON.parse(attribute(first, input) ?? "[]") as { role: string }[];
	const secondInput = JSON.parse(attribute(second, input) ?? "[]") as { role: string }[];
	assert.ok(firstInput.some((message) => message.role === "user" && JSON.stringify(message).includes(userText)));
	assert.ok(secondInput.some((message) => message.role === "user" && JSON.stringify(message).includes(userText)));
	assert.ok(secondInput.some((message) => message.role === "assistant" && JSON.stringify(message).includes(firstAnswer)));
	for (const text of [fakeToken, workspaceText, attachment, thinking, toolArgument, toolResult]) {
		assert.ok(!body.includes(text), `Unexpected trace content: ${text}`);
	}
});
