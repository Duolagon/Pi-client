import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitSnapshots } from "../src/git-snapshots.ts";

const exec = promisify(execFile);
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-git-snapshots-"));
	const project = join(root, "project");
	const data = join(root, "app-data");
	await mkdir(project);
	await exec("git", ["init", project]);
	await writeFile(join(project, ".gitignore"), "ignored/\n");
	await writeFile(join(project, "tracked.txt"), "index baseline\n");
	await exec("git", ["add", "--", ".gitignore", "tracked.txt"], { cwd: project });
	await writeFile(join(project, "tracked.txt"), "user's unstaged work\n");
	await writeFile(join(project, "untracked.txt"), "user's untracked work\n");
	await mkdir(join(project, "ignored"));
	await writeFile(join(project, "ignored", "secret.txt"), "ignored data");
	return { project, data, service: new GitSnapshots(data), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("checkpoints restore actual worktree changes and preserve prior edits, ignored files, and Git index", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const index = await readFile(join(project, ".git", "index"));
		const start = await service.begin(project, "conversation-1", "Implement a feature");
		assert.equal(start.status, "pending");
		await assert.rejects(service.restore(project, start.id), /未完成|尚未结束/);
		await writeFile(join(project, "tracked.txt"), "agent update\n");
		await rm(join(project, "untracked.txt"));
		await mkdir(join(project, "new-folder"));
		await writeFile(join(project, "new-folder", "new.txt"), "agent new file\n");
		await writeFile(join(project, "ignored", "secret.txt"), "ignored external edit");
		const finished = await service.finish(project, start.id);
		assert.equal(finished.status, "ready");
		assert.deepEqual(
			finished.changes.map((item) => item.path),
			["new-folder", "new-folder/new.txt", "tracked.txt", "untracked.txt"],
		);
		assert.deepEqual(await readFile(join(project, ".git", "index")), index);
		const diff = await service.diff(project, start.id, "tracked.txt");
		assert.match(diff.files[0].diff, /-user's unstaged work/);
		assert.match(diff.files[0].diff, /\+agent update/);
		const reloaded = new GitSnapshots(data);
		assert.equal((await reloaded.list(project, "conversation-1"))[0].id, start.id);
		assert.equal((await reloaded.list(project, "other")).length, 0);
		const restored = await reloaded.restore(project, start.id);
		assert.equal(restored.status, "restored", JSON.stringify(restored));
		assert.equal(restored.checkpoint.status, "restored");
		assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "user's unstaged work\n");
		assert.equal(await readFile(join(project, "untracked.txt"), "utf8"), "user's untracked work\n");
		await assert.rejects(lstat(join(project, "new-folder")), { code: "ENOENT" });
		assert.equal(await readFile(join(project, "ignored", "secret.txt"), "utf8"), "ignored external edit");
		assert.deepEqual(await readFile(join(project, ".git", "index")), index);
		assert.equal((await reloaded.restore(project, start.id)).status, "unchanged");
	} finally {
		await cleanup();
	}
});

test("restore preflights every selected file before writing and reports external edits as conflicts", async () => {
	const { project, service, cleanup } = await fixture();
	try {
		const start = await service.begin(project, "conversation-2");
		await writeFile(join(project, "tracked.txt"), "agent tracked");
		await writeFile(join(project, "untracked.txt"), "agent untracked");
		await service.finish(project, start.id);
		await writeFile(join(project, "tracked.txt"), "external edit after finish");
		const result = await service.restore(project, start.id);
		assert.equal(result.status, "conflict");
		assert.ok(result.conflicts.some((item) => item.path === "tracked.txt"));
		assert.equal(await readFile(join(project, "untracked.txt"), "utf8"), "agent untracked");
		assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "external edit after finish");
		const partial = await service.restore(project, start.id, ["untracked.txt"]);
		assert.equal(partial.status, "restored");
		assert.equal(partial.checkpoint.status, "partially-restored");
		assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "external edit after finish");
		await writeFile(join(project, "tracked.txt"), "agent tracked");
		assert.equal((await service.restore(project, start.id)).checkpoint.status, "restored");
	} finally {
		await cleanup();
	}
});

