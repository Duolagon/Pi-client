import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { WorktreeService } from "../src/worktree-service.ts";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, env });
	return stdout.trim();
}

async function commit(cwd: string, message: string): Promise<void> {
	await git(cwd, "-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", message);
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-test-")));
	const project = join(root, "repo with spaces");
	const dataDir = join(root, "app-data");
	await mkdir(project);
	await mkdir(dataDir);
	await git(project, "-c", "init.defaultBranch=main", "init");
	await writeFile(join(project, "seed.txt"), "original\n");
	await writeFile(join(project, ".gitignore"), "ignored.txt\nnode_modules/\n");
	await git(project, "add", "--", "seed.txt", ".gitignore");
	await commit(project, "feat: Initialize worktree fixture");
	return { root, project, dataDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("worktree creation isolates HEAD without touching dirty files or the original index", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		await writeFile(join(data.project, "seed.txt"), "staged\n");
		await git(data.project, "add", "--", "seed.txt");
		await writeFile(join(data.project, "seed.txt"), "user-unstaged\n");
		await writeFile(join(data.project, "user-new.txt"), "keep untracked\n");
		const index = await readFile(join(data.project, ".git", "index"));
		const before = await git(data.project, "status", "--porcelain=v1");
		const worktree = await service.create({ project: data.project, conversationId: "conversation-one" });
		assert.equal(worktree.status, "ready");
		assert.equal(worktree.repository, data.project);
		assert.match(worktree.branch, /^pi-desktop\/[a-f0-9-]+$/);
		assert.equal(await readFile(join(worktree.path, "seed.txt"), "utf8"), "original\n");
		await assert.rejects(access(join(worktree.path, "user-new.txt")));
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "user-unstaged\n");
		assert.deepEqual(await readFile(join(data.project, ".git", "index")), index);
		assert.equal(await git(data.project, "status", "--porcelain=v1"), before);
		await writeFile(join(worktree.path, "seed.txt"), "isolated edit\n");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "user-unstaged\n");
		assert.deepEqual((await service.list(data.project)).map((item) => item.id), [worktree.id]);
		assert.equal((await lstat(join(worktree.path, ".git"))).isFile(), true);
	} finally { await data.cleanup(); }
});

test("parallel creation has unique branches and bindings survive a service restart", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const trees = await Promise.all(Array.from({ length: 3 }, () => service.create({ project: data.project })));
		assert.equal(new Set(trees.map((item) => item.path)).size, 3);
		assert.equal(new Set(trees.map((item) => item.branch)).size, 3);
		await service.bindConversation(trees[0].id, "bound-conversation");
		const restored = new WorktreeService({ dataDir: data.dataDir, env });
		await restored.initialize();
		const list = await restored.list();
		assert.equal(list.length, 3);
		assert.equal(list.find((item) => item.id === trees[0].id)?.conversationId, "bound-conversation");
		assert.ok(list.every((item) => item.status === "ready"));
		await assert.rejects(restored.remove("../../external"), /本客户端/);
	} finally { await data.cleanup(); }
});

test("active guards block both merge and deletion until the host releases the task", { timeout: 30000 }, async () => {
	const data = await fixture();
	let active = true;
	const service = new WorktreeService({ dataDir: data.dataDir, env, isActive: () => active });
	try {
		const tree = await service.create({ project: data.project });
		await assert.rejects(service.remove(tree.id), /活动任务|终端/);
		assert.equal((await service.merge(tree.id)).status, "blocked");
		active = false;
		const removed = await service.remove(tree.id);
		assert.equal(removed.branchRetained, false);
		await assert.rejects(access(tree.path));
		assert.deepEqual(await service.list(), []);
		await assert.rejects(git(data.project, "rev-parse", "--verify", `refs/heads/${tree.branch}`));
	} finally { await data.cleanup(); }
});

test("dirty and ignored files prevent deletion without losing user data", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		await writeFile(join(tree.path, "new.txt"), "unsaved\n");
		await assert.rejects(service.remove(tree.id), /未提交|未跟踪/);
		assert.equal(await readFile(join(tree.path, "new.txt"), "utf8"), "unsaved\n");
		await rm(join(tree.path, "new.txt"));
		await writeFile(join(tree.path, "ignored.txt"), "local private data\n");
		await assert.rejects(service.remove(tree.id), /忽略/);
		assert.equal(await readFile(join(tree.path, "ignored.txt"), "utf8"), "local private data\n");
	} finally { await data.cleanup(); }
});

test("fast-forward merge changes only the target branch and retains no uncommitted state", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		await writeFile(join(tree.path, "seed.txt"), "worktree change\n");
		assert.equal((await service.merge(tree.id)).status, "blocked", "Uncommitted work must never be implicitly committed");
		await git(tree.path, "add", "--", "seed.txt");
		await commit(tree.path, "feat: Add isolated worktree change");
		const merged = await service.merge(tree.id);
		assert.equal(merged.status, "merged");
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "worktree change\n");
		assert.equal(await git(data.project, "status", "--porcelain=v1"), "");
		assert.equal(await git(data.project, "branch", "--show-current"), "main");
		assert.equal((await service.merge(tree.id)).status, "up-to-date");
		assert.equal((await service.remove(tree.id)).branchRetained, false);
	} finally { await data.cleanup(); }
});

