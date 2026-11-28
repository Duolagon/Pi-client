import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWerewolfPrompt, evaluateWerewolfPlan, WerewolfService, werewolfVerdict } from "../src/werewolf.ts";

test("werewolf uses host receipts and keeps unaddressed acceptance and invented quotes out of verdict evidence", async () => {
	const reply = "node --test 的退出码为 0。";
	const input = {
		requirements: ["运行 node --test。确认键盘也能操作。"],
		reply,
		receipts: [{ id: "call-1", command: "node --test", exitCode: 1 }],
	};
	const proposed = {
		claims: [
			{ quote: reply, requirement: "运行 node --test", description: "检查退出码",
				receipt: { id: "call-1", expectedExitCode: 0 }, status: "verified" },
			{ requirement: "确认键盘也能操作", description: "键盘操作" },
			{ quote: "不存在的虚报", description: "发明证据" },
			{ quote: reply, description: "重复声明" },
		],
	};
	const claims = await evaluateWerewolfPlan(input, JSON.stringify(proposed), tmpdir(), AbortSignal.timeout(3000));
	assert.deepEqual(claims.map((claim) => claim.status), ["contradicted", "unverified"]);
	assert.equal(claims[0].evidence?.actual, "1");
	assert.equal(claims[1].quote, undefined);
	assert.equal(werewolfVerdict(claims), "contradicted");
	const otherCode = { claims: [{ quote: reply, description: "解释不一致", receipt: { id: "call-1", expectedExitCode: 1 } }] };
	assert.equal((await evaluateWerewolfPlan(input, JSON.stringify(otherCode), tmpdir(), AbortSignal.timeout(3000)))[0].status, "unverified");
	const mistakenSpan = { ...input, reply: `不能认为 ${reply}` };
	assert.equal((await evaluateWerewolfPlan(mistakenSpan, JSON.stringify(proposed), tmpdir(), AbortSignal.timeout(3000)))
		.some((claim) => claim.status === "contradicted"), false);
	assert.ok(buildWerewolfPrompt(input).includes(JSON.stringify(input)));
});

test("werewolf defaults to enabled and preserves reports and opt-outs across restarts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-werewolf-state-"));
	const service = new WerewolfService(dir);
	try {
		const input = { requirements: ["运行 node --test"], reply: "node --test 的退出码为 0。", receipts: [{ id: "one", command: "node --test", exitCode: 0 }] };
		const messages: string[] = [];
		service.subscribe((state) => messages.push(state.reviews.at(-1)?.status ?? "empty"));
		let planned = 0;
		const materialize = async () => "snapshot-1";
		const plan = async () => {
			planned++;
			return JSON.stringify({ claims: [{ quote: input.reply, description: "命令回执", receipt: { id: "one", expectedExitCode: 0 } }] });
		};
		const reply = { entryId: "assistant-entry", timestamp: 10, checkpointId: "cp1" };
		assert.equal((await service.state("conversation")).enabled, true);
		await Promise.all([service.start("conversation", reply, input, materialize, plan),
			service.start("conversation", reply, input, materialize, plan)]);
		assert.equal(planned, 1);
		assert.deepEqual(messages, ["pending", "verified"]);
		const saved = await readFile(join(dir, "werewolf", "conversation.json"), "utf8");
		assert.ok(saved.includes("snapshot-1"));
		await service.setEnabled("conversation", false);
		const restarted = new WerewolfService(dir);
		assert.equal((await restarted.state("conversation")).enabled, false);
		assert.deepEqual(await restarted.state("conversation"), await service.state("conversation"));
		await restarted.start("conversation", { ...reply, entryId: "next-assistant-entry" }, input, materialize, plan);
		assert.equal(planned, 1);
		assert.deepEqual(await restarted.state("another"), { conversationId: "another", enabled: true, reviews: [] });
		await restarted.close();
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("werewolf records why a code-changing turn was not reviewed, once per reply and only while enabled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-werewolf-skip-"));
	const service = new WerewolfService(dir);
	try {
		const reply = { entryId: "assistant-entry", timestamp: 10, checkpointId: "cp1" };
		await service.recordSkipped("conversation", reply, "最终回复没有文字内容，没有可核验的声明。");
		await service.recordSkipped("conversation", reply, "重复记录不应出现。");
		const reviews = (await service.state("conversation")).reviews;
		assert.equal(reviews.length, 1);
		assert.equal(reviews[0].status, "unverified");
		assert.equal(reviews[0].replyEntryId, "assistant-entry");
		assert.match(reviews[0].error!, /^未核验：最终回复没有文字内容/);
		await service.setEnabled("conversation", false);
		await service.recordSkipped("conversation", { ...reply, entryId: "other" }, "关闭后不记录。");
		assert.equal((await service.state("conversation")).reviews.length, 1);
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("werewolf drops 'not reviewed' notes before real reviews when the history is full", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-werewolf-cap-"));
	const service = new WerewolfService(dir);
	try {
		const input = { requirements: ["运行 node --test"], reply: "node --test 的退出码为 0。", receipts: [{ id: "one", command: "node --test", exitCode: 0 }] };
		const plan = async () => JSON.stringify({ claims: [{ quote: input.reply, description: "命令回执", receipt: { id: "one", expectedExitCode: 0 } }] });
		await service.start("conversation", { entryId: "real", timestamp: 1, checkpointId: "cp" }, input, async () => "rev", plan);
		for (let index = 0; index < 35; index++)
			await service.recordSkipped("conversation", { entryId: `skip-${index}`, timestamp: 2 + index, checkpointId: "cp" }, "回复没有正常结束。");
		const reviews = (await service.state("conversation")).reviews;
		assert.equal(reviews.length, 30);
		assert.ok(reviews.some((item) => item.replyEntryId === "real" && item.status === "verified"));
		assert.equal(reviews.at(-1)?.replyEntryId, "skip-34");
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a planner quote of just the pass clause merges with the host's whole sentence", async () => {
	const evidence = {
		runs: [{ id: "t1", command: "npm test", kind: "test" as const, exitCode: 0, scope: "full" as const, finishedAt: 10, batch: 1, tests: { total: 2, passed: 2, failed: 0 } }],
		writes: [],
	};
	const reply = "修好了 parseList，测试全部通过。";
	const input = { requirements: ["修复 parseList"], reply, receipts: [], evidence };
	const merged = await evaluateWerewolfPlan(input, JSON.stringify({ claims: [{ quote: "测试全部通过", description: "测试结果" }] }), tmpdir(), AbortSignal.timeout(3000));
	assert.deepEqual(merged.map((claim) => [claim.description, claim.status]), [["测试结果", "verified"]]);
	// A short quote that is not itself a pass claim stays its own claim.
	const apart = await evaluateWerewolfPlan(input, JSON.stringify({ claims: [{ quote: "修好了 parseList", description: "改动" }] }), tmpdir(), AbortSignal.timeout(3000));
	assert.deepEqual(apart.map((claim) => claim.description), ["改动", "宿主核对：回复声称检查已通过。"]);
});
