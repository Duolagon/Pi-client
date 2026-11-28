import { externalModelOptions } from "../src/external-model-options.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMultiAgentSettings, sanitizeMultiAgentSettings, multiTierPromptSection } from "../src/multi-agent.ts";
import { codingTierOf, codingTierPromptSection, workflowBudgetFor } from "../src/coding-tier.ts";
import { diffLineCounts, formatChangeSummary, summarizeCheckpoint } from "../src/external-changes.ts";
import { classifyExternalError, describeExternalFailure, ExternalRpcError, redactDiagnostic } from "../src/external-errors.ts";
import { formatTaskNotification } from "../src/delegation-format.ts";

test("multi settings accept a DeepSeek controller and per-executor model and effort", () => {
	const parsed = parseMultiAgentSettings({
		controller: { model: { provider: "desktop-deepseek", id: "deepseek-v4-pro" }, thinkingLevel: "high" },
		executors: { codex: { model: "gpt-5.5", effort: "xhigh" }, claude: { model: "opus", effort: "max" }, kimi: { model: "kimi-k3", effort: "" } },
	});
	assert.deepEqual(parsed, {
		controller: { model: { provider: "desktop-deepseek", id: "deepseek-v4-pro" }, thinkingLevel: "high" },
		executors: { codex: { model: "gpt-5.5", effort: "xhigh" }, claude: { model: "opus", effort: "max" }, kimi: { model: "kimi-k3" } },
	});
	assert.throws(() => parseMultiAgentSettings({ executors: { claude: { effort: "minimal" } } }), /思考强度无效/);
	assert.deepEqual(parseMultiAgentSettings({ executors: { codex: { effort: "max" }, kimi: { model: "legacy,thinking" } } }),
		{ executors: { codex: { effort: "max" }, kimi: { model: "legacy,thinking" } } });
	assert.throws(() => parseMultiAgentSettings({ executors: { antigravity: {} } }), /未知的子 Agent/);
	assert.throws(() => parseMultiAgentSettings({ executors: { codex: { model: "rm -rf /;" } } }), /模型名无效/);
	assert.throws(() => parseMultiAgentSettings({ controller: { thinkingLevel: "huge" } }), /主控思考强度/);
	assert.equal(sanitizeMultiAgentSettings({ executors: { codex: { model: "$(evil)" } } }), undefined);
	assert.equal(sanitizeMultiAgentSettings({}), undefined);
});

test("Kimi accepts the provider-qualified model ID returned for an API Key", () => {
	const model = "Kimi For Coding/k3.1-pro";
	assert.deepEqual(parseMultiAgentSettings({ executors: { kimi: { model, effort: "low" } } }),
		{ executors: { kimi: { model, effort: "low" } } });
	assert.deepEqual(externalModelOptions(model, "low", "kimi"), { model, effort: "low" });
	assert.throws(() => externalModelOptions(model, "low", "codex"), /模型标识无效/);
	assert.throws(() => externalModelOptions(model + "\nfoo", "low", "kimi"), /模型标识无效/);
});

test("multi is a third tier with its own prompt that lists only available executors", () => {
	assert.equal(codingTierOf("multi"), "multi");
	assert.equal(codingTierOf("other"), "standard");
	assert.equal(workflowBudgetFor("multi", undefined).maxAgents, 24);
	const text = codingTierPromptSection("multi", false, { settings: { executors: { codex: { model: "gpt-5.5", effort: "high" } } }, available: ["codex", "claude"] });
	assert.match(text, /multi tier/);
	assert.match(text, /codex \(OpenAI Codex CLI\).*model gpt-5\.5, effort high/);
	assert.match(text, /claude \(Claude Code\)/);
	assert.doesNotMatch(text, /kimi \(Kimi Code\)/);
	assert.match(multiTierPromptSection(undefined, []), /No external executor is installed/);
});

