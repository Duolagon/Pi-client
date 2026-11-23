import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileReferences, formatFileReference, insertFileReference, referenceQuery, removeFileReference } from "../src/file-references.ts";
import { projectMemoryContext } from "../src/project-memory.ts";
import { searchWorkspaceFiles } from "../src/workspace-file-search.ts";

const exec = promisify(execFile);

test("completing an @ reference preserves surrounding text and supports quoted paths", () => {
	const original = "前文 @aud 后文";
	const cursor = original.indexOf(" 后文");
	const query = referenceQuery(original, cursor);
	assert.deepEqual(query, { query: "aud", from: 3, to: cursor });
	const result = insertFileReference(original, query!, 'src/audit "notes".md', false);
	const expected = '前文 @"src/audit \\"notes\\".md" 后文';
	assert.equal(result.text, expected);
	assert.equal(result.cursor, expected.indexOf(" 后文"));
	const [ref] = fileReferences(result.text);
	assert.equal(ref.path, 'src/audit "notes".md');
	assert.deepEqual(removeFileReference(result.text, ref, { start: result.cursor, end: result.cursor }), {
		text: "前文 后文", selection: { start: 3, end: 3 },
	});
	assert.deepEqual(removeFileReference(result.text, ref, { start: result.cursor + 1, end: result.text.length }), {
		text: "前文 后文", selection: { start: 3, end: 5 },
	});
	assert.equal(formatFileReference("src/readme.md"), "@src/readme.md");
	const backticks = "src/`literal`.md";
	assert.equal(fileReferences(formatFileReference(backticks))[0]?.path, backticks);
	assert.equal(referenceQuery(" `@notes` ", 8), undefined);
});

test("file lookup can reach beyond the small shallow composer list", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-file-search-"));
	try {
		await exec("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, ".gitignore"), "ignored/\n");
		await mkdir(join(root, "ignored"));
		await writeFile(join(root, "ignored", "audit notes.md"), "ignored");
		await writeFile(join(root, ".env"), "excluded");
		const directory = "packages/ui/src/components/deep/testing";
		await mkdir(join(root, directory), { recursive: true });
		await writeFile(join(root, directory, 'audit "notes".md'), "Fixture content for a deep workspace reference.\n");
		await Promise.all(Array.from({ length: 425 }, (_, i) => writeFile(join(root, `prefill-${i}.txt`), "fixture")));
		const results = await searchWorkspaceFiles(root, "audit", process.env);
		assert.deepEqual(results.map(({ path }) => path), [`${directory}/audit "notes".md`]);
		const lookupWithoutExecutables = await searchWorkspaceFiles(root, "deep/testing/audit", { PATH: "/nonexistent" });
		// A folder search starts from the supplied workspace-relative path.
		assert.deepEqual(lookupWithoutExecutables, []);
		const fallback = await searchWorkspaceFiles(root, "packages/ui/src/components/deep/testing/audit", { PATH: "/nonexistent" });
		assert.equal(fallback[0]?.name, 'audit "notes".md');
		assert.deepEqual(await searchWorkspaceFiles(root, ".env", process.env), []);
		const prompt = `参考 ${formatFileReference(`${directory}/audit "notes".md`)} 后再执行。`;
		assert.match(await projectMemoryContext(root, prompt), /Fixture content for a deep workspace reference/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
