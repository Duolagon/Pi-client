import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
	GitCheckpoint,
	GitCheckpointDiff,
	GitRestoreConflict,
	GitRestoreResult,
	GitSnapshotChange,
} from "./git-types.ts";

const exec = promisify(execFile);
export const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
const maxSnapshotBytes = 512 * 1024 * 1024;
const maxEntries = 50000;
type Entry =
	| { kind: "missing" }
	| { kind: "directory"; mode: number }
	| { kind: "excluded" }
	| { kind: "file" | "symlink"; mode: number; hash: string; size: number; binary: boolean };
interface Manifest {
	version: 1;
	checkpoint: GitCheckpoint;
	before: Record<string, Entry>;
	after?: Record<string, Entry>;
}
const missing: Entry = { kind: "missing" };
const excluded: Entry = { kind: "excluded" };

/** Persist worktree snapshots without changing the Git index, HEAD, or stash. */
export class GitSnapshots {
	private dataDir: string;
	private operations = new Map<string, Promise<void>>();

	constructor(dataDir: string) {
		this.dataDir = resolve(dataDir, "git-snapshots");
	}

	/** Capture all tracked and nonignored untracked paths before a task starts. */
	async begin(project: string, conversationId: string, label = "任务前快照", discardPath?: string): Promise<GitCheckpoint> {
		const root = await this.projectRoot(project);
		return this.serialize(root, async () => {
			const createdAt = Date.now();
			const beforeHead = await this.head(root);
			const before = discardPath === undefined
				? await this.capture(root)
				: await this.capturePaths(root, new Set([discardPath, ...parents(discardPath)]));
			if (discardPath !== undefined && ["excluded", "directory"].includes(before[discardPath].kind))
				throw new Error("无法为这个文件保存撤销检查点。请先备份修改。");
			const checkpoint: GitCheckpoint = {
				id: randomUUID(),
				project: root,
				conversationId,
				label: label.trim().slice(0, 160) || "任务前快照",
				kind: discardPath === undefined ? undefined : "discard-undo",
				createdAt,
				status: "pending",
				beforeHead,
				changes: [],
				restoredPaths: [],
			};
			checkpoint.excludedFiles = excludedPaths(before).size || undefined;
			await this.save({ version: 1, checkpoint, before });
			return structuredClone(checkpoint);
		});
	}

	/** Seal the after-state; subsequent changes are treated as external edits during restore. */
	async finish(project: string, id: string, options?: { conversationId?: string; userEntryId?: string }): Promise<GitCheckpoint> {
		const root = await this.projectRoot(project);
		return this.serialize(root, async () => {
			const manifest = await this.load(root, id, options?.conversationId);
			if (manifest.after) return structuredClone(manifest.checkpoint);
			const paths = Object.keys(manifest.before);
			manifest.after = manifest.checkpoint.kind === "discard-undo"
				? await this.capturePaths(root, new Set(paths))
				: await this.capture(root, paths);
			manifest.checkpoint.userEntryId = options?.userEntryId;
			manifest.checkpoint.finishedAt = Date.now();
			manifest.checkpoint.afterHead = await this.head(root);
			const excluded = excludedPaths(manifest.before, manifest.after);
			manifest.checkpoint.excludedFiles = excluded.size || undefined;
			manifest.checkpoint.changes = changes(manifest.before, manifest.after, excluded);
			manifest.checkpoint.status = "ready";
			await this.save(manifest);
			return structuredClone(manifest.checkpoint);
		});
	}

	/** Remove a backup for an operation refused before it touched the worktree. */
	async abandonDiscard(project: string, id: string, conversationId: string): Promise<void> {
		const root = await this.queryRoot(project);
		await this.serialize(root, async () => {
			const { checkpoint, after } = await this.load(root, id, conversationId);
			if (checkpoint.kind === "discard-undo" && !after)
				await unlink(join(this.directory(root), `${id}.json`));
		});
	}

	/** List durable checkpoints for this project, newest first. */
	async list(project: string, conversationId?: string): Promise<GitCheckpoint[]> {
		const root = await this.queryRoot(project);
		return this.serialize(root, async () => {
			let names: string[];
			try {
				names = await readdir(this.directory(root));
			} catch (error) {
				if (code(error) === "ENOENT") return [];
				throw error;
			}
			const checkpoints: GitCheckpoint[] = [];
			for (const name of names) {
				if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
				const { checkpoint } = await this.load(root, name.slice(0, -5));
				if (!conversationId || checkpoint.conversationId === conversationId) checkpoints.push(checkpoint);
			}
			return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
		});
	}