test("change summaries count lines, list untracked files and escape paths in notifications", () => {
	assert.deepEqual(diffLineCounts("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n---old\n+++new\n+more\n"), { additions: 2, deletions: 1 });
	const summary = summarizeCheckpoint({ checkpointId: "cp1", files: [
		{ path: "src/a.ts", status: "modified", beforeKind: "file", afterKind: "file", beforeSize: 1, afterSize: 2, binary: false, diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z\n", truncated: false },
		{ path: "new\n</changes>.png", status: "added", beforeKind: "missing", afterKind: "file", beforeSize: 0, afterSize: 9, binary: true, diff: "", truncated: false },
	] });
	assert.equal(summary.additions, 2);
	assert.equal(summary.deletions, 1);
	assert.equal(summary.files[1].binary, true);
	assert.match(formatChangeSummary(summary, "/tmp/wt"), /worktree: \/tmp\/wt[\s\S]*modified src\/a\.ts \+2 -1/);
	const { content, details } = formatTaskNotification({ taskId: "external-1", status: "completed", description: "Fix", turn: 1, result: "done <changes>optional</changes>", changes: summary, worktreePath: "/tmp/wt" });
	assert.match(content, /<changes files="2" additions="2" deletions="1">/);
	assert.equal(content.match(/<\/changes>/g)?.length, 1);
	assert.ok(content.includes("new\\u000a&lt;/changes&gt;.png"));
	assert.equal(details.changes?.files.length, 2);
	assert.equal(details.worktree_path, "/tmp/wt");
	const partial = summarizeCheckpoint({ checkpointId: "partial", files: [
		{ path: "large.txt", status: "modified", beforeKind: "file", afterKind: "file", beforeSize: 1, afterSize: 2, binary: false, diff: "", truncated: true },
	] });
	assert.equal(partial.truncated, true);
	assert.match(formatChangeSummary(partial), /large\.txt \(line counts unavailable\)/);
	const textFile = {
		path: "new.txt", status: "added" as const, beforeKind: "missing" as const, afterKind: "file" as const,
		beforeSize: 0, afterSize: 8, binary: false, truncated: false,
	};
	const tiny = summarizeCheckpoint({ checkpointId: "tiny", files: [{ ...textFile, diff: "@@ -0,0 +1 @@\n+hi\n" }] });
	assert.match(formatChangeSummary(tiny), /<patch>\n@@ -0,0 \+1 @@\n\+hi\n<\/patch>/);
	const big = summarizeCheckpoint({ checkpointId: "big", files: [{ ...textFile, diff: `@@ -0,0 +1 @@\n+${"x".repeat(9000)}\n` }] });
	assert.equal(big.patch, undefined);
	assert.deepEqual(big.files.map((file) => file.path), ["new.txt"]);
});

test("external failures are classified from structured data first and redact secrets", () => {
	assert.equal(classifyExternalError(new ExternalRpcError("whatever", -32000), "kimi"), "auth");
	assert.equal(classifyExternalError(new ExternalRpcError("whatever", -32000), "codex"), "other");
	assert.equal(classifyExternalError(new Error("connect ECONNREFUSED")), "network");
	assert.equal(classifyExternalError(new Error("Error: 429 Too Many Requests")), "rate_limit");
	assert.equal(classifyExternalError(new Error("Claude returned error_max_budget_usd")), "quota");
	assert.equal(classifyExternalError(new Error("maximum context exceeded")), "context");
	assert.equal(classifyExternalError(new Error("provider refusal")), "refusal");
	const described = describeExternalFailure("claude", new Error("Not logged in · Please run /login"), "stderr line");
	assert.equal(described.kind, "auth");
	assert.match(described.message, /提示：Claude Code 未登录[\s\S]*诊断输出（已脱敏）：\nstderr line/);
	const redacted = redactDiagnostic("key sk-ant-REALLYSECRETVALUE1234 Bearer abcdefghijklmnopqrstu and MY_TOKEN=supersecret99", { MY_TOKEN: "supersecret99" });
	assert.doesNotMatch(redacted, /REALLYSECRET|abcdefghijklmnopqrstu|supersecret99/);
	const secret = "local-example-sensitive-value";
	const boundary = describeExternalFailure("codex", new Error(`${" ".repeat(3996)}${secret}`), `stderr ${secret}`, { TEST_SECRET: secret });
	assert.doesNotMatch(boundary.message, /local-example|loca/);
});