test("binary bytes, executable permissions, deletion, and symlinks survive a durable checkpoint", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const original = Buffer.from([0, 1, 255, 0, 17]);
		await writeFile(join(project, "binary.bin"), original);
		await writeFile(join(project, "run.sh"), "#!/bin/sh\nprintf original\n");
		await chmod(join(project, "run.sh"), 0o755);
		await writeFile(join(project, "outside.txt"), "outside original");
		await symlink("outside.txt", join(project, "link"));
		const start = await service.begin(project, "conversation-3");
		await writeFile(join(project, "binary.bin"), Buffer.from([0, 42]));
		await chmod(join(project, "run.sh"), 0o644);
		await rm(join(project, "link"));
		await symlink("/this/target/does/not/exist", join(project, "link"));
		const finished = await service.finish(project, start.id);
		assert.equal(finished.changes.find((item) => item.path === "binary.bin")?.binary, true);
		const diff = await service.diff(project, start.id, "binary.bin");
		assert.match(diff.files[0].diff, /Binary files/);
		assert.equal((await new GitSnapshots(data).restore(project, start.id)).status, "restored");
		assert.deepEqual(await readFile(join(project, "binary.bin")), original);
		assert.equal((await lstat(join(project, "run.sh"))).mode & 0o777, 0o755);
		assert.equal(await readlink(join(project, "link")), "outside.txt");
		assert.equal(await readFile(join(project, "outside.txt"), "utf8"), "outside original");
	} finally {
		await cleanup();
	}
});

test("file/directory transitions restore in dependency order and reject unseen children", async () => {
	const { project, service, cleanup } = await fixture();
	try {
		await writeFile(join(project, "was-file"), "original file");
		await mkdir(join(project, "was-dir"));
		await writeFile(join(project, "was-dir", "child.txt"), "original child");
		const start = await service.begin(project, "conversation-4");
		await rm(join(project, "was-file"));
		await mkdir(join(project, "was-file"));
		await writeFile(join(project, "was-file", "new.txt"), "new child");
		await rm(join(project, "was-dir"), { recursive: true });
		await writeFile(join(project, "was-dir"), "replacement file");
		await service.finish(project, start.id);
		const incomplete = await service.restore(project, start.id, ["was-file"]);
		assert.equal(incomplete.status, "conflict");
		assert.equal(await readFile(join(project, "was-dir"), "utf8"), "replacement file");
		await writeFile(join(project, "was-file", "external.txt"), "keep me");
		const conflicted = await service.restore(project, start.id);
		assert.equal(conflicted.status, "conflict");
		assert.equal(await readFile(join(project, "was-file", "external.txt"), "utf8"), "keep me");
		await rm(join(project, "was-file", "external.txt"));
		const restored = await service.restore(project, start.id);
		assert.equal(restored.status, "restored", JSON.stringify(restored));
		assert.equal(await readFile(join(project, "was-file"), "utf8"), "original file");
		assert.equal(await readFile(join(project, "was-dir", "child.txt"), "utf8"), "original child");
	} finally {
		await cleanup();
	}
});

test("paths and symlink ancestors cannot escape the project or overwrite outside files", async () => {
	const { project, service, cleanup } = await fixture();
	try {
		await mkdir(join(project, "folder"));
		await writeFile(join(project, "folder", "file.txt"), "original");
		const outside = join(project, "..", "outside");
		await mkdir(outside);
		await writeFile(join(outside, "file.txt"), "private outside");
		const start = await service.begin(project, "conversation-5");
		await writeFile(join(project, "folder", "file.txt"), "agent change");
		await service.finish(project, start.id);
		await rm(join(project, "folder"), { recursive: true });
		await symlink(outside, join(project, "folder"));
		const result = await service.restore(project, start.id);
		assert.equal(result.status, "conflict");
		assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "private outside");
		await assert.rejects(service.restore(project, start.id, ["../outside/file.txt"]), /路径/);
		await assert.rejects(service.diff(project, start.id, ".git/index"), /路径/);
		await assert.rejects(service.restore(project, "../../escape"), /ID/);
	} finally {
		await cleanup();
	}
});

test("corrupt snapshot blobs are rejected before replacing the original file", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const start = await service.begin(project, "conversation-6");
		await writeFile(join(project, "tracked.txt"), "agent changed file");
		await writeFile(join(project, "agent-created.txt"), "agent-created content");
		await service.finish(project, start.id);
		const blobs = join(data, "git-snapshots", "blobs");
		for (const name of await readdir(blobs)) await writeFile(join(blobs, name), "corrupt");
		const result = await service.restore(project, start.id);
		assert.equal(result.status, "conflict");
		assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "agent changed file");
		assert.equal(await readFile(join(project, "agent-created.txt"), "utf8"), "agent-created content");
	} finally {
		await cleanup();
	}
});

