import { spawn } from "node:child_process";
import { parseFallbackModelUpdate } from "./model-routing.ts";
import { GRAIL_CRITERIA } from "./shared.ts";
import type {
	GrailBlindResult,
	GrailBlindSolution,
	GrailCheckName,
	GrailCheckRun,
	GrailCitation,
	GrailComparisonResult,
	GrailCriterion,
	GrailDistortionHit,
	GrailFinding,
	GrailGrade,
	GrailObjectiveResult,
	GrailStepResults,
} from "./shared.ts";

export { GRAIL_CRITERIA };
const criteria = Object.keys(GRAIL_CRITERIA) as GrailCriterion[];

export interface DiffLine {
	file: string;
	side: "+" | "-";
	line: number;
	text: string;
	hunk: number;
}

/** Changed lines of unified per-file diffs, numbered on their own side (new for "+", old for "-"). */
export function parseDiffLines(files: { path: string; diff: string }[]): DiffLine[] {
	const result: DiffLine[] = [];
	let hunk = 0;
	for (const file of files) {
		let oldLine = 0;
		let newLine = 0;
		let inHunk = false;
		for (const raw of file.diff.split("\n")) {
			const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
			if (header) {
				oldLine = Number(header[1]);
				newLine = Number(header[2]);
				inHunk = true;
				hunk++;
				continue;
			}
			if (!inHunk || raw.startsWith("\\")) continue;
			if (raw.startsWith("+")) result.push({ file: file.path, side: "+", line: newLine++, text: raw.slice(1), hunk });
			else if (raw.startsWith("-")) result.push({ file: file.path, side: "-", line: oldLine++, text: raw.slice(1), hunk });
			else if (raw.startsWith(" ")) {
				oldLine++;
				newLine++;
			} else inHunk = false;
		}
	}
	return result;
}

/** Diff rendered with explicit line numbers so the reviewer can cite `file`, `side` and `line`. */
export function annotateDiff(files: { path: string; diff: string }[], maxChars = 200_000): { text: string; truncated: boolean } {
	const out: string[] = [];
	let size = 0;
	for (const file of files) {
		const block: string[] = [`### ${file.path}`];
		let oldLine = 0;
		let newLine = 0;
		let inHunk = false;
		for (const raw of file.diff.split("\n")) {
			const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
			if (header) {
				oldLine = Number(header[1]);
				newLine = Number(header[2]);
				inHunk = true;
				block.push(raw);
				continue;
			}
			if (!inHunk) {
				if (/^(Binary files|差异超过|路径类型)/.test(raw)) block.push(raw);
				continue;
			}
			if (raw.startsWith("+")) block.push(`+ ${newLine++} | ${raw.slice(1)}`);
			else if (raw.startsWith("-")) block.push(`- ${oldLine++} | ${raw.slice(1)}`);
			else if (raw.startsWith(" ")) {
				block.push(`  ${newLine} | ${raw.slice(1)}`);
				oldLine++;
				newLine++;
			}
		}
		const text = block.join("\n");
		if (size + text.length > maxChars) return { text: out.join("\n\n") + "\n\n（diff 过长，其余文件已截断）", truncated: true };
		out.push(text);
		size += text.length + 2;
	}
	return { text: out.join("\n\n"), truncated: false };
}

