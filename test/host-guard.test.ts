import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	HostResourceGuard,
	buildSafeComputeEnv,
	parsePsGroupRss,
	resolveMaxRssBytes,
	resolveNiceCommand,
} from "../src/host-guard.ts";
import { createGuardedBashOperations } from "../src/host-guard-bash.ts";

test("resolveNiceCommand wraps commands with /usr/bin/nice on Unix without double wrapping", () => {
	if (process.platform === "win32") return;
	const wrapped = resolveNiceCommand("/bin/bash", ["-c", "echo hi"], 10);
	assert.equal(wrapped.command, "/usr/bin/nice");
	assert.deepEqual(wrapped.args, ["-n", "10", "/bin/bash", "-c", "echo hi"]);
	const already = resolveNiceCommand("/usr/bin/nice", ["-n", "5", "ls"], 10);
	assert.equal(already.command, "/usr/bin/nice");
	assert.deepEqual(already.args, ["-n", "5", "ls"]);
});

test("buildSafeComputeEnv sets safe defaults without overriding explicit user values", () => {
	const env = buildSafeComputeEnv(
		{ OMP_NUM_THREADS: "2", PATH: "/usr/bin" },
		{ cpuCount: 15, totalMemBytes: 24 * 1024 * 1024 * 1024 },
	);
	assert.equal(env.OMP_NUM_THREADS, "2");
	assert.equal(env.OPENBLAS_NUM_THREADS, "13");
	assert.equal(env.PI_MAX_WORKERS, "13");
	assert.equal(Number(env.PI_MAX_MEMORY_MB), Math.floor(24 * 1024 * 0.55));
});

test("resolveMaxRssBytes honors PI_DESKTOP_MAX_BASH_RSS_MB override and 0 disable", () => {
	const total = 16 * 1024 * 1024 * 1024;
	assert.equal(resolveMaxRssBytes(total, { PI_DESKTOP_MAX_BASH_RSS_MB: "0" }), 0);
	assert.equal(resolveMaxRssBytes(total, { PI_DESKTOP_MAX_BASH_RSS_MB: "2048" }), 2048 * 1024 * 1024);
	assert.equal(resolveMaxRssBytes(total, {}), Math.floor(total * 0.55));
});

test("parsePsGroupRss sums RSS across processes sharing a process group", () => {
	const map = parsePsGroupRss("  101 100 1024\n  102 100 2048\n  205 200 512\n");
	assert.equal(map.get(100), 3072 * 1024);
	assert.equal(map.get(200), 512 * 1024);
});

test("HostResourceGuard kills the heaviest group on RSS cap breach and critical pressure", async () => {
	const GB = 1024 * 1024 * 1024;
	const killed: Array<{ pgid: number; reason: string }> = [];
	let rssMap = new Map<number, number>([
		[1000, 2 * GB],
		[2000, 7 * GB],
	]);
	let pressure = 1;
	const guard = new HostResourceGuard({
		pollMs: 60_000,
		totalMemBytes: 16 * GB,
		maxRssBytes: 8 * GB,
		sampleGroupRss: async () => rssMap,
		sampleMemoryPressure: async () => pressure,
		killGroup: (pgid) => killed.push({ pgid, reason: "killed" }),
	});
	const reasons: string[] = [];
	guard.register(1000, { label: "small", onKill: (r) => reasons.push(`1000:${r}`) });
	guard.register(2000, { label: "heavy", onKill: (r) => reasons.push(`2000:${r}`) });

	// Combined RSS = 9 GB > 8 GB cap -> must kill heaviest (2000), leave 1000 alone
	const tripped1 = await guard.checkNow();
	assert.equal(tripped1, true);
	assert.deepEqual(killed.map((k) => k.pgid), [2000]);
	assert.equal(reasons.length, 1);
	assert.match(reasons[0], /^2000:\[Host Safety Guard\]/);

	// Remaining 1000 is 2 GB (< 20% of 16 GB = 3.2 GB): critical pressure should NOT kill innocent tiny process
	rssMap = new Map([[1000, 2 * GB]]);
	pressure = 4;
	assert.equal(await guard.checkNow(), false);

	// If 1000 grows to 4 GB (>= 20% of 16 GB) under critical pressure, kill it
	rssMap = new Map([[1000, 4 * GB]]);
	assert.equal(await guard.checkNow(), true);
	assert.deepEqual(killed.map((k) => k.pgid), [2000, 1000]);
	guard.stop();
});

test("createGuardedBashOperations runs commands at nice>=10 and cleans up on abort", async () => {
	if (process.platform === "win32") return;
	const ops = createGuardedBashOperations({ niceValue: 10 });
	let out = "";
	const res = await ops.exec("ps -o nice= -p $$", tmpdir(), {
		onData: (buf) => {
			out += buf.toString("utf8");
		},
	});
	assert.equal(res.exitCode, 0);
	assert.ok(Number(out.trim()) >= 10, `expected nice >= 10, got ${out.trim()}`);

	// Abort kills a long-running sleep cleanly
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 120);
	await assert.rejects(
		ops.exec("sleep 30", tmpdir(), { onData: () => {}, signal: controller.signal }),
		/aborted/,
	);
});