test("valid unusual Git filenames do not collide with JavaScript object properties", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const paths = ["__proto__", "constructor", "toString", "space name.txt", "line\nbreak.txt"];
		for (const path of paths) await writeFile(join(project, path), `original ${path}`);
		const start = await service.begin(project, "conversation-7");
		for (const path of paths) await writeFile(join(project, path), `agent ${path}`);
		await service.finish(project, start.id);
		assert.equal((await new GitSnapshots(data).restore(project, start.id)).status, "restored");
		for (const path of paths) assert.equal(await readFile(join(project, path), "utf8"), `original ${path}`);
	} finally {
		await cleanup();
	}
});

test("corrupt manifests cannot inject a filesystem path or omit the baseline", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const start = await service.begin(project, "conversation-8");
		const directories = (await readdir(join(data, "git-snapshots"))).filter((name) => name !== "blobs");
		const manifestPath = join(data, "git-snapshots", directories[0], `${start.id}.json`);
		const original = await readFile(manifestPath, "utf8");
		const corrupted = JSON.parse(original) as { before?: Record<string, unknown> };
		corrupted.before = { "../outside.txt": { kind: "missing" } };
		await writeFile(manifestPath, JSON.stringify(corrupted));
		await assert.rejects(service.list(project), /路径/);
		delete corrupted.before;
		await writeFile(manifestPath, JSON.stringify(corrupted));
		await assert.rejects(service.list(project), /任务前状态/);
	} finally {
		await cleanup();
	}
});

test("archived checkpoint metadata and diffs remain readable after the original project is removed", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const checkpoint = await service.begin(project, "archived-conversation");
		await writeFile(join(project, "tracked.txt"), "completed task content\n");
		await service.finish(project, checkpoint.id);
		await rm(project, { recursive: true });
		const reloaded = new GitSnapshots(data);
		assert.equal((await reloaded.list(checkpoint.project))[0].id, checkpoint.id);
		assert.equal((await reloaded.list(project, "archived-conversation"))[0].id, checkpoint.id);
		const diff = await reloaded.diff(checkpoint.project, checkpoint.id, "tracked.txt");
		assert.match(diff.files[0].diff, /-user's unstaged work/);
		assert.match(diff.files[0].diff, /\+completed task content/);
		await assert.rejects(reloaded.restore(checkpoint.project, checkpoint.id), { code: "ENOENT" });
		await assert.rejects(reloaded.diff(join(checkpoint.project, "different-project"), checkpoint.id), {
			code: "ENOENT",
		});
	} finally {
		await cleanup();
	}
});

test("selected-file restore recreates missing ancestor permissions and remains compatible with a later full restore", async () => {
	const { project, service, cleanup } = await fixture();
	try {
		await mkdir(join(project, "private"), { mode: 0o700 });
		await writeFile(join(project, "private", "file.txt"), "private original");
		const checkpoint = await service.begin(project, "private-directory");
		await rm(join(project, "private"), { recursive: true });
		await service.finish(project, checkpoint.id);
		assert.equal((await service.restore(project, checkpoint.id, ["private/file.txt"])).status, "restored");
		assert.equal((await lstat(join(project, "private"))).mode & 0o777, 0o700);
		assert.equal(await readFile(join(project, "private", "file.txt"), "utf8"), "private original");
		assert.equal((await service.restore(project, checkpoint.id)).checkpoint.status, "restored");
	} finally {
		await cleanup();
	}
});

test("materializeBefore reconstructs files, directories, and symlinks from the wish start state", async () => {
	const { project, data, service, cleanup } = await fixture();
	const copy = await mkdtemp(join(tmpdir(), "pi-git-snapshots-copy-"));
	try {
		await mkdir(join(project, "nested"));
		await writeFile(join(project, "nested", "inner.txt"), "inner original\n");
		await writeFile(join(project, "target.txt"), "link target\n");
		await symlink("target.txt", join(project, "link"));
		const start = await service.begin(project, "conversation-materialize");
		// Mutate the worktree after the wish start; materializeBefore must ignore these.
		await rm(join(project, "link"));
		await writeFile(join(project, "target.txt"), "changed after start\n");
		await service.finish(project, start.id);
		const destination = join(copy, "before");
		await new GitSnapshots(data).materializeBefore(project, start.id, destination);
		assert.equal(await readFile(join(destination, "tracked.txt"), "utf8"), "user's unstaged work\n");
		assert.equal(await readFile(join(destination, "nested", "inner.txt"), "utf8"), "inner original\n");
		assert.equal(await readFile(join(destination, "target.txt"), "utf8"), "link target\n");
		const info = await lstat(join(destination, "link"));
		assert.ok(info.isSymbolicLink(), "snapshot symlink must be recreated in the before-state copy");
		assert.equal(await readlink(join(destination, "link")), "target.txt");
	} finally {
		await rm(copy, { recursive: true, force: true });
		await cleanup();
	}
});

