import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentOutputSchema, parseAgentOutputText, validateAgentOutput } from "../src/agent-output-schema.ts";
import { formatTaskNotification } from "../src/delegation-format.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("Agent validates an inline output schema for external executors", () => {
	const output_schema = {
		type: "object", properties: { result: { type: ["integer", "null"] } },
		required: ["result"], additionalProperties: false,
	};
	const input = { description: "Check status", prompt: "Read the result", executor: "kimi", output_schema };
	assert.deepEqual(validateDesktopToolInput("Agent", input), input);
	assert.throws(() => validateDesktopToolInput("Agent", { ...input, executor: "pi" }), /requires an external executor/);
	const schema = parseAgentOutputSchema(output_schema);
	assert.deepEqual(validateAgentOutput(schema, { result: null }), { result: null });
	assert.throws(() => validateAgentOutput(schema, { result: "123" }), /does not match/);
	assert.throws(() => validateAgentOutput(schema, { result: 123, extra: true }), /does not match/);
});

test("schema and payload parsing are bounded and reject unsupported executable constraints", () => {
	assert.throws(() => parseAgentOutputSchema({ properties: { item: { $ref: "#" } } }), /Unsupported keyword/);
	assert.throws(() => parseAgentOutputSchema({ dependencies: { data: { properties: { value: { pattern: "^ok" } } } } }), /Unsupported keyword/);
	assert.throws(() => parseAgentOutputSchema({ type: "number", minimum: "3" }), /Invalid minimum/);
	assert.throws(() => parseAgentOutputSchema({ description: "x".repeat(17000) }), /size limit/);
	assert.throws(() => parseAgentOutputText("x".repeat(50000)), /size limit/);
	assert.deepEqual(parseAgentOutputText('```json\n{"count":1}\n```'), { count: 1 });
});

test("structured task handback preserves the JSON values and closes its tagged envelope once", () => {
	const value = { answer: "</result> & result text" };
	const notice = formatTaskNotification({
		taskId: "external-result", status: "completed", description: "Structured result", turn: 1,
		result: "Plain text", structuredOutput: value,
	});
	const json = notice.content.match(/<result format="json">\n(.*)\n<\/result>/)?.[1];
	assert.ok(json);
	assert.deepEqual(JSON.parse(json), value);
	assert.equal(notice.content.match(/<\/result>/g)?.length, 1);
	assert.deepEqual(notice.details.structured_output, value);
});
