import { constants as fs } from "node:fs";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { managedDirectory, managedFile } from "./managed-path.ts";

export const privateMemoryLabel = "本机项目记忆";
export const memoryLimit = 24 * 1024;

export function memoryName(project: string): string {
	return createHash("sha256").update(project).digest("hex") + ".md";
}

export async function readProjectText(root: string, path: string, limit = memoryLimit): Promise<string | undefined> {
	const parts = path.split("/");
	try {
		const target = await managedFile(root, parts.slice(0, -1), parts.at(-1)!, false);
		if (!target) return;
		const file = await open(target, fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0));
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > limit) return;
			const buffer = Buffer.alloc(limit + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead <= limit && !buffer.subarray(0, bytesRead).includes(0)) return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await file.close();
		}
	} catch { /* Optional instructions may be absent or inaccessible. */ }
}

function references(text: string): string[] {
	const plain = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
	return [...plain.matchAll(/(?:^|[\s(])@(?:"([^"\n]+)"|([\p{L}\p{N}_./-]+))/gu)]
		.map((match) => match[1] ?? match[2].replace(/[.]$/, ""))
		.slice(0, 24);
}

function projectRelative(root: string, parent: string, target: string): string | undefined {
	const rel = relative(root, resolve(root, parent, target)).split(sep).join("/");
	if (!/^(?!\.\.(?:\/|$))[^/].*/.test(rel)) return;
	if (rel.split("/").some((part) => /^(?:\.git|\.env(?:\..*)?|\.ssh|auth\.json|.*\.(?:pem|key))$/i.test(part))) return;
	return rel;
}

export function scopedRule(source: string): { body: string; patterns: string[] } {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
	if (!frontmatter) return { body: source, patterns: [] };
	const paths = /^paths:[ \t]*([^\r\n]*)(?:\r?\n((?:[ \t]*-[ \t]+[^\r\n]*(?:\r?\n|$))+))?/m.exec(frontmatter[1]);
	const list = paths?.[2]?.split(/\r?\n/).map((line) => line.replace(/^\s*-\s+/, ""))
		?? (paths?.[1] ? (paths[1].startsWith("[") ? (paths[1].slice(1, -1).match(/(?:\{[^}]*\}|[^,])+/g) ?? []) : [paths[1]]) : []);
	return { body: source.slice(frontmatter[0].length), patterns: list.map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) };
}

export async function rulePaths(root: string, start: string): Promise<string[]> {
	try {
		const initial = await managedDirectory(root, start.split("/"), false);
		if (!initial) return [];
		const queue = [start];
		const paths: string[] = [];
		for (let cursor = 0; cursor < queue.length && cursor < 24 && paths.length < 48; cursor++) {
			const dir = queue[cursor];
			const entries = await readdir(join(root, dir), { withFileTypes: true });
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory() && queue.length < 24) queue.push(path);
				if (entry.isFile() && /\.md$/i.test(entry.name) && paths.length < 48) paths.push(path);
			}
		}
		return paths;
	} catch { return []; }
}

export async function projectMemoryContext(root: string, prompt: string, privateFile?: string, toolPaths: string[] = [], currentSystem = ""): Promise<string> {
	const parts: string[] = [];
	const visited = new Set<string>();
	let remaining = memoryLimit;
	const promptPaths = references(prompt).map((path) => projectRelative(root, "", path)).filter((path): path is string => Boolean(path));
	const relevant = [...promptPaths, ...toolPaths.map((path) => projectRelative(root, "", path)).filter((path): path is string => Boolean(path))];
	const append = (label: string, body: string) => {
		if (!body.trim() || remaining < 128) return;
		const prefix = `\n\n## ${label.replace(/[\r\n]/g, " ")}\n`;
		const limit = remaining - Buffer.byteLength(prefix);
		if (limit <= 0) return;
		const text = prefix + Buffer.from(body).subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
		parts.push(text);
		remaining -= Buffer.byteLength(text);
	};
	const visit = async (path: string, depth: number, include: boolean, rule = false): Promise<void> => {
		if (visited.has(path) || depth > 5 || visited.size >= 80 || remaining < 128) return;
		visited.add(path);
		const source = await readProjectText(root, path);
		if (source === undefined) return;
		const { body, patterns } = rule ? scopedRule(source) : { body: source, patterns: [] };
		if (patterns.length && !patterns.some((pattern) => relevant.some((path) => matchesGlob(path, pattern)))) return;
		if (include && !currentSystem.includes(body.trim())) append(path, body);
		if (/\.md$/i.test(path)) {
			for (const target of references(body)) {
				const resolved = projectRelative(root, dirname(path), target);
				if (resolved) await visit(resolved, depth + 1, true);
			}
		}
	};
	if (privateFile) {
		const notes = await readProjectText(dirname(privateFile), privateFile.split(sep).at(-1)!);
		if (notes) append(privateMemoryLabel, notes);
	}
	// Pi supplies root project instructions. Load their imports and Desktop-only rules here.
	for (const path of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"]) {
		await visit(path, 0, true);
	}
	for (const folder of [".claude/rules", ".pi/rules"]) {
		for (const path of await rulePaths(root, folder)) await visit(path, 0, true, true);
	}
	for (const path of promptPaths) await visit(path, 0, true);
	return parts.length ? `# Pi Desktop 项目上下文${parts.join("")}` : "";
}
