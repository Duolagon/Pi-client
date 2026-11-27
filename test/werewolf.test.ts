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
