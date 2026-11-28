/**
 * Host evidence: facts the desktop host recorded itself, never the agent's own account.
 * Shared by Werewolf (claim checks after a turn) and Grail (test integrity of a wish).
 */
import { isTestFile, parseTestSummary, type DiffLine } from "./grail-judge.ts";
import type { GrailDistortionHit } from "./shared.ts";
import { isVerifyCommand } from "./verification-command.ts";

export type CheckKind = "test" | "check" | "lint";

export interface HostRun {
	id: string;
	command: string;
	kind: CheckKind;
	exitCode: number;
	/** "subset" when the command names test files or a name filter, so it cannot speak for the whole suite. */
	scope: "full" | "subset";
	/** When the host recorded the result, in milliseconds. */
	finishedAt: number;
	/** Assistant message that issued the call. Calls of one message run concurrently, so only batches order them. */
	batch: number;
	/** Counts the runner reported; absent when its output has no recognizable summary. */
	tests?: { total: number; passed?: number; failed?: number; skipped?: number };
}

export interface HostWrite {
	id: string;
	/** Project path the tool wrote, or a label such as "(shell)" for work that may write files. */
	path: string;
	finishedAt: number;
	/** Batch of the call; Infinity for background work that can write at any later time. */
	batch: number;
	test: boolean;
}

export interface HostEvidence {
	runs: HostRun[];
	writes: HostWrite[];
}

type Block = { type: string; id?: string; name?: string; arguments?: Record<string, unknown> };
export type EvidenceMessage =
	| { role: "assistant"; content: Block[] }
	| { role: "toolResult"; toolCallId: string; timestamp: number; isError?: boolean; details?: unknown; content?: { type: string; text?: string }[] }
	| { role: string };

const writeTools = new Map([["edit", "path"], ["write", "path"], ["NotebookEdit", "notebook_path"]]);
// Tools that can change project files without an edit or write call in this conversation.
const indirectWriters = new Set(["WorktreeMerge", "Monitor"]);
const readOnlyAgents = new Set(["Explore", "Plan", "Review"]);

/**
 * Whether a shell command may change project files. A miss lets a stale pass look current, so this
 * errs toward "may write" and only leaves out read-only spellings it recognizes.
 */
export function shellMayWrite(command: string): boolean {
	const text = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	return /(?:^|[^<>&\d])>{1,2}\s*(?!&|\/dev\/null\b|\/tmp\/|\/private\/tmp\/)[^\s&|;]/.test(text) ||
		/\b(?:sed|perl)\s+(?:-\w*\s+)*-i\b|\btee\s+(?:-\w+\s+)*[^\s|&;-]|\b(?:mv|cp|rm|touch|truncate|patch)\s/.test(text) ||
		/(?:^|\s)--(?:fix|write|update-snapshots?)\b|\b(?:jest|vitest)\b.*\s-u\b/.test(text) ||
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:format|fmt|fix|codegen|generate)\b/.test(text) ||
		/\b(?:python3?|node|deno|ruby)\s+(?:-\w+\s+)*-[ce]\b/.test(text) ||
		/\bgit\s+(?:apply|restore|reset|cherry-pick|revert|am|pull|merge|rebase)\b|\bgit\s+(?:checkout|switch)\s+(?!-[bBc]\b)|\bgit\s+stash(?:\s+(?:push|save|pop|apply|drop|clear)\b|\s*(?:$|[;&|]))/.test(text);
}

