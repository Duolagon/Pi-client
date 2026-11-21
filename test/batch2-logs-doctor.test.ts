import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { DesktopLog, LOG_FILE_NAME, redactLogText, summarizeEngineError, tildify } from "../src/desktop-log.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/permission-extension.ts");
const toolControlPath = resolve(here, "../src/tool-control-extension.ts");
const navigationPath = resolve(here, "../src/session-navigation-extension.ts");
const historyPath = resolve(here, "../src/session-history-entry.ts");

test("redactLogText removes credentials and the home directory", () => {
	const home = "/Users/alice";
	const fakeKey = ["sk", "ant", "api03", "abcdefghijklmnop1234"].join("-");
	const input = [
		"Authorization: Bearer abc.def.ghi",
		`authorization=${fakeKey}`,
		"bearer tok_123456",
		`key ${fakeKey} used`,
		"PI_DESKTOP_KEY_OPENAI=plainsecretvalue",
		'{"apiKey":"hunter2","name":"ok"}',
		"GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123",
		"DB_PASSWORD='p@ss word'",
		"hex 0123456789abcdef0123456789abcdef01",
		"b64 QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefghijklmnop==",
		"proxy http://user:pa55@proxy.local:8080",
		"at /Users/alice/project/file.ts:10 and /Users/alicea/other",
	].join("\n");
	const out = redactLogText(input, home);
	for (const secret of [
		"abc.def.ghi",
		fakeKey,
		"tok_123456",
		"plainsecretvalue",
		"hunter2",
		"ghp_abcdefghijklmnopqrstuvwxyz0123",
		"p@ss word",
		"0123456789abcdef0123456789abcdef01",
		"QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefghijklmnop",
		"pa55",
	])
		assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
	assert.match(out, /"name":"ok"/);
	assert.match(out, /~\/project\/file\.ts:10/);
	// Only the exact home directory is replaced, not a sibling with the same prefix.
	assert.match(out, /\/Users\/alicea\/other/);
	assert.equal(tildify("/Users/alice", home), "~");
	// Ordinary words and short identifiers survive.
	assert.equal(redactLogText("engine_start_failed conversation=abc-123 reason=crashed", home), "engine_start_failed conversation=abc-123 reason=crashed");
});

test("redactLogText catches secrets after a non-secret name and in URL query strings", () => {
	const home = "/Users/alice";
	const cases: [string, string][] = [
		["Error: MOONSHOT_API_KEY=abcDEF123456xyz", "abcDEF123456xyz"],
		["fetch https://api.example.com/v1/models?api_key=Ab3dEf9hIjKlMn0pQr failed", "Ab3dEf9hIjKlMn0pQr"],
		["request to https://gw.example.com/v1?access_token=abcDEF123456 failed", "abcDEF123456"],
		["https://x.example.com/?a=1&client_secret=s3cr3tvalue&b=2", "s3cr3tvalue"],
	];
	for (const [input, secret] of cases) {
		const out = redactLogText(input, home);
		assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
		assert.match(out, /\[REDACTED\]/);
	}
	assert.equal(redactLogText("https://x.example.com/?a=1&client_secret=s3cr3tvalue&b=2", home), "https://x.example.com/?a=1&client_secret=[REDACTED]&b=2");
	assert.equal(redactLogText("fetch https://api.example.com/v1/models?page=2 failed", home), "fetch https://api.example.com/v1/models?page=2 failed");
});

test("summarizeEngineError keeps only the exit code of a Pi process crash", () => {
	assert.equal(summarizeEngineError("Pi 进程已退出 (1)。user prompt echoed on stderr\nmore"), "Pi 进程已退出 (1)");
	assert.equal(summarizeEngineError("first line\nsecond line"), "first line");
});

test("DesktopLog writes redacted lines and rotates keeping three old files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-log-"));
	try {
		const dir = join(root, "logs");
		const log = new DesktopLog({ dir, maxBytes: 400, keep: 3, home: "/Users/alice" });
		log.error("uncaughtException", { error: "Error: boom at /Users/alice/x.ts Authorization: Bearer secrettoken" });
		const first = await readFile(join(dir, LOG_FILE_NAME), "utf8");
		assert.match(first, /ERROR uncaughtException error=/);
		assert.match(first, /~\/x\.ts/);
		assert.ok(!first.includes("secrettoken"));
		for (let index = 0; index < 60; index++) log.info("tick", { index, filler: "x".repeat(40) });
		const files = (await readdir(dir)).sort();
		assert.deepEqual(files, [LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`, `${LOG_FILE_NAME}.3`]);
		for (const file of files) assert.ok((await stat(join(dir, file))).size <= 400, file);
		if (process.platform !== "win32") assert.equal((await stat(join(dir, LOG_FILE_NAME))).mode & 0o777, 0o600);
		// The newest lines stay in the active file.
		assert.match(await readFile(join(dir, LOG_FILE_NAME), "utf8"), /index="59"/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("doctor() returns fast local checks without secrets", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = fixture.root;
	const logDir = join(fixture.dataDir, "logs");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extensionPath,
		toolControlExtension: toolControlPath,
		navigationExtension: navigationPath,
		historyEntry: historyPath,
		env: { ...fixture.env, HOME: fixture.root },
		initialProject: fixture.project,
		logDir,
	});
	try {
		await service.initialize();
		const started = Date.now();
		const report = await service.doctor();
		assert.ok(Date.now() - started < 5000, "doctor should finish within 5 s");
		assert.equal(typeof report.generatedAt, "number");
		const ids = report.checks.map((check) => check.id);
		for (const id of ["runtime", "data-dir", "model", "network", "sandbox", "git", "gh", "project", "hooks", "mcp", "logs"])
			assert.ok(ids.includes(id), `missing ${id}`);
		for (const check of report.checks) {
			assert.ok(["ok", "warn", "error"].includes(check.status), check.id);
			assert.equal(typeof check.label, "string");
			assert.equal(typeof check.detail, "string");
		}
		const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
		assert.equal(byId["data-dir"].status, "ok");
		assert.match(byId.runtime.detail, /Pi 1\.5\.2/);
		assert.match(byId.runtime.detail, /Node /);
		assert.match(byId.logs.detail, /logs/);
		// The fixture project is not trusted yet.
		assert.equal(byId.project.status, "warn");
		assert.match(byId.project.detail, /未信任/);
		assert.match(byId.hooks.detail, /未配置 Hooks|共 \d+ 个/);
		assert.match(byId.mcp.detail, /共 0 个/);

		const caFile = join(fixture.root, "ca.pem");
		await writeFile(caFile, "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n");
		await service.saveSettings({ permission: "ask", theme: "light", disableAllHooks: true, caFile });
		const withCa = Object.fromEntries((await service.doctor()).checks.map((check) => [check.id, check]));
		assert.equal(withCa.network.status, "ok");
		assert.match(withCa.network.detail, /CA 证书 ~\/ca\.pem/);
		// A CA file removed after saving is reported as unreadable.
		await rm(caFile);
		const after = Object.fromEntries((await service.doctor()).checks.map((check) => [check.id, check]));
		assert.equal(after.hooks.status, "warn");
		assert.match(after.hooks.detail, /已停用全部 Hooks/);
		assert.equal(after.network.status, "error");
		assert.match(after.network.detail, /无法读取/);
	} finally {
		await service.close();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fixture.cleanup();
	}
});
