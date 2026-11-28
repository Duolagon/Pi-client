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

test("the ultracode keyword must stand alone among Latin text; Chinese may touch it", async () => {
	const { ultracodeKeywordRanges, mentionsUltracode } = await import("../src/coding-tier.ts");
	assert.deepEqual(ultracodeKeywordRanges("ultracode 审查这个仓库"), [[0, 9]]);
	assert.deepEqual(ultracodeKeywordRanges("请用ultracode做"), [[2, 11]]);
	assert.deepEqual(ultracodeKeywordRanges("Ultracode! and ULTRACODE"), [[0, 9], [15, 24]]);
	assert.equal(mentionsUltracode("用 ultracode."), true, "a sentence may end with it");
	for (const text of ["/ultracode on", "ultracode-ish", "myultracode", "src/ultracode/x.ts", "foo.ultracode", "see ultracode.ts", "@ultracode.md"])
		assert.equal(mentionsUltracode(text), false, text);
});

test("tier spans open and close once and answer which prompts ran on ultracode", async () => {
	const { recordTierSpan, ranOnUltracode } = await import("../src/coding-tier.ts");
	let spans = recordTierSpan(undefined, true, 10);
	assert.deepEqual(recordTierSpan(spans, true, 15), spans, "an open span is not reopened");
	spans = recordTierSpan(spans, false, 20);
	assert.deepEqual(spans, [{ from: 10, to: 20 }]);
	assert.deepEqual(recordTierSpan(spans, false, 25), spans, "a closed span is not closed again");
	assert.equal(ranOnUltracode(spans, 10), true);
	assert.equal(ranOnUltracode(spans, 21), false);
	assert.equal(ranOnUltracode(recordTierSpan(spans, true, 30), 99), true, "an open span covers everything after it");
	assert.equal(recordTierSpan(Array.from({ length: 300 }, (_, i) => ({ from: i, to: i })), true, 400).length, 200);
});

test("a prompt that says ultracode runs that one turn on ultracode and then returns to standard", { timeout: 20000 }, async () => {
	const fixture = await createCoreFixture();
	const service = new DesktopService({
		dataDir: fixture.dataDir, executable: process.execPath, entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		workflowWorker: resolve(here, "../src/workflow-worker-entry.ts"),
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
	});
	try {
		const snapshot = await service.initialize();
		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		const id = snapshot.active!.id;
		const tierFile = async () => {
			const name = (await readdir(fixture.dataDir)).find((file) => file.startsWith(`tier-${id}-`) && file.endsWith(".md"));
			return readFile(join(fixture.dataDir, name!), "utf8");
		};
		const events: { conversationId: string; event: { type: string } }[] = [];
		service.subscribe((packet) => events.push(packet as never));
		const settled = async (count: number) => {
			for (let i = 0; i < 400 && events.filter((p) => p.conversationId === id && p.event.type === "agent_settled").length < count; i++)
				await new Promise((done) => setTimeout(done, 25));
		};
		const before = Date.now();
		await service.command({ type: "prompt", message: "用 ultracode 审查一下" }, id);
		await settled(1);
		await new Promise((done) => setTimeout(done, 200));
		const after = await service.snapshot();
		assert.equal(after.active?.codingTier, undefined, "the standing tier is unchanged");
		assert.equal(after.active?.turnTier, undefined, "the keyword turn ends when it settles");
		assert.match(await tierFile(), /standard tier/, "the prompt section returns to standard");
		const spans = after.active?.ultracodeTurns ?? [];
		assert.equal(spans.length, 1);
		assert.ok(spans[0].from >= before && spans[0].to !== undefined, "the turn's span is recorded and closed");

		// While a keyword turn runs, workflow budgets follow ultracode.
		const runtime = (service as never as { runtimes: Map<string, { turnTier?: string }> }).runtimes.get(id)!;
		runtime.turnTier = "ultracode";
		const wf = await service.startWorkflow(id, { script: "return 1;", budget: { maxAgents: 90 } });
		assert.equal(wf.budget.maxAgents, 90);
		runtime.turnTier = undefined;
		const capped = await service.startWorkflow(id, { script: "return 1;", budget: { maxAgents: 90 } });
		assert.equal(capped.budget.maxAgents, WORKFLOW_LIMITS.standard.maxAgents);

		// A plain prompt adds no span.
		await service.command({ type: "prompt", message: "普通的一轮" }, id);
		await settled(2);
		assert.equal((await service.snapshot()).active?.ultracodeTurns?.length, 1);

		// A slash command that mentions the word is not the keyword.
		await service.command({ type: "prompt", message: "/no-such-command ultracode" }, id).catch(() => {});
		await new Promise((done) => setTimeout(done, 300));
		assert.equal(runtime.turnTier, undefined);

		// Switching the standing tier off during a keyword turn closes its span and ends the turn.
		const internal = service as never as { setTurnTier(runtime: unknown, tier?: string): Promise<void> };
		await internal.setTurnTier(runtime, "ultracode");
		assert.equal((await service.snapshot()).active?.ultracodeTurns?.at(-1)?.to, undefined);
		await service.updateConversationMeta(id, { codingTier: "ultracode" });
		await service.updateConversationMeta(id, { codingTier: "standard" });
		const closed = (await service.snapshot()).active!;
		assert.equal(runtime.turnTier, undefined);
		assert.ok(closed.ultracodeTurns!.every((span) => span.to !== undefined), "no span is left open");
		assert.match(await tierFile(), /standard tier/);
	} finally {
		await service.close();
		await fixture.cleanup();
	}
});