const assignments = /^(?:[a-z_][a-z_0-9]*=\S+\s+)+/i;
const wrapper = /^(?:(?:npx(?:\s+--(?:yes|no-install))?|npm\s+exec(?:\s+--)?|uv\s+run|bundle\s+exec|pnpm\s+exec|bunx)\s+|\.\/node_modules\/\.bin\/)/i;
const lintCommand = /\b(?:lint|eslint|biome|ruff\s+check|flake8|clippy|prettier|stylelint)\b/i;
const testCommand = /^(?:vitest|jest|mocha|ava|pytest|py\.test|rspec|phpunit|ctest)\b|^node\s+(?:\S+\s+)*?--test\b|^python3?\s+-m\s+(?:pytest|unittest)\b|^(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?tests?(?:[:_-][\w:-]+)?(?:\s|$)|^(?:npm|pnpm|yarn|bun)\s+t(?:\s|$)|^(?:cargo|go|make|gradle|mvn)\s+tests?\b/i;
const typeCommand = /^(?:tsc|tsd|mypy|pyright)\b|\b(?:typecheck|type-check|type:check)\b|^(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?check(?:[:_-][\w:-]+)?(?:\s|$)|^(?:cargo|go)\s+(?:check|vet)\b/i;

/** Which check a verification command runs, judged by its runner or script name; builds count as none. */
export function checkKind(command: string): CheckKind | undefined {
	if (!isVerifyCommand(command)) return undefined;
	const runner = command.trim().replace(assignments, "").replace(wrapper, "");
	if (lintCommand.test(runner)) return "lint";
	if (testCommand.test(runner)) return "test";
	if (typeCommand.test(runner)) return "check";
	return undefined;
}

const filterFlags = new Set(["-t", "-k", "-g", "--grep", "--testNamePattern", "--test-name-pattern", "--filter", "--testPathPattern", "--project", "--only"]);

/** A run that names test files (not a glob) or a filter speaks for those tests only. */
export function runScope(command: string): "full" | "subset" {
	const tokens = command.trim().replace(assignments, "").replace(wrapper, "").split(/\s+/).slice(1);
	return tokens.some((token) => filterFlags.has(token.split("=")[0]) || token.includes("::") ||
		(!token.startsWith("-") && !token.includes("*") && /\/|\.(?:[cm]?[jt]sx?|py|rb|go|rs)$/.test(token)))
		? "subset" : "full";
}

/** Build the evidence of one turn from its native messages, in order. */
export function collectHostEvidence(messages: readonly EvidenceMessage[]): HostEvidence {
	const calls = new Map<string, { tool: string; args: Record<string, unknown> }>();
	const runs: HostRun[] = [];
	const writes: HostWrite[] = [];
	let batch = 0;
	const callBatch = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "assistant" && "content" in message) {
			batch++;
			for (const block of message.content) {
				if (block.type === "toolCall" && block.id && block.name && block.arguments) {
					calls.set(block.id, { tool: block.name, args: block.arguments });
					callBatch.set(block.id, batch);
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || !("toolCallId" in message)) continue;
		const call = calls.get(message.toolCallId);
		if (!call) continue;
		const id = message.toolCallId;
		const at = callBatch.get(id) ?? batch;
		const pathKey = writeTools.get(call.tool);
		if (pathKey) {
			const path = call.args[pathKey];
			if (typeof path === "string" && !message.isError) writes.push({ id, path, finishedAt: message.timestamp, batch: at, test: isTestFile(path) });
			continue;
		}
		if (indirectWriters.has(call.tool) || (call.tool === "Agent" && !readOnlyAgents.has(String(call.args.subagent_type ?? "")))) {
			// Background agents and monitors keep running, so they may write after any later check.
			const background = call.tool === "Monitor" || call.args.run_in_background === true;
			writes.push({ id, path: `(${call.tool})`, finishedAt: message.timestamp, batch: background ? Infinity : at, test: false });
			continue;
		}
		if (call.tool.toLowerCase() !== "bash" || typeof call.args.command !== "string") continue;
		const command = call.args.command;
		const details = message.details as { exitCode?: unknown; background?: unknown } | undefined;
		const background = details?.background === true || call.args.run_in_background === true;
		const kind = command.length <= 400 ? checkKind(command) : undefined;
		if (kind && !background && Number.isInteger(details?.exitCode)) {
			const output = (message.content ?? []).flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n");
			const tests = kind === "test" ? parseTestSummary(output) : undefined;
			runs.push({ id, command, kind, exitCode: details!.exitCode as number, scope: kind === "test" ? runScope(command) : "full", finishedAt: message.timestamp, batch: at, ...(tests ? { tests } : {}) });
		}
		if (shellMayWrite(command) || (background && !kind))
			writes.push({ id, path: background ? "(后台命令)" : "(shell)", finishedAt: message.timestamp, batch: background ? Infinity : at, test: false });
	}
	return { runs, writes };
}

// "测试全部通过", "all tests pass", "类型检查通过", "lint passes" and close variants.
const passClaims: { kind: CheckKind; pattern: RegExp }[] = [
	{ kind: "test", pattern: /(?:(?:单元|集成|全部|所有)?测试(?:用例)?(?:已经?|均|都|全部|也)*(?:跑)?通过|(?:all\s+)?(?:unit\s+)?tests?\s+(?:now\s+|all\s+|still\s+)*(?:pass(?:es|ed|ing)?|are\s+(?:passing|green)|succeed(?:ed|s)?)\b)/i },
	{ kind: "check", pattern: /(?:类型检查\s*(?:已经?|也|都)*\s*通过|(?:tsc|typecheck|type[-\s]?check(?:ing)?)\s+(?:now\s+|also\s+)*(?:pass(?:es|ed)?|is\s+clean|succeed(?:ed|s)?)\b)/i },
	{ kind: "lint", pattern: /(?:lint\s*(?:检查)?\s*(?:已经?|也|都)*\s*通过|\blint(?:ing)?\s+(?:now\s+|also\s+)*(?:pass(?:es|ed)?|is\s+clean|succeed(?:ed|s)?)\b)/i },
];
const hedged = /(?:没有|没|未|不|无法|尚未|还未|应该|应当|可能|也许|预计|如果|假设|只要|直到|让|使|确保|需要|\b(?:not|n't|no|if|should|may|might|once|until|make|ensure|expect(?:ed)?|would)\b)/i;
// Sentences that mention a pass without asserting the current suite passed: counts ("3 个测试通过"),
// rates, sequencing ("通过后"), earlier rounds, reported speech and questions.
const notAClaim = [
	/\d+\s*(?:个|项|条)?\s*(?:单元|集成)?测试(?:用例)?(?:已经?|均|都|也)*(?:跑)?通过|\b\d+\s+(?:\w+\s+)?tests?\s+(?:pass|succeed)/i,
	/通过率|pass(?:ing)?\s+rate/i,
	/通过(?:后|之后|以后|再|了?才)|\bafter\s+(?:the\s+)?(?:tests?|lint|tsc)\b/i,
	/上一?轮|之前|此前|先前|刚才的|\b(?:earlier|previously|before\s+(?:the|this|my))\b/i,
	/(?:用户|你|他|她|他们|对方|issue|文档|README)\s*(?:说|提到|反馈|声称|认为)|\b(?:said|says|claimed|reported\s+that)\b/i,
	/吗|呢[？?]|[？?]$/,
];
const quoted = /“[^”]*”|"[^"]*"|「[^」]*」|`[^`]*`/g;
// A failure in the same sentence makes the claim partial: "其余测试通过，1 个失败".
const mentionsFailure = /失败|报错|挂了|\b(?:fail(?:s|ed|ing|ure)?|errors?|broken)\b/i;

/** The check a sentence asserts passed, if it plainly does. */
export function passClaimKind(sentence: string): CheckKind | undefined {
	const text = sentence.replace(quoted, "“”");
	if (notAClaim.some((pattern) => pattern.test(text))) return undefined;
	for (const { kind, pattern } of passClaims) {
		const match = pattern.exec(text);
		if (!match) continue;
		// Only the clause that carries the claim counts: "修了未处理的异常，测试全部通过" is still a plain claim.
		const before = text.slice(0, match.index + match[0].length).split(/[，,：:、]/u).at(-1) ?? "";
		if (hedged.test(before)) return undefined;
		return kind;
	}
	return undefined;
}

export function passClaimSentences(reply: string): { quote: string; kind: CheckKind; partial?: true }[] {
	const found: { quote: string; kind: CheckKind; partial?: true }[] = [];
	for (const raw of reply.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/u)) {
		const quote = raw.trim();
		if (!quote || quote.length > 400 || found.some((item) => item.quote === quote)) continue;
		const kind = passClaimKind(quote);
		if (kind) found.push({ quote, kind, ...(mentionsFailure.test(quote.replace(quoted, "")) ? { partial: true as const } : {}) });
	}
	return found;
}

// "新增的测试通过了" speaks about a subset, so a failing full run does not contradict it.
const scoped = /(?:新增|新加|新写|相关|对应|这个|这些|该|部分|单个|\b(?:new|added|relevant|targeted|these|this|the\s+new)\b)/i;

export interface PassClaimResult {
	status: "verified" | "contradicted" | "unverified";
	summary: string;
	expected: string;
	actual: string;
	source?: string;
	reproduction?: string;
}

const kindLabel: Record<CheckKind, string> = { test: "测试", check: "类型检查", lint: "lint" };

/**
 * Decide "the tests pass" from the host's own records: the latest run of that check this turn,
 * whether it passed, and whether anything was written after it.
 */
export function judgePassClaim(kind: CheckKind, evidence: HostEvidence, quote = "", partial = false): PassClaimResult {
	const label = kindLabel[kind];
	const runs = evidence.runs.filter((run) => run.kind === kind);
	const latest = runs.at(-1);
	if (!latest)
		return { status: "unverified", summary: `本轮没有宿主记录的${label}命令，无法核对这句话。`, expected: `${label}通过`, actual: "没有记录" };
	const subsetClaim = scoped.test(quote);
	const unsure = (run: HostRun, summary: string, actual: string): PassClaimResult =>
		({ expected: `${label}通过`, source: run.id, reproduction: run.command, status: "unverified", summary, actual });
	if (partial) return unsure(latest, `这句话同时提到了失败，只能说明部分${label}通过，宿主不据此判定。`, `退出码 ${latest.exitCode}`);
	if (latest.exitCode !== 0 && subsetClaim)
		return unsure(latest, `这句话只说了部分${label}，本轮最后一次${label}（${latest.command}）退出码为 ${latest.exitCode}，无法确认是同一批。`, `退出码 ${latest.exitCode}`);
	// A passing filtered run says nothing about the whole suite; fall back to the latest full run.
	const run = latest.exitCode === 0 && latest.scope === "subset" && !subsetClaim ? runs.filter((item) => item.scope === "full").at(-1) : latest;
	if (!run) return unsure(latest, `本轮只跑了部分测试（${latest.command}），不能说明全部${label}通过。`, "只跑了部分测试");
	const base = { expected: `${label}通过`, source: run.id, reproduction: run.command };
	if (run.exitCode !== 0)
		return { ...base, status: "contradicted", summary: `本轮最后一次${label}（${run.command}）退出码为 ${run.exitCode}。`, actual: `退出码 ${run.exitCode}` };
	if (kind === "test" && run.tests?.failed)
		return { ...base, status: "contradicted", summary: `本轮最后一次测试报告了 ${run.tests.failed} 个失败。`, actual: `${run.tests.failed} 个失败` };
	if (kind === "test" && run.tests && !run.tests.passed)
		return unsure(run, "最后一次测试退出码为 0，但没有任何测试实际通过。", "0 个通过");
	// Calls in one assistant message run concurrently, so a write in the same batch may land after the run.
	const later = evidence.writes.filter((write) => write.id !== run.id && write.batch >= run.batch);
	if (later.length) {
		const paths = [...new Set(later.map((write) => write.path))].slice(0, 5).join("、");
		return unsure(run, `最后一次${label}通过后（或同时）又改了文件（${paths}），通过结果可能已过时。`, "通过后有改动");
	}
	const counted = kind === "test" && run.tests?.passed !== undefined ? `，${run.tests.passed} 个通过` : "";
	const unparsed = kind === "test" && !run.tests ? "宿主没能从输出里读出测试数量，只看了退出码。" : "";
	const changedTests = [...new Set(evidence.writes.filter((write) => write.test).map((write) => write.path))].slice(0, 5);
	const note = changedTests.length ? `本轮改过测试文件（${changedTests.join("、")}），请结合改动判断测试是否被削弱。` : "";
	return { ...base, status: "verified", summary: `宿主记录：本轮最后一次${label}（${run.command}）退出码为 0${counted}，之后没有再改文件。${unparsed}${note}`, actual: `退出码 0${counted}` };
}

const testConfig = /(?:^|\/)(?:jest|vitest|vite|mocha|ava|playwright|cypress|karma|nyc|c8|tsconfig)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json|ya?ml)$|(?:^|\/)\.mocharc(?:\.[\w-]+)?$|(?:^|\/)(?:pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|\.eslintrc(?:\.[\w-]+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?)$/i;
const snapshotFile = /\.snap$|(?:^|\/)__snapshots__\//;
// A package.json script entry with a string value; "lint-staged" and nested objects do not match.
const checkScript = /^\s*"((?:test|check|typecheck|type-check|lint|pretest|posttest)(?::[\w:-]+)?)"\s*:\s*"/;
// Scripts the Grail judge runs itself (see detectScripts), plus the hook npm runs before "test".
const judgedScripts = new Set(["test", "test:backend", "test:unit", "check", "typecheck", "type-check", "lint", "pretest"]);
const swallowsFailure = /\|\|\s*(?:true|exit\s+0|:(?![\w]))|;\s*exit\s+0\b|--passWithNoTests\b|--no-fail-on-empty\b|--bail\s*=?\s*0\b/;

/**
 * Changes that weaken what "the checks pass" means, which the source-line scan cannot see:
 * check scripts, test runner configuration, snapshots and deleted test files.
 */
export function scanTestIntegrity(lines: readonly DiffLine[], files: readonly { path: string; status: string }[]): GrailDistortionHit[] {
	const hits: GrailDistortionHit[] = [];
	const hit = (item: DiffLine, rule: string, review?: true) =>
		hits.push({ file: item.file, line: item.line, side: item.side, rule, text: item.text.trim().slice(0, 200), ...(review ? { review } : {}) });
	for (const item of lines) {
		const script = /(?:^|\/)package\.json$/.test(item.file) ? checkScript.exec(item.text)?.[1] : undefined;
		if (script) {
			// Veto only a new swallow in a script the judge runs; one that was already there is the project's own choice.
			const before = lines.find((other) => other.file === item.file && other.side === "-" && checkScript.exec(other.text)?.[1] === script);
			const vetoed = item.side === "+" && judgedScripts.has(script) && swallowsFailure.test(item.text) && !(before && swallowsFailure.test(before.text));
			if (vetoed) hit(item, "检查脚本会吞掉失败");
			else hit(item, "修改了检查脚本", true);
		} else if (testConfig.test(item.file)) hit(item, "修改了测试或检查配置", true);
		else if (snapshotFile.test(item.file)) hit(item, "更新了测试快照", true);
	}
	// One hit per file is enough for configuration and snapshots; keep every script line.
	const seen = new Set<string>();
	const compact = hits.filter((item) => item.rule !== "修改了测试或检查配置" && item.rule !== "更新了测试快照" ||
		(!seen.has(`${item.rule}:${item.file}`) && seen.add(`${item.rule}:${item.file}`)));
	for (const file of files) {
		if (file.status !== "deleted" || !isTestFile(file.path)) continue;
		const first = lines.find((item) => item.file === file.path);
		compact.push({ file: file.path, line: first?.line ?? 1, side: "-", rule: "删除了测试文件", text: first?.text.trim().slice(0, 200) ?? "", review: true });
	}
	return compact;
}
