import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import {
	BUILTIN_OUTPUT_STYLES,
	MAX_OUTPUT_STYLE_BYTES,
	discoverOutputStyles,
	findOutputStyle,
	outputStylePromptSection,
	parseOutputStyle,
	validOutputStyleName,
} from "../src/output-styles.ts";
import { editorChoice, editorUrl, launchesCode, parseOpenInEditorInput, resolveEditorTarget } from "../src/editor-open.ts";
import { resolveEditorPath } from "../src/editor-path.ts";
import { registerOutputStyle } from "../src/permission-extension.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("parseOutputStyle reads frontmatter and body", () => {
	const parsed = parseOutputStyle('---\nname: "Pirate"\ndescription: Talk like a pirate\nkeep-coding-instructions: true\n---\n\nAlways say arr.\n', "file");
	assert.deepEqual(parsed, { name: "Pirate", description: "Talk like a pirate", prompt: "Always say arr." });
	const bare = parseOutputStyle("Just a body\r\nline two", "terse");
	assert.equal(bare.name, "terse");
	assert.equal(bare.prompt, "Just a body\nline two");
	assert.equal(parseOutputStyle("---\nname: x\nno closing", "fb").name, "fb");
	assert.equal(validOutputStyleName("  ok  "), "ok");
	assert.equal(validOutputStyleName("bad\nname"), undefined);
	assert.equal(validOutputStyleName(""), undefined);
	assert.equal(validOutputStyleName(3), undefined);
});

test("built-in styles and prompt sections", () => {
	assert.deepEqual(BUILTIN_OUTPUT_STYLES.map((s) => s.name), ["default", "explanatory", "learning"]);
	assert.equal(outputStylePromptSection(findOutputStyle(BUILTIN_OUTPUT_STYLES, "default")), "");
	assert.equal(outputStylePromptSection(undefined), "");
	assert.match(outputStylePromptSection(findOutputStyle(BUILTIN_OUTPUT_STYLES, "LEARNING")), /TODO\(human\)/);
	assert.match(outputStylePromptSection(findOutputStyle(BUILTIN_OUTPUT_STYLES, "explanatory")), /Insight/);
});

