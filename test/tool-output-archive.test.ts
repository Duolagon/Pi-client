import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissions from "../src/permission-extension.ts";
import { readToolOutputPage, ToolOutputBudget, toolOutputDirectory } from "../src/tool-output-archive.ts";
import { toolOutputReference, toolRoundOutputBytes } from "../src/tool-output-types.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

test("parallel results govern one text budget and archive previews survive reopening", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-tool-output-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = join(directory, "output");
	const budget = new ToolOutputBudget(root, "owner");
	const first = "a".repeat(16 * 1024);
	const second = "BEGIN\n" + "验证🌳".repeat(1400) + "\nEND";
	assert.ok(Buffer.byteLength(second) < toolRoundOutputBytes);
	assert.ok(Buffer.byteLength(first + second) > toolRoundOutputBytes);
	const [plain, archived] = await Promise.all([budget.archive("read", text(first), {}), budget.archive("bash", text(second), {})]);
	assert.equal(plain, undefined);
	assert.ok(archived?.reference);
	const ref = archived.reference;
	assert.equal(ref.partial, false);
	assert.equal(ref.bytes, Buffer.byteLength(second));
	assert.match(JSON.stringify(archived.content), /END/);
	assert.match(JSON.stringify(archived.content), new RegExp(ref.id));
	assert.doesNotMatch(JSON.stringify(archived.content), /BEGIN|�/u);
	assert.ok(Buffer.byteLength(JSON.stringify(archived.content)) < 1300);
	assert.deepEqual(toolOutputReference({ desktopToolOutput: ref }), ref);
	assert.equal(toolOutputReference({ fullOutputPath: "legacy" }), undefined);
	const restarted = new ToolOutputBudget(root, "owner");
	assert.equal(await restarted.archive("bash", text(second), {}), undefined);
	let materialized = "";
	let cursor: number | null = 0;
	while (cursor !== null) {
		const page = await readToolOutputPage(root, "owner", ref.id, cursor, 1103);
		materialized += page.text;
		cursor = page.nextOffset;
	}
	assert.equal(materialized, second);
	await assert.rejects(readToolOutputPage(root, "another-owner", ref.id), /不属于此会话/);
	await assert.rejects(readToolOutputPage(root, "../owner", ref.id), /不属于此会话/);
	await assert.rejects(readToolOutputPage(root, "owner", "../../elsewhere"), /分页参数无效/);
	budget.reset();
	assert.equal(await budget.archive("bash", text(second), {}), undefined);
});

test("native bash spill recovers text omitted by the SDK and rejects path substitutions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-tool-output-spill-test-"));
	const spill = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
	const fakeSpill = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
		await rm(spill, { force: true });
		await rm(fakeSpill, { force: true });
	});
	const complete = "FIRST SOURCE LINE\n" + "abc\n".repeat(10000) + "TAIL";
	await writeFile(spill, complete, { flag: "wx", mode: 0o600 });
	await symlink(spill, fakeSpill);
	const root = join(directory, "output");
	const budget = new ToolOutputBudget(root, "owner");
	const archived = await budget.archive("bash", text("NATIVE TAIL ONLY"), { fullOutputPath: spill });
	assert.ok(archived?.reference);
	assert.equal(archived.reference.partial, false);
	assert.match((await readToolOutputPage(root, "owner", archived.reference.id)).text, /^FIRST SOURCE LINE/m);
	const fallback = await budget.archive("bash", text("NATIVE TAIL ONLY"), { fullOutputPath: fakeSpill });
	assert.ok(fallback?.reference);
	assert.equal(fallback.reference.partial, true);
	assert.equal((await readToolOutputPage(root, "owner", fallback.reference.id)).text, "NATIVE TAIL ONLY");
	const injectedId = "0".repeat(32);
	await symlink(spill, join(toolOutputDirectory(root, "owner"), `${injectedId}.txt`));
	await assert.rejects(readToolOutputPage(root, "owner", injectedId), /不属于此会话/);
});

test("archive tool rechecks source permissions and only reads redacted text from its current branch", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-tool-output-authorization-test-"));
	const root = join(project, "output");
	const policyFile = join(project, "policy.json");
	const env = { PI_DESKTOP_POLICY_FILE: policyFile, PI_DESKTOP_TOOL_OUTPUT_ROOT: root, PI_DESKTOP_TOOL_OUTPUT_OWNER: "owner" };
	const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(async () => {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(project, { recursive: true, force: true });
	});
	const policy = { version: 1, project, mode: "auto", sandbox: true, rules: [], disabledTools: [] };
	await writeFile(policyFile, JSON.stringify(policy));
	const handlers = new Map<string, (...args: any[]) => any>();
	let readArchive: (...args: any[]) => any;
	permissions({
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (definition: { name: string; execute: (...args: any[]) => any }) => {
			if (definition.name === "ReadToolOutput") readArchive = definition.execute;
		},
	} as unknown as ExtensionAPI);
	const originalResult = "visible.txt:1: " + "a".repeat(30 * 1024) + "\n.env:1: PROTECTED_LOG";
	const sourceCall = { type: "toolCall", id: "call1", name: "grep", arguments: {} };
	const result = await handlers.get("tool_result")!({
		toolName: "grep", toolCallId: sourceCall.id, input: sourceCall.arguments, content: text(originalResult),
		details: { truncation: { content: originalResult, totalLines: 2 } }, isError: false,
	});
	const reference = toolOutputReference(result.details);
	assert.ok(reference);
	assert.doesNotMatch(JSON.stringify(result), /PROTECTED_LOG/);
	const onDisk = await readToolOutputPage(root, "owner", reference.id);
	assert.match(onDisk.text, /^visible\.txt:1: /);
	const remainder = await readToolOutputPage(root, "owner", reference.id, onDisk.nextOffset!);
	assert.equal(onDisk.text + remainder.text, originalResult.split("\n")[0] + "\n\n[已按权限规则隐藏 1 条结果]");
	const branch = [
		{ type: "message", message: { role: "assistant", content: [sourceCall] } },
		{ type: "message", message: { role: "toolResult", toolCallId: sourceCall.id, toolName: sourceCall.name, details: result.details } },
	];
	const read = (entries: unknown[]) => readArchive!("read-archive", { id: reference.id }, undefined, undefined, { sessionManager: { getBranch: () => entries } });
	await assert.rejects(() => read(branch.slice(0, 1)), /当前会话分支/);
	const page = await read(branch);
	assert.match(page.content[0].text, /^visible\.txt:1: /);
	assert.match(page.content[0].text, /Next byte offset: 8192/);
	await writeFile(policyFile, JSON.stringify({ ...policy, disabledTools: ["grep"] }));
	await assert.rejects(() => read(branch), /已停用/);
});