const sourceFile = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const testFile = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const assertion = /\b(?:assert(?:\.\w+)?|expect)\s*\(|\.should\b|\bt\.(?:is|not|deepEqual|equal|true|false|throws|like|snapshot)\s*\(/;
const addedRules: { rule: string; pattern: RegExp; tests?: boolean }[] = [
	{ rule: "新增 .skip / .only", pattern: /\b(?:describe|it|test|context|suite)\.(?:skip|only)\b|\b(?:xit|xdescribe|fit|fdescribe)\s*\(|\{\s*(?:skip|only)\s*:\s*true\b/ },
	{ rule: "新增 @ts-ignore / @ts-expect-error", pattern: /@ts-(?:ignore|expect-error|nocheck)\b/ },
	{ rule: "新增 as any", pattern: /\bas\s+any\b/ },
	{ rule: "新增 eslint-disable", pattern: /eslint-disable/ },
	{ rule: "留下 console.log", pattern: /\bconsole\.log\s*\(/ },
	{ rule: "留下 debugger", pattern: /(?:^|[;{}\s])debugger\s*(?:;|$)/ },
	{ rule: "新增 TODO", pattern: /\b(?:TODO|FIXME|XXX)\b/ },
];

/** Regex scan of changed lines for cheating traces; every hit carries file and line. */
export function scanDistortions(lines: DiffLine[]): GrailDistortionHit[] {
	const hits: GrailDistortionHit[] = [];
	for (const item of lines) {
		if (!sourceFile.test(item.file)) continue;
		const hit = (rule: string) => hits.push({ file: item.file, line: item.line, side: item.side, rule, text: item.text.trim().slice(0, 200) });
		if (item.side === "+") {
			for (const { rule, pattern } of addedRules) if (pattern.test(item.text)) hit(rule);
		} else if (testFile.test(item.file) && assertion.test(item.text)) {
			const replaced = lines.some((other) => other.hunk === item.hunk && other.side === "+" && assertion.test(other.text));
			hit(replaced ? "测试期望值被修改" : "删除断言");
		}
	}
	return hits;
}

/** Number of tests a runner reported (node --test, vitest, jest, mocha); undefined when unknown. */
export function parseTestCount(output: string): number | undefined {
	const text = output.replace(/\x1b\[[0-9;]*m/g, "");
	const node = [...text.matchAll(/^\s*(?:#|ℹ)\s*tests\s+(\d+)\s*$/gm)];
	if (node.length) return node.reduce((sum, match) => sum + Number(match[1]), 0);
	const jest = /^\s*Tests:\s+.*?(\d+)\s+total/m.exec(text);
	if (jest) return Number(jest[1]);
	const vitest = /^\s*Tests\s+.*?\((\d+)\)\s*$/m.exec(text);
	if (vitest) return Number(vitest[1]);
	const passing = /^\s*(\d+)\s+passing\b/m.exec(text);
	if (passing) {
		const failing = /^\s*(\d+)\s+failing\b/m.exec(text);
		const pending = /^\s*(\d+)\s+pending\b/m.exec(text);
		return Number(passing[1]) + Number(failing?.[1] ?? 0) + Number(pending?.[1] ?? 0);
	}
	return undefined;
}

/** TypeScript diagnostics count from `tsc` output; 0 when tsc printed none. */
export function parseTscErrors(output: string): number {
	const found = /Found (\d+) errors?/.exec(output);
	if (found) return Number(found[1]);
	return (output.match(/error TS\d+:/g) ?? []).length;
}

/** test, check (or typecheck) and lint scripts of a package.json, skipping npm's placeholder test. */
export function detectScripts(manifest: unknown): { name: GrailCheckName; script: string }[] {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
	const scripts = (manifest as { scripts?: unknown }).scripts;
	if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
	const table = scripts as Record<string, unknown>;
	const pick = (...names: string[]) => names.find((name) => typeof table[name] === "string" && (table[name] as string).trim());
	const result: { name: GrailCheckName; script: string }[] = [];
	const test = pick("test");
	if (test && !/no test specified/i.test(table[test] as string)) result.push({ name: "test", script: test });
	const check = pick("check", "typecheck", "type-check");
	if (check) result.push({ name: "check", script: check });
	const lint = pick("lint");
	if (lint) result.push({ name: "lint", script: lint });
	return result;
}

export function packageManager(files: string[]): "npm" | "pnpm" | "yarn" {
	if (files.includes("pnpm-lock.yaml")) return "pnpm";
	if (files.includes("yarn.lock")) return "yarn";
	return "npm";
}

const secretName = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY|AUTH)/i;
/** Child env for project scripts: no credentials, no host test-runner context, non-interactive. */
export function scriptEnvironment(env: NodeJS.ProcessEnv, cacheDir: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || secretName.test(key) || key.startsWith("PI_DESKTOP_") || key.startsWith("AWS_")) continue;
		if (key === "NODE_TEST_CONTEXT" || key === "ELECTRON_RUN_AS_NODE" || key === "GOOGLE_APPLICATION_CREDENTIALS") continue;
		result[key] = value;
	}
	return { ...result, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", npm_config_cache: cacheDir, npm_config_update_notifier: "false", npm_config_logs_max: "0" };
}

const maxOutput = 64 * 1024;
/** Spawn without a shell; output keeps the tail, the process group dies on timeout or abort. */
export function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		const append = (chunk: Buffer | string) => {
			output = (output + chunk.toString()).slice(-maxOutput);
		};
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, Math.max(1, options.timeoutMs));
		options.signal.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => append(`\n${error.message}`));
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal.removeEventListener("abort", kill);
			resolve({ exitCode: code, timedOut, output });
		});
	});
}

