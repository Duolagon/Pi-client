import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { readClaudeProjectPermissions, writeClaudeProjectPermissions } from "../src/claude-settings-sync.ts";
import { HooksService } from "../src/hooks-service.ts";
import { formatCodeIntelligence, LanguageService } from "../src/language-service.ts";
import { McpRegistry } from "../src/mcp-registry.ts";
import { projectMemoryContext } from "../src/project-memory.ts";
import { createDraftPullRequest, readPullRequest } from "../src/review-service.ts";
import { buildSeatbeltProfile, probeSeatbeltSupport, resolveGitWorktreeWritablePaths } from "../src/sandbox.ts";

const exec = promisify(execFile);

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-desktop-feature-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("Claude export preserves custom settings, separates private rules and rejects a malformed target", async (t) => {
	const root = await fixture(t);
	const config = join(root, ".claude");
	await mkdir(config);
	const shared = join(config, "settings.json");
	await writeFile(shared, JSON.stringify({ permissions: { allow: ["FutureTool(option)"], custom: "keep" }, model: "fixture" }));
	await writeFile(join(config, "settings.local.json"), JSON.stringify({ permissions: { deny: ["Bash(private)"] } }));
	const rules = await readClaudeProjectPermissions(root);
	const privateRule = rules.find((rule) => rule.id.startsWith("private-"))!;
	await writeClaudeProjectPermissions(root, [...rules, { ...privateRule, id: privateRule.id.slice(8) },
		{ id: "write-rule", action: "ask", scope: "project", project: root, tool: "write" }]);
	assert.deepEqual(JSON.parse(await readFile(shared, "utf8")), { model: "fixture", permissions: { custom: "keep", allow: ["FutureTool(option)"], ask: ["Write"] } });
	await writeFile(shared, "{invalid");
	await assert.rejects(writeClaudeProjectPermissions(root, rules));
	assert.equal(await readFile(shared, "utf8"), "{invalid");
});

test("Claude hooks use the Claude tool name and seconds while MCP edits preserve other entries", async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, ".claude"));
	await writeFile(join(root, ".claude/settings.json"), JSON.stringify({
		hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "exit 2", timeout: 10 }] }] },
	}));
	const hooks = new HooksService({ agentDir: () => join(root, "agent") });
	const entry = (await hooks.list(root, true)).find((item) => item.matcher === "^Bash$");
	assert.equal(entry?.timeout, 10000);
	assert.equal((await hooks.run("PreToolUse", { project: root, projectTrusted: true, conversationId: "fixture", toolName: "bash" })).blocked, true);
	await mkdir(join(root, ".pi"));
	const path = join(root, ".pi/mcp.json");
	await writeFile(path, JSON.stringify({ marker: 3, mcpServers: { unknown: 17, "invalid name": { custom: true } } }));
	const mcp = new McpRegistry({ agentDir: () => join(root, "agent") });
	await mcp.save(root, { name: "new-server", scope: "project", transport: "stdio", command: "demo" });
	const updated = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual({ ...updated.mcpServers, "new-server": undefined }, { unknown: 17, "invalid name": { custom: true }, "new-server": undefined });
	assert.equal(updated.marker, 3);
});

test("project memory follows nested imports and path globs within the workspace", async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, ".claude/rules/nested"), { recursive: true });
	await mkdir(join(root, "src"));
	await writeFile(join(root, ".claude/rules/nested/test.md"), '---\npaths:\n  - "src/**/*.ts"\n---\nSCOPED-RULE');
	await writeFile(join(root, "src/test.ts"), "REFERENCE-TEXT");
	await writeFile(join(root, "CLAUDE.md"), "@./project.md");
	await writeFile(join(root, "project.md"), "IMPORTED @./CLAUDE.md");
	await writeFile(join(root, "memory.md"), "PRIVATE-MEMORY");
	await writeFile(join(root, ".env"), "SECRET-VALUE");
	await symlink("project.md", join(root, "linked.md"));
	const unscoped = await projectMemoryContext(root, "inspect @linked.md @.env", join(root, "memory.md"));
	assert.match(unscoped, /PRIVATE-MEMORY/);
	assert.match(unscoped, /IMPORTED/);
	assert.doesNotMatch(unscoped, /SCOPED-RULE|SECRET-VALUE|## linked.md/);
	assert.match(await projectMemoryContext(root, "inspect @src/test.ts"), /SCOPED-RULE[\s\S]*REFERENCE-TEXT/);
	assert.match(await projectMemoryContext(root, "inspect", undefined, [join(root, "src/test.ts")]), /SCOPED-RULE/);
	const seatbelt = buildSeatbeltProfile(root, [], false, "/Users/example");
	assert.doesNotMatch(seatbelt, /deny network/);
	assert.match(seatbelt, /\(deny file-read\*[\s\S]*\/Users\/example\/\.ssh/);
	assert.match(seatbelt, /\/Users\/example\/\.aws/);
	assert.match(seatbelt, /\/Users\/example\/\.netrc/);
	assert.match(buildSeatbeltProfile(root, [], true, "/Users/example"), /deny network/);
});

