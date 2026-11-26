import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolCallEventResult, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import permissions from "../src/permission-extension.ts";
import { memoryLimit, projectMemoryContext } from "../src/project-memory.ts";

async function setup(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-nested-rules-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const put = async (file: string, body: string) => {
		const path = join(root, file);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
	};
	return { root, put };
}

test("scoped guidance follows touched directories, precedence, local globs, and file access", { timeout: 10000 }, async (t) => {
	const { root, put } = await setup(t);
	await put("packages/AGENTS.md", "SHARED_GUIDANCE");
	await put("packages/alpha/AGENTS.md", "SHADOWED_GUIDANCE");
	await put("packages/alpha/AGENTS.override.md", "ALPHA_GUIDANCE @./private.md");
	await put("packages/alpha/private.md", "DENIED_IMPORT");
	await put("packages/alpha/.claude/CLAUDE.md", "ALPHA_CLAUDE_GUIDANCE");
	await put("packages/alpha/.claude/rules/source.md", "---\npaths: src/**/*.ts\n---\nALPHA_SOURCE_GUIDANCE");
	await put("packages/alpha/.pi/rules/all.md", "ALPHA_ALL_GUIDANCE");
	await put("packages/beta/AGENTS.md", "BETA_GUIDANCE");
	await put("packages/beta/.claude/rules/source.md", "---\npaths: src/**/*.ts\n---\nBETA_SOURCE_GUIDANCE");
	await symlink(join(root, "packages", "beta", "AGENTS.md"), join(root, "packages", "alpha", "CLAUDE.md"));
	const seenRules = new Set<string>();
	const options = { mode: "scoped" as const, seenRules, allowed: async (path: string) => !path.endsWith("private.md") };
	const first = await projectMemoryContext(root, "@packages/alpha/src/api.ts", undefined, [], "", options);
	assert.match(first, /SHARED_GUIDANCE[\s\S]*ALPHA_GUIDANCE[\s\S]*ALPHA_SOURCE_GUIDANCE[\s\S]*ALPHA_ALL_GUIDANCE/);
	assert.match(first, /ALPHA_CLAUDE_GUIDANCE/);
	assert.doesNotMatch(first, /SHADOWED_GUIDANCE|DENIED_IMPORT|BETA_GUIDANCE|BETA_SOURCE_GUIDANCE/);
	assert.equal(await projectMemoryContext(root, "", undefined, ["packages/alpha/src/second.ts"], "", options), "");
	const other = await projectMemoryContext(root, "", undefined, [join(root, "packages/beta/test/readme.md")], "", options);
	assert.match(other, /BETA_GUIDANCE/);
	assert.doesNotMatch(other, /BETA_SOURCE_GUIDANCE|SHARED_GUIDANCE/);
	const base = await projectMemoryContext(root, "@packages/alpha/src/api.ts", undefined, [], "", { mode: "base" });
	assert.doesNotMatch(base, /ALPHA_GUIDANCE|SHARED_GUIDANCE/);
	const denied = await projectMemoryContext(root, "@packages/alpha/src/api.ts", undefined, [], "", {
		mode: "scoped", allowed: async (path) => !path.endsWith("api.ts"),
	});
	assert.equal(denied, "");
});

