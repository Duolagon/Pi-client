import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPullRequestCommentsPrompt, readPullRequest, readPullRequestComments, setPullRequestAutoMerge } from "../src/review-service.ts";
import { groupSidebarConversations } from "../src/renderer/subagent-panel-state.ts";
import type { Conversation } from "../src/shared.ts";
import { evaluatePermission } from "../src/permission-policy.ts";
import { buildSeatbeltProfile } from "../src/sandbox.ts";
import { formatWebSearchResults, injectDeepSeekBuiltinSearch, isDeepSeekModel, searchWithDeepSeekApi, validateSearchEndpoint } from "../src/web-search.ts";
import { formatCodeIntelligence, formatLspDiagnostics, isLspSupportedFile } from "../src/language-service.ts";
import { validateToolInvocation } from "../src/tool-control-types.ts";
import { formatForkedSkillPrompt, parseSkillInvocation, SkillRegistry } from "../src/skill-registry.ts";
import { buildGoalInitialPrompt, evaluateGoalContinuation, isGoalAchieved, parseGoalCommand, type GoalState } from "../src/goal-mode.ts";

test("#11 PR: auto-merge toggle, comment fetching, and agent prompt formatting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pr-test-"));
	try {
		const binDir = join(dir, "bin");
		const stateFile = join(dir, "auto-merge-state.txt");
		await mkdir(binDir, { recursive: true });
		await writeFile(stateFile, "off", "utf8");
		const ghScript = join(binDir, "gh");
		await writeFile(
			ghScript,
			`#!/bin/sh
STATE_FILE=${JSON.stringify(stateFile)}
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  case "$*" in
    *"--disable-auto"*) echo "off" > "$STATE_FILE" ;;
    *"--auto"*) echo "SQUASH" > "$STATE_FILE" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *"comments,reviews"*)
      cat <<'JSON'
{"comments":[{"id":"c1","author":{"login":"alice"},"body":"Please add a test.","createdAt":"2026-11-21T10:00:00Z","url":"https://github.com/org/repo/pull/42#issuecomment-1"}],"reviews":[{"id":"r1","author":{"login":"bob"},"body":"Looks mostly good, see inline note.","state":"CHANGES_REQUESTED","submittedAt":"2026-11-21T10:05:00Z","url":"https://github.com/org/repo/pull/42#pullrequestreview-1"}]}
JSON
      exit 0
      ;;
  esac
  STATE=$(cat "$STATE_FILE")
  if [ "$STATE" = "off" ]; then
    AM="null"
  else
    AM='{"enabledAt":"2026-11-21T11:00:00Z","mergeMethod":"SQUASH"}'
  fi
  cat <<JSON
{"number":42,"title":"Fix race condition","url":"https://github.com/org/repo/pull/42","state":"OPEN","isDraft":false,"headRefName":"fix/race","baseRefName":"main","reviewDecision":"REVIEW_REQUIRED","autoMergeRequest":$AM,"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}]}
JSON
  exit 0
fi
if [ "$1" = "api" ]; then
  cat <<'JSON'
[{"id":99,"user":{"login":"carol"},"body":"Null check missing here","path":"src/app.ts","line":18,"created_at":"2026-11-21T10:02:00Z","html_url":"https://github.com/org/repo/pull/42#discussion_r99"}]
JSON
  exit 0
fi
exit 1
`,
			"utf8",
		);
		await chmod(ghScript, 0o755);
		const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

		const initial = await readPullRequest(dir, env, 42);
		assert.equal(initial?.autoMerge?.enabled, false);

		const enabled = await setPullRequestAutoMerge(dir, 42, true, "squash", env);
		assert.equal(enabled?.autoMerge?.enabled, true);
		assert.equal(enabled?.autoMerge?.mergeMethod, "SQUASH");

		const disabled = await setPullRequestAutoMerge(dir, 42, false, "squash", env);
		assert.equal(disabled?.autoMerge?.enabled, false);

		const comments = await readPullRequestComments(dir, 42, env);
		assert.equal(comments.length, 3);
		assert.deepEqual(
			comments.map((c) => [c.kind, c.author]),
			[
				["issue", "alice"],
				["inline", "carol"],
				["review", "bob"],
			],
		);
		assert.equal(comments[1].path, "src/app.ts");
		assert.equal(comments[1].line, 18);

		const prompt = formatPullRequestCommentsPrompt(enabled!, comments);
		assert.match(prompt, /PR #42/);
		assert.match(prompt, /@carol \(src\/app\.ts:18\)/);
		assert.match(prompt, /Please add a test/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("#12 Session management: sidebar partitioning for pinned, custom groups, and archived", () => {
	const now = Date.now();
	const make = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
		id,
		title: id,
		project: "/tmp/proj",
		updatedAt: now,
		...extra,
	});
	const result = groupSidebarConversations(
		[
			make("normal-today", { updatedAt: now - 1000 }),
			make("pinned-old", { pinned: true, updatedAt: now - 10 * 86400 * 1000 }),
			make("grouped-a", { group: "后端重构", updatedAt: now - 5000 }),
			make("archived-one", { archived: true, updatedAt: now - 2000 }),
			make("child-sub", { kind: "subagent", parentConversationId: "normal-today", updatedAt: now - 500 }),
		],
		now,
	);
	assert.deepEqual(
		result.groups.map((g) => g.label),
		["置顶", "后端重构", "今天"],
	);
	assert.deepEqual(result.groups[0].items.map((c) => c.id), ["pinned-old"]);
	assert.deepEqual(result.groups[1].items.map((c) => c.id), ["grouped-a"]);
	assert.deepEqual(result.groups[2].items.map((c) => c.id), ["normal-today"]);
	assert.deepEqual(result.archived.map((c) => c.id), ["archived-one"]);
	assert.deepEqual(result.childrenByParent.get("normal-today")?.map((c) => c.id), ["child-sub"]);
});

test("#22 /add-dir: permission policy allows read/write in additionalDirs and Seatbelt syncs writable roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-adddir-"));
	try {
		const project = join(root, "proj");
		const extra = join(root, "shared-lib");
		const outside = join(root, "secret");
		await mkdir(project, { recursive: true });
		await mkdir(extra, { recursive: true });
		await mkdir(outside, { recursive: true });

		const policy = {
			version: 1 as const,
			mode: "ask" as const,
			rules: [],
			disabledTools: [],
			project,
			additionalDirs: [extra],
		};

		const readExtra = await evaluatePermission(policy, { toolName: "read", input: { path: join(extra, "a.ts") } });
		assert.equal(readExtra.action, "allow");

		const editExtra = await evaluatePermission(policy, { toolName: "edit", input: { path: join(extra, "a.ts") } });
		assert.equal(editExtra.action, "allow");

		const readOutside = await evaluatePermission(policy, { toolName: "read", input: { path: join(outside, "b.ts") } });
		assert.equal(readOutside.action, "ask");

		// Read-only mode still blocks writes even in additionalDirs.
		const writeInReadMode = await evaluatePermission(
			{ ...policy, mode: "read" },
			{ toolName: "write", input: { path: join(extra, "a.ts") } },
		);
		assert.equal(writeInReadMode.action, "deny");

		// Seatbelt profile includes the extra writable directory.
		const profile = buildSeatbeltProfile(project, [extra], false, "/Users/test");
		assert.ok(profile.includes(`(subpath "${extra}")`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("#14 WebSearch: DeepSeek Search API client and DeepSeek built-in search payload injection", async () => {
	assert.throws(() => validateSearchEndpoint("http://example.com/search"), /HTTPS/);
	assert.equal(isDeepSeekModel({ provider: "desktop-deepseek", id: "deepseek-chat" }), true);
	assert.equal(isDeepSeekModel({ provider: "custom", baseUrl: "https://api.deepseek.com/v1" }), true);
	assert.equal(isDeepSeekModel({ provider: "desktop-openai", id: "gpt-4o" }), false);

	const rewritten = injectDeepSeekBuiltinSearch({
		model: "deepseek-chat",
		tools: [
			{ name: "read", description: "read file" },
			{ name: "WebSearch", description: "client web search" },
		],
	}) as { tools: Array<{ name?: string; type?: string }> };
	assert.equal(rewritten.tools.some((t) => t.name === "WebSearch"), false);
	assert.equal(rewritten.tools.some((t) => t.type === "deepseek_web_search"), true);

	// Idempotent if already injected
	const twice = injectDeepSeekBuiltinSearch(rewritten) as { tools: Array<{ type?: string }> };
	assert.equal(twice.tools.filter((t) => t.type === "deepseek_web_search").length, 1);

	// DeepSeek rejects `strict` on function tools next to the built-in search tool.
	const strictPayload = injectDeepSeekBuiltinSearch({
		model: "deepseek-chat",
		tools: [{ type: "function", function: { name: "read", description: "read file", strict: true, parameters: {} } }],
	}) as { tools: Array<{ type?: string; function?: Record<string, unknown> }> };
	assert.equal(strictPayload.tools.some((t) => t.type === "deepseek_web_search"), true);
	assert.equal(strictPayload.tools.some((t) => t.function && "strict" in t.function), false);
	assert.equal(strictPayload.tools[0].function?.name, "read");
	assert.deepEqual(strictPayload.tools.at(-1), { type: "deepseek_web_search" });

	const webSearch = { type: "function", function: { name: "WebSearch" } };
	const read = { type: "function", function: { name: "read" } };
	const nonThinking = { thinking: { type: "disabled" }, tools: [read, webSearch] };
	assert.deepEqual(injectDeepSeekBuiltinSearch(nonThinking), nonThinking);
	assert.deepEqual(injectDeepSeekBuiltinSearch({
		...nonThinking, tools: [read, webSearch, { type: "deepseek_web_search" }],
	}), nonThinking);
	assert.deepEqual(injectDeepSeekBuiltinSearch({ ...nonThinking, tools: [webSearch] }), {
		...nonThinking, tools: [{ type: "deepseek_web_search" }],
	});
	assert.deepEqual(injectDeepSeekBuiltinSearch({ tools: [{ name: "WebSearch" }] }, "anthropic-messages"), {
		tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
	});

	let seenAuth = "";
	let seenUrl = "";
	let seenBody: Record<string, unknown> = {};
	const mockFetch: typeof fetch = async (input, init) => {
		seenUrl = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		seenAuth = headers.Authorization ?? headers.authorization ?? "";
		seenBody = JSON.parse(String(init?.body ?? "{}"));
		return new Response(
			JSON.stringify({
				results: [
					{ title: "DeepSeek Docs", url: "https://api-docs.deepseek.com", snippet: "Official API docs", site_name: "DeepSeek" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	const response = await searchWithDeepSeekApi({
		query: "DeepSeek search",
		count: 5,
		needContent: false,
		apiKey: "sk-test-key",
		fetchImpl: mockFetch,
	});
	assert.equal(seenUrl, "https://api.deepseek.com/v1/tools/search");
	assert.equal(seenAuth, "Bearer sk-test-key");
	assert.equal(seenBody.query, "DeepSeek search");
	assert.equal(seenBody.count, 5);
	assert.equal(response.results.length, 1);
	const formatted = formatWebSearchResults(response);
	assert.match(formatted, /DeepSeek Docs/);
	assert.match(formatted, /https:\/\/api-docs\.deepseek\.com/);
});

test("#15 LSP: tool validation, permission policy, and diagnostic formatting", async () => {
	const validated = validateToolInvocation({
		tool: "LSP",
		toolCallId: "call-1",
		input: { operation: "diagnostics", filePath: "src/app.ts" },
	});
	assert.equal(validated.tool, "LSP");
	assert.throws(() =>
		validateToolInvocation({
			tool: "LSP",
			toolCallId: "call-2",
			input: { operation: "unknown", filePath: "src/app.ts" },
		}),
	);

	assert.equal(isLspSupportedFile("src/index.ts"), true);
	assert.equal(isLspSupportedFile("main.py"), true);
	assert.equal(isLspSupportedFile("README.md"), false);

	const diagText = formatLspDiagnostics("src/app.ts", {
		server: "typescript-language-server",
		diagnostics: [{ line: 10, column: 4, severity: 1, message: "Cannot find name 'foo'." }],
	});
	assert.match(diagText, /L10:4 \[Error\] Cannot find name 'foo'\./);

	const inspectText = formatCodeIntelligence(
		"src/app.ts",
		{
			server: "typescript-language-server",
			diagnostics: [],
			symbols: [{ name: "main", line: 1, column: 1 }],
			definitions: [{ path: "src/lib.ts", line: 5, column: 2 }],
		},
		"inspect",
	);
	assert.match(inspectText, /无诊断问题/);
	assert.match(inspectText, /main \(L1:1\)/);
	assert.match(inspectText, /src\/lib\.ts:5:2/);

	const decision = await evaluatePermission(
		{ version: 1, mode: "read", rules: [], disabledTools: [], project: "/tmp" },
		{ toolName: "LSP", input: { operation: "diagnostics", filePath: "a.ts" } },
	);
	assert.equal(decision.action, "allow");
});

test("#23 Skill context: fork frontmatter parsing, save round-trip, and prompt formatting", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skill-fork-"));
	try {
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(projectDir, ".claude", "commands"), { recursive: true });
		await writeFile(
			join(projectDir, ".claude", "commands", "audit.md"),
			"---\ndescription: Run isolated audit\ncontext: fork\nagent: Explore\n---\nAudit target: $ARGUMENTS\n",
			"utf8",
		);
		const registry = new SkillRegistry({ agentDir: () => agentDir });
		await registry.save({
			name: "deep-check",
			description: 'Run check: "subagent" #literal \\ path',
			body: "Inspect $ARGUMENTS carefully.",
			scope: "user",
			context: "fork",
			agent: "Review",
		});

		const list = await registry.list(projectDir, true);
		const saved = list.find((s) => s.name === "deep-check");
		assert.equal(saved?.context, "fork");
		assert.equal(saved?.agent, "Review");
		assert.equal(saved?.description, 'Run check: "subagent" #literal \\ path');

		await registry.save({ name: "deep-check", description: "Project override", body: "Project prompt", scope: "project", project: projectDir });
		assert.equal((await registry.list(projectDir, true)).find((entry) => entry.name === "deep-check")?.body, "Project prompt");
		assert.equal((await registry.list(projectDir, false)).find((entry) => entry.name === "deep-check")?.scope, "user");

		const cmd = list.find((s) => s.name === "audit");
		assert.equal(cmd?.context, "fork");
		assert.equal(cmd?.agent, "Explore");

		assert.deepEqual(parseSkillInvocation("/deep-check src/backend.ts"), { name: "deep-check", args: "src/backend.ts" });
		assert.deepEqual(parseSkillInvocation("/skill:audit PR #12"), { name: "audit", args: "PR #12" });
		assert.equal(parseSkillInvocation("regular message"), null);
		assert.equal(formatForkedSkillPrompt(saved!, "src/backend.ts"), "Inspect src/backend.ts carefully.");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("#24 /goal: command parser, completion marker, and turn/cost caps", () => {
	assert.deepEqual(parseGoalCommand(""), { action: "status" });
	assert.deepEqual(parseGoalCommand("stop"), { action: "stop" });
	assert.deepEqual(parseGoalCommand("--max-turns 5 --max-cost 1.5 修复全部测试"), {
		action: "start",
		objective: "修复全部测试",
		maxTurns: 5,
		maxCostUsd: 1.5,
	});
	assert.throws(() => parseGoalCommand("--max-turns 999 test"), /1–50/);

	assert.equal(isGoalAchieved("Done!\n<goal-achieved/>"), true);
	assert.equal(isGoalAchieved("Still working on step 2."), false);
	assert.equal(isGoalAchieved("还没完成，所以暂不输出 \`<goal-achieved/>\`"), false);
	assert.equal(isGoalAchieved("<goal-achieved/>\nOnly an example."), false);
	assert.equal(isGoalAchieved("    <goal-achieved/>"), false);

	const initial: GoalState = {
		objective: "Ship feature X",
		maxTurns: 3,
		turnsUsed: 0,
		maxCostUsd: 2.0,
		active: true,
		status: "running",
		startedAt: 1000,
	};
	assert.match(buildGoalInitialPrompt(initial), /<goal-achieved\/>/);

	const turn1 = evaluateGoalContinuation(initial, "Progress made, 2 tests left.", 0.5, 2000);
	assert.equal(turn1.shouldContinue, true);
	assert.equal(turn1.next.turnsUsed, 1);
	assert.match(turn1.continuePrompt ?? "", /第 2\/3 轮/);

	const achieved = evaluateGoalContinuation(turn1.next, "All green!\n<goal-achieved/>", 0.8, 3000);
	assert.equal(achieved.shouldContinue, false);
	assert.equal(achieved.next.status, "achieved");

	const overCost = evaluateGoalContinuation(turn1.next, "Still working", 2.1, 3000);
	assert.equal(overCost.shouldContinue, false);
	assert.equal(overCost.next.status, "max_cost");
	const sameGoalWithHistory = { ...initial, baselineCostUsd: 12 };
	assert.equal(evaluateGoalContinuation(sameGoalWithHistory, "Still working", 12.5).shouldContinue, true);
	assert.equal(evaluateGoalContinuation(sameGoalWithHistory, "Still working", 14.1).next.status, "max_cost");

	const turn2 = evaluateGoalContinuation(turn1.next, "Still working", 0.9, 3000);
	const overTurns = evaluateGoalContinuation(turn2.next, "Still working", 1.0, 4000);
	assert.equal(overTurns.shouldContinue, false);
	assert.equal(overTurns.next.status, "max_turns");
});
