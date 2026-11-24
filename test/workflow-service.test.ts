import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../src/skill-registry.ts";
import { validateJsonSchema } from "../src/workflow-schema.ts";
import { WorkflowService } from "../src/workflow-service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workerEntryTs = resolve(here, "../src/workflow-worker-entry.ts");

test("a model caller abort revokes the workflow directory hand-off during approval", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-wf-caller-"));
	const caller = new AbortController();
	const service = new WorkflowService({
		dataDir: () => dir,
		callbacks: {
			workerPath: () => workerEntryTs,
			permissionMode: () => "ask",
			runAgentStep: async () => { throw new Error("aborted workflow must not start an agent"); },
		},
	});
	try {
		const workflow = await service.start({
			conversationId: "parent",
			rootConversationId: "parent",
			project: dir,
			input: { script: 'return agent({ prompt: "test" });' },
			callerSignal: caller.signal,
		});
		assert.equal(service.hasWaitingCaller(workflow.id, "parent"), true);
		assert.equal(service.hasWaitingCaller(workflow.id, "another-parent"), false);
		const done = service.wait(workflow.id);
		caller.abort();
		assert.equal(service.hasWaitingCaller(workflow.id, "parent"), false);
		assert.equal((await done).status, "cancelled");
		assert.equal(service.get(workflow.id)?.pendingApproval, undefined);
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("Workflow isolated worker runs parallel/pipeline/phase/budget and blocks Date.now, Math.random, require, import, eval", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-wf-sandbox-"));
	try {
		const calls: string[] = [];
		const service = new WorkflowService({
			dataDir: () => dir,
			callbacks: {
				workerPath: () => workerEntryTs,
				permissionMode: () => "auto",
				runAgentStep: async (req) => {
					calls.push(req.stepKey);
					return {
						taskId: `task_${calls.length}`,
						output: `done:${req.prompt}`,
						usage: { totalTokens: 100, cost: 0.01 },
					};
				},
			},
		});

		try {
			// Verify forbidden APIs fail cleanly inside the isolated VM
			for (const badScript of [
				"return Date.now();",
				"return Math.random();",
				"return require('node:fs');",
				"return eval('1+1');",
				"return new Function('return 1')();",
				"return await import('node:fs');",
				"return typeof process;",
			]) {
				const wf = await service.start({
					conversationId: "root-1",
					rootConversationId: "root-1",
					project: dir,
					input: { title: "forbidden-check", script: badScript },
				});
				const done = await service.wait(wf.id);
				if (badScript === "return typeof process;") {
					assert.equal(done.status, "completed");
					assert.equal(done.result, "undefined");
				} else {
					assert.equal(done.status, "failed", `expected failure for ${badScript}`);
				}
			}

			// Valid workflow exercising phase, parallel, pipeline, log, budget, and agent
			const wf = await service.start({
				conversationId: "root-1",
				rootConversationId: "root-1",
				project: dir,
				input: {
					title: "multi-phase",
					budget: { maxAgents: 5, maxTokens: 1000, maxCost: 1 },
					script: `
						const research = await phase("research", async () => {
							log("starting parallel research");
							return await parallel([
								() => agent({ prompt: "scan A" }),
								() => agent({ prompt: "scan B" }),
							]);
						});
						const finalOut = await phase("synth", async () => {
							const b = await budget();
							return await pipeline(
								research.map((r) => r.output).join("|"),
								async (combined) => (await agent({ prompt: "summarize: " + combined })).output,
								(text) => ({ summary: text, agentsUsed: b.spawnedAgents })
							);
						});
						return finalOut;
					`,
				},
			});
			const done = await service.wait(wf.id);
			assert.equal(done.status, "completed");
			assert.deepEqual(done.result, {
				summary: "done:summarize: done:scan A|done:scan B",
				agentsUsed: 2,
			});
			assert.equal(done.budget.spawnedAgents, 3);
			assert.equal(done.budget.spentTokens, 300);
			assert.deepEqual(
				done.phases.map((p) => [p.name, p.status]),
				[
					["research", "completed"],
					["synth", "completed"],
				],
			);
			assert.ok(done.logs.some((l) => l.message.includes("starting parallel research")));
		} finally {
			await service.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("WorkflowService enforces Once/Always/Deny approval, durable journal replay, and StructuredOutput 5-retry validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-wf-journal-"));
	try {
		let failSecond = true;
		let structuredAttempt = 0;
		const seenSteps: string[] = [];

		const service = new WorkflowService({
			dataDir: () => dir,
			callbacks: {
				workerPath: () => workerEntryTs,
				permissionMode: () => "ask",
				runAgentStep: async (req) => {
					seenSteps.push(req.stepKey);
					if (req.prompt === "step-two" && failSecond) {
						throw new Error("transient step-two failure");
					}
					if (req.schema !== undefined) {
						return { taskId: "task-struct", output: "not json yet", usage: { totalTokens: 10, cost: 0.001 } };
					}
					return { taskId: `t_${seenSteps.length}`, output: `ok:${req.prompt}`, usage: { totalTokens: 50, cost: 0.005 } };
				},
				resumeStructuredStep: async (taskId) => {
					structuredAttempt += 1;
					if (structuredAttempt < 3) {
						return { taskId, output: JSON.stringify({ count: "wrong-type" }), usage: { totalTokens: 10, cost: 0.001 } };
					}
					return {
						taskId,
						structuredOutput: { status: "ok", count: 42 },
						output: JSON.stringify({ status: "ok", count: 42 }),
						usage: { totalTokens: 10, cost: 0.001 },
					};
				},
			},
		});

		try {
			// 1. Deny cancels cleanly
			const deniedWf = await service.start({
				conversationId: "root-a",
				rootConversationId: "root-a",
				project: dir,
				input: { title: "deny-test", script: `return (await agent({ prompt: "x" })).output;` },
			});
			await new Promise((r) => setTimeout(r, 20));
			const reqDeny = service.get(deniedWf.id)?.pendingApproval;
			assert.ok(reqDeny);
			await service.respondApproval(deniedWf.id, reqDeny.id, "deny");
			assert.equal((await service.wait(deniedWf.id)).status, "cancelled");

			// 2. Once approves single run, step 1 commits to journal, step 2 fails -> resume replays step 1!
			const wf = await service.start({
				conversationId: "root-a",
				rootConversationId: "root-a",
				project: dir,
				input: {
					title: "journal-test",
					script: `
						const a = await agent({ prompt: "step-one" });
						const b = await agent({ prompt: "step-two" });
						return [a.output, b.output];
					`,
				},
			});
			await new Promise((r) => setTimeout(r, 20));
			const reqOnce = service.get(wf.id)?.pendingApproval;
			assert.ok(reqOnce);
			await service.respondApproval(wf.id, reqOnce.id, "once");
			const failed = await service.wait(wf.id);
			assert.equal(failed.status, "failed");
			assert.equal(seenSteps.filter((s) => s.includes("#0")).length, 1);

			// Resume with "always" -> step-one must NOT re-execute!
			failSecond = false;
			await service.resume(wf.id);
			await new Promise((r) => setTimeout(r, 20));
			const reqAlways = service.get(wf.id)?.pendingApproval;
			assert.ok(reqAlways);
			await service.respondApproval(wf.id, reqAlways.id, "always");
			const resumed = await service.wait(wf.id);
			assert.equal(resumed.status, "completed");
			assert.deepEqual(resumed.result, ["ok:step-one", "ok:step-two"]);
			assert.equal(seenSteps.filter((s) => s.includes("#0")).length, 1, "journal replay skipped completed step #0");

			// 3. Subsequent workflow on root-a skips approval (due to "always") and exercises StructuredOutput retries!
			const structWf = await service.start({
				conversationId: "root-a",
				rootConversationId: "root-a",
				project: dir,
				input: {
					title: "structured-output",
					script: `
						const res = await agent({
							prompt: "produce stats",
							schema: {
								type: "object",
								properties: { status: { type: "string" }, count: { type: "integer", minimum: 1 } },
								required: ["status", "count"],
								additionalProperties: false
							}
						});
						return res.structuredOutput;
					`,
				},
			});
		const structDone = await service.wait(structWf.id);
			assert.equal(structDone.status, "completed");
			assert.deepEqual(structDone.result, { status: "ok", count: 42 });
			assert.equal(structuredAttempt, 3);

			// 4. StructuredOutput exceeding max 5 retries fails cleanly
			let alwaysBadCount = 0;
			const failingService = new WorkflowService({
				dataDir: () => dir,
				callbacks: {
					workerPath: () => workerEntryTs,
					permissionMode: () => "auto",
					runAgentStep: async () => ({ taskId: "task-bad", output: "bad", usage: { totalTokens: 5, cost: 0 } }),
					resumeStructuredStep: async (taskId) => {
						alwaysBadCount += 1;
						return { taskId, output: "still bad", usage: { totalTokens: 5, cost: 0 } };
					},
				},
			});
			try {
				const badWf = await failingService.start({
					conversationId: "root-b",
					rootConversationId: "root-b",
					project: dir,
					input: {
						title: "fail-after-5",
						script: `return await agent({ prompt: "x", schema: { type: "object", required: ["ok"] } });`,
					},
				});
				const badDone = await failingService.wait(badWf.id);
				assert.equal(badDone.status, "failed");
				assert.match(badDone.error ?? "", /after 5 retries/);
				assert.equal(alwaysBadCount, 5);
			} finally {
				await failingService.close();
			}
		} finally {
			await service.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("StructuredOutput schema validator enforces max 5 retries and /batch bundled skill shadows cleanly", async () => {
	assert.equal(
		validateJsonSchema({ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, { a: "nope" }).valid,
		false,
	);
	assert.equal(
		validateJsonSchema({ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, { a: 7 }).valid,
		true,
	);

	const root = await mkdtemp(join(tmpdir(), "pi-bundled-skill-"));
	try {
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });

		const registry = new SkillRegistry({ agentDir: () => agentDir });
		const withBundled = await registry.list(projectDir, true);
		const batch = withBundled.find((s) => s.name === "batch");
		assert.equal(batch?.scope, "bundled");
		assert.equal(batch?.editable, false);

		// User skill named batch shadows bundled
		await mkdir(join(agentDir, "skills", "batch"), { recursive: true });
		await writeFile(join(agentDir, "skills", "batch", "SKILL.md"), "---\nname: batch\ndescription: Custom batch\n---\ncustom body\n");
		const shadowed = await registry.list(projectDir, true);
		const matches = shadowed.filter((s) => s.name === "batch");
		assert.equal(matches.length, 1);
		assert.equal(matches[0]?.scope, "user");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
