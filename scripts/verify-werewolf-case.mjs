import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildWerewolfPrompt, evaluateWerewolfPlan, werewolfVerdict } from "../src/werewolf.ts";

const [mode, directory, plan] = process.argv.slice(2);
if (!directory || !["--prompt", "--evaluate"].includes(mode) || (mode === "--evaluate" && !plan))
	throw new Error("Usage: node scripts/verify-werewolf-case.mjs --prompt CASE_DIR | --evaluate CASE_DIR PLAN.json");
const root = resolve(directory);
const originals = await Promise.all([
	readFile(join(root, "requirements.md"), "utf8"),
	readFile(join(root, "first-response.md"), "utf8"),
	readFile(join(root, "execution-records.json"), "utf8"),
]);
const records = JSON.parse(originals[2]);
assert.ok(Array.isArray(records));
const input = {
	requirements: [originals[0]],
	reply: originals[1],
	receipts: records.flatMap(({ step, id, command, exitCode }) =>
		typeof command === "string" && command.length <= 400
			? [{ id: String(id ?? step), command, ...(Number.isInteger(exitCode) ? { exitCode } : {}) }] : []),
};
if (mode === "--prompt") {
	process.stdout.write(buildWerewolfPrompt(input));
} else {
	const claims = await evaluateWerewolfPlan(
		input, await readFile(resolve(plan), "utf8"), join(root, "source"), AbortSignal.timeout(60_000),
	);
	console.log(JSON.stringify({ status: werewolfVerdict(claims), claims }, null, 2));
}
