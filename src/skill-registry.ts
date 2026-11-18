import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type SkillScope = "user" | "project";

export interface SkillDefinitionEntry {
	id: string;
	name: string;
	description: string;
	body: string;
	scope: SkillScope;
	kind: "skill" | "command";
	sourceDir: string;
	filePath: string;
	editable: boolean;
	estimatedTokens: number;
}

export interface SkillSaveInput {
	name: string;
	description: string;
	body: string;
	scope: SkillScope;
	project?: string;
}

export interface SkillRemoveInput {
	name: string;
	scope: SkillScope;
	project?: string;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	const norm = raw.replace(/\r\n/g, "\n");
	if (!norm.startsWith("---\n")) return { data: {}, body: norm.trim() };
	const end = norm.indexOf("\n---", 4);
	if (end < 0) return { data: {}, body: norm.trim() };
	const data: Record<string, string> = {};
	for (const line of norm.slice(4, end).split("\n")) {
		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	return { data, body: norm.slice(end + 4).replace(/^\n+/, "").trim() };
}

function estimateTokens(text: string): number {
	return text ? Math.ceil(Buffer.byteLength(text, "utf8") / 3.5) : 0;
}

async function scanSkillDirectory(
	root: string,
	scope: SkillScope,
	editable: boolean,
): Promise<SkillDefinitionEntry[]> {
	const results: SkillDefinitionEntry[] = [];
	try {
		const items = await readdir(root, { withFileTypes: true });
		for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!item.isDirectory()) continue;
			const skillFile = join(root, item.name, "SKILL.md");
			try {
				const info = await stat(skillFile);
				if (!info.isFile()) continue;
				const content = (await readFile(skillFile, "utf8")).slice(0, 256 * 1024);
				const { data, body } = parseFrontmatter(content);
				const name = (data.name || item.name).trim();
				const description = (data.description || body.split("\n").find((l) => l.trim()) || name).trim().slice(0, 500);
				results.push({
					id: `${scope}:${root}:${name}`,
					name,
					description,
					body,
					scope,
					kind: "skill",
					sourceDir: root,
					filePath: skillFile,
					editable,
					estimatedTokens: estimateTokens(content),
				});
			} catch {
				// Skip unreadable skill subdirectories.
			}
		}
	} catch {
		return [];
	}
	return results;
}

async function scanCommandsDirectory(root: string, scope: SkillScope): Promise<SkillDefinitionEntry[]> {
	const results: SkillDefinitionEntry[] = [];
	try {
		const items = await readdir(root, { withFileTypes: true });
		for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!item.isFile() || !item.name.endsWith(".md")) continue;
			const filePath = join(root, item.name);
			try {
				const content = (await readFile(filePath, "utf8")).slice(0, 256 * 1024);
				const { data, body } = parseFrontmatter(content);
				const name = (data.name || basename(item.name, ".md")).trim();
				const description = (data.description || body.split("\n").find((l) => l.trim()) || name).trim().slice(0, 500);
				results.push({
					id: `${scope}:cmd:${root}:${name}`,
					name,
					description,
					body,
					scope,
					kind: "command",
					sourceDir: root,
					filePath,
					editable: false,
					estimatedTokens: estimateTokens(content),
				});
			} catch {
				// Ignore unreadable files.
			}
		}
	} catch {
		return [];
	}
	return results;
}

function validateName(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("Skill 名称格式错误。");
	const trimmed = raw.trim().toLowerCase();
	if (!namePattern.test(trimmed)) throw new Error("Skill 名称仅支持小写字母、数字和连字符（最多 64 字符）。");
	return trimmed;
}

export class SkillRegistry {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	async list(project?: string, projectTrusted = true): Promise<SkillDefinitionEntry[]> {
		const out: SkillDefinitionEntry[] = [
			...(await scanSkillDirectory(join(this.agentDir(), "skills"), "user", true)),
			...(await scanSkillDirectory(join(homedir(), ".claude", "skills"), "user", false)),
			...(await scanCommandsDirectory(join(homedir(), ".claude", "commands"), "user")),
		];
		if (project && isAbsolute(project) && projectTrusted) {
			out.push(
				...(await scanSkillDirectory(join(project, ".pi", "skills"), "project", true)),
				...(await scanSkillDirectory(join(project, ".claude", "skills"), "project", false)),
				...(await scanCommandsDirectory(join(project, ".claude", "commands"), "project")),
			);
		}
		return out;
	}

	async save(input: SkillSaveInput): Promise<SkillDefinitionEntry[]> {
		const name = validateName(input.name);
		if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500)
			throw new Error("Skill 描述不能为空且不超过 500 字符。");
		if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 128 * 1024)
			throw new Error("Skill 指令正文不能为空。");
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Skill 作用域无效。");
		const baseDir =
			input.scope === "user"
				? join(this.agentDir(), "skills")
				: (() => {
						if (!input.project || !isAbsolute(input.project)) throw new Error("项目 Skill 需要绝对项目路径。");
						return join(input.project, ".pi", "skills");
					})();
		const skillDir = join(baseDir, name);
		const file = join(skillDir, "SKILL.md");
		await mkdir(skillDir, { recursive: true });
		const frontmatter = [
			"---",
			`name: ${name}`,
			`description: ${input.description.trim().replace(/\r?\n/g, " ")}`,
			"---",
			"",
			input.body.trim(),
			"",
		].join("\n");
		await writeFile(`${file}.tmp`, frontmatter, "utf8");
		await rename(`${file}.tmp`, file);
		return this.list(input.project, true);
	}

	async remove(input: SkillRemoveInput): Promise<SkillDefinitionEntry[]> {
		const name = validateName(input.name);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Skill 作用域无效。");
		const baseDir =
			input.scope === "user"
				? join(this.agentDir(), "skills")
				: (() => {
						if (!input.project || !isAbsolute(input.project)) throw new Error("项目 Skill 需要绝对项目路径。");
						return join(input.project, ".pi", "skills");
					})();
		await rm(join(baseDir, name), { recursive: true, force: true });
		return this.list(input.project, true);
	}
}
