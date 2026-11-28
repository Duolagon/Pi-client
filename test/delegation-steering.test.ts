import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildAgentListing, formatAgentListing, parseAgentListing } from "../src/agent-listing.ts";
import { BUNDLED_SKILLS, bundledSkillFile } from "../src/skill-registry.ts";
import toolControl from "../src/tool-control-extension.ts";
import { deferredSpecialistTools } from "../src/tool-control-types.ts";
import { ToolHostServer } from "../src/tool-host-server.ts";

/** Register the root conversation's desktop tools and return their definitions and loadout. */
async function rootTools(context: { after: (fn: () => unknown) => void }) {
	const host = new ToolHostServer({ handle: async () => ({ ok: true }) });
	context.after(() => host.close());
	await host.start();
	const registration = host.register("conv-steering");
	const dir = await mkdtemp(join(tmpdir(), "pi-steering-"));
	context.after(() => rm(dir, { recursive: true, force: true }));
	const toolsFile = join(dir, "tools.json");
	await writeFile(toolsFile, JSON.stringify({ overrides: {} }), "utf8");
	const env: Record<string, string> = {
		PI_DESKTOP_TOOLS_DIR: dir,
		PI_DESKTOP_TOOLS_TOKEN: "a".repeat(64),
		PI_DESKTOP_TOOLS_COMMAND: `desktop-tools-${"b".repeat(32)}`,
		PI_DESKTOP_TOOLS_FILE: toolsFile,
		PI_DESKTOP_HOST_URL: registration.url,
		PI_DESKTOP_HOST_TOKEN: registration.token,
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	context.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const definitions = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function>();
	let active = ["read", "bash", "edit", "write", "grep"];
	const all = active.map((name) => ({
		name, description: name, parameters: { type: "object", properties: {} }, exposure: "direct",
		sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
	})) as ToolInfo[];
	toolControl({
		registerTool(definition: ToolDefinition) {
			definitions.set(definition.name, definition);
			all.push({ name: definition.name, description: definition.description, parameters: definition.parameters,
				exposure: definition.exposure ?? "direct",
				sourceInfo: { path: "/runtime/tool-control.mjs", source: "extension", scope: "temporary", origin: "top-level" } } as ToolInfo);
			if (definition.defaultActive !== false) active.push(definition.name);
		},
		registerCommand() {},
		on(event: string, handler: Function) { handlers.set(event, handler); },
		getAllTools: () => all,
		getActiveTools: () => active,
		setActiveTools(next: string[]) { active = [...next]; },
		getSettings: () => ({}),
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI);
	// A prompt that names neither workflows nor pipelines, so no keyword can unlock anything.
	await handlers.get("before_agent_start")!({ messageType: "user", prompt: "重构登录表单的校验逻辑", systemPromptOptions: { sections: {} } }, {});
	return { definitions, hidden: definitions.get("ToolSearch")!.prepareLoadout?.({} as never)?.hiddenDeclarations ?? [] };
}

test("WorkflowRun is declared from the first turn without ToolSearch or a keyword", async (context) => {
	const { definitions, hidden } = await rootTools(context);
	assert.ok(!(deferredSpecialistTools as readonly string[]).includes("WorkflowRun"));
	assert.ok(!hidden.includes("WorkflowRun"), "WorkflowRun must not be hidden behind ToolSearch");
	assert.doesNotMatch(definitions.get("ToolSearch")!.description, /WorkflowRun/);
	// The other specialists stay deferred.
	assert.ok(hidden.includes("CronCreate"));
});

test("delegation tools tell the model when to delegate, how to brief and which patterns exist", async (context) => {
	const { definitions } = await rootTools(context);
	const agent = definitions.get("Agent")!;
	for (const section of ["## When to use", "## How to brief", "## Running and results"]) assert.ok(agent.description.includes(section), section);
	assert.match(agent.description, /only context/);
	assert.match(agent.description, /in ONE message/);
	// The old sentence read as advice against delegating; it is now scoped to small lookups.
	assert.doesNotMatch(agent.description, /^List a directory with ls or find and read a few known files directly\./m);
	const workflow = definitions.get("WorkflowRun")!;
	for (const pattern of ["Adversarial verify", "Judge panel", "Loop until dry", "Completeness critic"]) assert.ok(workflow.description.includes(pattern), pattern);
	// The description promises only what this engine does: phase takes a callback.
	assert.match(workflow.description, /phase\(name, async \(\) => \{\.\.\.\}\)/);
	for (const name of ["Agent", "WorkflowRun", "TodoCreate"]) {
		const definition = definitions.get(name)!;
		assert.ok((definition.promptGuidelines ?? []).length > 0, `${name} needs rules in the system prompt`);
		assert.ok(definition.promptSnippet && !definition.promptSnippet.includes("\n"), `${name} needs a one-line snippet`);
	}
	assert.match(definitions.get("Agent")!.promptGuidelines!.join(" "), /one message/);
});

test("the agent listing states the fan-out limits and keeps old listings readable", () => {
	const definitions = [{ name: "general-purpose", description: "General work", prompt: "", readOnly: false, scope: "builtin" as const }];
	const shallow = formatAgentListing(buildAgentListing(definitions as never, { maxConcurrent: 8, nestedDepth: 0 }));
	assert.match(shallow, /Up to 8 of your subagents run at once/);
	assert.match(shallow, /cannot launch subagents of their own/);
	const nested = formatAgentListing(buildAgentListing(definitions as never, { maxConcurrent: 4, nestedDepth: 2 }));
	assert.match(nested, /may delegate 2 more levels down/);
	// A listing written before limits existed still parses, and renders no limits line.
	const legacy = buildAgentListing(definitions as never);
	assert.equal(legacy.limits, undefined);
	assert.deepEqual(parseAgentListing(JSON.parse(JSON.stringify(legacy))), legacy);
	assert.doesNotMatch(formatAgentListing(legacy), /run at once/);
	// Out-of-range limits are refused rather than rendered into the prompt.
	assert.throws(() => parseAgentListing({ ...legacy, limits: { maxConcurrent: 0, nestedDepth: 0 } }), /Invalid agent listing/);
	assert.throws(() => parseAgentListing({ ...legacy, limits: { maxConcurrent: 4, nestedDepth: 1, extra: 1 } }), /Invalid agent listing/);
});

test("orchestration skills are model-invocable while review skills stay user-invoked", () => {
	for (const name of ["batch", "workflow-authoring"]) {
		const skill = BUNDLED_SKILLS.find((item) => item.name === name)!;
		assert.ok(skill, name);
		assert.equal(skill.disableModelInvocation, undefined, `${name} should be reachable by the model`);
		assert.doesNotMatch(bundledSkillFile(skill), /disable-model-invocation/);
	}
	for (const name of ["code-review", "security-review"])
		assert.equal(BUNDLED_SKILLS.find((item) => item.name === name)?.disableModelInvocation, true, name);
	// The examples use this engine's own API and its determinism rule.
	const authoring = BUNDLED_SKILLS.find((item) => item.name === "workflow-authoring")!.body;
	assert.match(authoring, /phase\('Find', \(\) => parallel/);
	assert.match(authoring, /key: `verify:/);
});
