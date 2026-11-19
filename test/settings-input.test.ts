import assert from "node:assert/strict";
import { test } from "node:test";
import { parseForegroundMinutes } from "../src/renderer/settings-input.ts";

test("the foreground wait field rejects an empty value instead of saving 0 (wait without limit)", () => {
	for (const value of ["", "   ", "-1", "1.5", "1e2", "1441", "abc", "0x10"]) assert.equal(parseForegroundMinutes(value), undefined, JSON.stringify(value));
	assert.equal(parseForegroundMinutes("0"), 0);
	assert.equal(parseForegroundMinutes(" 5 "), 5);
	assert.equal(parseForegroundMinutes("1440"), 1440);
});
