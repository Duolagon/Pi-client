import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

let cachedSupport: Promise<{ supported: boolean; reason?: string }> | undefined;

const SENSITIVE_HOME_SUBPATHS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", "Library/Keychains"] as const;
const SENSITIVE_HOME_LITERALS = [".netrc", ".npmrc", ".pypirc"] as const;
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/** Check protected names used by the native file tools, alongside the command sandbox. */
export function isProtectedFileToolPath(path: string, homeDir: string): boolean {
	const fileName = basename(path).toLowerCase();
	if (/^\.env(?:\.|$)/.test(fileName) && !ENV_TEMPLATES.has(fileName)) return true;
	const fromHome = relative(homeDir, path).split(sep).join("/").toLowerCase();
	return SENSITIVE_HOME_LITERALS.some((name) => fromHome === name) ||
		SENSITIVE_HOME_SUBPATHS.some((name) => {
			const protectedPath = name.toLowerCase();
			return fromHome === protectedPath || fromHome.startsWith(`${protectedPath}/`);
		});
}

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

type WritablePath = string | { literal: string };

/**
 * When `project` is inside a Git worktree (`.git` is a regular pointer file),
 * return the minimal Git metadata paths required for index, object and ref writes,
 * including the packed refs file and its lock, without exposing
 * the main repository working tree, `.git/config`, or `.git/hooks`.
 */
export async function resolveGitWorktreeWritablePaths(project: string): Promise<WritablePath[]> {
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
				// A linked worktree's administrative directory must also point back to its .git file.
				await lstat(join(gitDir, "HEAD"));
				const link = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
				if (!link || await realpath(resolve(gitDir, link)) !== await realpath(dotGit)) return [];
				const extras: WritablePath[] = [gitDir];
				try {
					const commonRaw = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
					if (commonRaw) {
						const commonDir = await realpath(resolve(gitDir, commonRaw));
						if ((await lstat(commonDir)).isDirectory()) {
							extras.push(join(commonDir, "objects"), join(commonDir, "refs"), join(commonDir, "logs"));
							extras.push({ literal: join(commonDir, "packed-refs") }, { literal: join(commonDir, "packed-refs.lock") });
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
	extraWritablePaths: WritablePath[] = [],
	offline = false,
	homeDir: string = homedir(),
): string {
	const roots = Array.from(new Set(
		[project, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", ...extraWritablePaths]
			.filter(Boolean)
			.map((item) => typeof item === "string"
				? `(subpath "${escapeSeatbeltString(item)}")`
				: `(literal "${escapeSeatbeltString(item.literal)}")`),
	)).join("\n    ");
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