test("GitHub CLI reports checks and creates draft PRs using an explicit head", async (t) => {
	const root = await fixture(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "git"), "#!/bin/sh\nprintf 'fixture\n'\n", { mode: 0o700 });
	const status = JSON.stringify({ number: 7, url: "https://github.example/example/repo/pull/7", statusCheckRollup: [{ name: "Build", conclusion: "SUCCESS" }] });
	await writeFile(join(bin, "gh"), `#!/bin/sh
if [ "$2" = create ]; then
  [ "$3" = --draft ] && [ "$4" = --head=fixture ] || exit 1
  printf '%s\\n' https://github.example/example/repo/pull/7
else
  printf '%s\\n' '${status}'
fi
`, { mode: 0o700 });
	const env = { PATH: bin + delimiter + process.env.PATH };
	assert.deepEqual((await readPullRequest(root, env))?.checks, [{ name: "Build", status: "SUCCESS" }]);
	assert.equal((await createDraftPullRequest(root, { branch: "fixture", title: "Draft", body: "Description" }, env)).number, 7);
	await assert.rejects(createDraftPullRequest(root, { branch: "stale", title: "Draft", body: "" }, env), /分支/);
});

test("language server reuses a process, waits for late diagnostics and cancels stale requests", async (t) => {
	const root = await fixture(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "demo.ts"), "const demo = 1;\n");
	await writeFile(join(root, "cancel.ts"), "const wait = 1;\n");
	await writeFile(join(root, "silent.ts"), "export {};\n");
	await writeFile(join(bin, "typescript-language-server"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
function record(event) { appendFileSync("language-server-events", event+"\\n"); }
record("spawn");
let buffer = Buffer.alloc(0);
const range = {start: { line: 1, character: 2 }};
function send(body) {
 const payload = JSON.stringify({jsonrpc:"2.0", ...body});
 process.stdout.write("Content-Length: " + Buffer.byteLength(payload) + "\\r\\n\\r\\n" + payload);
}
process.stdin.on("data", chunk => {
 buffer = Buffer.concat([buffer, chunk]);
 for (;;) {
  const index = buffer.indexOf("\\r\\n\\r\\n");
  if (index < 0) return;
  const length = Number(buffer.subarray(0,index).toString().split(":")[1]);
  if (buffer.length < index+4+length) return;
  const data = JSON.parse(buffer.subarray(index+4,index+4+length));
  buffer = buffer.subarray(index+4+length);
  if (data.method === "initialize") send({id:data.id,result:{capabilities:{}}});
  if (data.method === "textDocument/didOpen") {
   const { uri, version } = data.params.textDocument;
   if (uri.endsWith("/demo.ts")) {
    send({method:"textDocument/publishDiagnostics",params:{uri,version,diagnostics:[]}});
    setTimeout(() => send({method:"textDocument/publishDiagnostics",params:{uri,version,diagnostics:[{message:"Fixture semantic diagnostic",severity:2,range}]}}), 400);
   }
  }
  if (data.method === "textDocument/documentSymbol") {
   if (data.params.textDocument.uri.endsWith("/cancel.ts")) record("waiting-symbols");
   else send({id:data.id,result:[{name:"demo",selectionRange:range}]});
  }
  if (data.method === "textDocument/definition") send({id:data.id,result:{uri:data.params.textDocument.uri,range}});
  if (data.method === "$/cancelRequest") record("cancelled");
 }
});
`, { mode: 0o700 });
	const lsp = new LanguageService({ PATH: bin + delimiter + process.env.PATH });
	const log = join(root, "language-server-events");
	try {
		const result = await lsp.inspect(root, "demo.ts", { line: 1, column: 7 });
		assert.deepEqual(result.symbols, [{ name: "demo", line: 2, column: 3 }]);
		assert.equal(result.diagnostics[0].message, "Fixture semantic diagnostic");
		assert.deepEqual(result.definitions, [{ path: "demo.ts", line: 2, column: 3 }]);
		assert.equal(result.diagnosticsComplete, true);

		const controller = new AbortController();
		const waiting = lsp.inspect(root, "cancel.ts", undefined, "documentSymbol", controller.signal);
		const rejected = assert.rejects(waiting, /fixture request cancelled/);
		const deadline = Date.now() + 1000;
		while (!(await readFile(log, "utf8")).includes("waiting-symbols") && Date.now() < deadline) await delay(10);
		controller.abort(new Error("fixture request cancelled"));
		await rejected;
		const noReport = await lsp.inspect(root, "silent.ts", undefined, "diagnostics");
		assert.equal(noReport.diagnosticsComplete, false);
		assert.match(formatCodeIntelligence("silent.ts", noReport, "diagnostics"), /尚未报告诊断/);
		assert.equal(await readFile(log, "utf8"), "spawn\nwaiting-symbols\ncancelled\n");
	} finally {
		lsp.close();
	}
});

test("resolveGitWorktreeWritablePaths grants minimal git metadata write access for worktrees under Seatbelt", async (t) => {
	const root = await fixture(t);
	const mainRepo = join(root, "main");
	const wtRepo = join(root, "wt");
	const wtSub = join(wtRepo, "packages", "app");
	await mkdir(mainRepo);
	const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	await exec("git", ["init", "-b", "main"], { cwd: mainRepo, env: gitEnv });
	await writeFile(join(mainRepo, "a.txt"), "hello\n");
	await exec("git", ["add", "a.txt"], { cwd: mainRepo, env: gitEnv });
	await exec("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: mainRepo, env: gitEnv });
	await exec("git", ["worktree", "add", "-b", "feat-sb", wtRepo], { cwd: mainRepo, env: gitEnv });
	await mkdir(wtSub, { recursive: true });

	assert.deepEqual(await resolveGitWorktreeWritablePaths(mainRepo), []);
	const extras = await resolveGitWorktreeWritablePaths(wtSub);
	assert.ok(extras.some((p) => typeof p === "string" && p.includes("/.git/worktrees/")));
	assert.ok(extras.some((p) => typeof p === "string" && p.endsWith("/.git/objects")));
	assert.ok(extras.some((p) => typeof p === "string" && p.endsWith("/.git/refs")));
	assert.ok(!extras.includes(join(mainRepo, ".git")), "must not expose main .git root (config/hooks)");
	const profile = buildSeatbeltProfile(wtRepo, extras, false);
	assert.match(profile, /\(literal "[^"]+\/\.git\/packed-refs"\)/);
	assert.match(profile, /\(literal "[^"]+\/\.git\/packed-refs\.lock"\)/);

	if ((await probeSeatbeltSupport()).supported) {
		await writeFile(join(wtRepo, "b.txt"), "world\n");
		await exec(
			"/usr/bin/sandbox-exec",
			["-p", profile, "/bin/sh", "-c", "git add b.txt && git -c user.name=T -c user.email=t@t commit -m wt-commit"],
			{ cwd: wtRepo, env: gitEnv },
		);
		const { stdout } = await exec("git", ["log", "-n", "1", "--oneline"], { cwd: wtRepo, env: gitEnv });
		assert.match(stdout, /wt-commit/);
		await exec("/usr/bin/sandbox-exec", ["-p", profile, "git", "pack-refs", "--all"], { cwd: wtRepo, env: gitEnv });
	}
});