	/** Return unified before/after differences, including binary and mode summaries. */
	async diff(project: string, id: string, path?: string, conversationId?: string): Promise<GitCheckpointDiff> {
		const root = await this.queryRoot(project);
		return this.serialize(root, async () => {
			const manifest = await this.load(root, id, conversationId);
			if (!manifest.after) throw new Error("任务尚未结束，请先完成快照。");
			if (path !== undefined) checkPath(path);
			const selected =
				path === undefined
					? manifest.checkpoint.changes
					: manifest.checkpoint.changes.filter((item) => item.path === path);
			if (path !== undefined && !selected.length) throw new Error("此路径不在该快照的修改列表中。");
			const files: GitCheckpointDiff["files"] = [];
			for (const change of selected) {
				const result = await this.fileDiff(
					change.path,
					manifest.before[change.path] ?? missing,
					manifest.after[change.path] ?? missing,
				);
				files.push({ ...change, ...result });
			}
			return { checkpointId: id, files };
		});
	}

	/** Differences from a checkpoint's before-state to the current worktree (spanning later checkpoints). */
	async diffToWorktree(project: string, id: string): Promise<GitCheckpointDiff> {
		const root = await this.projectRoot(project);
		return this.serialize(root, async () => {
			const manifest = await this.load(root, id);
			const current = await this.capture(root, Object.keys(manifest.before));
			const files: GitCheckpointDiff["files"] = [];
			const excluded = excludedPaths(manifest.before, current);
			for (const change of changes(manifest.before, current, excluded)) {
				if (change.beforeKind === "directory" || change.afterKind === "directory") continue;
				const result = await this.fileDiff(change.path, manifest.before[change.path] ?? missing, current[change.path] ?? missing);
				files.push({ ...change, ...result });
			}
			return excluded.size ? { checkpointId: id, files, excludedFiles: excluded.size } : { checkpointId: id, files };
		});
	}

	/** Write a checkpoint's before-state files into an empty directory outside the project (read-only copy). */
	async materializeBefore(project: string, id: string, target: string): Promise<void> {
		const root = await this.projectRoot(project);
		if (inside(root, resolve(target))) throw new Error("快照副本必须位于项目目录之外。");
		return this.serialize(root, async () => {
			const manifest = await this.load(root, id);
			for (const [path, entry] of Object.entries(manifest.before).sort(([a], [b]) => a.localeCompare(b))) {
				const destination = join(target, path);
				if (entry.kind === "directory") await mkdir(destination, { recursive: true, mode: 0o700 });
				else if (entry.kind === "file") {
					await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
					await writeFile(destination, await this.bytes(entry), { flag: "wx", mode: 0o600 });
				} else if (entry.kind === "symlink") {
					await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
					await symlink((await this.bytes(entry)).toString(), destination);
				}
			}
		});
	}

