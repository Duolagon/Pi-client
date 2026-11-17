import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ClaudeAdapter } from "../src/external-claude.ts";
import type { ExternalAdapterEvent } from "../src/external-types.ts";

// Arguments: helper.mjs, existing Claude executable, optional Node/Electron executable.
// Open performs SDK initialization with an empty input stream; this script sends no prompt.
const helperPath = resolve(process.argv[2] ?? "dist/runtime/external-claude-helper.mjs");
const executable = resolve(process.argv[3] ?? "/opt/homebrew/bin/claude");
const nodeExecutable = process.argv[4] ? resolve(process.argv[4]) : process.execPath;
await stat(helperPath);
await stat(executable);
const root = await mkdtemp(join(tmpdir(), "pi-packaged-claude-"));
const events: ExternalAdapterEvent[] = [];
const session = await new ClaudeAdapter().open({
	executable, helperPath, nodeExecutable, cwd: root,
	env: {
		PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root,
		ANTHROPIC_API_KEY: "local-protocol-only-unused",
		ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	},
	policy: { version: 1, project: root, mode: "ask", rules: [], disabledTools: [] },
	onEvent: (event) => events.push(event),
	onPermission: async () => ({ decision: "deny" }),
});
try {
	assert.equal(events.some((event) => ["text_delta", "tool_start", "usage"].includes(event.type)), false);
	await session.close();
	console.log("Packaged Claude helper acceptance passed: native SDK initialize and clean shutdown, no model prompt.");
} finally { await session.close(); await rm(root, { recursive: true, force: true }); }
