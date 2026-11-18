import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { readClaudeProjectPermissions, writeClaudeProjectPermissions } from "../src/claude-settings-sync.ts";
import { HooksService } from "../src/hooks-service.ts";
import { codeIntelligence } from "../src/language-service.ts";
import { McpRegistry } from "../src/mcp-registry.ts";
import { projectMemoryContext } from "../src/project-memory.ts";
import { createDraftPullRequest, readPullRequest } from "../src/review-service.ts";
import { buildSeatbeltProfile } from "../src/sandbox.ts";

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
	assert.doesNotMatch(buildSeatbeltProfile(root), /deny network/);
	assert.match(buildSeatbeltProfile(root, [], true), /deny network/);
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

test("language server framing and definition navigation use the current workspace file", async (t) => {
	const root = await fixture(t);
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "demo.ts"), "const demo = 1;\n");
	await writeFile(join(bin, "typescript-language-server"), `#!${process.execPath}
let buffer = Buffer.alloc(0), uri;
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
  if (data.id === 1) send({id:1,result:{capabilities:{}}});
  if (data.method === "textDocument/didOpen") uri=data.params.textDocument.uri;
  if (data.id === 2) {
   send({id:2,result:[{name:"demo",selectionRange:range}]});
   send({method:"textDocument/publishDiagnostics",params:{uri,diagnostics:[{message:"Fixture",severity:2,range}]}});
  }
  if (data.id === 3) send({id:3,result:{uri,range}});
 }
});
`, { mode: 0o700 });
	const result = await codeIntelligence(root, "demo.ts", { PATH: bin + delimiter + process.env.PATH }, { line: 1, column: 7 });
	assert.deepEqual(result.symbols, [{ name: "demo", line: 2, column: 3 }]);
	assert.equal(result.diagnostics[0].message, "Fixture");
	assert.deepEqual(result.definitions, [{ path: "demo.ts", line: 2, column: 3 }]);
});
