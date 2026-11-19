import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	formatClaudePermissionSpec,
	parseClaudePermissionRules,
	readClaudeProjectPermissionsDetailed,
	writeClaudeProjectPermissions,
} from "../src/claude-settings-sync.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import type { RuntimePermissionPolicy } from "../src/permission-types.ts";
import { projectMemoryContext, userMemoryContext } from "../src/project-memory.ts";
import { detectProjectTrustResources } from "../src/project-trust.ts";

async function project() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-compat-")));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const policy = (root: string, rules: RuntimePermissionPolicy["rules"]): RuntimePermissionPolicy => ({
	version: 1,
	mode: "ask",
	rules,
	disabledTools: [],
	project: root,
});

test("Claude Bash rules keep prefix semantics for both :* and trailing-space * forms", async () => {
	const { root, cleanup } = await project();
	try {
		const legacy = parseClaudePermissionRules("Bash(git:*)", "allow", root);
		assert.deepEqual(legacy.map((rule) => rule.command), [{ type: "prefix", argv: ["git"] }]);
		const spaced = parseClaudePermissionRules("Bash(npm run *)", "allow", root);
		assert.deepEqual(spaced[0].command, { type: "prefix", argv: ["npm", "run"] });
		assert.deepEqual(parseClaudePermissionRules("Bash(npm test)", "deny", root)[0].command, { type: "exact", value: "npm test" });
		assert.equal(parseClaudePermissionRules("Bash", "ask", root)[0].command, undefined);
		// Mid-pattern wildcards cannot be represented safely and must be reported, not guessed.
		assert.deepEqual(parseClaudePermissionRules("Bash(git * main)", "deny", root), []);

		const p = policy(root, legacy);
		assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command: "git status" } })).action, "allow");
		assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command: "git" } })).action, "allow");
		assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command: "gitk" } })).action, "ask");
		assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command: "git status; rm -rf x" } })).action, "ask");
		assert.equal(formatClaudePermissionSpec(legacy[0]), "Bash(git:*)");
	} finally {
		await cleanup();
	}
});

test("Claude WebFetch domain rules match hosts; deny also covers subdomains", async () => {
	const { root, cleanup } = await project();
	try {
		const allow = parseClaudePermissionRules("WebFetch(domain:docs.example.com)", "allow", root);
		const deny = parseClaudePermissionRules("WebFetch(domain:evil.test)", "deny", root);
		assert.equal(allow[0].domain, "docs.example.com");
		const p = policy(root, [...allow, ...deny]);
		const fetch = (url: string) => evaluatePermission(p, { toolName: "WebFetch", input: { url } });
		assert.equal((await fetch("https://docs.example.com/a")).action, "allow");
		assert.equal((await fetch("https://other.example.com/a")).action, "ask");
		assert.equal((await fetch("https://x.docs.example.com/a")).action, "ask");
		assert.equal((await fetch("https://evil.test/")).action, "deny");
		assert.equal((await fetch("https://api.evil.test/")).action, "deny");
		assert.equal(formatClaudePermissionSpec(allow[0]), "WebFetch(domain:docs.example.com)");
	} finally {
		await cleanup();
	}
});

test("Claude MCP server rules select every tool of that server", async () => {
	const { root, cleanup } = await project();
	try {
		const rules = parseClaudePermissionRules("mcp__github", "deny", root);
		assert.equal(rules[0].tool, "mcp__github__*");
		const p = policy(root, rules);
		assert.equal((await evaluatePermission(p, { toolName: "mcp__github__create_issue", input: {} })).action, "deny");
		assert.equal((await evaluatePermission(p, { toolName: "mcp__gitlab__x", input: {} })).action, "ask");
		assert.equal(parseClaudePermissionRules("mcp__github__get_issue", "allow", root)[0].tool, "mcp__github__get_issue");
	} finally {
		await cleanup();
	}
});

test("Claude path rules map project-root, absolute and gitignore-style patterns, and Read/Edit cover their tool family", async () => {
	const { root, cleanup } = await project();
	try {
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "a.ts"), "x");
		await writeFile(join(root, ".env"), "SECRET=1");
		const readDeny = parseClaudePermissionRules("Read(.env)", "deny", root);
		assert.deepEqual(readDeny.map((rule) => rule.tool), ["read", "grep", "find", "ls"]);
		assert.equal(readDeny[0].path, "**/.env");
		assert.equal(new Set(readDeny.map((rule) => rule.id)).size, 4);
		const editAllow = parseClaudePermissionRules("Edit(/src/**)", "allow", root);
		assert.deepEqual(editAllow.map((rule) => rule.tool), ["edit", "write", "NotebookEdit"]);
		assert.equal(editAllow[0].path, "src/**");
		assert.equal(parseClaudePermissionRules("Read(//etc/hosts)", "deny", root)[0].path, "/etc/hosts");
		const p = policy(root, [...readDeny, ...editAllow]);
		assert.equal((await evaluatePermission(p, { toolName: "read", input: { path: ".env" } })).action, "deny");
		assert.equal((await evaluatePermission(p, { toolName: "grep", input: { path: ".env" } })).action, "deny");
		assert.equal((await evaluatePermission(p, { toolName: "write", input: { path: "src/a.ts" } })).action, "allow");
		assert.equal(formatClaudePermissionSpec(editAllow[0]), "Edit(/src/**)");
		assert.equal(formatClaudePermissionSpec(readDeny[0]), "Read(.env)");
	} finally {
		await cleanup();
	}
});

