import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeSeatbeltSupport } from "../src/sandbox.ts";
import { executeWerewolfProbe, parseWerewolfProbe, werewolfProbeBinding, type WerewolfProbe } from "../src/werewolf-probes.ts";

function plan(input: unknown): WerewolfProbe {
	const parsed = parseWerewolfProbe(input);
	assert.ok(parsed);
	return parsed;
}

function literal(value: unknown) {
	return { literal: value };
}

function exported(exportName: string, args: unknown[] = [], module = "example.ts") {
	return { call: { module, exportName, args } };
}

function behavior(op: string, left: unknown, right: unknown) {
	return { kind: "behavior", op, left, right };
}

async function fixture(callback: (snapshot: string, outside: string) => Promise<void>) {
	const temp = await mkdtemp(join(tmpdir(), "pi-werewolf-probe-"));
	try {
		const snapshot = join(temp, "frozen");
		await mkdir(snapshot);
		const outside = join(temp, "outside.txt");
		await writeFile(outside, "fixture marker");
		await callback(snapshot, outside);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

test("werewolf probe schema rejects expressions without real calls or outside the snapshot", () => {
	assert.equal(parseWerewolfProbe(behavior("different", literal("fabricated"), literal("fabricated"))), undefined);
	assert.equal(parseWerewolfProbe(behavior("different", exported("round"), exported("round"))), undefined);
	assert.equal(parseWerewolfProbe(behavior("equal", exported("read", [], "../outside.ts"), literal(true))), undefined);
	assert.equal(parseWerewolfProbe(behavior("equal", exported("read", [], "/etc/passwd"), literal(true))), undefined);
	assert.equal(parseWerewolfProbe(behavior("equal", exported("read", [], "C:\\somewhere.ts"), literal(true))), undefined);
	assert.equal(parseWerewolfProbe(behavior("equal", { pick: { from: exported("read"), path: ["__proto__"] } }, literal(true))), undefined);
	assert.equal(parseWerewolfProbe({ kind: "source", file: ".env", exact: "key" }), undefined);
	assert.equal(parseWerewolfProbe({ kind: "source", file: "example.ts", exact: "key", shell: "node" }), undefined);
});

test("werewolf results need a binding to the actual original claim and probed output", () => {
	const collision = plan(behavior("different", exported("encode", [literal("one")]), exported("encode", [literal("two")])));
	assert.equal(werewolfProbeBinding(collision, "encode creates collision-free keys."), true);
	assert.equal(werewolfProbeBinding(collision, "reencode creates collision-free keys."), false);
	assert.equal(werewolfProbeBinding(collision, "encode cannot promise collision-free keys."), false);
	assert.equal(werewolfProbeBinding(collision, "encode 保留了输入历史。"), false);
	assert.equal(werewolfProbeBinding(collision, "encode 已导出。", "要求 encode 无损。"), false);
	const unrelated = plan(behavior("different", exported("encode", [literal("one")]), exported("other", [literal("two")])));
	assert.equal(werewolfProbeBinding(unrelated, "encode and other each create collision-free keys."), false);

	const actual = exported("total", [literal([5, 2])]);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(7))), "total 返回 7。"), true);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(99))), "total 返回 7。"), false);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(7))), "total 不返回 7。"), false);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(7))), "total 返回 7 或 9。"), false);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(1))), "total 返回 1e20。"), false);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", exported("total", [literal(3)]), literal(7))), "total(2) 返回 7。"), false);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", actual, literal(7))), "total 在空列表时返回 7。"), false);
	const wrongTime = plan(behavior("equal", exported("overlap", [literal(1), literal(2)]), literal(false)));
	assert.equal(werewolfProbeBinding(wrongTime, "overlap 对开始时间等于结束时间的区间返回 false。"), false);

	const left = exported("format", [literal({ data: "fixed", prior: "old value" })]);
	const right = exported("format", [literal({ data: "fixed", prior: "new value" })]);
	const unrelatedRight = exported("format", [literal({ data: "different", prior: "old value" })]);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", left, right)), "format is independent of prior."), true);
	assert.equal(werewolfProbeBinding(plan(behavior("equal", left, unrelatedRight)), "format is independent of prior."), false);
});

