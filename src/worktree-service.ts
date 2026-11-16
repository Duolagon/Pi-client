import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";

const exec = promisify(execFile);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type StoredWorktree = Omit<WorktreeInfo, "status"> & { commonDir: string };

export interface WorktreeServiceOptions {
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	/** The host checks both the source worktree and its merge target for active agents or terminals. */
	isActive?: (worktree: WorktreeInfo) => boolean | Promise<boolean>;
}

/** Manage only app-owned worktrees, preserving the user's main index and unmerged commits. */
export class WorktreeService {
	private options: WorktreeServiceOptions;
	private root = "";
	private records: StoredWorktree[] = [];
	private initialized = false;
	private operation: Promise<void> = Promise.resolve();

	constructor(options: WorktreeServiceOptions) {
		this.options = options;
	}

	initialize(): Promise<void> {
		return this.serialize(() => this.load());
	}

	list(project?: string): Promise<WorktreeInfo[]> {
		return this.serialize(async () => {
			await this.load();
			const repository = project === undefined ? undefined : await this.repository(project);
			return Promise.all(
				this.records.filter((item) => !repository || item.repository === repository).map((item) => this.info(item)),
			);
		});
	}

	create(input: WorktreeCreateInput): Promise<WorktreeInfo> {
		return this.serialize(async () => {
			await this.load();
			if ((await lstat(this.root)).isSymbolicLink() || (await realpath(this.root)) !== this.root)
				throw new Error("Worktree 存储目录已被替换，未创建工作区。");
			const repository = await this.repository(input.project);
			const baseRef = input.baseRef?.trim() || "HEAD";
			if (baseRef.startsWith("-") || baseRef.includes("\0") || baseRef.length > 512)
				throw new Error("Git 基准引用无效。");
			let baseCommit: string;
			try {
				baseCommit = (
					await this.git(repository, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])
				).trim();
			} catch {
				throw new Error("找不到 Git 基准提交。请先为仓库创建提交，或选择有效引用。");
			}
			const id = randomUUID();
			const branch = `pi-desktop/${id}`;
			let targetBranch: string | undefined;
			try {
				targetBranch = (await this.git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
			} catch (error) {
				if ((error as { code?: number }).code !== 1) throw error;
			}
			await this.git(repository, ["check-ref-format", "--branch", branch]);
			const record: StoredWorktree = {
				id,
				repository,
				path: join(this.root, id),
				branch,
				baseRef,
				baseCommit,
				targetBranch,
				createdAt: Date.now(),
				conversationId: input.conversationId,
				commonDir: await this.commonDir(repository),
			};
			await this.git(repository, ["worktree", "add", "-b", branch, record.path, baseCommit]);
			this.records.push(record);
			try {
				await this.persist();
			} catch (error) {
				this.records = this.records.filter((item) => item.id !== id);
				try {
					await this.git(repository, ["worktree", "remove", record.path]);
					await this.deleteMergedBranch(record);
				} catch {
					throw new Error(`无法保存 Worktree 索引，已保留工作目录以保护数据：${record.path}`, { cause: error });
				}
				throw error;
			}
			return this.info(record);
		});
	}

	bindConversation(id: string, conversationId: string): Promise<WorktreeInfo> {
		return this.serialize(async () => {
			await this.load();
			const record = this.requireRecord(id);
			if (!conversationId || conversationId.length > 200 || conversationId.includes("\0"))
				throw new Error("会话 ID 无效。");
			const previous = record.conversationId;
			record.conversationId = conversationId;
			try {
				await this.persist();
			} catch (error) {
				record.conversationId = previous;
				throw error;
			}
			return this.info(record);
		});
	}

