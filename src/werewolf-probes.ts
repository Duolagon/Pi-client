import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { probeSeatbeltSupport } from "./sandbox.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Expression =
	| { literal: Json }
	| { call: { module: string; exportName: string; args: Expression[] } }
	| { pick: { from: Expression; path: (string | number)[] } };

export type WerewolfProbe =
	| { kind: "behavior"; op: "equal" | "different" | "contains" | "omits"; left: Expression; right: Expression }
	| { kind: "source"; file: string; exact: string };

export interface WerewolfProbeResult {
	status: "verified" | "contradicted" | "unverified";
	summary: string;
	expected?: string;
	actual?: string;
	reproduction?: string;
	source?: string;
}

const maxInputBytes = 24 * 1024;
const maxOutputBytes = 128 * 1024;
const maxSourceBytes = 1024 * 1024;
const timeoutMs = 3000;
const maxAttempts = 2;
const behaviorExpectations = {
	equal: "两侧结构化结果应相同。",
	different: "两侧结构化结果应不同。",
	contains: "左侧结果应包含右侧值。",
	omits: "左侧结果应排除右侧值。",
} as const;

export const werewolfProbeInstructions = `
Use a behavior probe to test a concrete directly observable claim against the snapshot.
Schema: {"kind":"behavior","op":"equal"|"different"|"contains"|"omits","left":expression,"right":expression}.
Expressions:
  {"literal": any JSON value}
  {"call":{"module":"relative/path.ts","exportName":"actualExport","args":[expression,...]}}
  {"pick":{"from":expression,"path":["actualField",0]}}
Only real JS or TypeScript function exports in the snapshot can be invoked. No shell, scripts of your own, network, or writable files.
When the quoted text writes out an expected result, make one side that exact {"literal": ...} value and the other the call on the input the text names. That is the shape a stated outcome binds to; deriving the same fact another way (comparing two calls, picking a length, omitting a substring) leaves the claim unverified.
For equality checks with no stated outcome, prefer two genuinely different inputs or compare a real result to the original input after a round trip.
Quote the whole assertion and retain the actual function or module reference if it appears in the original text. A supported check binds the asserted outcome to its exact observed output or the round-trip or isolation property to the corresponding calls.
For contains/omits, use a string substring or an array item. A missing export, thrown error, or nondeterministic output is unverified.
For a direct source inspection use {"kind":"source","file":"relative/path","exact":"a short literal excerpt"}.
A source match is supporting context only. A bare string match does not establish behavior or an absence claim.
`.trim();

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return;
	return value as Record<string, unknown>;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeKey(value: string): boolean {
	return value.length <= 120 && !["__proto__", "prototype", "constructor"].includes(value);
}

function sourcePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 500 &&
		!/[:\\\x00-\x1f\x7f]/.test(value) && !isAbsolute(value) &&
		value.split("/").every((part) => part && part !== "." && part !== ".." &&
			part !== ".git" && part !== "node_modules" && !/^\.env(?:\.|$)/i.test(part));
}

function jsonValue(value: unknown, depth: number): value is Json {
	if (depth > 12) return false;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") return value.length < maxInputBytes;
	if (Array.isArray(value)) return value.length <= 150 && value.every((item) => jsonValue(item, depth + 1));
	const entries = record(value);
	return entries !== undefined && Object.keys(entries).length <= 150 &&
		Object.entries(entries).every(([key, item]) => safeKey(key) && jsonValue(item, depth + 1));
}

function expression(value: unknown, budget: { remaining: number }, depth = 0): value is Expression {
	if (depth > 7 || --budget.remaining < 0) return false;
	const object = record(value);
	if (!object) return false;
	if (hasKeys(object, ["literal"])) return jsonValue(object.literal, 0);
	if (hasKeys(object, ["call"])) {
		const call = record(object.call);
		return Boolean(call && hasKeys(call, ["module", "exportName", "args"]) &&
			sourcePath(call.module) && /\.(?:[cm]?[jt]s)$/i.test(call.module) &&
			typeof call.exportName === "string" && /^[a-zA-Z_$][\w$]{0,79}$/.test(call.exportName) &&
			Array.isArray(call.args) && call.args.length <= 10 &&
			call.args.every((arg) => expression(arg, budget, depth + 1)));
	}
	if (hasKeys(object, ["pick"])) {
		const pick = record(object.pick);
		return Boolean(pick && hasKeys(pick, ["from", "path"]) &&
			Array.isArray(pick.path) && pick.path.length > 0 && pick.path.length <= 10 &&
			pick.path.every((part) => typeof part === "number" ? Number.isSafeInteger(part) && part >= 0 :
				typeof part === "string" && safeKey(part)) &&
			expression(pick.from, budget, depth + 1));
	}
	return false;
}