test("discoverOutputStyles gates project styles on trust and caps file size", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-style-"));
	try {
		const home = join(root, "home");
		const project = join(root, "project");
		await mkdir(join(home, ".claude", "output-styles"), { recursive: true });
		await mkdir(join(project, ".claude", "output-styles"), { recursive: true });
		await writeFile(join(home, ".claude", "output-styles", "terse.md"), "---\nname: terse\ndescription: user one\n---\nBe terse.");
		await writeFile(join(home, ".claude", "output-styles", "huge.md"), `---\nname: huge\n---\n${"x".repeat(MAX_OUTPUT_STYLE_BYTES)}`);
		await writeFile(join(home, ".claude", "output-styles", "empty.md"), "---\nname: empty\n---\n");
		await writeFile(join(home, ".claude", "output-styles", "default.md"), "Override default?");
		await writeFile(join(home, ".claude", "output-styles", "notes.txt"), "ignored");
		await writeFile(join(project, ".claude", "output-styles", "team.md"), "---\nname: Team\ndescription: project one\n---\nFollow team rules.");
		await writeFile(join(project, ".claude", "output-styles", "terse.md"), "---\nname: terse\ndescription: project override\n---\nProject terse.");

		const untrusted = await discoverOutputStyles({ home, project, trusted: false });
		assert.deepEqual(untrusted.map((s) => s.name), ["default", "explanatory", "learning", "terse"]);
		assert.equal(findOutputStyle(untrusted, "terse")?.source, "user");
		assert.equal(findOutputStyle(untrusted, "default")?.prompt, "");

		const trusted = await discoverOutputStyles({ home, project, trusted: true });
		assert.deepEqual(trusted.map((s) => s.name).sort(), ["Team", "default", "explanatory", "learning", "terse"].sort());
		assert.equal(findOutputStyle(trusted, "team")?.source, "project");
		assert.equal(findOutputStyle(trusted, "terse")?.prompt, "Project terse.");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("registerOutputStyle writes the style file as a prompt section each turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-style-ext-"));
	try {
		const file = join(root, "style.md");
		type Event = { systemPrompt: string; systemPromptOptions: { sections: Record<string, string> } };
		const handlers: Array<(event: Event) => Promise<unknown>> = [];
		const pi = { on: (event: string, handler: (event: Event) => Promise<unknown>) => { if (event === "before_agent_start") handlers.push(handler); } };
		registerOutputStyle(pi as never, file);
		assert.equal(handlers.length, 1);
		const event = (): Event => ({ systemPrompt: "BASE", systemPromptOptions: { sections: { agent_types: "listing" } } });
		let current = event();
		assert.equal(await handlers[0](current), undefined, "missing file adds nothing");
		assert.deepEqual(current.systemPromptOptions.sections, { agent_types: "listing" });
		await writeFile(file, "# Output style: x\n\nBe brief.");
		current = event();
		// Never returns a forced systemPrompt, which would drop other handlers' sections.
		assert.equal(await handlers[0](current), undefined);
		assert.deepEqual(current.systemPromptOptions.sections, { agent_types: "listing", output_style: "# Output style: x\n\nBe brief." });
		await writeFile(file, "");
		current.systemPromptOptions.sections.output_style = "stale";
		assert.equal(await handlers[0](current), undefined, "default style adds nothing");
		assert.deepEqual(current.systemPromptOptions.sections, { agent_types: "listing" });
		const none: unknown[] = [];
		registerOutputStyle({ on: (...args: unknown[]) => none.push(args) } as never, undefined);
		assert.equal(none.length, 0, "children without a style file register nothing");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("editor URLs encode paths and validate input", () => {
	assert.equal(editorUrl("vscode", "/Users/a/My Project/src/a#b.ts", 12), "vscode://file/Users/a/My%20Project/src/a%23b.ts:12");
	assert.equal(editorUrl("cursor", "/tmp/中文.ts"), `cursor://file/tmp/${encodeURIComponent("中文.ts")}`);
	assert.equal(editorUrl("vscode", "C:\\work\\a b.ts", 3), "vscode://file/C:/work/a%20b.ts:3");
	assert.equal(editorChoice("cursor"), "cursor");
	assert.equal(editorChoice("emacs"), "vscode");
	assert.equal(editorChoice(undefined), "vscode");
	assert.deepEqual(parseOpenInEditorInput({ path: "/a/b.ts", line: 4 }), { path: "/a/b.ts", line: 4 });
	assert.deepEqual(parseOpenInEditorInput({ path: "/a/b.ts" }), { path: "/a/b.ts" });
	assert.throws(() => parseOpenInEditorInput({ path: "relative/b.ts" }), /绝对路径/);
	assert.throws(() => parseOpenInEditorInput({ path: "/a\0b" }), /格式错误/);
	assert.throws(() => parseOpenInEditorInput({ path: "/a", line: 0 }), /正整数/);
	assert.throws(() => parseOpenInEditorInput({ path: "/a", line: 1.5 }), /正整数/);
	assert.throws(() => parseOpenInEditorInput({ path: "/a", line: "3" }), /正整数/);
	assert.throws(() => parseOpenInEditorInput(null), /格式错误/);
});

test("resolveEditorPath joins project-relative paths in the renderer", () => {
	assert.equal(resolveEditorPath("/p/proj", "src/a.ts"), "/p/proj/src/a.ts");
	assert.equal(resolveEditorPath("/p/proj/", "./src/../b.ts"), "/p/proj/b.ts");
	assert.equal(resolveEditorPath("/p/proj", "/abs/c.ts"), "/abs/c.ts");
	assert.equal(resolveEditorPath(undefined, "src/a.ts"), undefined);
	assert.equal(resolveEditorPath("/p", "~/x"), undefined);
});

test("resolveEditorTarget only allows existing files inside known roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-editor-"));
	try {
		const project = join(root, "project");
		const outside = join(root, "outside");
		await mkdir(join(project, "src"), { recursive: true });
		await mkdir(outside);
		await writeFile(join(project, "src", "a.ts"), "x");
		await writeFile(join(outside, "secret.txt"), "x");
		await symlink(join(outside, "secret.txt"), join(project, "link.txt"));
		const real = await resolveEditorTarget(join(project, "src", "a.ts"), [project]);
		assert.ok(real.endsWith(join("project", "src", "a.ts")));
		await assert.rejects(resolveEditorTarget(join(outside, "secret.txt"), [project]), /只能打开/);
		await assert.rejects(resolveEditorTarget(join(project, "src", "..", "..", "outside", "secret.txt"), [project]), /只能打开/);
		await assert.rejects(resolveEditorTarget(join(project, "link.txt"), [project]), /只能打开/, "symlink escaping the project");
		await assert.rejects(resolveEditorTarget(join(project, "missing.ts"), [project]), /不存在/);
		await assert.rejects(resolveEditorTarget(join(project + "-sibling", "a.ts"), [project]), /不存在|只能打开/);
		await assert.rejects(resolveEditorTarget("src/a.ts", [project]), /绝对路径/);
		await writeFile(join(project, "run"), "#!/bin/sh\n");
		await chmod(join(project, "run"), 0o755);
		const file = { isFile: () => true, isDirectory: () => false, mode: 0o644 };
		assert.equal(launchesCode("/p/a.ts", file), false);
		assert.equal(launchesCode("/p/install.command", file), true);
		assert.equal(launchesCode("/p/Thing.app", { isFile: () => false, isDirectory: () => true, mode: 0o755 }), true);
		assert.equal(launchesCode("/p/run", { ...file, mode: 0o755 }), true);
		assert.equal(launchesCode("/p/src", { isFile: () => false, isDirectory: () => true, mode: 0o755 }), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DesktopService persists outputStyle and editor, and lists styles by trust", async () => {
	const fixture = await createCoreFixture();
	const home = fixture.root;
	await mkdir(join(home, ".claude", "output-styles"), { recursive: true });
	await writeFile(join(home, ".claude", "output-styles", "terse.md"), "---\nname: terse\ndescription: brief\n---\nBe terse.");
	await mkdir(join(fixture.project, ".claude", "output-styles"), { recursive: true });
	await writeFile(join(fixture.project, ".claude", "output-styles", "team.md"), "---\nname: team\n---\nTeam rules.");
	const service = new DesktopService({
		dataDir: fixture.dataDir,
		executable: process.execPath,
		entry: fixture.entry,
		permissionExtension: resolve(here, "../src/permission-extension.ts"),
		toolControlExtension: resolve(here, "../src/tool-control-extension.ts"),
		navigationExtension: resolve(here, "../src/session-navigation-extension.ts"),
		historyEntry: resolve(here, "../src/session-history-entry.ts"),
		env: { ...fixture.env, HOME: home },
		initialProject: fixture.project,
	});
	try {
		await service.initialize();
		const names = (await service.outputStyles()).map((s) => s.name);
		assert.ok(names.includes("terse") && !names.includes("team"), "untrusted project styles are hidden");
		const base = (await service.snapshot()).settings;
		await assert.rejects(service.saveSettings({ permission: base.permission, theme: base.theme, outputStyle: "team" }), /找不到输出风格/);

		await service.setProjectTrust({ project: fixture.project, decision: "trusted" });
		assert.ok((await service.outputStyles()).some((s) => s.name === "team" && s.source === "project"));

		let snapshot = await service.saveSettings({ permission: base.permission, theme: base.theme, outputStyle: "Terse", editor: "cursor" });
		assert.equal(snapshot.settings.outputStyle, "terse");
		assert.equal(snapshot.settings.editor, "cursor");
		assert.equal(service.editorSetting(), "cursor");
		await assert.rejects(service.saveSettings({ permission: base.permission, theme: base.theme, editor: "emacs" as never }), /编辑器设置无效/);

		// The running main conversation's style file reflects the new style without a restart.
		const styleFiles = (await readdir(fixture.dataDir)).filter((name) => /^style-.*\.md$/.test(name));
		if (styleFiles.length) assert.match(await readFile(join(fixture.dataDir, styleFiles[0]), "utf8"), /Be terse\./);

		snapshot = await service.saveSettings({ permission: base.permission, theme: base.theme, outputStyle: null });
		assert.equal(snapshot.settings.outputStyle, undefined);
		if (styleFiles.length) assert.equal(await readFile(join(fixture.dataDir, styleFiles[0]), "utf8"), "");

		const roots = await service.editorRoots();
		assert.ok(roots.length > 0, JSON.stringify(roots));
		assert.ok(await resolveEditorTarget(join(fixture.project, "seed.txt"), roots));
		const store = JSON.parse(await readFile(join(fixture.dataDir, "state.json"), "utf8").catch(() => "{}"));
		if (store.settings) assert.equal(store.settings.editor, "cursor");
	} finally {
		await service.close?.();
		await fixture.cleanup();
	}
});