test("werewolf source observation locates the literal without handing out a behavioral verdict", async () => {
	await fixture(async (snapshot, outside) => {
		await writeFile(join(snapshot, "example.ts"), "// Header\nexport function double(i: number) { return i * 2 }\n");
		await symlink(outside, join(snapshot, "redirect.ts"));
		const evidence = await executeWerewolfProbe(snapshot, plan({ kind: "source", file: "example.ts", exact: "return i * 2" }));
		assert.equal(evidence.status, "unverified");
		assert.equal(evidence.source, "example.ts:2");
		assert.equal(evidence.actual, "return i * 2");
		const redirected = await executeWerewolfProbe(snapshot, plan({ kind: "source", file: "redirect.ts", exact: "fixture marker" }));
		assert.equal(redirected.status, "unverified");
		assert.equal(redirected.actual, undefined);
	});
});

test("werewolf sandbox runs independently proposed TypeScript probes and replays an input collision", async (t) => {
	if (!(await probeSeatbeltSupport()).supported) return t.skip("A strict execution sandbox is unavailable");
	await fixture(async (snapshot) => {
		await writeFile(join(snapshot, "example.ts"), [
			"export function encode(a: string, b: string) { return { key: a + ':' + b } }",
			"export function decode(v: string) { return v.split(':') }",
		].join("\n"));
		const actualKey = (a: string, b: string) => ({ pick: { from: exported("encode", [literal(a), literal(b)]), path: ["key"] } });
		const collision = plan(behavior("different", actualKey("alpha:beta", "gamma"), actualKey("alpha", "beta:gamma")));
		const result = await executeWerewolfProbe(snapshot, collision);
		assert.equal(result.status, "contradicted", JSON.stringify(result));
		assert.match(result.actual ?? "", /alpha:beta:gamma/);
		assert.deepEqual(JSON.parse(result.reproduction ?? "{}"), collision);
		const roundTrip = plan(behavior("equal", exported("decode", [actualKey("alpha", "beta")]), literal(["alpha", "beta"])));
		assert.equal((await executeWerewolfProbe(snapshot, roundTrip)).status, "verified");
	});
});

test("werewolf execution denies live filesystem, environment, and subprocess access and fails closed on unsupported calls", async (t) => {
	if (!(await probeSeatbeltSupport()).supported) return t.skip("A strict execution sandbox is unavailable");
	await fixture(async (snapshot, outside) => {
		await writeFile(join(snapshot, ".env"), "local test marker");
		await writeFile(join(snapshot, "example.ts"), [
			'import { readFileSync, writeFileSync } from "node:fs";',
			'import { spawnSync } from "node:child_process";',
			'function denied(action: () => unknown) { try { action(); return false; } catch { return true; } }',
			'export function isolation(outside: string) {',
			'  return [denied(() => readFileSync(outside)), denied(() => writeFileSync(outside, "modified")),',
			'    denied(() => readFileSync(".env")), denied(() => spawnSync("/usr/bin/true")), process.env.PI_TEST_ONLY_SECRET === undefined];',
			'}',
		].join("\n"));
		const isolation = plan(behavior("equal", exported("isolation", [literal(outside)]), literal([true, true, true, true, true])));
		const result = await executeWerewolfProbe(snapshot, isolation);
		assert.equal(result.status, "verified", JSON.stringify(result));
		assert.equal(await readFile(outside, "utf8"), "fixture marker");
		for (const missing of [exported("unknown"), exported("verify", [], "missing.ts")]) {
			const unverifiable = await executeWerewolfProbe(snapshot, plan(behavior("equal", missing, literal(true))));
			assert.equal(unverifiable.status, "unverified");
		}
	});
});
