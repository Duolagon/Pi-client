import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { codingTierPromptSection, WORKFLOW_LIMITS, workflowBudgetFor } from "../src/coding-tier.ts";
import { registerCodingTier } from "../src/permission-extension.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("workflow budgets are clamped to the tier ceiling and filled in when absent", () => {
	assert.deepEqual(workflowBudgetFor("standard", undefined), WORKFLOW_LIMITS.standard);
	assert.deepEqual(workflowBudgetFor("ultracode", undefined), WORKFLOW_LIMITS.ultracode);
	assert.deepEqual(workflowBudgetFor("standard", { maxAgents: 100, maxCost: 50 }), WORKFLOW_LIMITS.standard);
	assert.deepEqual(workflowBudgetFor("ultracode", { maxAgents: 6.7, maxCost: 0.2, maxTokens: 5000 }), { maxAgents: 6, maxCost: 0.2, maxTokens: 5000 });
	// Junk values fall back to the ceiling instead of lifting it.
	assert.deepEqual(workflowBudgetFor("standard", { maxAgents: -1, maxCost: Number.NaN, maxTokens: "9" }), WORKFLOW_LIMITS.standard);
	assert.ok(WORKFLOW_LIMITS.standard.maxAgents < WORKFLOW_LIMITS.ultracode.maxAgents);
});

test("the tier prompt keeps orchestration opt-in on standard and standing on ultracode", () => {
	const standard = codingTierPromptSection(undefined);
	assert.match(standard, /standard tier/);
	assert.match(standard, /Use WorkflowRun only when the user asks/);
	assert.match(standard, new RegExp(`${WORKFLOW_LIMITS.standard.maxAgents} agents`));
	const ultra = codingTierPromptSection("ultracode");
	assert.match(ultra, /ultracode tier/);
	assert.match(ultra, /For every substantive task, orchestrate/);
	assert.match(ultra, /adversarially verify/);
	assert.match(ultra, new RegExp(`${WORKFLOW_LIMITS.ultracode.maxAgents} agents`));
	assert.equal(codingTierPromptSection("bogus"), standard);
});

