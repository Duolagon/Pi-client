import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWebSearchResults } from "../src/web-search.ts";

test("WebSearch keeps whole results within the total model-output budget", () => {
	const results = Array.from({ length: 50 }, (_, index) => ({
		title: `Result ${index + 1}`,
		url: `https://example.invalid/${index + 1}`,
		snippet: "Summary",
		content: "a".repeat(2000),
	}));
	const output = formatWebSearchResults({ query: "example", total: 50, results });
	assert.ok(output.length <= 24_000);
	assert.match(output, /Result 1\*\*/);
	assert.match(output, /省略后续 \d+ 条结果/);
	assert.doesNotMatch(output, /Result 50\*\*/);
});
