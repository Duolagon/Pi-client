import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type EditorChoice = "vscode" | "cursor" | "system";
export const EDITOR_CHOICES: readonly EditorChoice[] = ["vscode", "cursor", "system"];
export const DEFAULT_EDITOR: EditorChoice = "vscode";

export function editorChoice(value: unknown): EditorChoice {
	return EDITOR_CHOICES.includes(value as EditorChoice) ? (value as EditorChoice) : DEFAULT_EDITOR;
}

export interface OpenInEditorInput {
	path: string;
	line?: number;
}

/** Validates the renderer's openInEditor request shape. */
export function parseOpenInEditorInput(value: unknown): OpenInEditorInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求参数格式错误。");
	const record = value as Record<string, unknown>;
	const path = record.path;
	if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")) throw new Error("文件路径格式错误。");
	if (!isAbsolute(path)) throw new Error("文件路径必须是绝对路径。");
	const line = record.line;
	if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || line > 10_000_000))
		throw new Error("行号必须是正整数。");
	return { path, ...(line !== undefined ? { line } : {}) };
}

/** Builds `vscode://file/<path>:<line>` style URLs; each path segment is percent-encoded. */
export function editorUrl(editor: "vscode" | "cursor", path: string, line?: number): string {
	const normalized = path.replaceAll("\\", "/");
	const encoded = normalized
		.split("/")
		.map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");
	const withSlash = encoded.startsWith("/") ? encoded : `/${encoded}`;
	return `${editor}://file${withSlash}${line ? `:${line}` : ""}`;
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolves a requested path to its real location and checks that it exists and
 * lies inside one of the allowed roots (projects and worktrees). Symlinks are
 * followed on both sides, so a link inside a project cannot point outside it.
 */
export async function resolveEditorTarget(path: string, roots: readonly string[]): Promise<string> {
	if (!isAbsolute(path)) throw new Error("文件路径必须是绝对路径。");
	let target: string;
	try {
		target = await realpath(resolve(path));
		await stat(target);
	} catch {
		throw new Error("文件不存在。");
	}
	for (const root of roots) {
		if (!root || !isAbsolute(root)) continue;
		const real = await realpath(root).catch(() => undefined);
		if (real && inside(real, target)) return target;
	}
	throw new Error("只能打开当前项目或 Worktree 内的文件。");
}

const LAUNCHABLE_EXTENSIONS = new Set([
	".app", ".command", ".tool", ".terminal", ".sh", ".zsh", ".bash", ".pkg", ".mpkg", ".dmg",
	".workflow", ".scpt", ".applescript", ".jar", ".action", ".prefpane", ".webloc", ".inetloc", ".fileloc",
]);

/**
 * True when handing the path to the system default app could run code instead
 * of showing it (bundles, scripts, installers or executable files). Such paths
 * are revealed in Finder rather than opened.
 */
export function launchesCode(path: string, info: { isFile(): boolean; isDirectory(): boolean; mode: number }): boolean {
	const lower = path.toLowerCase();
	const dot = lower.lastIndexOf(".");
	const extension = dot > lower.lastIndexOf("/") ? lower.slice(dot) : "";
	if (LAUNCHABLE_EXTENSIONS.has(extension)) return true;
	if (info.isDirectory()) return false;
	return info.isFile() && (info.mode & 0o111) !== 0;
}
