import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

function segment(value: string): string {
	if (!value || /[\0/\\:]/.test(value) || value === "." || value === "..")
		throw new Error("配置路径段无效。");
	return value;
}

/**
 * Resolve a directory below a trusted base without following symlinked config
 * directories. Returns undefined when the directory is absent and create=false.
 */
export async function managedDirectory(
	base: string,
	segments: string[],
	create: boolean,
): Promise<string | undefined> {
	let root: string;
	try {
		root = await realpath(base);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!create) return undefined;
		await mkdir(base, { recursive: true, mode: 0o700 });
		root = await realpath(base);
	}
	let current = root;
	for (const name of segments) {
		const next = join(current, segment(name));
		let info;
		try {
			info = await lstat(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!create) return undefined;
			await mkdir(next, { mode: 0o700 });
			info = await lstat(next);
		}
		if (info.isSymbolicLink()) throw new Error("配置目录不能是符号链接。");
		if (!info.isDirectory()) throw new Error("配置路径不是目录。");
		const actual = await realpath(next);
		if (!inside(root, actual)) throw new Error("配置路径超出项目目录。");
		current = actual;
	}
	return current;
}

/** Resolve a managed file and reject a symlinked final path. */
export async function managedFile(
	base: string,
	segments: string[],
	file: string,
	create: boolean,
): Promise<string | undefined> {
	const directory = await managedDirectory(base, segments, create);
	if (!directory) return undefined;
	const target = join(directory, segment(file));
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink()) throw new Error("配置文件不能是符号链接。");
		if (!info.isFile()) throw new Error("配置路径不是文件。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return target;
}

/** Replace a validated file using a fresh, exclusively created sibling. */
export async function writeManagedFile(target: string, content: string): Promise<void> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}