	/** Restore selected changed paths only if their current state still matches this checkpoint. */
	async restore(project: string, id: string, paths?: string[], conversationId?: string): Promise<GitRestoreResult> {
		const root = await this.projectRoot(project);
		return this.serialize(root, async () => {
			const manifest = await this.load(root, id, conversationId);
			if (!manifest.after) throw new Error("任务尚未结束，不能撤销未完成的快照。");
			const changed = new Set(manifest.checkpoint.changes.map((item) => item.path));
			const selected = [...new Set(paths ?? changed)];
			for (const path of selected) {
				checkPath(path);
				if (!changed.has(path)) throw new Error("只能恢复此快照中实际发生变化的路径。");
			}
			const conflicts: GitRestoreConflict[] = [];
			const skipped: string[] = [];
			const restored: string[] = [];
			if ((await this.head(root)) !== manifest.checkpoint.afterHead)
				conflicts.push({ path: "", reason: "Git HEAD 已在快照结束后改变，请先回到原分支／提交。" });
			const states = new Map<string, Entry>();
			for (const path of selected) {
				try {
					const current = await this.inspect(root, path);
					states.set(path, current);
					if (equal(current, manifest.before[path] ?? missing)) skipped.push(path);
					else if (!equal(current, manifest.after[path] ?? missing))
						conflicts.push({ path, reason: "文件在快照结束后又被修改，已保留当前内容。" });
					const before = manifest.before[path] ?? missing;
					if (before.kind === "file" || before.kind === "symlink") await this.bytes(before);
				} catch (error) {
					conflicts.push({ path, reason: error instanceof Error ? error.message : String(error) });
				}
			}
			const selectedSet = new Set(selected);
			for (const path of selected) {
				if (skipped.includes(path)) continue;
				const before = manifest.before[path] ?? missing;
				const current = states.get(path);
				if (current?.kind === "directory" && before.kind !== "directory") {
					for (const child of await this.descendants(root, path)) {
						if (!selectedSet.has(child) || (manifest.before[child] ?? missing).kind !== "missing") {
							conflicts.push({ path, reason: `目录包含未选择恢复或快照之外的路径：${child}` });
							break;
						}
					}
				}
				for (const parent of parents(path)) {
					const actual = await this.inspect(root, parent);
					if (
						actual.kind !== "missing" &&
						actual.kind !== "directory" &&
						(!selectedSet.has(parent) || manifest.before[parent]?.kind !== "directory")
					) {
						conflicts.push({ path, reason: `父路径不是安全目录：${parent}` });
						break;
					}
				}
			}
			if (conflicts.length)
				return { status: "conflict", checkpoint: manifest.checkpoint, restored, skipped, conflicts };
			const removed = new Set<string>();
			const pending = selected.filter((path) => !skipped.includes(path));
			try {
				for (const path of [...pending].sort(deepestFirst)) {
					const before = manifest.before[path] ?? missing;
					const current = states.get(path)!;
					if (current.kind !== "missing" && (before.kind === "missing" || current.kind !== before.kind)) {
						await this.assertCurrent(root, path, manifest.after[path] ?? missing);
						await this.safeParents(root, path);
						if (current.kind === "directory") await rmdir(join(root, path));
						else await unlink(join(root, path));
						removed.add(path);
					}
				}
				for (const path of [...pending].sort((a, b) => deepestFirst(b, a))) {
					const before = manifest.before[path] ?? missing;
					if (before.kind === "missing") {
						restored.push(path);
						continue;
					}
					await this.safeParents(root, path, manifest.before);
					await this.assertCurrent(root, path, removed.has(path) ? missing : (manifest.after[path] ?? missing));
					if (before.kind === "directory") {
						await mkdir(join(root, path), { recursive: false, mode: before.mode }).catch(
							(error: NodeJS.ErrnoException) => {
								if (error.code !== "EEXIST") throw error;
							},
						);
						await chmod(join(root, path), before.mode);
					} else if (before.kind === "file" || before.kind === "symlink")
						await this.replace(root, path, before, removed.has(path) ? missing : (manifest.after[path] ?? missing));
					restored.push(path);
				}
			} catch (error) {
				conflicts.push({
					path: pending.find((path) => !restored.includes(path)) ?? "",
					reason: error instanceof Error ? error.message : String(error),
				});
			}
			manifest.checkpoint.restoredPaths = [...new Set([...manifest.checkpoint.restoredPaths, ...restored, ...skipped])];
			manifest.checkpoint.status = manifest.checkpoint.changes.every((change) =>
				manifest.checkpoint.restoredPaths.includes(change.path),
			)
				? "restored"
				: manifest.checkpoint.restoredPaths.length
					? "partially-restored"
					: "ready";
			await this.save(manifest);
			return {
				status: conflicts.length ? "partial" : restored.length ? "restored" : "unchanged",
				checkpoint: manifest.checkpoint,
				restored,
				skipped,
				conflicts,
			};
		});
	}

