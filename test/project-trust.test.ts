import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { detectProjectTrustResources } from "../src/project-trust.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../src/permission-extension.ts");

test("detects protected project resources, including ancestor .agents skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-trust-"));
	try {
		await mkdir(join(root, ".git"));
		const project = join(root, "project");
		await mkdir(join(project, ".pi", "skills", "demo"), { recursive: true });
		await writeFile(join(project, ".pi", "settings.json"), "{}");
		await writeFile(join(project, ".pi", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
		await mkdir(join(root, ".agents", "skills"), { recursive: true });
		assert.deepEqual(await detectProjectTrustResources(project), [".pi/settings.json", ".pi/skills", "../.agents/skills"].sort());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project trust gates .pi settings and persists across restarts", { timeout: 60000 }, async () => {
	const fixture = await createCoreFixture();
	const options = {
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: extension,
		env: fixture.env,
		initialProject: fixture.project,
	};
	let service: DesktopService | undefined;
	try {
		await mkdir(join(fixture.project, ".pi"), { recursive: true });
		await writeFile(join(fixture.project, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));

		service = new DesktopService(options);
		let snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		assert.equal(snapshot.trust?.required, true);
		assert.equal(snapshot.trust?.decision, undefined);
		assert.deepEqual(snapshot.trust?.resources, [".pi/settings.json"]);
		assert.equal(snapshot.state?.thinkingLevel, "medium");

		const project = snapshot.active!.project;
		snapshot = await service.setProjectTrust({ project, decision: "trusted" });
		assert.equal(snapshot.trust?.decision, "trusted");
		assert.equal(snapshot.state?.thinkingLevel, "high");
		const stored = JSON.parse(await readFile(join(fixture.dataDir, "desktop.json"), "utf8")) as {
			projectTrust?: Record<string, string>;
		};
		assert.equal(stored.projectTrust?.[project], "trusted");

		await service.close();
		service = new DesktopService(options);
		snapshot = await service.initialize();
		assert.equal(snapshot.engineStatus, "ready", snapshot.engineError);
		assert.equal(snapshot.trust?.decision, "trusted");
		assert.equal(snapshot.state?.thinkingLevel, "high");

		snapshot = await service.setProjectTrust({ project, decision: "untrusted" });
		assert.equal(snapshot.trust?.decision, "untrusted");
		assert.equal(snapshot.state?.thinkingLevel, "medium");
	} finally {
		await service?.close();
		await fixture.cleanup();
	}
});