/** Step 5.1: run the project's own scripts; only exit codes and the reported test count count. */
export async function runObjectiveChecks(options: {
	project: string;
	manifest: unknown;
	files: string[];
	env: NodeJS.ProcessEnv;
	sandboxProfile?: string;
	deadline: number;
	signal: AbortSignal;
}): Promise<GrailObjectiveResult> {
	if (options.manifest === undefined)
		return { status: "unavailable", reason: "第一版只支持 Node/TypeScript 项目：项目根目录没有 package.json。", runs: [] };
	const scripts = detectScripts(options.manifest);
	if (!scripts.some((item) => item.name === "test"))
		return { status: "unavailable", reason: "package.json 没有可执行的 test 脚本。", runs: [] };
	const manager = packageManager(options.files);
	const runs: GrailCheckRun[] = [];
	for (const { name, script } of scripts) {
		if (options.signal.aborted) throw new Error("鉴定已取消。");
		const args = ["run", script];
		const [command, argv] = options.sandboxProfile
			? ["/usr/bin/sandbox-exec", ["-f", options.sandboxProfile, manager, ...args]]
			: [manager, args];
		const result = await runProcess(command, argv, { cwd: options.project, env: options.env, timeoutMs: options.deadline - Date.now(), signal: options.signal });
		if (options.signal.aborted) throw new Error("鉴定已取消。");
		const run: GrailCheckRun = { name, script, command: `${manager} ${args.join(" ")}`, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output };
		if (name === "test") run.testCount = parseTestCount(result.output);
		if (name === "check") run.errorCount = parseTscErrors(result.output);
		runs.push(run);
		if (result.timedOut) return { status: "fail", reason: `${run.command} 超时。`, runs };
		if (result.exitCode !== 0) return { status: "fail", reason: `${run.command} 退出码 ${result.exitCode ?? "无"}。`, runs };
		if (name === "test" && run.testCount === undefined)
			return { status: "unavailable", reason: "测试通过，但无法从输出读取测试数量。", runs };
		if (name === "test" && run.testCount === 0) return { status: "unavailable", reason: "测试脚本没有运行任何测试（0 个测试不算通过）。", runs };
	}
	return { status: "pass", runs };
}

/** First JSON object in model text, from a fenced block or the outermost braces. */
export function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
	for (const candidate of candidates) {
		if (!candidate?.trim()) continue;
		try {
			const value: unknown = JSON.parse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value)) return value;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

function requirementBlock(requirement: string[]): string {
	return requirement.map((message, index) => `【第 ${index + 1} 条】\n${message}`).join("\n\n");
}

