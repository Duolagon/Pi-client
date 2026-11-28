import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { checkExecutorCompatibility, discoverExecutors, executablePath, isExternalProvider, validateExecutorInput } from "../src/external-executors.ts";
import { createRegistryExternalAdapter } from "../src/external-registry-adapter.ts";
import { acpExecutorDefinition } from "../src/external-registry.ts";
import type { ExternalSessionOptions } from "../src/external-types.ts";

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-catalog-test-")));
	const env = { PATH: [root, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), CATALOG_LOG: join(root, "launches.jsonl") };
	const executable = join(root, "qwen");
	const source = new URL("./fixtures/fake-kimi-acp.mjs", import.meta.url).href;
	await writeFile(executable, [
		"#!/usr/bin/env node",
		"import { appendFileSync } from 'node:fs';",
		"appendFileSync(process.env.CATALOG_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
		"await import(" + JSON.stringify(source) + ");",
	].join("\n") + "\n", { mode: 0o700 });
	for (const runner of ["npx", "uvx", "npm"]) {
		await writeFile(join(root, runner), "#!/bin/sh\nprintf 'installer invoked\\n' >> \"$CATALOG_LOG\"\nexit 1\n", { mode: 0o700 });
	}
	return {
		root, env, executable, log: env.CATALOG_LOG,
		settings: { "acp-qwen-code": { enabled: true, executable } },
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("catalog resolves an installed CLI by its local command and executes only its registered ACP arguments", async () => {
	const data = await fixture();
	try {
		const detected = await discoverExecutors({}, data.env);
		const qwen = detected.find(({ id }) => id === "acp-qwen-code")!;
		assert.equal(qwen.executable, data.executable);
		assert.equal(qwen.enabled, false, "catalog executors are opt-in");
		assert.equal(qwen.version, "fake-acp 1.0");
		assert.match(qwen.installCommand!, /^npm install --global @qwen-code\/qwen-code@/);
		assert.equal(qwen.capabilities.approvalSemantics, "agent-rules");
		assert.equal(isExternalProvider("acp-unregistered"), false);
		assert.throws(() => validateExecutorInput({ id: "acp-unregistered", executable: data.executable }), /未知执行器/);
		assert.throws(() => validateExecutorInput({ id: qwen.id, args: ["--auto-approve"] }), /未知执行器/);
		await assert.rejects(executablePath(join(data.root, "npx")), /包管理器/);
		assert.deepEqual(validateExecutorInput({ id: qwen.id, enabled: true }), { id: qwen.id, enabled: true });

		const adapter = createRegistryExternalAdapter(qwen.id)!;
		const options: ExternalSessionOptions = {
			executable: qwen.executable!, cwd: data.root, env: data.env,
			policy: { version: 1, project: data.root, mode: "ask", rules: [], disabledTools: [] },
			onEvent: () => {}, onPermission: async () => ({ decision: "deny" }),
		};
		const session = await adapter.open(options);
		try { assert.match((await session.run("verify local catalog")).text, /verify local catalog/); }
		finally { await session.close(); }
		await assert.rejects(adapter.open({ ...options, policy: { ...options.policy, dontAsk: true } }), /dontAsk/);

		const argv = (await readFile(data.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(argv, [["--version"], acpExecutorDefinition(qwen.id)!.acp.args]);
	} finally { await data.cleanup(); }
});

test("an installed but incompatible ACP CLI reports its version and handshake error", async () => {
	const data = await fixture();
	try {
		const executor = (await discoverExecutors(data.settings, data.env)).find(({ id }) => id === "acp-qwen-code")!;
		assert.equal(executor.compatibility, "unverified");
		const checked = await checkExecutorCompatibility(executor, { ...data.env, KIMI_TEST_LOG: join(data.root, "protocol.jsonl") });
		assert.equal(checked.compatibility, "compatible");
		assert.equal(checked.capabilities.continuation, true);
		const noRestore = await checkExecutorCompatibility(executor, { ...data.env, KIMI_TEST_NO_RESTORE: "1" });
		assert.equal(noRestore.compatibility, "compatible");
		assert.equal(noRestore.capabilities.continuation, false);
		const protocol = (await readFile(join(data.root, "protocol.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(protocol.map(({ method }) => method), ["initialize"]);
		const mismatch = await checkExecutorCompatibility(executor, { ...data.env, KIMI_TEST_PROTOCOL: "2" });
		assert.equal(mismatch.available, false);
		assert.equal(mismatch.compatibility, "incompatible");
		assert.equal(mismatch.version, "fake-acp 1.0");
		assert.match(mismatch.error!, /不兼容.*ACP v1/);
		const auth = await checkExecutorCompatibility(executor, { ...data.env, ACP_TEST_AUTH: "1" });
		assert.equal(auth.available, true);
		assert.equal(auth.compatibility, "unverified");
		assert.match(auth.error!, /登录/);
	} finally { await data.cleanup(); }
});

test("a catalog profile can enforce an approval mode named by the CLI", async () => {
	const data = await fixture();
	try {
		const adapter = createRegistryExternalAdapter("acp-goose")!;
		const protocolLog = join(data.root, "goose-protocol.jsonl");
		const session = await adapter.open({
			executable: data.executable, cwd: data.root, env: { ...data.env, ACP_TEST_CATALOG_MODE: "1", KIMI_TEST_LOG: protocolLog },
			policy: { version: 1, project: data.root, mode: "ask", rules: [], disabledTools: [] },
			onEvent: () => {}, onPermission: async () => ({ decision: "deny" }),
		});
		try { await assert.rejects(session.run("auto-mode"), /changed to an unattended mode/); }
		finally { await session.close(); }
		const protocol = (await readFile(protocolLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(protocol.find(({ method }) => method === "session/set_mode").params.modeId, "approve");
	} finally { await data.cleanup(); }
});
