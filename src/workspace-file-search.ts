import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isReferenceablePath } from "./file-references.ts";
import type { FileEntry } from "./shared.ts";

const exec = promisify(execFile);
const generatedDirectories = new Set([".git", "node_modules", "dist", "release", ".next", "coverage"]);
const resultLimit = 32;

async function searchPaths(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
	const options = { cwd: root, env, timeout: 3000, maxBuffer: 64 * 1024 * 1024 };
	try {
		const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], options);
		return stdout.split("\0");
	} catch {
		// Non-Git directories still support file references.
	}
	try {
		const { stdout } = await exec("rg", ["--files", "--hidden", "--null"], options);
		return stdout.split("\0");
	} catch {
		// Keep working when neither executable is available.
	}
	const pending = [""];
	const result: string[] = [];
	for (let index = 0; index < pending.length && index < 4096 && result.length < 100_000; index++) {
		const folder = pending[index];
		const children = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
		for (const child of children) {
			const path = folder ? `${folder}/${child.name}` : child.name;
			if (!isReferenceablePath(path) || generatedDirectories.has(child.name)) continue;
			if (child.isDirectory()) pending.push(path);
			if (child.isFile()) result.push(path);
		}
	}
	return result;
}

export async function searchWorkspaceFiles(root: string, query: string, env: NodeJS.ProcessEnv): Promise<FileEntry[]> {
	const prefix = query.toLocaleLowerCase().replace(/^\.\//, "");
	const slash = prefix.lastIndexOf("/");
	const directory = slash >= 0 ? prefix.slice(0, slash + 1) : "";
	const needle = slash >= 0 ? prefix.slice(slash + 1) : prefix;
	const matches = new Map<string, FileEntry & { score: number }>();
	const add = (path: string, directoryEntry: boolean) => {
		if (matches.has(path)) return;
		const parts = path.split("/");
		const name = parts.at(-1)!;
		const lowerPath = path.toLocaleLowerCase();
		const lowerName = name.toLocaleLowerCase();
		if (directory && !lowerPath.startsWith(directory)) return;
		if (needle && !lowerPath.includes(needle)) return;
		const depth = parts.length - 1;
		const score = lowerPath === prefix ? 0
			: lowerName === needle ? 1
			: lowerName.startsWith(needle) ? 2
			: 3;
		matches.set(path, { path, name, directory: directoryEntry, score: score * 10 + Math.min(depth, 9) });
	};
	for (const path of await searchPaths(root, env)) {
		const names = path.split("/");
		if (!isReferenceablePath(path) || names.some((part) => generatedDirectories.has(part) || part === ".DS_Store")) continue;
		add(path, false);
		for (let length = names.length - 1; length > 0; length--) add(names.slice(0, length).join("/"), true);
	}
	return [...matches.values()].sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
		.slice(0, resultLimit)
		.map(({ path, name, directory: folder }) => ({ path, name, directory: folder }));
}