test("Claude settings import reports specs it cannot convert and round-trips exports", async () => {
	const { root, cleanup } = await project();
	try {
		await mkdir(join(root, ".claude"));
		await writeFile(
			join(root, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(git:*)", "WebFetch(domain:example.com)"], deny: ["Bash(* --force)", "WebFetch(https://x)"] } }),
		);
		const { rules, skipped } = await readClaudeProjectPermissionsDetailed(root);
		assert.equal(rules.length, 2);
		assert.deepEqual(skipped, ["deny: Bash(* --force)", "deny: WebFetch(https://x)"]);
		await writeClaudeProjectPermissions(root, rules);
		const saved = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[] } };
		assert.deepEqual(saved.permissions.allow, ["Bash(git:*)", "WebFetch(domain:example.com)"]);
	} finally {
		await cleanup();
	}
});

test("user CLAUDE.md is injected once and AGENTS.override.md shadows AGENTS.md", async () => {
	const { root, cleanup } = await project();
	try {
		const home = join(root, "home", ".claude");
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "CLAUDE.md"), "USER-GLOBAL-RULE");
		assert.match(await userMemoryContext(join(home, "CLAUDE.md")), /USER-GLOBAL-RULE/);
		assert.equal(await userMemoryContext(join(home, "CLAUDE.md"), "system...USER-GLOBAL-RULE..."), "");
		assert.equal(await userMemoryContext(join(home, "missing.md")), "");

		const repo = join(root, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "AGENTS.md"), "SHADOWED-AGENTS");
		await writeFile(join(repo, "AGENTS.override.md"), "OVERRIDE-AGENTS");
		const context = await projectMemoryContext(repo, "hello");
		assert.doesNotMatch(context, /SHADOWED-AGENTS/);
		assert.match(context, /OVERRIDE-AGENTS/);
	} finally {
		await cleanup();
	}
});

test("project .claude skills and commands require a trust decision", async () => {
	const { root, cleanup } = await project();
	try {
		await mkdir(join(root, ".claude", "skills", "demo"), { recursive: true });
		await mkdir(join(root, ".claude", "commands"), { recursive: true });
		assert.deepEqual(await detectProjectTrustResources(root), [".claude/commands", ".claude/skills"]);
	} finally {
		await cleanup();
	}
});

test("~/.claude skills and commands are callable in a real Pi session, and autoRetry reflects the saved setting", { timeout: 60000 }, async () => {
	const { DesktopService } = await import("../src/backend.ts");
	const { createCoreFixture } = await import("./fixtures/core-fixture.ts");
	const fixture = await createCoreFixture();
	try {
		const claude = join(fixture.root, ".claude");
		await mkdir(join(claude, "skills", "review-api"), { recursive: true });
		await writeFile(join(claude, "skills", "review-api", "SKILL.md"), "---\nname: review-api\ndescription: Review REST endpoints\n---\nCheck validation.\n");
		await mkdir(join(claude, "commands", "team"), { recursive: true });
		await writeFile(join(claude, "commands", "ship-it.md"), "---\ndescription: Ship the change\n---\nShip $ARGUMENTS\n");
		await writeFile(join(claude, "commands", "team", "standup.md"), "---\ndescription: Team standup\n---\nSummarize.\n");
		const service = new DesktopService({
			dataDir: fixture.dataDir,
			executable: process.execPath,
			entry: fixture.entry,
			permissionExtension: fileURLToPath(new URL("../src/permission-extension.ts", import.meta.url)),
			env: { ...fixture.env, HOME: fixture.root },
			initialProject: fixture.project,
		});
		try {
			const snapshot = await service.initialize();
			assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
			const names = snapshot.commands.map((command) => command.name);
			assert.ok(names.includes("skill:review-api"), names.join(","));
			assert.ok(names.includes("ship-it"), names.join(","));
			assert.ok(names.includes("standup"), names.join(","));
			// The fixture's Pi settings disable retry; get_state alone would report the default (on).
			assert.equal((await service.contextReport()).autoRetryEnabled, false);
		} finally {
			await service.close();
		}
	} finally {
		await fixture.cleanup();
	}
});

