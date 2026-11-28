import assert from "node:assert/strict";
import { test } from "node:test";
import { editProfile, loadLibrary, ratingKey, recommend, validateProfileResources, type MultiCatalog } from "../src/multi-profiles.ts";
import { parseMultiAgentSettings } from "../src/multi-agent.ts";
import { discoverMultiSources, recentModelAccess } from "../src/multi-discovery.ts";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalExecutorDefinition } from "../src/external-registry.ts";
import type { ExternalTask } from "../src/external-types.ts";

const keyModel = "Kimi For Coding/k3.1-pro";
const catalog: MultiCatalog = {
	controllers: [
		{ id: "planner-pro", provider: "pi-api", name: "Planner", reasoning: true, contextWindow: 100000, thinkingLevels: ["low", "high"], cost: { input: 8, output: 20 } },
		{ id: "planner-flash", provider: "pi-api", name: "Flash", reasoning: false, contextWindow: 32000, thinkingLevels: ["off"], cost: { input: 0.2, output: 0.5 } },
	],
	sources: [
		{ id: "kimi", readOnly: false, models: [
			{ id: "kimi-code/k3", efforts: [], access: "subscription" },
			{ id: keyModel, efforts: ["off", "on"], access: "confirmed" },
		] },
		{ id: "codex", readOnly: true, models: [{ id: "implementation", efforts: ["low", "high"], access: "listed" }] },
		{ id: "claude", readOnly: true, models: [{ id: "opus", efforts: ["max"], access: "auth" }] },
	],
};
test("three profiles use reachable role-specific routes and model-specific effort, honoring cost overrides", () => {
	const library = loadLibrary();
	const extreme = recommend(catalog, "极致", library)!;
	assert.equal(extreme.implementation, "kimi");
	assert.deepEqual(extreme.executors?.kimi, { model: keyModel, effort: "on" });
	assert.equal(extreme.controller?.model?.id, "planner-pro");
	assert.deepEqual(extreme.reviewer, { executor: "codex", model: "implementation", effort: "high" });
	assert.deepEqual(extreme.allowed, ["codex", "kimi"]);
	validateProfileResources(extreme, catalog);
	const cheap = recommend(catalog, "平民", { saved: [], ratings: { [ratingKey("codex", "implementation")]: { cost: "low" } } })!;
	assert.equal(cheap.implementation, "codex");
	assert.equal(cheap.controller?.thinkingLevel, "off");
	assert.equal(cheap.reviewPolicy, "on-demand");
	assert.throws(() => validateProfileResources({ executors: { kimi: { model: "kimi-code/k3" } } }, catalog), /无模型权限/);
	assert.throws(() => validateProfileResources({ reviewer: { executor: "codex", model: "implementation", effort: "max" } }, catalog), /不支持/);
	assert.throws(() => parseMultiAgentSettings({ reviewer: { executor: "kimi" } }), /只读/);
	assert.throws(() => parseMultiAgentSettings({ allowed: ["codex"], implementation: "kimi" }), /允许/);
	assert.equal(recommend({ ...catalog, sources: [] }, "性价比", library), undefined);
});

test("named configs survive storage, retain old manual settings and undo an application independently of edits", () => {
	const manual = { executors: { kimi: { model: keyModel } } };
	const newConfig = recommend(catalog, "性价比", loadLibrary())!;
	const saved = editProfile(manual, loadLibrary(), { type: "save", name: "开发", config: newConfig });
	assert.deepEqual(saved.config, manual);
	const applied = editProfile(manual, saved.library, { type: "apply", name: "开发", config: newConfig });
	const reopened = loadLibrary(JSON.parse(JSON.stringify(applied.library)));
	assert.equal(reopened.active, "开发");
	assert.deepEqual(reopened.saved.find(p => p.name === "当前自定义")?.config, manual);
	const renamed = editProfile(applied.config, reopened, { type: "rename", name: "开发", newName: "开发 2" });
	assert.equal(renamed.library.active, "开发 2");
	const undone = editProfile(renamed.config, renamed.library, { type: "undo" });
	assert.deepEqual(undone.config, manual);
	assert.equal(editProfile(undone.config, undone.library, { type: "delete", name: "开发 2" }).library.saved.length, 1);
});
test("access evidence is scoped to a native route and newer successful runs clear failures", () => {
	const now = Date.now();
	const failure = { executor: "kimi", model: "kimi-code/k3", status: "failed", updatedAt: now - 10, accessFailure: "subscription" } as ExternalTask;
	assert.equal(recentModelAccess([failure], "kimi", keyModel), undefined);
	assert.equal(recentModelAccess([failure], "kimi", failure.model), "subscription");
	assert.equal(recentModelAccess([failure, { ...failure, status: "completed", updatedAt: now }], "kimi", failure.model), "confirmed");
	assert.equal(recentModelAccess([{ ...failure, updatedAt: now - 86400000 }], "kimi", failure.model), undefined);
});


test("Kimi discovery reads model-dependent efforts in an isolated ACP session while other sources remain disabled", async t => {
	const dir = await mkdtemp(join(tmpdir(), "kimi-discovery-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const executable = join(dir, "kimi.mjs");
	await cp(new URL("./fixtures/fake-kimi-acp.mjs", import.meta.url), executable);
	await chmod(executable, 0o700);
	const result = await discoverMultiSources([{ id: "kimi", executable, available: true, enabled: true,
		capabilities: externalExecutorDefinition("kimi")!.capabilities }], [], {
		env: { PATH: process.env.PATH, ACP_TEST_CONFIG: "1" }, nodeExecutable: process.execPath, helperPath: "/unused",
	});
	assert.deepEqual(result.find(s => s.id === "kimi")?.models.map(m => [m.id, m.efforts]), [
		["kimi-default", ["low"]], ["kimi-k3", ["low", "high"]],
	]);
	assert.ok(result.find(s => s.id === "claude")?.issue);
});
