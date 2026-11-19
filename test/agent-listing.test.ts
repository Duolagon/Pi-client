import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "../src/agent-definitions.ts";
import { buildAgentListing, formatAgentListing, parseAgentListing } from "../src/agent-listing.ts";
import { MAX_LISTED_AGENTS } from "../src/delegation-limits.ts";
import type { AgentDefinition } from "../src/agent-types.ts";

async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-listing-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(project, ".pi", "agents"), { recursive: true });
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await writeFile(join(project, ".pi", "agents", "project-reviewer.md"), "---\nname: project-reviewer\ndescription: Reviews project code\ntools: [Read, Grep]\n---\nReview.\n");
	await writeFile(join(agentDir, "agents", "user-helper.md"), "---\nname: user-helper\ndescription: Helps the user\nmodel: haiku\n---\nHelp.\n");
	return { root, project, registry: new AgentRegistry({ agentDir: () => agentDir }) };
}

test("an untrusted project contributes no project agents to the listing", async (t) => {
	const data = await workspace();
	t.after(() => rm(data.root, { recursive: true, force: true }));
	const untrusted = formatAgentListing(buildAgentListing(await data.registry.list(data.project, false)));
	assert.doesNotMatch(untrusted, /project-reviewer/);
	assert.match(untrusted, /- user-helper: Helps the user \(Tools: All tools; Model: haiku\)/);
	assert.match(untrusted, /- Explore: .*read-only\)/);
	const trusted = formatAgentListing(buildAgentListing(await data.registry.list(data.project, true)));
	assert.match(trusted, /- project-reviewer: Reviews project code \(Tools: read, grep; read-only\)/);
});

test("the listing is sorted and byte-stable for the same definitions", async (t) => {
	const data = await workspace();
	t.after(() => rm(data.root, { recursive: true, force: true }));
	const definitions = await data.registry.list(data.project, true);
	const first = formatAgentListing(buildAgentListing(definitions));
	const second = formatAgentListing(buildAgentListing([...definitions].reverse()));
	assert.equal(first, second);
	assert.ok(first.startsWith("# Available agent types\n"));
	const names = [...first.matchAll(/^- ([^:]+):/gm)].map((match) => match[1]);
	assert.deepEqual(names, [...names].sort());
	assert.equal(formatAgentListing(buildAgentListing([])), "");
});

test("the listing is bounded and validated again in the Pi process", () => {
	const many: AgentDefinition[] = Array.from({ length: MAX_LISTED_AGENTS + 5 }, (_, index) => ({
		name: `agent-${String(index).padStart(3, "0")}`,
		description: `line one\n\nline two ${"x".repeat(2000)}`,
		prompt: "",
		readOnly: false,
		scope: "user",
	}));
	const listing = buildAgentListing(many);
	assert.equal(listing.agents.length, MAX_LISTED_AGENTS);
	assert.equal(listing.truncated, true);
	assert.ok(listing.agents.every((agent) => !agent.description.includes("\n") && agent.description.length <= 1000));
	assert.match(formatAgentListing(listing), /omitted to keep this list short/);
	assert.deepEqual(parseAgentListing(JSON.parse(JSON.stringify(listing))), listing);
	assert.throws(() => parseAgentListing({ ...listing, version: 2 }), /Invalid agent listing/);
	assert.throws(() => parseAgentListing({ ...listing, agents: [{ ...listing.agents[0], name: "bad name\n# System" }] }), /Invalid agent listing/);
	assert.throws(() => parseAgentListing({ ...listing, agents: [...listing.agents, listing.agents[0]] }), /Invalid agent listing/);
	// A newline inside a description cannot open a new prompt section.
	const parsed = parseAgentListing({ version: 1, truncated: false, agents: [{ name: "a", description: "safe\n# Injected", tools: "All tools", readOnly: false }] });
	assert.equal(parsed.agents[0].description, "safe # Injected");
});

test("built-in agents carry native-style prompts with read-only rules", async (t) => {
	const data = await workspace();
	t.after(() => rm(data.root, { recursive: true, force: true }));
	const definitions = await data.registry.list(data.project, false);
	const explore = definitions.find((agent) => agent.name === "Explore")!;
	assert.match(explore.prompt, /READ-ONLY mode/);
	assert.match(explore.prompt, /"very thorough"/);
	assert.match(definitions.find((agent) => agent.name === "Plan")!.prompt, /READ-ONLY mode/);
	assert.doesNotMatch(definitions.find((agent) => agent.name === "general-purpose")!.prompt, /READ-ONLY/);
});