test("process wrappers and absolute executables cannot bypass command deny rules", async () => {
	const { root, cleanup } = await project();
	try {
		const deny = parseClaudePermissionRules("Bash(rm:*)", "deny", root);
		const p = { ...policy(root, deny), mode: "auto" as const };
		for (const command of ["rm -rf build", "nohup rm -rf build", "timeout 5 rm -rf build", "timeout -s KILL 5 rm x", "nice -n 10 rm x", "time rm x", "stdbuf -oL rm x", "/bin/rm -rf build"])
			assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command } })).action, "deny", command);
		assert.equal((await evaluatePermission(p, { toolName: "bash", input: { command: "timeout 60 npm test" } })).action, "allow");
		// Process wrappers are never valid as the executable of a remembered prefix.
		assert.deepEqual(parseClaudePermissionRules("Bash(timeout:*)", "allow", root), []);
		assert.deepEqual(parseClaudePermissionRules("Bash(nohup:*)", "allow", root), []);
		// An allow rule for `npm test` still applies under a wrapper, but not to /usr/bin lookalikes.
		const allow = policy(root, parseClaudePermissionRules("Bash(npm test:*)", "allow", root));
		assert.equal((await evaluatePermission(allow, { toolName: "bash", input: { command: "timeout 60 npm test" } })).action, "allow");
		assert.equal((await evaluatePermission(allow, { toolName: "bash", input: { command: "/tmp/npm test" } })).action, "ask");
	} finally {
		await cleanup();
	}
});

test("recursive grep/find/ls results hide files covered by Read deny rules", async () => {
	const { redactSearchOutput } = await import("../src/permission-policy.ts");
	const { root, cleanup } = await project();
	try {
		await mkdir(join(root, "config"));
		const p = policy(root, parseClaudePermissionRules("Read(.env)", "deny", root));
		const grep = await redactSearchOutput(p, "grep", { pattern: "SECRET" }, ".env:1: SECRET=1\nsrc/a.ts:3: SECRET usage\nconfig/.env-2- ctx\nconfig/.env:4: SECRET=2");
		assert.equal(grep.text, "src/a.ts:3: SECRET usage");
		assert.equal(grep.removed, 3);
		const find = await redactSearchOutput(p, "find", { pattern: "*", path: "config" }, ".env\napp.json\n\n[2 results]");
		assert.equal(find.text, "app.json\n\n[2 results]");
		const ls = await redactSearchOutput(p, "ls", {}, ".env\nconfig/\nsrc/");
		assert.equal(ls.text, "config/\nsrc/");
		const allowOnly = policy(root, parseClaudePermissionRules("Read(src/**)", "allow", root));
		assert.equal((await redactSearchOutput(allowOnly, "grep", {}, ".env:1: x")).removed, 0);
	} finally {
		await cleanup();
	}
});

test("Claude import rejects tool-name wildcards and quoted prefixes instead of widening them", async () => {
	const { root, cleanup } = await project();
	try {
		for (const spec of ["*", "B*", "Ed?t", "mcp__*", "Bash(git commit -m \"wip\":*)", "Bash(echo 'a b')", "Bash(echo $HOME)"])
			assert.deepEqual(parseClaudePermissionRules(spec, "allow", root), [], spec);
		assert.equal(parseClaudePermissionRules("mcp__github__*", "allow", root)[0].tool, "mcp__github__*");
	} finally {
		await cleanup();
	}
});

test("export after import does not duplicate or expand entries in .claude/settings.json", async () => {
	const { root, cleanup } = await project();
	try {
		await mkdir(join(root, ".claude"));
		const allow = ["Read(src/**)", "Bash(npm run *)", "mcp__github", "Edit(./docs/x.md)"];
		await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow } }));
		const store = new Map((await readClaudeProjectPermissionsDetailed(root)).rules.map((rule) => [rule.id, rule]));
		const first = await writeClaudeProjectPermissions(root, [...store.values()]);
		assert.equal(first.count, 0);
		for (const rule of (await readClaudeProjectPermissionsDetailed(root)).rules) store.set(rule.id, rule);
		assert.equal(store.size, 9);
		// A rule created in Desktop is still exported once.
		const manual = parseClaudePermissionRules("Bash(make test:*)", "ask", root)[0];
		assert.equal((await writeClaudeProjectPermissions(root, [...store.values(), { ...manual, id: "manual-1" }])).count, 1);
		assert.equal((await writeClaudeProjectPermissions(root, [...store.values(), { ...manual, id: "manual-1" }])).count, 0);
		const saved = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[]; ask: string[] } };
		assert.deepEqual(saved.permissions.allow, allow);
		assert.deepEqual(saved.permissions.ask, ["Bash(make test:*)"]);
	} finally {
		await cleanup();
	}
});

test("large user CLAUDE.md is truncated, symlinked AGENTS.override.md still shadows AGENTS.md", async () => {
	const { symlink } = await import("node:fs/promises");
	const { root, cleanup } = await project();
	try {
		const big = join(root, "CLAUDE.md");
		await writeFile(big, `HEAD-MARKER\n${"x".repeat(40 * 1024)}`);
		const context = await userMemoryContext(big);
		assert.match(context, /HEAD-MARKER/);
		assert.ok(Buffer.byteLength(context) < 26 * 1024);
		const repo = join(root, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "AGENTS.md"), "SHADOWED-AGENTS");
		await writeFile(join(root, "shared-override.md"), "LINKED-OVERRIDE");
		await symlink(join(root, "shared-override.md"), join(repo, "AGENTS.override.md"));
		assert.doesNotMatch(await projectMemoryContext(repo, "hi"), /SHADOWED-AGENTS/);
	} finally {
		await cleanup();
	}
});
