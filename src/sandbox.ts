import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

let cachedSupport: Promise<{ supported: boolean; reason?: string }> | undefined;

const SENSITIVE_HOME_SUBPATHS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", "Library/Keychains"] as const;
const SENSITIVE_HOME_LITERALS = [".netrc", ".npmrc", ".pypirc"] as const;

export const SANDBOX_PROTECTED_READ_LABELS = [
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.kube",
	"~/.docker",
	"~/.netrc",
	"~/.npmrc",
	"~/.pypirc",
	"~/Library/Keychains",
] as const;

/** Probe once whether macOS Seatbelt sandbox-exec can apply in this host environment. */
export async function probeSeatbeltSupport(): Promise<{ supported: boolean; reason?: string }> {
	if (process.platform !== "darwin") {
		return { supported: false, reason: "OS 命令行沙箱当前仅支持 macOS (sandbox-exec)。" };
	}
	if (!cachedSupport) {
		cachedSupport = exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 3000 })
			.then(() => ({ supported: true }))
			.catch((error: unknown) => ({
				supported: false,
				reason: error instanceof Error ? error.message : String(error),
			}));
	}
	return cachedSupport;
}

function escapeSeatbeltString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isWithinOrSame(target: string, ancestor: string): boolean {
	const a = resolve(ancestor);
	const t = resolve(target);
	return t === a || t.startsWith(`${a}/`);
}

/**
 * When `project` is inside a Git worktree (`.git` is a regular pointer file),
 * return the minimal Git metadata paths (`gitdir`, `objects`, `refs`, `logs`)
 * required so `git add` / `git commit` succeed under Seatbelt without exposing
 * the main repository working tree, `.git/config`, or `.git/hooks`.
 */
export async function resolveGitWorktreeWritablePaths(project: string): Promise<string[]> {
	let current = resolve(project);
	for (let depth = 0; depth < 32; depth += 1) {
		const dotGit = join(current, ".git");
		try {
			const info = await lstat(dotGit);
			if (info.isDirectory()) return [];
			if (info.isFile()) {
				const raw = await readFile(dotGit, "utf8");
				const match = /^gitdir:\s*(.+)$/m.exec(raw);
				if (!match) return [];
				const gitDir = await realpath(resolve(current, match[1].trim()));
				const gitDirStat = await lstat(gitDir);
				if (!gitDirStat.isDirectory()) return [];
				// Confirm this is a genuine worktree gitdir (has HEAD + commondir).
				await lstat(join(gitDir, "HEAD"));
				const extras = [gitDir];
				try {
					const commonRaw = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
					if (commonRaw) {
						const commonDir = await realpath(resolve(gitDir, commonRaw));
						if ((await lstat(commonDir)).isDirectory()) {
							extras.push(join(commonDir, "objects"), join(commonDir, "refs"), join(commonDir, "logs"));
						}
					}
				} catch {
					// Standalone gitdir without commondir.
				}
				return Array.from(new Set(extras));
			}
			return [];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return [];
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return [];
}

/**
 * Build a Seatbelt profile restricting file writes to the workspace and temp directories
 * and blocking reads of common user credential stores.
 */
export function buildSeatbeltProfile(
	project: string,
	extraWritablePaths: string[] = [],
	offline = false,
	homeDir: string = homedir(),
): string {
	const roots = Array.from(
		new Set([project, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", ...extraWritablePaths].filter(Boolean)),
	)
		.map((item) => `(subpath "${escapeSeatbeltString(item)}")`)
		.join("\n    ");
	const deniedReads: string[] = [];
	if (homeDir) {
		for (const rel of SENSITIVE_HOME_SUBPATHS) {
			const full = join(homeDir, rel);
			if (!isWithinOrSame(project, full)) deniedReads.push(`(subpath "${escapeSeatbeltString(full)}")`);
		}
		for (const rel of SENSITIVE_HOME_LITERALS) {
			const full = join(homeDir, rel);
			if (!isWithinOrSame(project, full)) deniedReads.push(`(literal "${escapeSeatbeltString(full)}")`);
		}
	}
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		...(deniedReads.length ? [`(deny file-read*\n    ${deniedReads.join("\n    ")})`] : []),
		...(offline ? ["(deny network*)"] : []),
		`(allow file-write*`,
		`    (literal "/dev/null")`,
		`    (literal "/dev/tty")`,
		`    (regex #"^/dev/fd/")`,
		`    ${roots})`,
	].join("\n");
}