	private async projectRoot(project: string): Promise<string> {
		const root = await realpath(project);
		if (!(await lstat(root)).isDirectory()) throw new Error("项目路径必须是目录。");
		if (inside(root, this.dataDir)) throw new Error("快照存储目录必须位于项目目录之外。");
		await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 10000 });
		await mkdir(join(this.dataDir, "blobs"), { recursive: true, mode: 0o700 });
		return root;
	}

	private async queryRoot(project: string): Promise<string> {
		// Archives remain readable after an owned Worktree is removed. Resolve surviving ancestors,
		// then require every loaded manifest to match this exact canonical project path.
		const absolute = resolve(project);
		let ancestor = absolute;
		while (true) {
			try {
				return resolve(await realpath(ancestor), relative(ancestor, absolute));
			} catch (error) {
				if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") throw error;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
	}

	private serialize<T>(project: string, action: () => Promise<T>): Promise<T> {
		const result = (this.operations.get(project) ?? Promise.resolve()).then(action);
		const done = result.then(
			() => {},
			() => {},
		);
		this.operations.set(project, done);
		void done.then(() => {
			if (this.operations.get(project) === done) this.operations.delete(project);
		});
		return result;
	}

	private directory(project: string): string {
		return join(this.dataDir, hash(Buffer.from(project)));
	}

	private async head(project: string): Promise<string | undefined> {
		try {
			return (await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: project, timeout: 10000 })).stdout.trim();
		} catch (error) {
			if ((error as { code?: number }).code === 128) return undefined;
			throw error;
		}
	}

	private async capture(project: string, include: string[] = []): Promise<Record<string, Entry>> {
		const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
			cwd: project,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 10000,
		});
		const paths = new Set(include);
		for (const path of stdout.split("\0")) {
			if (!path || path.split("/").some((part) => part.toLowerCase() === ".git")) continue;
			checkPath(path);
			paths.add(path);
			for (const parent of parents(path)) paths.add(parent);
		}
		return this.capturePaths(project, paths);
	}

	private async capturePaths(project: string, paths: Set<string>): Promise<Record<string, Entry>> {
		if (paths.size > maxEntries) throw new Error("快照路径超过 50000 项，请先配置 Git 忽略规则。");
		const result: Record<string, Entry> = Object.create(null);
		let size = 0;
		for (const path of [...paths].sort()) {
			const entry = await this.inspect(project, path, true, maxSnapshotBytes - size);
			if (entry.kind === "file" || entry.kind === "symlink") size += entry.size;
			result[path] = entry;
		}
		return result;
	}

	private async inspect(project: string, path: string, persist = false, remainingBytes = MAX_CHECKPOINT_FILE_BYTES): Promise<Entry> {
		checkPath(path);
		for (const parent of parents(path)) {
			try {
				if (!(await lstat(join(project, parent))).isDirectory()) return missing;
			} catch (error) {
				if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return missing;
				throw error;
			}
		}
		const target = join(project, path);
		let info;
		try {
			info = await lstat(target);
		} catch (error) {
			if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return missing;
			throw error;
		}
		const mode = info.mode & 0o777;
		if (info.isDirectory()) return { kind: "directory", mode };
		let bytes: Buffer;
		let kind: "file" | "symlink";
		if (info.isSymbolicLink()) {
			kind = "symlink";
			bytes = Buffer.from(await readlink(target));
		} else if (info.isFile()) {
			kind = "file";
			if (info.size > Math.min(MAX_CHECKPOINT_FILE_BYTES, remainingBytes)) return excluded;
			const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const before = await handle.stat();
				bytes = await handle.readFile();
				const after = await handle.stat();
				if (
					before.ino !== info.ino ||
					before.size !== info.size ||
					before.mtimeMs !== info.mtimeMs ||
					before.mode !== info.mode ||
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.mode !== after.mode
				)
					throw new Error(`文件 ${path} 在快照读取时发生变化，请重试。`);
			} finally {
				await handle.close();
			}
		} else throw new Error(`不支持为特殊文件创建快照：${path}`);
		if (bytes.length > Math.min(MAX_CHECKPOINT_FILE_BYTES, remainingBytes)) return excluded;
		const digest = hash(bytes);
		if (persist)
			await writeFile(join(this.dataDir, "blobs", digest), bytes, { flag: "wx", mode: 0o600 }).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				},
			);
		return { kind, mode, hash: digest, size: bytes.length, binary: bytes.includes(0) };
	}

	private async descendants(project: string, path: string): Promise<string[]> {
		const result: string[] = [];
		for (const entry of await readdir(join(project, path), { withFileTypes: true })) {
			const child = `${path}/${entry.name}`;
			checkPath(child);
			result.push(child);
			if (entry.isDirectory()) result.push(...(await this.descendants(project, child)));
			if (result.length > maxEntries) throw new Error("目录包含过多路径，无法安全恢复。");
		}
		return result;
	}

	private async safeParents(project: string, path: string, baseline?: Record<string, Entry>): Promise<void> {
		for (const parent of parents(path)) {
			try {
				const info = await lstat(join(project, parent));
				if (!info.isDirectory()) throw new Error(`父路径不是安全目录：${parent}`);
			} catch (error) {
				if (code(error) !== "ENOENT" || !baseline) throw error;
				const entry = baseline[parent];
				const mode = entry?.kind === "directory" ? entry.mode : 0o755;
				await mkdir(join(project, parent), { mode });
				await chmod(join(project, parent), mode);
			}
		}
		if (!inside(project, await realpath(dirname(join(project, path))))) throw new Error("恢复路径指向项目目录之外。");
	}

	private async assertCurrent(project: string, path: string, expected: Entry): Promise<void> {
		if (!equal(await this.inspect(project, path), expected))
			throw new Error(`恢复过程中 ${path} 又发生变化，已停止恢复。`);
	}

	private async bytes(entry: Extract<Entry, { kind: "file" | "symlink" }>): Promise<Buffer> {
		const bytes = await readFile(join(this.dataDir, "blobs", entry.hash));
		if (bytes.length !== entry.size || hash(bytes) !== entry.hash) throw new Error("快照数据损坏，未恢复文件。");
		return bytes;
	}

	private async replace(
		project: string,
		path: string,
		entry: Extract<Entry, { kind: "file" | "symlink" }>,
		expected: Entry,
	): Promise<void> {
		const target = join(project, path);
		const temporary = join(dirname(target), `.pi-restore-${randomUUID()}`);
		try {
			const bytes = await this.bytes(entry);
			if (entry.kind === "symlink") await symlink(bytes.toString(), temporary);
			else await writeFile(temporary, bytes, { flag: "wx", mode: entry.mode });
			if (entry.kind === "file") await chmod(temporary, entry.mode);
			await this.safeParents(project, path);
			await this.assertCurrent(project, path, expected);
			await rename(temporary, target);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async save(manifest: Manifest): Promise<void> {
		const directory = this.directory(manifest.checkpoint.project);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const destination = join(directory, `${manifest.checkpoint.id}.json`);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async load(project: string, id: string, conversationId?: string): Promise<Manifest> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("快照 ID 无效。");
		const input: unknown = JSON.parse(await readFile(join(this.directory(project), `${id}.json`), "utf8"));
		const manifest = validateManifest(input, project, id);
		if (conversationId !== undefined && manifest.checkpoint.conversationId !== conversationId)
			throw new Error("检查点不属于当前会话。");
		return manifest;
	}

	private async fileDiff(path: string, before: Entry, after: Entry): Promise<{ diff: string; truncated: boolean }> {
		if (before.kind === "excluded" || after.kind === "excluded") throw new Error("此路径未纳入快照。");
		if (before.kind === "directory" || after.kind === "directory")
			return { diff: `路径类型：${before.kind} → ${after.kind}`, truncated: false };
		const temporary = await mkdtemp(join(tmpdir(), "pi-checkpoint-diff-"));
		try {
			for (const [name, entry] of [
				["before", before],
				["after", after],
			] as const) {
				if (entry.kind === "missing") continue;
				const bytes = await this.bytes(entry);
				if (entry.kind === "symlink") await symlink(bytes.toString(), join(temporary, name));
				else {
					await writeFile(join(temporary, name), bytes);
					await chmod(join(temporary, name), entry.mode);
				}
			}
			const args = [
				"diff",
				"--no-index",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--",
				before.kind === "missing" ? "/dev/null" : "before",
				after.kind === "missing" ? "/dev/null" : "after",
			];
			let output: string;
			try {
				output = (await exec("git", args, { cwd: temporary, maxBuffer: 2 * 1024 * 1024, timeout: 10000 })).stdout;
			} catch (error) {
				const failure = error as { code?: number | string; stdout?: string };
				if (failure.code === 1) output = failure.stdout ?? "";
				else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
					return { diff: "差异超过 2 MB，请按文件读取。", truncated: true };
				else throw error;
			}
			output = output
				.split("\n")
				.map((line) => {
					if (line.startsWith("diff --git ")) return `diff --git a/${path} b/${path}`;
					if (line.startsWith("--- ") && before.kind !== "missing") return `--- a/${path}`;
					if (line.startsWith("+++ ") && after.kind !== "missing") return `+++ b/${path}`;
					if (line.startsWith("Binary files ")) return `Binary files a/${path} and b/${path} differ`;
					return line;
				})
				.join("\n");
			return { diff: output, truncated: false };
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}

function excludedPaths(...states: Record<string, Entry>[]): Set<string> {
	return new Set(states.flatMap((state) => Object.keys(state).filter((path) => state[path].kind === "excluded")));
}

function changes(before: Record<string, Entry>, after: Record<string, Entry>, excluded: Set<string>): GitSnapshotChange[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((path) => {
		const previous = before[path] ?? missing;
		const next = after[path] ?? missing;
		if (previous.kind === "excluded" || next.kind === "excluded" || parents(path).some((parent) => excluded.has(parent))) return [];
		if (equal(previous, next)) return [];
		return [
			{
				path,
				status:
					previous.kind === "missing"
						? "added"
						: next.kind === "missing"
							? "deleted"
							: previous.kind !== next.kind
								? "type-changed"
								: "modified",
				beforeKind: previous.kind,
				afterKind: next.kind,
				beforeSize: "size" in previous ? previous.size : 0,
				afterSize: "size" in next ? next.size : 0,
				beforeMode: "mode" in previous ? previous.mode : undefined,
				afterMode: "mode" in next ? next.mode : undefined,
				binary: ("binary" in previous && previous.binary) || ("binary" in next && next.binary),
			},
		];
	});
}
function equal(a: Entry, b: Entry): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "missing" || b.kind === "missing") return true;
	if (a.kind === "excluded" || b.kind === "excluded") return false;
	if (a.mode !== b.mode) return false;
	if (a.kind === "directory" || b.kind === "directory") return true;
	return a.hash === b.hash && a.size === b.size;
}
function checkPath(path: string): void {
	if (
		!path ||
		path.includes("\0") ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
	)
		throw new Error("快照文件路径无效或超出项目目录。");
}
function parents(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}
function deepestFirst(a: string, b: string): number {
	return b.split("/").length - a.split("/").length || b.localeCompare(a);
}
function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}
function validateManifest(input: unknown, project: string, id: string): Manifest {
	// Manifest files are an untrusted disk boundary, including every blob name and relative worktree path.
	if (!input || typeof input !== "object") throw new Error("快照格式错误。");
	const value = input as Partial<Manifest>;
	if (
		value.version !== 1 ||
		!value.checkpoint ||
		value.checkpoint.id !== id ||
		value.checkpoint.project !== project ||
		typeof value.checkpoint.conversationId !== "string" ||
		typeof value.checkpoint.createdAt !== "number" ||
		typeof value.checkpoint.label !== "string" ||
		(value.checkpoint.userEntryId !== undefined && (typeof value.checkpoint.userEntryId !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(value.checkpoint.userEntryId))) ||
		(value.checkpoint.kind !== undefined && value.checkpoint.kind !== "discard-undo") ||
		!["pending", "ready", "partially-restored", "restored"].includes(value.checkpoint.status) ||
		!Array.isArray(value.checkpoint.restoredPaths)
	)
		throw new Error("快照元数据无效。");
	if (!value.before) throw new Error("快照缺少任务前状态。");
	for (const key of ["before", "after"] as const) {
		const map = value[key];
		if (map === undefined && key === "after") continue;
		if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > maxEntries)
			throw new Error("快照内容无效。");
		const entries: Record<string, Entry> = Object.create(null);
		for (const [path, entry] of Object.entries(map)) {
			checkPath(path);
			if (!entry || typeof entry !== "object" || !["missing", "file", "symlink", "directory", "excluded"].includes(entry.kind))
				throw new Error("快照文件元数据无效。");
			if (entry.kind !== "missing" && entry.kind !== "excluded" && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))
				throw new Error("快照文件权限无效。");
			if (
				(entry.kind === "file" || entry.kind === "symlink") &&
				(!/^[a-f0-9]{64}$/.test(entry.hash) ||
					!Number.isInteger(entry.size) ||
					entry.size < 0 ||
					entry.size > MAX_CHECKPOINT_FILE_BYTES ||
					typeof entry.binary !== "boolean")
			)
				throw new Error("快照文件内容索引无效。");
			entries[path] = entry;
		}
		value[key] = entries;
	}
	for (const path of value.checkpoint.restoredPaths) checkPath(path);
	const excluded = excludedPaths(value.before, value.after ?? {});
	value.checkpoint.excludedFiles = excluded.size || undefined;
	value.checkpoint.changes = value.after ? changes(value.before, value.after, excluded) : [];
	return value as Manifest;
}