	remove(id: string): Promise<WorktreeRemoveResult> {
		return this.serialize(async () => {
			await this.load();
			const record = this.requireRecord(id);
			await this.verify(record);
			if (await this.options.isActive?.(await this.info(record)))
				throw new Error("Worktree 中仍有活动任务或终端，请先停止。");
			// Ignored files can contain local secrets or build output; normal status would hide them before deletion.
			if (await this.status(record.path, ["--ignored=matching"]))
				throw new Error("Worktree 中有未提交、未跟踪或被忽略的文件，未删除任何内容。");
			await this.git(record.repository, ["worktree", "remove", record.path]);
			const branchRetained = !(await this.deleteMergedBranch(record));
			this.records = this.records.filter((item) => item.id !== id);
			await this.persist();
			return { worktreeId: id, branch: record.branch, branchRetained };
		});
	}

	merge(id: string): Promise<WorktreeMergeResult> {
		return this.serialize(async () => {
			await this.load();
			const record = this.requireRecord(id);
			await this.verify(record);
			const blocked = (reason: string): WorktreeMergeResult => ({
				status: "blocked",
				worktreeId: id,
				repository: record.repository,
				reason,
			});
			if (await this.options.isActive?.(await this.info(record)))
				return blocked("源 Worktree 或目标仓库仍有活动任务或终端。");
			if (await this.status(record.path)) return blocked("Worktree 有未提交的修改，请先检查并提交需要合入的内容。");
			if (await this.status(record.repository)) return blocked("目标仓库有未提交或未跟踪的修改，请先处理后再合入。");
			try {
				const branch = (await this.git(record.repository, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
				if (!record.targetBranch || branch !== record.targetBranch)
					return blocked(`目标分支已改变，请切回创建任务时的分支 ${record.targetBranch ?? "（未指定）"} 后再合入。`);
			} catch {
				return blocked("目标仓库处于分离 HEAD 状态，请先选择目标分支。");
			}
			const source = (await this.git(record.path, ["rev-parse", "HEAD"])).trim();
			const target = (await this.git(record.repository, ["rev-parse", "HEAD"])).trim();
			if (await this.isAncestor(record.repository, source, target))
				return { status: "up-to-date", worktreeId: id, repository: record.repository, head: target };
			if (!(await this.isAncestor(record.repository, target, source)))
				return blocked("分支已分叉，无法快进合并。请在 Git 中人工合并或变基；目标仓库未改变。");
			try {
				await this.git(record.repository, [
					"merge",
					"--ff-only",
					"--no-overwrite-ignore",
					"--no-edit",
					"--no-stat",
					source,
				]);
			} catch (error) {
				return blocked(
					`Git 未能完成快进合并，请检查目标文件：${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { status: "merged", worktreeId: id, repository: record.repository, head: source };
		});
	}

	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operation.then(action);
		this.operation = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async load(): Promise<void> {
		if (this.initialized) return;
		await mkdir(join(this.options.dataDir, "worktrees"), { recursive: true, mode: 0o700 });
		this.root = await realpath(join(this.options.dataDir, "worktrees"));
		try {
			const value: unknown = JSON.parse(await readFile(join(this.options.dataDir, "worktrees.json"), "utf8"));
			this.records = validateRecords(value, this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.initialized = true;
	}

	private requireRecord(id: string): StoredWorktree {
		const record = this.records.find((item) => item.id === id);
		if (!record) throw new Error("找不到由本客户端创建的 Worktree。");
		return record;
	}

	private async info(record: StoredWorktree): Promise<WorktreeInfo> {
		const { commonDir: _commonDir, ...info } = record;
		let status: WorktreeInfo["status"] = "missing";
		try {
			const file = await lstat(record.path);
			if (file.isDirectory() && !file.isSymbolicLink() && (await realpath(record.path)) === record.path)
				status = "ready";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return { ...info, status };
	}

	private async repository(project: string): Promise<string> {
		const directory = await realpath(project);
		try {
			return await realpath((await this.git(directory, ["rev-parse", "--show-toplevel"])).trim());
		} catch {
			throw new Error("请选择已初始化并存在提交的 Git 工作区。");
		}
	}

	private async commonDir(directory: string): Promise<string> {
		return realpath(resolve(directory, (await this.git(directory, ["rev-parse", "--git-common-dir"])).trim()));
	}

	private async verify(record: StoredWorktree): Promise<void> {
		if ((await this.info(record)).status !== "ready") throw new Error("Worktree 目录缺失或已被替换，未执行操作。");
		const gitFile = await lstat(join(record.path, ".git"));
		if (!gitFile.isFile() || gitFile.isSymbolicLink()) throw new Error("Worktree 的 Git 元数据已被替换，未执行操作。");
		const [root, targetRoot, sourceCommon, targetCommon, branch] = await Promise.all([
			this.repository(record.path),
			this.repository(record.repository),
			this.commonDir(record.path),
			this.commonDir(record.repository),
			this.git(record.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
		]);
		if (
			root !== record.path ||
			targetRoot !== record.repository ||
			sourceCommon !== record.commonDir ||
			targetCommon !== record.commonDir ||
			branch.trim() !== record.branch
		)
			throw new Error("Worktree 的仓库或分支已改变，未执行操作。");
	}

	private status(directory: string, extra: string[] = []): Promise<string> {
		return this.git(directory, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=none",
			...extra,
		]);
	}

	private async isAncestor(directory: string, older: string, newer: string): Promise<boolean> {
		try {
			await this.git(directory, ["merge-base", "--is-ancestor", older, newer]);
			return true;
		} catch (error) {
			if ((error as { code?: number }).code === 1) return false;
			throw error;
		}
	}

	private async deleteMergedBranch(record: StoredWorktree): Promise<boolean> {
		const branchHead = (
			await this.git(record.repository, ["rev-parse", "--verify", `refs/heads/${record.branch}`])
		).trim();
		const targetHead = (await this.git(record.repository, ["rev-parse", "HEAD"])).trim();
		if (!(await this.isAncestor(record.repository, branchHead, targetHead))) return false;
		try {
			await this.git(record.repository, ["branch", "-d", "--", record.branch]);
			return true;
		} catch {
			return false;
		}
	}

	private async git(directory: string, args: string[]): Promise<string> {
		const env = { ...process.env, ...this.options.env };
		for (const name of [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_NAMESPACE",
		])
			delete env[name];
		const { stdout } = await exec("git", args, { cwd: directory, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
		return stdout;
	}

	private async persist(): Promise<void> {
		const destination = join(this.options.dataDir, "worktrees.json");
		const temporary = `${destination}.tmp`;
		await writeFile(temporary, JSON.stringify(this.records, null, 2), { mode: 0o600 });
		await rename(temporary, destination);
	}
}

function validateRecords(value: unknown, root: string): StoredWorktree[] {
	if (!Array.isArray(value)) throw new Error("Worktree 索引格式错误。");
	const ids = new Set<string>();
	return value.map((entry: unknown) => {
		// The persisted index is a disk trust boundary, not an authority to remove arbitrary directories.
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Worktree 记录格式错误。");
		const item = entry as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			!idPattern.test(item.id) ||
			ids.has(item.id) ||
			typeof item.repository !== "string" ||
			!isAbsolute(item.repository) ||
			typeof item.commonDir !== "string" ||
			!isAbsolute(item.commonDir) ||
			item.path !== join(root, item.id) ||
			item.branch !== `pi-desktop/${item.id}` ||
			typeof item.baseRef !== "string" ||
			typeof item.baseCommit !== "string" ||
			!/^[a-f0-9]{40,64}$/.test(item.baseCommit) ||
			typeof item.createdAt !== "number" ||
			!Number.isFinite(item.createdAt) ||
			(item.conversationId !== undefined && typeof item.conversationId !== "string") ||
			(item.targetBranch !== undefined && typeof item.targetBranch !== "string")
		)
			throw new Error("Worktree 记录包含无效路径或字段。");
		ids.add(item.id);
		return item as unknown as StoredWorktree;
	});
}