function invokesSource(value: Expression): boolean {
	return "call" in value || ("pick" in value && invokesSource(value.pick.from));
}

function operation(value: Expression): Extract<Expression, { call: unknown }>["call"] | undefined {
	return "call" in value ? value.call : "pick" in value ? operation(value.pick.from) : undefined;
}

function operationShape(value: Expression): unknown {
	if ("literal" in value) return null;
	if ("pick" in value) return { path: value.pick.path, from: operationShape(value.pick.from) };
	return { module: value.call.module, exportName: value.call.exportName, args: value.call.args.map(operationShape) };
}

function boundTarget(value: Expression, words: string): boolean {
	const call = operation(value);
	if (!call) return false;
	const tokens = words.match(/[A-Za-z0-9_.$/\\-]+/g) ?? [];
	return tokens.some((token) => {
		const trimmed = token.replace(/^\.+|\.+$/g, "");
		return trimmed === call.exportName || trimmed === call.module || trimmed === basename(call.module);
	});
}

function inputMatches(observed: Expression, expected: Json): boolean {
	const call = operation(observed);
	if (!call) return false;
	const outputPath = "pick" in observed ? observed.pick.path : [];
	return call.args.some((inner) => {
		const encoder = operation(inner);
		return encoder?.args.some((input) => {
			if (!("literal" in input)) return false;
			let value: Json = input.literal;
			for (const segment of outputPath) {
				if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return false;
				value = (value as Record<string, Json>)[String(segment)];
			}
			return isDeepStrictEqual(value, expected);
		}) ?? false;
	});
}

