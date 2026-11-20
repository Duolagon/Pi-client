import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelRoutingUpdate, sanitizeModelRouting } from "../src/model-routing.ts";

test("sanitize keeps only known roles with a well-formed model", () => {
	assert.deepEqual(
		sanitizeModelRouting({
			explore: { provider: " cheap ", id: "flash" },
			plan: { provider: "x" },
			review: "gpt",
			bogus: { provider: "a", id: "b" },
		}),
		{ explore: { provider: "cheap", id: "flash" } },
	);
	assert.equal(sanitizeModelRouting(undefined), undefined);
	assert.equal(sanitizeModelRouting([]), undefined);
	assert.equal(sanitizeModelRouting({ plan: null }), undefined);
});

test("update parsing is strict: unknown roles and bad models throw, null clears", () => {
	assert.deepEqual(parseModelRoutingUpdate({ review: { provider: "o", id: "g" }, plan: null }), { review: { provider: "o", id: "g" } });
	assert.deepEqual(parseModelRoutingUpdate({}), {});
	assert.throws(() => parseModelRoutingUpdate({ coder: { provider: "o", id: "g" } }), /未知的模型路由角色/);
	assert.throws(() => parseModelRoutingUpdate({ explore: { provider: "", id: "g" } }), /格式错误/);
	assert.throws(() => parseModelRoutingUpdate({ explore: { provider: "o", id: "x".repeat(201) } }), /格式错误/);
	assert.throws(() => parseModelRoutingUpdate("explore"), /格式错误/);
});
