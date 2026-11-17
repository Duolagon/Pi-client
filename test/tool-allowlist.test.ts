import assert from "node:assert/strict";
import { test } from "node:test";
import { piToolAllowlist } from "../src/backend.ts";

test("custom agent allowlists keep only Pi built-ins and preserve an explicit empty list", () => {
	assert.equal(piToolAllowlist(undefined), undefined);
	assert.deepEqual(piToolAllowlist(["read", "WebFetch", "edit"]), ["read", "edit"]);
	assert.deepEqual(piToolAllowlist(["WebFetch"]), []);
	assert.deepEqual(piToolAllowlist(["powershell"]), ["powershell"]);
});
