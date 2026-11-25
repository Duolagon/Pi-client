import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePermission } from "../src/permission-policy.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import { isStatusOnlyRequest } from "../src/remote-operation.ts";

const base: RuntimePermissionPolicy = { version: 1, mode: "ask", project: process.cwd(), rules: [], disabledTools: [] };
const inspect = { toolName: "KaggleComputerUse", input: { action: "inspect" } };
const run = { toolName: "KaggleComputerUse", input: { action: "run_all" } };

test("Kaggle computer use marks Run All as a mutation and allows read-only inspection", async () => {
	for (const mode of ["ask", "auto", "read", "plan"] as const) {
		const policy = { ...base, mode };
		assert.equal((await evaluatePermission(policy, inspect)).action, "allow");
		const result = await evaluatePermission(policy, run);
		if (mode === "read" || mode === "plan") assert.equal(result.action, "deny");
		else {
			assert.equal(result.action, "allow");
			assert.equal(result.remoteMutation, true);
		}
	}
	assert.equal((await evaluatePermission({ ...base, dontAsk: true }, run)).action, "deny");
});

test("disabled Kaggle computer use and explicit deny rules prevent browser actions", async () => {
	const deny: RuntimePermissionPolicy = {
		...base, mode: "auto", rules: [{ id: "blocked", scope: "global", tool: "KaggleComputerUse", action: "deny" }],
	};
	assert.equal((await evaluatePermission(deny, run)).action, "deny");
	assert.equal((await evaluatePermission(deny, inspect)).action, "deny");
	assert.equal((await evaluatePermission({ ...base, disabledTools: ["KaggleComputerUse"] }, run)).action, "deny");
	assert.equal(isStatusOnlyRequest("查看 Kaggle 当前 Notebook 的运行状态"), true);
	assert.equal(isStatusOnlyRequest("查看 Kaggle 当前 Notebook 的运行状态，再点击 Run All"), false);
});