/** Step 5.3 prompt: requirement only; the repository is reachable through read-only tools. */
export function buildBlindPrompt(requirement: string[]): string {
	return [
		"【圣杯盲解】你是独立的资深评审。下面是用户对一个代码任务的全部要求（含中途补充和纠正，以最终要求为准）。",
		"你只能用只读工具查看当前目录下的仓库，不能修改任何文件。仓库可能已经包含别人对这个任务的改动，请自己判断问题的根因，给出你认为最好的解法要点。",
		"只输出一个 JSON 对象，不要输出其他内容：",
		'{"rootCause":"根因在哪里","cutPoint":"该在哪一处下刀","files":["大致要改的文件"],"sizeEstimate":"大致代码量","hardSpots":["难点：并发、边界、失败路径等"],"tests":["需要的测试"]}',
		'如果给不出像样的解法，输出 {"unable":"原因"}。',
		"",
		"用户要求：",
		requirementBlock(requirement),
	].join("\n");
}

function text(value: unknown, max = 4000): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}
function texts(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((item) => text(item, 1000)).filter((item): item is string => Boolean(item)).slice(0, 40);
}

export function parseBlindSolution(output: string): GrailBlindResult {
	const value = extractJson(output) as Record<string, unknown> | undefined;
	if (!value) return { status: "unavailable", reason: "评审没有返回有效的 JSON 盲解。" };
	if (text(value.unable)) return { status: "unavailable", reason: `评审给不出盲解：${text(value.unable)}` };
	const solution: Partial<GrailBlindSolution> = {
		rootCause: text(value.rootCause),
		cutPoint: text(value.cutPoint),
		files: texts(value.files),
		sizeEstimate: text(value.sizeEstimate, 400),
		hardSpots: texts(value.hardSpots),
		tests: texts(value.tests),
	};
	if (!solution.rootCause || !solution.cutPoint || !solution.files?.length || !solution.sizeEstimate || !solution.hardSpots || !solution.tests)
		return { status: "unavailable", reason: "评审的盲解缺少根因、下刀点、文件、代码量、难点或测试。" };
	return { status: "ok", solution: solution as GrailBlindSolution };
}

/** Step 5.4 prompt: requirement, blind solution and the numbered diff; every conclusion must cite. */
export function buildComparisonPrompt(requirement: string[], solution: GrailBlindSolution, diff: string): string {
	return [
		"【圣杯对照】你是独立的资深评审。给你用户要求、一份独立写出的盲解要点，以及实际交付的 diff。逐条判定下面每一项标准。",
		"标准（criterion: 含义）：",
		...criteria.map((key) => `- ${key}: ${GRAIL_CRITERIA[key]}`),
		"要点：下刀点只有比盲解更深或一样深、而且代码相同或更少，才算接近\"道\"。最关键的一问：能不能用更少的代码做到同样好或更好？能，lessCode 就判 false，并在 note 里写出更好的写法。",
		"每条结论都必须引用 diff 中具体的改动行：file 为文件路径，side 为 \"+\"（新增行，用新行号）或 \"-\"（删除行，用旧行号），line 为 diff 中标注的行号。没有引用的结论会被丢弃。",
		"只输出一个 JSON 对象，不要输出其他内容：",
		'{"findings":[{"criterion":"requirement","pass":true,"note":"理由","citations":[{"file":"src/a.ts","side":"+","line":12}]}]}',
		"",
		"用户要求：",
		requirementBlock(requirement),
		"",
		"盲解要点：",
		JSON.stringify(solution, null, 2),
		"",
		"实际 diff（行首 + / - 后的数字是行号）：",
		diff,
	].join("\n");
}

