import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWorkspaceOutline } from "../src/language-service.ts";

test("the workspace outline continues past denied candidates and reports a limited result", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-outline-quota-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "a-private"));
	await mkdir(join(root, "z-public"));
	await Promise.all(Array.from({ length: 60 }, (_, index) =>
		writeFile(join(root, "a-private", index + ".ts"), "export const hidden = true;\n"),
	));
	await writeFile(join(root, "z-public", "module.ts"), "export interface Visible {}\n");
	const allowFile = async (path: string) => path.startsWith("z-public/");
	const complete = await buildWorkspaceOutline(root, ".", allowFile, undefined, 1);
	assert.deepEqual(complete.files.map((file) => file.path), ["z-public/module.ts"]);
	assert.equal(complete.truncated, false);
	await mkdir(join(root, "z-public", "nested"));
	await writeFile(join(root, "z-public", "nested", "second.ts"), "export function more() {}\n");
	const limited = await buildWorkspaceOutline(root, ".", allowFile, undefined, 1);
	assert.deepEqual(limited.files.map((file) => file.path), ["z-public/module.ts"]);
	assert.equal(limited.truncated, true);
	assert.match(limited.formatted, /1 file\(s\), truncated/);
});

test("the workspace outline skips commented declarations and multiline strings and keeps original source lines", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-outline-symbols-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "module.ts"), [
		"/* Illustrative snippet",
		"export class CommentExample {}",
		"*/",
		"export abstract class Repository {}",
		"const template = \x60",
		"export function TemplateExample() {}",
		"\x60;",
		"export default async function openProject() {}",
	].join("\n"));
	await writeFile(join(root, "module.py"), '"""Example:\ndef docstring_example():\n    pass\n"""\nasync def load():\n    pass\n');
	const outline = await buildWorkspaceOutline(root, ".");
	const actual = Object.fromEntries(outline.files.map(({ path, symbols }) => [path, symbols.map(({ name, line }) => [name, line])]));
	assert.deepEqual(actual, { "module.py": [["load", 5]], "module.ts": [["Repository", 4], ["openProject", 8]] });
	assert.equal(outline.truncated, false);
});