test("direct edits wait until applicable rules enter a model request, including mixed tool batches", { timeout: 10000 }, async (t) => {
	const { root, put } = await setup(t);
	await put("alpha/AGENTS.md", "ALPHA_RULE_VISIBLE");
	await put("beta/.claude/rules/module.md", "---\npaths: src/**\n---\nBETA_RULE_VISIBLE");
	await put("beta/src/file.ts", "export {};");
	await put("beta/.pi/rules/private.md", "BETA_DENIED_RULE");
	await put("gamma/AGENTS.md", "g".repeat(memoryLimit));
	await put("delta/AGENTS.md", "DELTA_FULL_RULE");
	await put("policy.json", JSON.stringify({
		version: 1, project: root, mode: "auto", disabledTools: [],
		rules: [{ id: "private-rule", scope: "global", action: "deny", tool: "read", path: "beta/.pi/rules/private.md" }],
	}));
	const previous = Object.fromEntries(["PI_DESKTOP_MEMORY_ROOT", "PI_DESKTOP_POLICY_FILE", "PI_DESKTOP_HOST_URL"]
		.map((name) => [name, process.env[name]]));
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	process.env.PI_DESKTOP_MEMORY_ROOT = root;
	process.env.PI_DESKTOP_POLICY_FILE = join(root, "policy.json");
	delete process.env.PI_DESKTOP_HOST_URL;
	const handlers = new Map<string, (event: unknown) => unknown>();
	permissions({
		registerTool() {}, registerProvider() {},
		on(name: string, handler: (event: unknown) => unknown) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI);
	const invokeWrite = (path: string) => handlers.get("tool_call")!({ toolName: "write", input: { path, content: "ok" } });
	const alpha = await invokeWrite("alpha/new.ts") as ToolCallEventResult;
	assert.equal(alpha.block, true);
	assert.match(alpha.reason ?? "", /ALPHA_RULE_VISIBLE/);
	const sibling = await invokeWrite("alpha/sibling.ts") as ToolCallEventResult;
	assert.equal(sibling.block, true);
	assert.doesNotMatch(sibling.reason ?? "", /ALPHA_RULE_VISIBLE/, "deduplicate same-batch rules");
	const beta = await handlers.get("tool_result")!({
		toolName: "read", toolCallId: "beta-read", input: { path: "beta/src/file.ts" },
		content: [{ type: "text", text: "export {};" }], isError: false,
	}) as ToolResultEventResult;
	assert.match(JSON.stringify(beta.content), /BETA_RULE_VISIBLE/);
	assert.doesNotMatch(JSON.stringify(beta.content), /BETA_DENIED_RULE/);
	assert.equal((await invokeWrite("beta/src/file.ts") as ToolCallEventResult).block, true, "a sibling read cannot approve a write in the same batch");
	await handlers.get("context")!({ messages: [
		{ role: "toolResult", content: [{ type: "text", text: alpha.reason }] },
		{ role: "toolResult", content: beta.content },
	] });
	assert.equal(await invokeWrite("alpha/new.ts"), undefined);
	assert.equal(await invokeWrite("beta/src/file.ts"), undefined);
	await handlers.get("context")!({ messages: [] });
	assert.equal((await invokeWrite("alpha/new.ts") as ToolCallEventResult).block, true, "the model must see the rules again after context removal");

	const large = await invokeWrite("gamma/new.ts") as ToolCallEventResult;
	assert.match(large.reason ?? "", /已截断/);
	const deferred = await invokeWrite("delta/new.ts") as ToolCallEventResult;
	assert.match(deferred.reason ?? "", /delta\/AGENTS.md/);
	assert.doesNotMatch(deferred.reason ?? "", /DELTA_FULL_RULE/);
	const readRule = (input: Record<string, unknown>, details?: unknown) => handlers.get("tool_result")!({
		toolName: "read", toolCallId: "manual-rule", input: { path: "delta/AGENTS.md", ...input },
		content: [{ type: "text", text: "DELTA_FULL_RULE" }], details, isError: false,
	});
	const exposeRule = (text: string) => handlers.get("context")!({ messages: [
		{ role: "toolResult", toolCallId: "manual-rule", content: [{ type: "text", text }] },
	] });
	for (const [input, details] of [[{ offset: 2 }, undefined], [{ limit: 1 }, undefined], [{}, { truncation: {} }]] as const) {
		await readRule(input, details);
		await exposeRule("DELTA_FULL_RULE");
		assert.equal((await invokeWrite("delta/new.ts") as ToolCallEventResult).block, true, "partial or truncated reads cannot unlock a write");
	}
	await readRule({});
	await exposeRule("DELTA_PREVIEW");
	assert.equal((await invokeWrite("delta/new.ts") as ToolCallEventResult).block, true, "the model must receive the complete read result");
	await exposeRule("DELTA_FULL_RULE");
	assert.equal(await invokeWrite("delta/new.ts"), undefined);
});