test("registerCodingTier writes the tier file as a prompt section each turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tier-ext-"));
	try {
		const file = join(root, "tier.md");
		type Event = { systemPromptOptions: { sections: Record<string, string> } };
		const handlers: Array<(event: Event) => Promise<unknown>> = [];
		registerCodingTier({ on: (name: string, handler: (event: Event) => Promise<unknown>) => { if (name === "before_agent_start") handlers.push(handler); } } as never, file);
		assert.equal(handlers.length, 1);
		await writeFile(file, codingTierPromptSection("ultracode"));
		const event: Event = { systemPromptOptions: { sections: { other: "x" } } };
		assert.equal(await handlers[0](event), undefined, "never forces a whole system prompt");
		assert.match(event.systemPromptOptions.sections.coding_tier, /ultracode tier/);
		assert.equal(event.systemPromptOptions.sections.other, "x");
		await writeFile(file, "");
		await handlers[0](event);
		assert.equal(event.systemPromptOptions.sections.coding_tier, undefined);
		const none: unknown[] = [];
		registerCodingTier({ on: (...args: unknown[]) => none.push(args) } as never, undefined);
		assert.equal(none.length, 0, "children without a tier file register nothing");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a conversation's tier persists, rewrites the runtime file and clamps workflow budgets", { timeout: 20000 }, async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		workflowWorker: resolve(here, "../src/workflow-worker-entry.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready");
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		const id = snapshot.active!.id;
		const tierFile = async () => {
			const name = (await readdir(fixture.dataDir)).find((file) => file.startsWith(`tier-${id}-`) && file.endsWith(".md"));
			assert.ok(name, "main conversation gets a tier file");
			return readFile(join(fixture.dataDir, name), "utf8");
		};
		assert.match(await tierFile(), /standard tier/);
		const script = "return 1;";
		let workflow = await service.startWorkflow(id, { script, budget: { maxAgents: 90, maxCost: 9 } });
		assert.equal(workflow.budget.maxAgents, WORKFLOW_LIMITS.standard.maxAgents);
		assert.equal(workflow.budget.maxCost, WORKFLOW_LIMITS.standard.maxCost);

		const next = await service.updateConversationMeta(id, { codingTier: "ultracode" });
		assert.equal(next.active?.codingTier, "ultracode");
		assert.match(await tierFile(), /ultracode tier/);
		workflow = await service.startWorkflow(id, { script, budget: { maxAgents: 90, maxCost: 9 } });
		assert.equal(workflow.budget.maxAgents, 90);
		assert.equal(workflow.budget.maxCost, WORKFLOW_LIMITS.ultracode.maxCost);
		const stored = JSON.parse(await readFile(join(fixture.dataDir, "desktop.json"), "utf8"));
		assert.equal(stored.conversations.find((item: { id: string }) => item.id === id).codingTier, "ultracode");

		// A clone keeps the tier, so the runtime it takes over keeps a prompt that matches the picker.
		const events: { conversationId: string; event: { type: string } }[] = [];
		service.subscribe((packet) => events.push(packet as never));
		await service.command({ type: "prompt", message: "hello" }, id);
		for (let i = 0; i < 200 && !events.some((packet) => packet.conversationId === id && packet.event.type === "agent_settled"); i++)
			await new Promise((done) => setTimeout(done, 25));
		const clone = await service.cloneSession({ conversationId: id, title: "tier clone" });
		assert.equal(clone.conversation?.codingTier, "ultracode");
		const moved = (await readdir(fixture.dataDir)).filter((file) => file.startsWith("tier-") && file.endsWith(".md"));
		for (const file of moved) assert.match(await readFile(join(fixture.dataDir, file), "utf8"), /ultracode tier/, "the clone's prompt matches its tier");
		await service.selectConversation(id);

		const back = await service.updateConversationMeta(id, { codingTier: "standard" });
		assert.equal(back.active?.codingTier, undefined);
		assert.match(await tierFile(), /standard tier/);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});

test("crossing the cost cap cancels the workflow's running agents, and resume clamps to a new ceiling", async () => {
	const { WorkflowService } = await import("../src/workflow-service.ts");
	const dir = await mkdtemp(join(tmpdir(), "pi-tier-wf-"));
	const cancelled: string[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((done) => { release = done; });
	const service = new WorkflowService({
		dataDir: () => dir,
		callbacks: {
			workerPath: () => resolve(here, "../src/workflow-worker-entry.ts"),
			permissionMode: () => "auto",
			cancelWorkflowTasks: async (id) => { cancelled.push(id); release(); },
			runAgentStep: async (req) => {
				// The first step finishes expensively; the others hang until the host cancels them.
				if (req.prompt === "a") return { taskId: "t-a", output: "a", usage: { totalTokens: 1, cost: 0.4 } };
				await gate;
				throw new Error("cancelled");
			},
		},
	});
	try {
		const wf = await service.start({
			conversationId: "root", rootConversationId: "root", project: dir,
			input: { script: 'return parallel(["a", "b", "c"].map((p) => () => agent({ prompt: p })));', budget: workflowBudgetFor("standard", { maxCost: 0.3 }) },
		});
		const done = await service.wait(wf.id);
		assert.deepEqual(cancelled.slice(0, 1), [wf.id], "the overshoot cancels the rest");
		assert.ok(done.budget.spentCost >= 0.3);

		const legacy = await service.start({
			conversationId: "root", rootConversationId: "root", project: dir,
			input: { script: "throw new Error('x')", budget: { maxAgents: 100 } },
		});
		await service.wait(legacy.id);
		const resumed = await service.resume(legacy.id, WORKFLOW_LIMITS.standard);
		assert.equal(resumed.budget.maxAgents, WORKFLOW_LIMITS.standard.maxAgents);
		assert.equal(resumed.budget.maxCost, WORKFLOW_LIMITS.standard.maxCost);
		await service.wait(legacy.id);
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});
