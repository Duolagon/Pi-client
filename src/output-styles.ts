import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Claude Code compatible output styles appended to the main conversation's system prompt. */
export type OutputStyleSource = "builtin" | "user" | "project";
export interface OutputStyleInfo {
	name: string;
	description: string;
	source: OutputStyleSource;
}
export interface OutputStyle extends OutputStyleInfo {
	/** Text appended to the system prompt; empty for "default". */
	prompt: string;
}

export const DEFAULT_OUTPUT_STYLE = "default";
export const MAX_OUTPUT_STYLE_BYTES = 32 * 1024;
const MAX_STYLE_FILES = 100;
const MAX_NAME_LENGTH = 100;

export const BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
	{ name: DEFAULT_OUTPUT_STYLE, description: "默认：直接完成任务，不额外讲解", source: "builtin", prompt: "" },
	{
		name: "explanatory",
		description: "讲解：完成任务的同时简要说明实现思路与取舍",
		source: "builtin",
		prompt: [
			"Output style: Explanatory.",
			"Complete the user's task as you normally would. Along the way, help the user understand the codebase and the reasons behind your choices.",
			"When you make a non-obvious decision (choosing an approach, following a project convention, handling an edge case), add a short block that starts with **Insight:** and contains two or three concise bullet points.",
			"Keep insights specific to this code and this task rather than general programming advice, and never let them replace or delay the actual work.",
		].join("\n"),
	},
	{
		name: "learning",
		description: "学习：留出小段关键代码请你亲手实现（TODO(human)）",
		source: "builtin",
		prompt: [
			"Output style: Learning.",
			"Help the user learn by doing while still moving the task forward.",
			"When the task needs a small but meaningful piece of logic (a design decision, business rule, algorithm step or error-handling choice, roughly 2 to 10 lines), write the surrounding code yourself and leave that piece to the user: put a `TODO(human)` comment at the exact spot, then stop and ask the user to implement it.",
			"In the request, say which file and function contain the TODO(human), what the code should do, and which trade-offs to consider. Ask for at most one contribution at a time and wait for the user before continuing.",
			"Write boilerplate, repetitive and purely mechanical code yourself. When you make a non-obvious choice, explain it briefly in a short block that starts with **Insight:**.",
		].join("\n"),
	},
];

/** Parses a style Markdown file with optional YAML frontmatter (`name`, `description`). */
export function parseOutputStyle(raw: string, fallbackName: string): { name: string; description: string; prompt: string } {
	const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	const data: Record<string, string> = {};
	let body = text;
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		if (end >= 0) {
			for (const line of text.slice(4, end).split("\n")) {
				const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
				if (match) data[match[1].toLowerCase()] = unquote(match[2].trim());
			}
			body = text.slice(end + 4).replace(/^[^\n]*\n?/, "");
		}
	}
	const name = cleanName(data.name) || cleanName(fallbackName) || "";
	return { name, description: (data.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300), prompt: body.trim() };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))))
		return value.slice(1, -1);
	return value;
}

function cleanName(value: string | undefined): string {
	// eslint-disable-next-line no-control-regex
	return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}

/** Validates a style name from IPC or settings; returns the trimmed name. */
export function validOutputStyleName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	// eslint-disable-next-line no-control-regex
	if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
	return name;
}

async function scanDirectory(directory: string, source: "user" | "project"): Promise<OutputStyle[]> {
	let entries: string[];
	try {
		entries = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".md")).sort().slice(0, MAX_STYLE_FILES);
	} catch {
		return [];
	}
	const styles: OutputStyle[] = [];
	for (const entry of entries) {
		const file = join(directory, entry);
		try {
			const info = await stat(file);
			if (!info.isFile() || info.size > MAX_OUTPUT_STYLE_BYTES) continue;
			const parsed = parseOutputStyle(await readFile(file, "utf8"), basename(entry, entry.slice(-3)));
			if (!parsed.name || !parsed.prompt) continue;
			styles.push({ ...parsed, source });
		} catch {
			/* Unreadable style files are skipped. */
		}
	}
	return styles;
}

/**
 * Lists built-in, user (`~/.claude/output-styles`) and project
 * (`<project>/.claude/output-styles`, trusted projects only) styles. A later
 * scope replaces an earlier one with the same name (case-insensitive), except
 * "default", which always means no change.
 */
export async function discoverOutputStyles(options: { home: string; project?: string; trusted: boolean }): Promise<OutputStyle[]> {
	const byName = new Map<string, OutputStyle>();
	for (const style of BUILTIN_OUTPUT_STYLES) byName.set(style.name.toLowerCase(), style);
	const scopes: OutputStyle[][] = [await scanDirectory(join(options.home, ".claude", "output-styles"), "user")];
	if (options.project && options.trusted)
		scopes.push(await scanDirectory(join(options.project, ".claude", "output-styles"), "project"));
	for (const styles of scopes)
		for (const style of styles) {
			const key = style.name.toLowerCase();
			if (key === DEFAULT_OUTPUT_STYLE) continue;
			byName.set(key, style);
		}
	return [...byName.values()];
}

export function findOutputStyle(styles: readonly OutputStyle[], name: string | undefined): OutputStyle | undefined {
	if (!name) return undefined;
	const key = name.trim().toLowerCase();
	return styles.find((style) => style.name.toLowerCase() === key);
}

/** Text the runtime appends to the system prompt; empty when the style is default or missing. */
export function outputStylePromptSection(style: OutputStyle | undefined): string {
	if (!style || !style.prompt) return "";
	return `# Output style: ${style.name}\n\n${style.prompt}`;
}