/** Validate the comparison; findings without a citation of a real changed line are dropped. */
export function parseComparison(output: string, lines: DiffLine[]): GrailComparisonResult {
	const value = extractJson(output) as Record<string, unknown> | undefined;
	if (!value || !Array.isArray(value.findings)) return { status: "unavailable", reason: "评审没有返回有效的 JSON 对照结论。", findings: [], dropped: 0 };
	const changed = new Set(lines.map((item) => `${item.side}${item.line}:${item.file}`));
	const findings: GrailFinding[] = [];
	let dropped = 0;
	for (const entry of value.findings.slice(0, 100)) {
		const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
		const criterion = record.criterion as GrailCriterion;
		const citations: GrailCitation[] = (Array.isArray(record.citations) ? record.citations : [])
			.slice(0, 20)
			.flatMap((item: unknown) => {
				const cite = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
				const side = cite.side === "-" ? "-" : cite.side === "+" ? "+" : undefined;
				if (!side || typeof cite.file !== "string" || !Number.isSafeInteger(cite.line)) return [];
				return changed.has(`${side}${cite.line}:${cite.file}`) ? [{ file: cite.file, side, line: cite.line as number }] : [];
			});
		if (!criteria.includes(criterion) || typeof record.pass !== "boolean" || !citations.length) {
			dropped++;
			continue;
		}
		findings.push({ criterion, pass: record.pass, note: text(record.note) ?? "", citations });
	}
	return { status: "ok", findings, dropped };
}

/** Pure verdict from the four step results; a missing step means the evidence is not there. */
export function gradeVerdict(steps: GrailStepResults): { grade: GrailGrade; reasons: string[] } {
	const { objective, distortion, blind, comparison } = steps;
	if (!objective) return { grade: "unjudgeable", reasons: ["没有执行客观检查。"] };
	if (objective.status === "unavailable") return { grade: "unjudgeable", reasons: [objective.reason ?? "没有可执行的测试。"] };
	if (objective.status === "fail") return { grade: "unfulfilled", reasons: [objective.reason ?? "客观检查失败。"] };
	if (!distortion) return { grade: "unjudgeable", reasons: ["没有执行扭曲扫描。"] };
	if (distortion.hits.length)
		return { grade: "twisted", reasons: distortion.hits.map((hit) => `${hit.rule}：${hit.file}:${hit.line}（${hit.side === "+" ? "新增" : "删除"}）`) };
	if (!blind || blind.status !== "ok") return { grade: "unjudgeable", reasons: [blind?.reason ?? "评审给不出盲解。"] };
	if (!comparison || comparison.status !== "ok") return { grade: "unjudgeable", reasons: [comparison?.reason ?? "没有对照结论。"] };
	const verdicts = new Map<GrailCriterion, { pass: boolean; notes: string[] }>();
	for (const finding of comparison.findings) {
		const current = verdicts.get(finding.criterion) ?? { pass: true, notes: [] };
		current.pass &&= finding.pass;
		if (!finding.pass && finding.note) current.notes.push(finding.note);
		verdicts.set(finding.criterion, current);
	}
	const failed = (key: GrailCriterion) => [`${GRAIL_CRITERIA[key]}：未满足${verdicts.get(key)?.notes.length ? `。${verdicts.get(key)!.notes.join("；")}` : "。"}`];
	if (verdicts.get("broken")?.pass === false) return { grade: "twisted", reasons: failed("broken") };
	if (!verdicts.has("requirement")) return { grade: "unjudgeable", reasons: ["评审没有给出带代码引用的需求结论。"] };
	if (!verdicts.get("requirement")!.pass) return { grade: "unfulfilled", reasons: failed("requirement") };
	const reasons = criteria.flatMap((key) => {
		const verdict = verdicts.get(key);
		if (!verdict) return [`${GRAIL_CRITERIA[key]}：评审没有给出带代码引用的结论。`];
		return verdict.pass ? [] : failed(key);
	});
	if (!reasons.length) return { grade: "grail", reasons: ["底线全过，对照达到\"道\"，评审指不出更好的刀法。"] };
	return { grade: "granted", reasons };
}

export function validGrailMaxCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 1000;
}
export function validGrailTimeout(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 30 && (value as number) <= 7200;
}
/** IPC check for settings.grailModel: null clears it, anything else must be { provider, id }. */
export function parseGrailModelUpdate(value: unknown): { provider: string; id: string } | null {
	try {
		return parseFallbackModelUpdate(value);
	} catch {
		throw new Error("评审模型格式错误。");
	}
}