function exactLiteralExpectation(actual: Json, words: string): boolean {
	const asserted = /(?:返回(?:值)?|固定(?:为|是)|输出(?:值)?|应当?为|等于|结果(?:为|是)|returns?(?:\s+exactly)?|equals?|outputs?(?:\s+exactly)?)\s*[：:=]?\s*([\x60"'“‘]?\[[^[\]\r\n]{0,160}\][\x60"'”’]?|[\x60"'“‘]?\{[^{}\r\n]{0,160}\}[\x60"'”’]?|[\x60"'“‘][^\r\n]{1,100}?[\x60"'”’]|-?\d+(?:\.\d+)?(?![a-zA-Z\d.%])|\b(?:true|false)\b)/gi;
	const candidates: Json[] = [];
	for (const match of words.matchAll(asserted)) {
		const cursor = match.index ?? 0;
		const context = words.slice(Math.max(0, cursor - 12), cursor);
		if (/(?:不(?:会|能)?|未(?:能)?|可能|\b(?:not|may)\b)\s*$/i.test(context)) continue;
		if (/^\s*(?:或|以及|\b(?:or|and)\b)/i.test(words.slice(cursor + match[0].length))) continue;
		const statement = match[1];
		if (typeof actual === "number") {
			const number = /^[`"'“‘]?(-?\d+(?:\.\d+)?)(?![a-zA-Z\d.%])/u.exec(statement)?.[1];
			if (number !== undefined) candidates.push(Number(number));
		} else if (typeof actual === "boolean") {
			const bool = /^[`"'“‘]?(true|false)(?![\w$])/i.exec(statement)?.[1];
			if (bool !== undefined) candidates.push(bool.toLowerCase() === "true");
		} else if (typeof actual === "string") {
			const value = /^[`"'“‘]([^`"'”’]*)[`"'”’]/u.exec(statement)?.[1];
			if (value !== undefined) candidates.push(value);
		} else if (actual !== null && typeof actual === "object") {
			// "返回 [1, 2]" and "返回 {ok: true}" name a whole structure; only a literal one counts.
			const written = /^[`"'“‘]?([[{][\s\S]*[\]}])[`"'”’]?$/u.exec(statement.trim())?.[1];
			if (written === undefined) continue;
			try {
				// Unquoted object keys are common in prose; JSON5 is not available here.
				candidates.push(JSON.parse(written.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')) as Json);
			} catch { continue; }
		}
	}
	return candidates.length > 0 && candidates.every((item) => isDeepStrictEqual(item, actual));
}

/**
 * Inputs a sentence can name in words rather than write out. Each pattern must name one exact value,
 * so the probe's own argument decides the match; a vague description ("带空白的串") names none.
 */
const describedInput: { pattern: RegExp; matches: (value: Json | undefined) => boolean }[] = [
	{ pattern: /空字符串|空串|空(?:的)?输入|empty (?:string|input)/i, matches: (value) => value === "" },
	{ pattern: /纯空白|只有空白|全是空格|whitespace[\s-]*only|blank (?:string|input)/i, matches: (value) => typeof value === "string" && value !== "" && value.trim() === "" },
	{ pattern: /(?:传入|给|遇到|对于)?\s*(?:null|空值)/i, matches: (value) => value === null },
	{ pattern: /零|\b(?:zero)\b/i, matches: (value) => value === 0 },
	{ pattern: /负数|negative (?:number|value)/i, matches: (value) => typeof value === "number" && value < 0 },
];

function literalInputScope(actual: Expression, quote: string): boolean {
	const call = operation(actual);
	if (!call) return false;
	const escaped = call.exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const example = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}\\(([^()\\n]*)\\)`).exec(quote);
	const args = call.args.map((argument) => "literal" in argument ? argument.literal : undefined);
	if (example) {
		try { return isDeepStrictEqual(args, JSON.parse(`[${example[1]}]`)); }
		catch { return false; }
	}
	if (/(?:空(?:列表|数组)|empty (?:list|array))/i.test(quote))
		return args.length === 1 && Array.isArray(args[0]) && args[0].length === 0;
	// An honest reply usually names its input in words ("空字符串直接返回 []") instead of writing the
	// call. One argument that is exactly the input the sentence names is as bound as a literal example.
	// Naming an input also narrows the sentence to it, so a probe on anything else is not what it claims.
	const described = args.length === 1 ? describedInput.filter(({ pattern }) => pattern.test(quote)) : [];
	if (described.length) return described.some(({ matches }) => matches(args[0]));
	if (/(?:开始(?:时间)?\s*(?:等于|[=＝]+)\s*结束(?:时间)?|\bstart\s*(?:equals|={2,3})\s*end\b)/i.test(quote))
		return typeof args[0] === "number" && args[0] === args[1];
	if (/(?:时返回|时输出|(?:遇到|对于|当).+?返回|不足|少于|多于|大于|小于|\b(?:when|if|unless)\b)/i.test(quote))
		return false;
	return true;
}

function includesNestedField(expression: Expression, name: string): boolean {
	const contains = (value: Json, depth: number): boolean => value !== null && typeof value === "object" &&
		((depth > 0 && !Array.isArray(value) && Object.hasOwn(value, name)) ||
			Object.values(value).some((item) => contains(item, depth + 1)));
	return operation(expression)?.args.some((argument) => "literal" in argument && contains(argument.literal, 0)) ?? false;
}

function changesNamedInput(left: Expression, right: Expression, words: string): boolean {
	const a = operation(left)?.args;
	const b = operation(right)?.args;
	if (!a || !b) return false;
	const changed = a.flatMap((argument, i) => isDeepStrictEqual(argument, b[i]) ? [] : [i]);
	if (changed.length !== 1) return false;
	const before = a[changed[0]];
	const after = b[changed[0]];
	if (!("literal" in before) || !("literal" in after)) return false;
	const first = record(before.literal);
	const next = record(after.literal);
	if (!first || !next) return false;
	const changedFields = Array.from(new Set([...Object.keys(first), ...Object.keys(next)]))
		.filter((key) => !isDeepStrictEqual(first[key], next[key]));
	if (changedFields.length !== 1) return false;
	const [key] = changedFields;
	return new Set<string>(words.match(/[A-Za-z0-9_$]+/g) ?? []).has(key);
}

/** Only an expression directly bound to a supported, affirmative textual contract may change the displayed verdict. */
export function werewolfProbeBinding(probe: WerewolfProbe, quote: string, requirement?: string): boolean {
	if (probe.kind === "source") return false;
	const words = [quote, requirement].filter(Boolean).join("\n");
	const leftBound = boundTarget(probe.left, words);
	const rightBound = boundTarget(probe.right, words);
	if (!leftBound && !rightBound) return false;
	const affirmative = !/(?:无法|不能|未(?:能|实现|满足|达到)|没有(?:实现|完成|做到)|不保证|可能|有待|如果|计划|建议|\b(?:cannot|might|may|should|could|if|plan to)\b)/i.test(quote);
	const roundTrip = /(?:无损|可逆|保持原样|原样(?:还原|恢复)|round[\s-]*trip|lossless|reversible|without loss)/i.test(quote);
	const unique = /(?:无碰撞|互不冲突|唯一(?:标识|键|值)?|injective|distinct (?:keys|results|outputs)|unique (?:keys|results|outputs)|collision[\s-]*free)/i.test(quote);
	const independent = /(?:无历史污染|不受.{1,18}影响|隔离|独立(?:于|生成)|independent of|does not depend on|isolation|unaffected by)/i.test(quote);
	const sameOperation = leftBound && rightBound && isDeepStrictEqual(operationShape(probe.left), operationShape(probe.right));
	if (!affirmative) return false;
	if (probe.op === "different") return sameOperation && (roundTrip || unique);
	if (probe.op === "equal") {
		if (sameOperation) return independent && changesNamedInput(probe.left, probe.right, words);
		const expected = "literal" in probe.left ? probe.left.literal : "literal" in probe.right ? probe.right.literal : undefined;
		if (expected === undefined) return false;
		const actual = "literal" in probe.left ? probe.right : probe.left;
		return (exactLiteralExpectation(expected, quote) && literalInputScope(actual, quote)) ||
			(roundTrip && inputMatches(actual, expected));
	}
	if (!leftBound || !("literal" in probe.right) || typeof probe.right.literal !== "string" || !probe.right.literal) return false;
	const rawToken = probe.right.literal.replace(/^["'`]|["'`]$/g, "");
	const identifier = /^[A-Za-z_$][\w$]*$/.test(rawToken);
	const explicitlyMentioned = identifier && new Set<string>(words.match(/[A-Za-z0-9_$]+/g) ?? []).has(rawToken) ||
		words.includes(`"${probe.right.literal}"`) || words.includes(`'${probe.right.literal}'`) ||
		words.includes(`${String.fromCharCode(96)}${probe.right.literal}${String.fromCharCode(96)}`) ||
		words.includes(`“${probe.right.literal}”`) || words.includes(`「${probe.right.literal}」`);
	if (!explicitlyMentioned) return false;
	if (/(?:嵌套|\bnested\b)/i.test(words) && !includesNestedField(probe.left, rawToken)) return false;
	const excluded = /(?:不(?:会|得)?包含|排除|省略|删去|不返回|不输出|omits?|excludes?|does not contain)/i.test(quote);
	if (probe.op === "omits") return excluded;
	return !excluded &&
		/(?:包含|保留|包括|contains?|includes?|preserves?)/i.test(quote);
}

function inside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return Boolean(fromRoot && !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

export function parseWerewolfProbe(value: unknown): WerewolfProbe | undefined {
	const item = record(value);
	if (!item) return;
	if (item.kind === "source" && hasKeys(item, ["kind", "file", "exact"]) &&
		sourcePath(item.file) && typeof item.exact === "string" && item.exact.trim() && item.exact.length <= 700) {
		return { kind: "source", file: item.file, exact: item.exact };
	}
	const budget = { remaining: 36 };
	if (item.kind !== "behavior" || !hasKeys(item, ["kind", "op", "left", "right"]) ||
		typeof item.op !== "string" || !Object.hasOwn(behaviorExpectations, item.op) ||
		!expression(item.left, budget) || !expression(item.right, budget) ||
		(!invokesSource(item.left) && !invokesSource(item.right)) ||
		isDeepStrictEqual(item.left, item.right)) return;
	const probe = { kind: "behavior" as const, op: item.op as keyof typeof behaviorExpectations, left: item.left, right: item.right };
	if (Buffer.byteLength(JSON.stringify(probe)) > maxInputBytes) return;
	return probe;
}

function quoted(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isolatedProfile(root: string, executable: string): string {
	const libraries = new Set(["/System/Library", "/usr/lib"]);
	if (executable.includes(".app/Contents/")) libraries.add(executable.slice(0, executable.indexOf(".app/Contents/") + 4));
	for (const prefix of ["/opt/homebrew", "/usr/local"]) {
		if (!executable.startsWith(`${prefix}/`)) continue;
		libraries.add(`${prefix}/Cellar`);
		libraries.add(`${prefix}/opt`);
	}
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-read*)",
		"(allow file-read-metadata)",
		`(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")`,
		...Array.from(libraries, (path) => `(subpath ${quoted(path)})`),
		`(subpath ${quoted(root)}) (literal ${quoted(executable)}))`,
		'(deny file-read-data (regex #"(^|/)\\.env([./]|$)" #"(^|/)\\.git(/|$)"))',
		"(deny file-write*)",
		"(deny network*)",
		"(deny process-fork)",
		"(deny process-exec)",
		`(allow process-exec (literal ${quoted(executable)}))`,
		"(deny signal)",
		"(allow signal (target self))",
	].join("\n");
}

// The fixed interpreter is included in the packaged host. No model-provided program is evaluated.
const runner = String.raw`
import { readFileSync, realpathSync, writeSync } from "node:fs";
import { relative, resolve, sep, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const plan = JSON.parse(readFileSync(0, "utf8"));
const stringify = JSON.stringify.bind(JSON);
const get = Reflect.get.bind(Reflect);
const apply = Reflect.apply.bind(Reflect);
const has = Object.hasOwn.bind(Object);
const seen = new Map();
const limit = 100 * 1024;
const denied = new Set(["__proto__", "prototype", "constructor"]);
async function evaluate(node) {
	if (has(node, "literal")) return node.literal;
	if (has(node, "pick")) {
		let value = await evaluate(node.pick.from);
		for (const segment of node.pick.path) {
			if (value === null || typeof value !== "object" || denied.has(segment) || !has(value, segment))
				throw new Error("投影字段不存在");
			value = get(value, segment);
		}
		return value;
	}
	const { module: path, exportName, args } = node.call;
	const canonical = realpathSync(resolve(root, path));
	const tail = relative(root, canonical);
	if (!tail || isAbsolute(tail) || tail === ".." || tail.startsWith(".." + sep))
		throw new Error("模块超出工作区快照");
	let exports = seen.get(canonical);
	if (!exports) {
		exports = await import(pathToFileURL(canonical).href);
		seen.set(canonical, exports);
	}
	if (!has(exports, exportName) || typeof exports[exportName] !== "function")
		throw new Error("找不到可调用的导出函数");
	const values = [];
	for (const argument of args) values.push(await evaluate(argument));
	return await apply(exports[exportName], undefined, values);
}
try {
	const result = await evaluate(plan);
	const encoded = stringify(result, (_key, value) => {
		if (value === undefined || typeof value === "symbol" || typeof value === "function" ||
			(typeof value === "number" && !Number.isFinite(value)))
			throw new Error("输出包含非 JSON 值");
		return value;
	});
	if (Buffer.byteLength(encoded) > limit) throw new Error("输出过大");
	writeSync(1, "PI_PROBE_RESULT " + encoded + "\n");
} catch {
	process.exitCode = 2;
}
`;

async function observe(root: string, executable: string, value: Expression, signal?: AbortSignal): Promise<Json | undefined> {
	signal?.throwIfAborted();
	if ("literal" in value) return value.literal;
	return new Promise((resolvePromise) => {
		const child = spawn("/usr/bin/sandbox-exec", [
			"-p", isolatedProfile(root, executable), executable, "--permission", `--allow-fs-read=${root}`,
			"--input-type=module", "--eval", runner, "--", root,
		], {
			cwd: root, env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", LANG: "C", OPENSSL_CONF: "/dev/null", ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["pipe", "pipe", "ignore"], shell: false,
		});
		const kill = () => child.kill("SIGKILL");
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener("abort", kill, { once: true });
		if (signal?.aborted) kill();
		const output: Buffer[] = [];
		let length = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length > maxOutputBytes) kill();
			else output.push(chunk);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(value));
		child.on("error", () => {});
		child.once("close", (status) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			if (status !== 0 || length > maxOutputBytes || signal?.aborted) return resolvePromise(undefined);
			const match = /^PI_PROBE_RESULT ([^\r\n]+)\n?$/.exec(Buffer.concat(output).toString("utf8"));
			if (!match) return resolvePromise(undefined);
			try {
				const result: unknown = JSON.parse(match[1]);
				const validated = jsonValue(result, 0) ? result : undefined;
				resolvePromise(validated);
			} catch {
				resolvePromise(undefined);
			}
		});
	});
}

function show(value: Json): string {
	const encoded = JSON.stringify(value);
	if (encoded.length <= 800) return encoded;
	return `${encoded.slice(0, 768)}… (SHA-256 ${createHash("sha256").update(encoded).digest("hex")})`;
}

function compared(op: keyof typeof behaviorExpectations, left: Json, right: Json): boolean | undefined {
	if (op === "equal") return isDeepStrictEqual(left, right);
	if (op === "different") return !isDeepStrictEqual(left, right);
	const includes = typeof left === "string" && typeof right === "string" ? left.includes(right)
		: Array.isArray(left) ? left.some((entry) => isDeepStrictEqual(entry, right)) : undefined;
	return includes === undefined ? undefined : op === "contains" ? includes : !includes;
}

export async function executeWerewolfProbe(
	snapshotPath: string,
	input: WerewolfProbe,
	signal?: AbortSignal,
): Promise<WerewolfProbeResult> {
	signal?.throwIfAborted();
	const probe = parseWerewolfProbe(input);
	if (!probe) return { status: "unverified", summary: "探针格式无效，无法复现。" };
	try {
		const root = await realpath(snapshotPath);
		if (probe.kind === "source") {
			const canonical = await realpath(resolve(root, probe.file));
			if (!inside(root, canonical) || !sourcePath(relative(root, canonical).split(sep).join("/")))
				return { status: "unverified", summary: "源码路径超出可核验的快照范围。" };
			const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = await file.stat();
				if (!info.isFile() || info.size > maxSourceBytes) return { status: "unverified", summary: "源码文件类型或大小无法核验。" };
				const data = Buffer.alloc(info.size + 1);
				const { bytesRead } = await file.read(data, 0, data.length, 0);
				if (bytesRead !== info.size) return { status: "unverified", summary: "读到的源码与快照大小不一致。" };
				const text = data.subarray(0, bytesRead).toString("utf8");
				const offset = text.indexOf(probe.exact);
				if (offset < 0) return { status: "unverified", summary: "未找到可定位的源码原文。" };
				return {
					status: "unverified", summary: "已定位源码原文，行为仍需执行验证。",
					actual: probe.exact, source: `${probe.file}:${text.slice(0, offset).split("\n").length}`,
				};
			} finally {
				await file.close();
			}
		}
		if (!(await probeSeatbeltSupport()).supported) {
			return { status: "unverified", summary: "当前系统缺少可用的严格执行沙箱。" };
		}
		const executable = await realpath(process.execPath);
		const outcomes: [Json, Json][] = [];
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const [left, right] = await Promise.all([observe(root, executable, probe.left, signal), observe(root, executable, probe.right, signal)]);
			signal?.throwIfAborted();
			if (left === undefined || right === undefined)
				return { status: "unverified", summary: "探针未返回可验证结果。模块、依赖或运行条件可能无法在快照中复现。" };
			outcomes.push([left, right]);
		}
		const [left, right] = outcomes[0];
		if (!outcomes.every((observed) => isDeepStrictEqual(observed, [left, right])))
			return { status: "unverified", summary: "两次独立复现的输出不一致。" };
		const success = compared(probe.op, left, right);
		if (success === undefined) return { status: "unverified", summary: "返回值类型不适用所选比对方式。" };
		return {
			status: success ? "verified" : "contradicted",
			summary: success ? "该探针的两次独立复现均符合预期。" : "该探针的两次独立复现均得到与预期矛盾的结果。",
			expected: behaviorExpectations[probe.op],
			actual: `左侧 ${show(left)}\n右侧 ${show(right)}`,
			reproduction: JSON.stringify(probe),
		};
	} catch {
		signal?.throwIfAborted();
		return { status: "unverified", summary: "无法读取稳定快照或启动独立探针。" };
	}
}
