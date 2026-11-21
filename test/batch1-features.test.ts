import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService, networkEnvironment, validateHeaders, validateKeyCommand, validateProxyUrl } from "../src/backend.ts";
import { HooksService } from "../src/hooks-service.ts";
import { escapeConfigValue, sessionCost } from "../src/permission-extension.ts";
import { BUNDLED_SKILLS, SkillRegistry, bundledSkillFile } from "../src/skill-registry.ts";
import { mergeNetworkEnvironment, parseShellEnvironment } from "../src/tool-path.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { createModelEndpoint } from "./fixtures/model-endpoint.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

function cipher() {
	const key = randomBytes(32);
	return {
		encrypt: (value: string) => {
			const nonce = randomBytes(12);
			const c = createCipheriv("aes-256-gcm", key, nonce);
			const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
			return Buffer.concat([nonce, c.getAuthTag(), encrypted]).toString("base64");
		},
		decrypt: (value: string) => {
			const bytes = Buffer.from(value, "base64");
			const d = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			d.setAuthTag(bytes.subarray(12, 28));
			return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString("utf8");
		},
	};
}

test("bundled review skills are listed, loadable by Pi and shadowed by user skills", async () => {
	const names = BUNDLED_SKILLS.map((skill) => skill.name);
	for (const name of ["code-review", "security-review", "simplify", "review"]) assert.ok(names.includes(name), name);
	const review = BUNDLED_SKILLS.find((skill) => skill.name === "code-review")!;
	const file = bundledSkillFile(review);
	assert.match(file, /^---\nname: code-review\ndescription: ".+"\ndisable-model-invocation: true\n---\n/);
	const root = await mkdtemp(join(tmpdir(), "pi-batch1-skill-"));
	try {
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "skills", "simplify"), { recursive: true });
		await writeFile(join(agentDir, "skills", "simplify", "SKILL.md"), "---\nname: simplify\ndescription: Mine\n---\nmine\n");
		const listed = await new SkillRegistry({ agentDir: () => agentDir }).list(undefined, false);
		assert.equal(listed.filter((skill) => skill.name === "simplify").length, 1);
		assert.equal(listed.find((skill) => skill.name === "simplify")?.scope, "user");
		assert.equal(listed.find((skill) => skill.name === "security-review")?.scope, "bundled");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("proxy settings validate URLs and produce both upper and lower case variables", () => {
	assert.equal(validateProxyUrl("  "), undefined);
	assert.equal(validateProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
	assert.throws(() => validateProxyUrl("socks5://127.0.0.1:1080"), /http/);
	assert.throws(() => validateProxyUrl("not a url"), /格式错误/);
	assert.throws(() => validateProxyUrl("http://user:secret@proxy.test:8080"), /用户名或密码/);
	const env = networkEnvironment({ proxy: "http://proxy.test:8080", noProxy: "localhost", caFile: "/tmp/ca.pem" });
	assert.equal(env.HTTPS_PROXY, "http://proxy.test:8080");
	assert.equal(env.https_proxy, "http://proxy.test:8080");
	assert.equal(env.no_proxy, "localhost");
	assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
	assert.deepEqual(networkEnvironment({}), {});
});

test("login shell capture keeps only network variables and never overrides launch values", () => {
	const m = "__PI_DESKTOP_SHELL_ENV__";
	// PATH, then HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy, NO_PROXY, no_proxy, ALL_PROXY, all_proxy, NODE_EXTRA_CA_CERTS
	const values = ["/opt/bin:/usr/bin", "http://shell:1", "", "", "", "localhost", "", "", "", "/etc/ca.pem"];
	const parsed = parseShellEnvironment(`motd noise${values.map((v) => m + v).join("")}${m}`);
	assert.ok(parsed);
	assert.equal(parsed.path, "/opt/bin:/usr/bin");
	assert.deepEqual(parsed.network, { HTTPS_PROXY: "http://shell:1", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem" });
	assert.equal(parseShellEnvironment("no markers"), undefined);
	const target: NodeJS.ProcessEnv = { https_proxy: "http://launch:2" };
	mergeNetworkEnvironment(target, parsed.network);
	assert.equal(target.HTTPS_PROXY, undefined, "a lower-case launch value wins over the shell");
	assert.equal(target.https_proxy, "http://launch:2");
	assert.equal(target.NO_PROXY, "localhost");
});

test("session cost sums assistant, tool and usage entries and ignores invalid numbers", () => {
	const usage = (total: unknown) => ({ cost: { total } });
	const spent = sessionCost([
		{ type: "message", message: { role: "assistant", usage: usage(0.4) } },
		{ type: "message", message: { role: "user", usage: usage(5) } },
		{ type: "message", message: { role: "toolResult", usage: usage(0.1) } },
		{ type: "usage", usage: usage(0.25) },
		{ type: "compaction", usage: usage(Number.NaN) },
		{ type: "message", message: { role: "assistant" } },
	]);
	assert.equal(Math.round(spent * 100) / 100, 0.75);
	assert.equal(escapeConfigValue("a$b"), "a$$b");
	assert.equal(escapeConfigValue("!cmd"), "$!cmd");
});

test("connection inputs reject multi-line commands and unsafe header names", () => {
	assert.equal(validateKeyCommand(""), undefined);
	assert.throws(() => validateKeyCommand("echo a\necho b"), /一行/);
	assert.deepEqual(validateHeaders({ "X-Org": "a" }), { "X-Org": "a" });
	assert.throws(() => validateHeaders({ "Bad Name": "a" }), /名称无效/);
	assert.throws(() => validateHeaders({ Host: "evil" }), /Host/);
	assert.throws(() => validateHeaders({ "X-A": "a\r\nInjected: 1" }), /值无效/);
});

test("disableAllHooks stops hooks from running but keeps them listed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-batch1-hooks-"));
	try {
		let disabled = false;
		const marker = join(root, "ran");
		const hooks = new HooksService({ agentDir: () => join(root, "agent"), disabled: () => disabled });
		await hooks.save({ event: "UserPromptSubmit", command: `touch ${JSON.stringify(marker)}`, scope: "user" });
		disabled = true;
		const skipped = await hooks.run("UserPromptSubmit", { project: root, prompt: "hi" });
		assert.equal(skipped.executedCount, 0);
		assert.equal((await hooks.list()).filter((hook) => hook.event === "UserPromptSubmit").length, 1);
		await assert.rejects(readFile(marker));
		disabled = false;
		const ran = await hooks.run("UserPromptSubmit", { project: root, prompt: "hi" });
		assert.equal(ran.executedCount, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test(
	"a key command and encrypted custom headers reach the model endpoint without leaking into snapshots",
	{ timeout: 60000 },
	async () => {
		const endpoint = await createModelEndpoint();
		const fixture = await createCoreFixture();
		const options = {
			dataDir: fixture.dataDir,
			executable: process.execPath,
			entry: fixture.entry,
			permissionExtension: extension,
			env: fixture.env,
			initialProject: fixture.project,
			providerBaseUrls: { deepseek: endpoint.baseUrl },
			...cipher(),
		};
		let service = new DesktopService(options);
		const commandKey = "test-only-command-key";
		const headerValue = "test-only-header-$value";
		try {
			await service.initialize();
			const checked = await service.testConnection({
				provider: "deepseek",
				keyCommand: `printf ${commandKey}`,
				headers: { "X-Test-Org": headerValue },
			});
			assert.equal(checked.success, true, checked.message);
			const request = endpoint.requests.at(-1)!;
			assert.equal(request.headers.authorization, `Bearer ${commandKey}`);
			assert.equal(request.headers["x-test-org"], headerValue);

			const saved = await service.saveSettings({
				permission: "ask",
				theme: "light",
				provider: "deepseek",
				keyCommand: `printf ${commandKey}`,
				headers: { "X-Test-Org": headerValue },
				maxCostUsd: 2.5,
			});
			assert.ok(saved.settings.configuredProviders.includes("deepseek"));
			assert.deepEqual(saved.settings.connections.deepseek?.headerNames, ["X-Test-Org"]);
			assert.equal(saved.settings.maxCostUsd, 2.5);
			assert.ok(!JSON.stringify(saved).includes(headerValue));
			const stored = await readFile(join(fixture.dataDir, "desktop.json"), "utf8");
			assert.ok(!stored.includes(headerValue), "header values are stored encrypted");

			await service.close();
			service = new DesktopService(options);
			const restored = await service.initialize();
			assert.equal(restored.settings.maxCostUsd, 2.5);
			assert.equal(restored.settings.connections.deepseek?.keyCommand, `printf ${commandKey}`);
			const recheck = await service.testConnection({ provider: "deepseek" });
			assert.equal(recheck.success, true, recheck.message);
			assert.equal(endpoint.requests.at(-1)?.headers["x-test-org"], headerValue);

			// A later save that only changes the model must keep the key command and headers.
			const resaved = await service.saveSettings({ permission: "ask", theme: "light", provider: "deepseek" });
			assert.equal(resaved.settings.connections.deepseek?.keyCommand, `printf ${commandKey}`);
			assert.deepEqual(resaved.settings.connections.deepseek?.headerNames, ["X-Test-Org"]);
			assert.ok(resaved.settings.configuredProviders.includes("deepseek"));
			await assert.rejects(
				service.saveSettings({ permission: "ask", theme: "light", maxCostUsd: 0.004 }),
				/0\.01/,
			);

			const cleared = await service.saveSettings({
				permission: "ask",
				theme: "light",
				provider: "deepseek",
				headers: {},
				maxCostUsd: null,
			});
			assert.equal(cleared.settings.connections.deepseek?.headerNames, undefined);
			assert.equal(cleared.settings.maxCostUsd, undefined);
		} finally {
			await service.close();
			await endpoint.close();
			await fixture.cleanup();
		}
	},
);

test("bundled review skills register in a real Pi session and a user skill of the same name wins", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	try {
		await mkdir(join(fixture.root, ".claude", "skills", "review"), { recursive: true });
		await writeFile(
			join(fixture.root, ".claude", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: My own review\n---\nmine\n",
		);
		const service = new DesktopService({
			dataDir: fixture.dataDir,
			executable: process.execPath,
			entry: fixture.entry,
			permissionExtension: extension,
			env: { ...fixture.env, HOME: fixture.root },
			initialProject: fixture.project,
		});
		try {
			const snapshot = await service.initialize();
			assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
			const names = snapshot.commands.map((command) => command.name);
			for (const name of ["code-review", "security-review", "simplify", "review"])
				assert.ok(names.includes(`skill:${name}`), names.join(","));
			const review = snapshot.commands.find((command) => command.name === "skill:review");
			assert.equal(review?.description, "My own review");
			const written = await readFile(join(fixture.dataDir, "bundled-skills", "code-review", "SKILL.md"), "utf8");
			assert.match(written, /name: code-review/);
		} finally {
			await service.close();
		}
	} finally {
		await fixture.cleanup();
	}
});
