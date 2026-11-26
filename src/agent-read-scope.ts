import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { exceedsLength } from "./delegation-limits.ts";

export const MAX_AGENT_SCOPE_PATHS = 32;
export const MAX_AGENT_SCOPE_PATH_LENGTH = 1024;
export const scopedReadToolNames: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "LSP", "ReadToolOutput"]);

/** A scope lists specific project-relative files or directories, never globs or an entire workspace. */
export function validateAgentScopePaths(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > MAX_AGENT_SCOPE_PATHS)
		throw new Error(`scope_paths must contain 1–${MAX_AGENT_SCOPE_PATHS} project-relative paths`);
	const paths = new Set<string>();
	for (const path of value) {
		if (typeof path !== "string" || !path.trim() || exceedsLength(path, MAX_AGENT_SCOPE_PATH_LENGTH) ||
			isAbsolute(path) || /^[a-z]:/i.test(path) || /[\\?*\[\]{}\u0000-\u001f\u007f]/.test(path))
			throw new Error("scope_paths accepts only literal project-relative paths");
		const parts = path.split("/");
		if (parts.includes("..")) throw new Error("scope_paths cannot traverse a parent directory");
		const normalized = parts.filter((part) => part && part !== ".").join("/");
		if (!normalized) throw new Error("scope_paths must identify a file or directory within the project");
		paths.add(normalized);
	}
	return [...paths];
}

/** Resolve grants before starting a worker. A symlink is not a directory grant. */
export async function verifyAgentScopePaths(project: string, paths: readonly string[]): Promise<void> {
	const root = await realpath(project);
	for (const path of paths) {
		const target = resolve(root, path);
		const resolved = await realpath(target).catch(() => undefined);
		if (!resolved) throw new Error(`Could not find scoped path: ${path}`);
		if (resolved !== target) throw new Error(`Scoped path cannot use a symbolic link: ${path}`);
		const info = await stat(resolved);
		if (!info.isFile() && !info.isDirectory()) throw new Error(`Scoped path must be a file or directory: ${path}`);
	}
}

/** Match literal path boundaries in a canonical project, without treating a sibling prefix as a grant. */
export function insideAgentScope(project: string, paths: readonly string[], target: string): boolean {
	const key = relative(project, target).split(sep).join("/");
	return paths.some((path) => key === path || key.startsWith(`${path}/`));
}