test("worktree review readiness checks only the selected project and does not save new blobs", async () => {
	const { project, data, service, cleanup } = await fixture();
	try {
		const selected = join(project, "packages", "app");
		await mkdir(selected, { recursive: true });
		const target = join(selected, "feature.txt");
		await writeFile(target, "before\n");
		const start = await service.begin(selected, "review-readiness");
		const blobNames = (await readdir(join(data, "git-snapshots", "blobs"))).sort();
		assert.equal(await service.hasWorktreeChanges(selected, start.id, "review-readiness"), false);

		await writeFile(join(project, "tracked.txt"), "Edited outside selected project\n");
		assert.equal(await service.hasWorktreeChanges(selected, start.id), false);
		await writeFile(target, "after\n");
		assert.equal(await service.hasWorktreeChanges(selected, start.id), true);
		assert.deepEqual((await readdir(join(data, "git-snapshots", "blobs"))).sort(), blobNames);
		await writeFile(target, "before\n");
		assert.equal(await service.hasWorktreeChanges(selected, start.id), false);
		await truncate(target, 65 * 1024 * 1024);
		assert.equal(await service.hasWorktreeChanges(selected, start.id), true);
		assert.equal((await service.diffToWorktree(selected, start.id)).excludedFiles, 1);
	} finally {
		await cleanup();
	}
});

test("worktree review retains file-to-directory changes and does not rewrite patch content", async () => {
	const { project, service, cleanup } = await fixture();
	try {
		await writeFile(join(project, ".gitignore"), "ignored/\nstructural/cache.txt\n");
		const structural = join(project, "structural");
		await writeFile(structural, "before\n");
		await writeFile(join(project, "tracked.txt"), "-- previous text\n");
		const start = await service.begin(project, "review-structure");
		await rm(structural);
		await mkdir(structural);
		await writeFile(join(structural, "cache.txt"), "ignored cache\n");
		await writeFile(join(project, "tracked.txt"), "++ updated text\n");
		const result = await service.diffToWorktree(project, start.id);
		assert.equal(result.files.find((file) => file.path === "structural")?.status, "type-changed");
		assert.match(result.files.find((file) => file.path === "structural")?.diff ?? "", /file → directory/);
		assert.match(result.files.find((file) => file.path === "tracked.txt")?.diff ?? "", /\n--- previous text\n\+\+\+ updated text\n/);

		const cancelled = new Error("review cancelled");
		const signal = AbortSignal.abort(cancelled);
		await assert.rejects(service.hasWorktreeChanges(project, start.id, undefined, signal), cancelled);
		await assert.rejects(service.diffToWorktree(project, start.id, undefined, signal), cancelled);
		await assert.rejects(service.materializeBefore(project, start.id, join(project, "..", "review-copy"), signal), cancelled);
	} finally {
		await cleanup();
	}
});

test("oversized files stay out of rollback even if they later fit within the snapshot", async () => {
	const { project, data, service, cleanup } = await fixture();
	const oversized = join(project, "large.bin");
	try {
		await writeFile(oversized, "");
		await truncate(oversized, 65 * 1024 * 1024);
		const start = await service.begin(project, "oversized");
		assert.equal(start.excludedFiles, 1);
		await writeFile(oversized, "new contents that must remain");
		await writeFile(join(project, "tracked.txt"), "agent edit");
		const finished = await service.finish(project, start.id);
		assert.equal(finished.excludedFiles, 1);
		assert.deepEqual(finished.changes.map((item) => item.path), ["tracked.txt"]);
		const reloaded = new GitSnapshots(data);
		assert.equal((await reloaded.list(project, "oversized"))[0].excludedFiles, 1);
		assert.equal((await reloaded.diffToWorktree(project, start.id)).excludedFiles, 1);
		await assert.rejects(reloaded.restore(project, start.id, ["large.bin"]), /实际发生变化/);
		assert.equal((await reloaded.restore(project, start.id)).status, "restored");
		assert.equal(await readFile(oversized, "utf8"), "new contents that must remain");
		assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "user's unstaged work\n");
	} finally {
		await cleanup();
	}
});
