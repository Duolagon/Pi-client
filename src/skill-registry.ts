import { managedDirectory, managedFile, writeManagedFile } from "./managed-path.ts";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type SkillScope = "user" | "project";
export type SkillEntryScope = SkillScope | "bundled";

export interface SkillDefinitionEntry {
	id: string;
	name: string;
	description: string;
	body: string;
	scope: SkillEntryScope;
	kind: "skill" | "command";
	sourceDir: string;
	filePath: string;
	editable: boolean;
	estimatedTokens: number;
	/** Frontmatter `disable-model-invocation: true`; forbids preloading into subagents. */
	disableModelInvocation?: boolean;
	/** Frontmatter `context: fork`; executes the skill in an isolated sub-agent. */
	context?: "fork";
	/** Optional frontmatter `agent:` specifying the sub-agent type when `context: fork` is set. */
	agent?: string;
}

export interface SkillSaveInput {
	name: string;
	description: string;
	body: string;
	scope: SkillScope;
	project?: string;
	context?: "fork";
	agent?: string;
}

export interface SkillRemoveInput {
	name: string;
	scope: SkillScope;
	project?: string;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Guides for WorkflowRun and worktree fan-out; delegated children cannot use either. */
export const ORCHESTRATION_SKILLS: ReadonlySet<string> = new Set(["batch", "workflow-authoring"]);
export const BUNDLED_SKILLS: readonly SkillDefinitionEntry[] = [
	modelSkill(
		"batch",
		"Split a large repository change (a migration, a rename across many files, the same fix in many modules) into independent units and run them in parallel in isolated worktrees",
		[
			"# /batch: parallel change orchestration",
			"",
			"Use this for one change that has to be made in many places, where each place can be done without the others.",
			"",
			"## 1. Understand before you split",
			"Read enough of the repository to know where the change lands and how it is tested. Find the project's type check and test commands. If one unit would need another's result first (a shared type that the rest import, a helper they all call), do that unit yourself before fanning out.",
			"",
			"## 2. Split into units that are truly independent",
			"Aim for 5 to 30 units. Two units are independent only if neither needs the other's result and they do not edit the same files. A unit that is too small wastes an agent; one that is too large defeats the parallelism. Group by module or directory when you can.",
			"",
			"## 3. Write the plan to the checklist",
			"Create one TodoCreate item per unit before starting any of them, so the user sees the whole plan. Put the unit's files and its acceptance criteria in the description. Mark each in_progress when its agent starts and completed when you have checked its result.",
			"",
			"## 4. Run the units",
			"For up to about 8 units, launch one Agent per unit in a single message, with isolation \"worktree\" and run_in_background true. For more, or when every unit needs the same verification step afterwards, write a WorkflowRun script that fans out with parallel().",
			"Brief each agent completely, since the prompt is its only context: the exact change, the files in its unit and only those, the checks to run before it reports, and what to return (files changed, check results, anything it could not do). Tell it not to touch files outside its unit.",
			"",
			"## 5. Check and report",
			"Read each agent's report as evidence, not proof. Look at the diff of any unit whose report is vague or whose checks failed. Tell the user which worktrees are ready to merge, which need attention and why. Do not merge on their behalf unless they asked.",
		],
	),
	modelSkill(
		"workflow-authoring",
		"How to write a WorkflowRun script: the API, determinism rules, resume behaviour and worked examples of fan-out, adversarial verification and loop-until-dry",
		[
			"# Writing a WorkflowRun script",
			"",
			"The script is the body of an async function. Use await directly. It runs in a sandbox with no file system, network or timers; all real work happens in the agents it starts.",
			"",
			"## API",
			"- `agent({prompt, description?, subagent_type?, model?, isolation?, schema?, key?})` starts one subagent and resolves to `{output, structuredOutput?, taskId, usage?, worktreeId?}`. `subagent_type` defaults to general-purpose; use Explore for read-only searching. `isolation` is \"worktree\" or \"shared\". With `schema` (a JSON Schema) the agent must call StructuredOutput, and `structuredOutput` holds the validated value; invalid output is retried up to five times.",
			"- `parallel([thunk, ...])` runs the thunks concurrently and resolves when all of them have. Pass functions (`() => agent(...)`), not promises.",
			"- `pipeline(value, step1, step2, ...)` passes a value through the steps one after another and resolves to the last result.",
			"- `phase(name, async () => {...})` groups the steps inside it under a heading in the progress view and resolves to the callback's result.",
			"- `log(...values)` shows a progress line. `budget()` resolves to `{spentCost, spentTokens, spawnedAgents, maxCost?, maxTokens?, maxAgents}`.",
			"- The script's return value is what you receive back from the tool.",
			"",
			"## Determinism and resume",
			"`Math.random()`, `Date.now()`, argless `new Date()`, `setTimeout`, `fetch`, `require` and `import` throw or are absent. Completed agent() steps are journaled by their position in the script, or by `key` when you pass one. A resumed run replays journaled steps instead of re-running them, so keep the order of agent() calls stable. Inside a loop whose length depends on earlier results, pass a `key` built from the item (for example the file path) so a step keeps its identity.",
			"",
			"## Briefing agents",
			"Each prompt is that agent's only context. Give it the goal, the exact files or scope, what to return and in what shape. When later code reads the result, pass a schema so you branch on fields instead of parsing prose.",
			"",
			"## Example: fan out, then verify each finding",
			"```js",
			"const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, claim: { type: 'string' } }, required: ['file', 'claim'] } } }, required: ['findings'] };",
			"const VERDICT = { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted', 'reason'] };",
			"const areas = ['src/auth', 'src/api', 'src/storage'];",
			"const found = await phase('Find', () => parallel(areas.map((area) => () => agent({",
			"  description: `review ${area}`, subagent_type: 'Explore', schema: FINDINGS, key: `find:${area}`,",
			"  prompt: `Review ${area} for real defects. Report each with file, line and the concrete failure. Stay inside ${area}.`,",
			"}))));",
			"const all = found.flatMap((r) => r.structuredOutput.findings);",
			"log(`${all.length} candidate findings`);",
			"const checked = await phase('Verify', () => parallel(all.map((f, i) => () => parallel([0, 1, 2].map((n) => () => agent({",
			"  description: `refute ${i}.${n}`, subagent_type: 'Explore', schema: VERDICT, key: `verify:${f.file}:${f.line}:${n}`,",
			"  prompt: `Try to REFUTE this claim by reading the code. Default to refuted=true if you cannot confirm it.\\nClaim: ${f.claim}\\nLocation: ${f.file}:${f.line}`,",
			"}))).then((votes) => ({ ...f, survives: votes.filter((v) => !v.structuredOutput.refuted).length >= 2 })))));",
			"return checked.filter((f) => f.survives);",
			"```",
			"",
			"## Example: loop until nothing new turns up",
			"```js",
			"const seen = new Set();",
			"const kept = [];",
			"let dry = 0, round = 0;",
			"while (dry < 2 && round < 6) {",
			"  const r = await agent({ key: `round:${round}`, schema: FINDINGS, subagent_type: 'Explore',",
			"    prompt: `Find defects in src/ not already in this list:\\n${[...seen].join('\\n') || '(none yet)'}` });",
			"  const fresh = r.structuredOutput.findings.filter((f) => !seen.has(`${f.file}:${f.claim}`));",
			"  fresh.forEach((f) => seen.add(`${f.file}:${f.claim}`));",
			"  kept.push(...fresh);",
			"  dry = fresh.length ? 0 : dry + 1;",
			"  round++;",
			"}",
			"log(`stopped after ${round} rounds, ${kept.length} findings`);",
			"return kept;",
			"```",
			"Deduplicate against everything seen, not only what was kept, or a rejected finding comes back every round and the loop never ends.",
			"",
			"## Sizing",
			"Bound a run with budget.maxAgents and maxCost in the tool call. Report anything you capped or skipped; a silent limit reads as full coverage.",
		],
	),
	bundledSkill(
		"code-review",
		"Review the current diff, a pull request number, a branch or a path for correctness bugs, then report verified findings ranked by severity",
		[
			"# /code-review",
			"",
			"Review code changes for real defects. Do not edit files unless the arguments contain `--fix`.",
			"",
			"## 1. Pick the target from the arguments",
			"- No arguments: the uncommitted work. Run `git status --porcelain` and `git diff HEAD`; read untracked files that `git status` lists. If there is nothing, review the commits on this branch that are not on the default branch (`git merge-base HEAD origin/HEAD` or `main`).",
			"- A number such as `123` or a pull request URL: run `gh pr view <n>` and `gh pr diff <n>`. If `gh` is missing or not signed in, say so and stop.",
			"- A branch name: `git diff $(git merge-base HEAD <branch>)...<branch>`.",
			"- A file or directory path: review that code as it is now.",
			"",
			"## 2. Find candidate problems",
			"Read every changed hunk together with enough surrounding code to understand it: callers, callees, types and tests. For a diff larger than about 400 lines, split the files into 2–5 groups and start one `Agent` with `subagent_type: \"Explore\"` per group in parallel; ask each for concrete defects with file and line, not style notes.",
			"Look for: wrong logic or conditions, off-by-one errors, null or undefined access, unhandled errors and rejected promises, race conditions, resource leaks, broken contracts between caller and callee, missing input validation at trust boundaries, security problems, and behaviour changes the change did not intend. Also note duplicated code that an existing helper already covers.",
			"",
			"## 3. Verify",
			"For each candidate, re-read the code and try to prove it wrong. Keep it only if you can name concrete inputs or a state that produce wrong output, a crash or data loss. Drop anything you cannot confirm, pure style preferences, and issues in code the change did not touch.",
			"",
			"## 4. Report",
			"Reply in the user's language. List the findings most severe first. For each: severity (high / medium / low), `path:line`, one sentence on the defect, the failure scenario, and a suggested fix. If nothing survived verification, say so plainly and mention what you checked.",
			"With `--fix`: after the report, apply the fixes for the verified findings, run the project's type check and tests if they exist, and report the results.",
		],
	),
	bundledSkill(
		"security-review",
		"Security review of the pending changes on the current branch: injection, authorization, secrets, path traversal and other exploitable issues",
		[
			"# /security-review",
			"",
			"Review the pending changes for exploitable security vulnerabilities. Do not edit files.",
			"",
			"## Scope",
			"Use the arguments as the target if given (pull request number, branch or path). Otherwise review `git diff HEAD` plus untracked files, or, when the tree is clean, the commits on this branch that are not on the default branch.",
			"",
			"## What to look for",
			"- Injection: SQL, shell commands built from strings, template, LDAP, XPath, header and log injection.",
			"- Authentication and authorization: missing checks, privilege escalation, insecure direct object references, session handling.",
			"- Secrets: keys, tokens or passwords in code, logs, URLs or error messages.",
			"- File system: path traversal, unsafe symlink handling, writing outside the intended directory, insecure temporary files.",
			"- Network: SSRF, open redirects, disabled TLS verification, CORS that is too broad.",
			"- Data handling: unsafe deserialization, prototype pollution, XSS, unsafe `eval` or dynamic `require`, missing output encoding.",
			"- Cryptography: weak algorithms, predictable randomness for security values, hard-coded keys or IVs.",
			"",
			"## Rules",
			"Trace each candidate from an attacker-controlled input to the dangerous sink and confirm that no validation stops it on the way. Keep only findings you are at least 80% confident are exploitable. Leave out denial of service through resource exhaustion, rate limiting, theoretical issues without a concrete path, missing hardening that is not itself a vulnerability, and code the change did not touch.",
			"",
			"## Report",
			"Reply in the user's language. For each finding: severity (high / medium), category, `path:line`, the attack scenario with the input an attacker controls, and a concrete fix. If you found nothing that meets the bar, say so and list the areas you checked.",
		],
	),
	bundledSkill(
		"simplify",
		"Review the changed code for reuse, simplification and efficiency, then apply the cleanups without changing behaviour",
		[
			"# /simplify",
			"",
			"Clean up the changed code without changing what it does. This is a quality pass, not a bug hunt; suggest `/code-review` for that.",
			"",
			"## 1. Target",
			"Use the arguments as the target if given (path, branch or pull request number). Otherwise use `git diff HEAD` plus untracked files.",
			"",
			"## 2. Look for",
			"- Reuse: new code that duplicates an existing helper, utility or component in the repository. Search for it before concluding.",
			"- Simplification: needless indirection, dead code, redundant conditions, copy-pasted blocks, state that can be derived, overly defensive checks on values that cannot be missing.",
			"- Efficiency: repeated work inside loops, N+1 queries or file reads, unnecessary copies, work that can be skipped early.",
			"- Altitude: logic placed in the wrong layer, or abstractions with a single caller that add nothing.",
			"",
			"## 3. Apply",
			"Make the changes in small edits that follow the project's existing style. Do not rename public APIs, change behaviour, or touch code outside the changed area. Skip a cleanup if you are not sure it is behaviour-preserving.",
			"After editing, run the project's type check and tests if they exist and fix anything you broke.",
			"",
			"## 4. Report",
			"Reply in the user's language with a short list of what you changed and why, what you considered and left alone, and the result of the checks.",
		],
	),
	bundledSkill(
		"review",
		"Review a GitHub pull request: summary, risks, defects and suggestions (uses the gh CLI; nothing is posted)",
		[
			"# /review",
			"",
			"Review a pull request. Do not post comments or approve anything; only report back.",
			"",
			"## 1. Find the pull request",
			"- If the arguments give a number or URL, use it.",
			"- Otherwise run `gh pr view --json number,title` for the current branch. If there is none, run `gh pr list --limit 10` and ask which one to review.",
			"If `gh` is missing or not signed in, explain how to fix that (`gh auth login`) and stop.",
			"",
			"## 2. Gather",
			"Run `gh pr view <n> --json title,body,author,baseRefName,headRefName,files,additions,deletions` and `gh pr diff <n>`. Read the changed files in the working tree when the branch is checked out, so you see full context.",
			"",
			"## 3. Review",
			"Check that the change does what the description says, look for defects (logic, error handling, edge cases, security, compatibility), missing or weak tests, and documentation that should change. Verify each problem against the code before reporting it.",
			"",
			"## 4. Report",
			"Reply in the user's language with: a two or three sentence summary of the change; the problems found, most severe first, each with `path:line`, what goes wrong and a suggested fix; smaller suggestions; and an overall verdict (ready to merge, needs changes, or needs discussion).",
		],
	),
];

function bundledSkill(name: string, description: string, lines: string[]): SkillDefinitionEntry {
	const body = lines.join("\n");
	return {
		id: `bundled:skill:${name}`,
		name,
		description,
		body,
		scope: "bundled",
		kind: "skill",
		sourceDir: "builtin:skills",
		filePath: `builtin:skills/${name}/SKILL.md`,
		editable: false,
		estimatedTokens: estimateTokens(body),
		disableModelInvocation: true,
	};
}

/**
 * A bundled skill the model may load on its own when the task calls for it. The review skills
 * stay user-invoked; orchestration guidance is meant to be reached for by the model.
 */
function modelSkill(name: string, description: string, lines: string[]): SkillDefinitionEntry {
	const { disableModelInvocation: _user, ...skill } = bundledSkill(name, description, lines);
	return skill;
}

/** SKILL.md text Pi can load for a bundled skill. */
export function bundledSkillFile(skill: SkillDefinitionEntry): string {
	return [
		"---",
		`name: ${skill.name}`,
		// A JSON string is a valid YAML double-quoted scalar, so ": " in the text stays literal.
		`description: ${JSON.stringify(skill.description)}`,
		...(skill.disableModelInvocation ? ["disable-model-invocation: true"] : []),
		...(skill.context === "fork" ? ["context: fork"] : []),
		...(skill.agent ? [`agent: ${skill.agent}`] : []),
		"---",
		"",
		skill.body,
		"",
	].join("\n");
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	const norm = raw.replace(/\r\n/g, "\n");
	if (!norm.startsWith("---\n")) return { data: {}, body: norm.trim() };
	const end = norm.indexOf("\n---", 4);
	if (end < 0) return { data: {}, body: norm.trim() };
	const data: Record<string, string> = {};
	for (const line of norm.slice(4, end).split("\n")) {
		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const value = m[2].trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				const parsed = JSON.parse(value) as unknown;
				if (typeof parsed === "string") { data[m[1]] = parsed; continue; }
			} catch { /* An imported YAML scalar may use a different escape convention. */ }
		}
		data[m[1]] = value.replace(/^["']|["']$/g, "");
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
				const disableModelInvocation = String(data["disable-model-invocation"] ?? "").trim().toLowerCase() === "true";
				const context = String(data.context ?? "").trim().toLowerCase() === "fork" ? "fork" as const : undefined;
				const agent = data.agent?.trim() || undefined;
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
					...(disableModelInvocation ? { disableModelInvocation: true } : {}),
					...(context ? { context } : {}),
					...(agent ? { agent } : {}),
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
				const context = String(data.context ?? "").trim().toLowerCase() === "fork" ? "fork" as const : undefined;
				const agent = data.agent?.trim() || undefined;
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
					...(context ? { context } : {}),
					...(agent ? { agent } : {}),
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

/** Extracts a `/skill-name [args]` or `/skill:skill-name [args]` invocation from user prompt text. */
export function parseSkillInvocation(message: string): { name: string; args: string } | null {
	const trimmed = message.trim();
	const match = /^\/(?:skill:)?([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i.exec(trimmed);
	if (!match) return null;
	return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Builds the self-contained prompt passed to a sub-agent when a skill has `context: fork`. */
export function formatForkedSkillPrompt(skill: Pick<SkillDefinitionEntry, "name" | "body">, args: string): string {
	const body = skill.body.trim();
	if (body.includes("$ARGUMENTS")) {
		return body.replaceAll("$ARGUMENTS", args);
	}
	return args ? `${body}\n\nArguments:\n${args}` : body;
}

export class SkillRegistry {
	private agentDir: () => string;

	constructor(options: { agentDir: () => string }) {
		this.agentDir = options.agentDir;
	}

	async list(project?: string, projectTrusted = true): Promise<SkillDefinitionEntry[]> {
		const out: SkillDefinitionEntry[] = [];
		if (project && isAbsolute(project) && projectTrusted) {
			out.push(
				...(await scanSkillDirectory(join(project, ".pi", "skills"), "project", true)),
				...(await scanSkillDirectory(join(project, ".claude", "skills"), "project", false)),
				...(await scanCommandsDirectory(join(project, ".claude", "commands"), "project")),
			);
		}
		out.push(
			...(await scanSkillDirectory(join(this.agentDir(), "skills"), "user", true)),
			...(await scanSkillDirectory(join(homedir(), ".claude", "skills"), "user", false)),
			...(await scanCommandsDirectory(join(homedir(), ".claude", "commands"), "user")),
		);
		for (const bundled of BUNDLED_SKILLS) {
			if (!out.some((entry) => entry.name.toLowerCase() === bundled.name)) out.push(bundled);
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
		const { base, segments } = this.location(input.scope, input.project, name);
		const file = (await managedFile(base, segments, "SKILL.md", true))!;
		const frontmatter = [
			"---",
			`name: ${name}`,
			`description: ${JSON.stringify(input.description.trim().replace(/\r?\n/g, " "))}`,
			...(input.context === "fork" ? ["context: fork"] : []),
			...(input.agent?.trim() ? [`agent: ${JSON.stringify(input.agent.trim().replace(/\r?\n/g, " "))}`] : []),
			"---",
			"",
			input.body.trim(),
			"",
		].join("\n");
		await writeManagedFile(file, frontmatter);
		return this.list(input.project, true);
	}

	async remove(input: SkillRemoveInput): Promise<SkillDefinitionEntry[]> {
		const name = validateName(input.name);
		if (input.scope !== "user" && input.scope !== "project") throw new Error("Skill 作用域无效。");
		const { base, segments } = this.location(input.scope, input.project, name);
		const directory = await managedDirectory(base, segments, false);
		if (directory) await rm(directory, { recursive: true, force: true });
		return this.list(input.project, true);
	}

	private location(scope: SkillScope, project: string | undefined, name: string) {
		if (scope === "user") return { base: this.agentDir(), segments: ["skills", name] };
		if (!project || !isAbsolute(project)) throw new Error("项目 Skill 需要绝对项目路径。");
		return { base: project, segments: [".pi", "skills", name] };
	}
}