test("diverged or dirty targets are not merged and unmerged commits survive worktree removal", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		await writeFile(join(tree.path, "result.txt"), "isolated result\n");
		await git(tree.path, "add", "--", "result.txt");
		await commit(tree.path, "feat: Add isolated result");
		await writeFile(join(data.project, "dirty.txt"), "local work\n");
		assert.equal((await service.merge(tree.id)).status, "blocked");
		await rm(join(data.project, "dirty.txt"));
		await writeFile(join(data.project, "main.txt"), "main branch change\n");
		await git(data.project, "add", "--", "main.txt");
		await commit(data.project, "feat: Add main branch change");
		const head = await git(data.project, "rev-parse", "HEAD");
		const merged = await service.merge(tree.id);
		assert.equal(merged.status, "blocked");
		if (merged.status === "blocked") assert.match(merged.reason, /分叉/);
		assert.equal(await git(data.project, "rev-parse", "HEAD"), head);
		await assert.rejects(access(join(data.project, "result.txt")));
		const sourceHead = await git(tree.path, "rev-parse", "HEAD");
		const removed = await service.remove(tree.id);
		assert.equal(removed.branchRetained, true);
		assert.equal(await git(data.project, "rev-parse", `refs/heads/${tree.branch}`), sourceHead);
	} finally { await data.cleanup(); }
});

test("fast-forward merge refuses to overwrite ignored target files", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		await writeFile(join(tree.path, "ignored.txt"), "tracked branch value\n");
		await git(tree.path, "add", "-f", "--", "ignored.txt");
		await commit(tree.path, "feat: Track previously ignored file");
		await writeFile(join(data.project, "ignored.txt"), "private local value\n");
		const head = await git(data.project, "rev-parse", "HEAD");
		assert.equal((await service.merge(tree.id)).status, "blocked");
		assert.equal(await readFile(join(data.project, "ignored.txt"), "utf8"), "private local value\n");
		assert.equal(await git(data.project, "rev-parse", "HEAD"), head);
	} finally { await data.cleanup(); }
});

test("changing the original checkout branch blocks merging into an unintended target", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		assert.equal(tree.targetBranch, "main");
		await writeFile(join(tree.path, "result.txt"), "task result\n");
		await git(tree.path, "add", "--", "result.txt");
		await commit(tree.path, "feat: Add guarded merge result");
		await git(data.project, "switch", "-c", "different-target");
		const target = await git(data.project, "rev-parse", "HEAD");
		const result = await service.merge(tree.id);
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.match(result.reason, /目标分支已改变/);
		assert.equal(await git(data.project, "rev-parse", "HEAD"), target);
		await assert.rejects(access(join(data.project, "result.txt")));
	} finally { await data.cleanup(); }
});

test("replaced worktree paths and forged persisted paths cannot be removed", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const tree = await service.create({ project: data.project });
		const moved = `${tree.path}-moved`;
		await rename(tree.path, moved);
		await symlink(data.project, tree.path);
		assert.equal((await service.list())[0].status, "missing");
		await assert.rejects(service.remove(tree.id), /替换|缺失/);
		assert.equal(await readFile(join(data.project, "seed.txt"), "utf8"), "original\n");
		const index = JSON.parse(await readFile(join(data.dataDir, "worktrees.json"), "utf8")) as Record<string, unknown>[];
		index[0].path = data.project;
		await writeFile(join(data.dataDir, "worktrees.json"), JSON.stringify(index));
		await assert.rejects(new WorktreeService({ dataDir: data.dataDir, env }).initialize(), /无效路径/);
	} finally { await data.cleanup(); }
});

test("missing base references and unborn repositories fail without creating worktrees", { timeout: 30000 }, async () => {
	const data = await fixture();
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		await assert.rejects(service.create({ project: data.project, baseRef: "does-not-exist" }), /基准提交/);
		await assert.rejects(service.create({ project: data.project, baseRef: "--upload-pack=invalid" }), /引用无效/);
		const unborn = join(data.root, "unborn");
		await mkdir(unborn);
		await git(unborn, "init");
		await assert.rejects(service.create({ project: unborn }), /基准提交/);
		assert.deepEqual(await service.list(), []);
	} finally { await data.cleanup(); }
});

test("omitted baseRef prefers origin/HEAD when present and falls back to HEAD otherwise", { timeout: 30000 }, async () => {
	const data = await fixture();
	const bareRemote = join(data.root, "remote.git");
	const localClone = join(data.root, "local-clone");
	const service = new WorktreeService({ dataDir: data.dataDir, env });
	try {
		const withoutRemote = await service.create({ project: data.project });
		assert.equal(withoutRemote.baseRef, "HEAD");

		await git(data.root, "clone", "--bare", data.project, bareRemote);
		await git(data.root, "clone", bareRemote, localClone);
		await git(localClone, "remote", "set-head", "origin", "main");
		const originCommit = await git(localClone, "rev-parse", "origin/HEAD");

		// Advance local main past origin/HEAD; omitted baseRef must still branch from origin/HEAD.
		await writeFile(join(localClone, "local-only.txt"), "local ahead\n");
		await git(localClone, "add", "--", "local-only.txt");
		await commit(localClone, "local commit ahead of origin");
		const localHead = await git(localClone, "rev-parse", "HEAD");
		assert.notEqual(localHead, originCommit);

		const fromOrigin = await service.create({ project: localClone });
		assert.equal(fromOrigin.baseRef, "origin/HEAD");
		assert.equal(fromOrigin.baseCommit, originCommit);
	} finally { await data.cleanup(); }
});
