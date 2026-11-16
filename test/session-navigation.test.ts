import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import navigation, {
	type SessionNavigationBridgeRequest,
	type SessionNavigationBridgeResponse,
} from "../src/session-navigation-extension.ts";
import { createCoreFixture } from "./fixtures/core-fixture.ts";
import { RpcHarness } from "./fixtures/rpc-harness.ts";

const timestamp = "2026-11-16T00:00:00.000Z";
const entries: SessionEntry[] = [
	{ type: "model_change", id: "base", parentId: null, timestamp, provider: "test", modelId: "test" },
	{
		type: "message",
		id: "first",
		parentId: "base",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "first prompt" }], timestamp: 0 },
	},
	{ type: "custom", id: "reply", parentId: "first", timestamp, customType: "fixture", data: {} },
	{
		type: "message",
		id: "second",
		parentId: "reply",
		timestamp,
		message: {
			role: "user",
			content: [
				{ type: "text", text: "second" },
				{ type: "text", text: " prompt" },
			],
			timestamp: 0,
		},
	},
	{
		type: "custom_message",
		id: "custom",
		parentId: "first",
		timestamp,
		customType: "fixture",
		content: "custom prompt",
		display: true,
	},
	{
		type: "message",
		id: "root",
		parentId: null,
		timestamp,
		message: { role: "user", content: "root prompt", timestamp: 0 },
	},
];

async function createBridge(initialLeaf: string | null = "second") {
	const directory = await mkdtemp(join(tmpdir(), "pi-desktop-navigation-"));
	const token = randomBytes(32).toString("hex");
	const command = `desktop-navigate-${randomBytes(16).toString("hex")}`;
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {
		throw new Error("Navigation command was not registered");
	};
	const keys = ["PI_DESKTOP_NAVIGATION_DIR", "PI_DESKTOP_NAVIGATION_TOKEN", "PI_DESKTOP_NAVIGATION_COMMAND"];
	const previous = keys.map((key) => process.env[key]);
	Object.assign(process.env, {
		PI_DESKTOP_NAVIGATION_DIR: directory,
		PI_DESKTOP_NAVIGATION_TOKEN: token,
		PI_DESKTOP_NAVIGATION_COMMAND: command,
	});
	try {
		navigation({
			registerCommand(name, definition) {
				assert.equal(name, command);
				handler = definition.handler;
			},
		} as ExtensionAPI);
	} finally {
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
	}
	const state = { leafId: initialLeaf, idle: true, pending: false, cancelled: false, throwError: false };
	const calls: { targetId: string; options: { summarize?: boolean; label?: string } | undefined }[] = [];
	const ctx = {
		mode: "rpc",
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		sessionManager: {
			getSessionId: () => "fixture-session",
			getLeafId: () => state.leafId,
			getEntries: () => entries,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
		},
		async navigateTree(targetId, options) {
			calls.push({ targetId, options });
			if (state.throwError) throw new Error("Native navigation failed");
			if (state.cancelled) return { cancelled: true };
			if (targetId !== state.leafId) {
				const target = entries.find((entry) => entry.id === targetId);
				assert.ok(target);
				state.leafId =
					target.type === "custom_message" || (target.type === "message" && target.message.role === "user")
						? target.parentId
						: target.id;
			}
			return { cancelled: false };
		},
	} as ExtensionCommandContext;
	const request = async (input: SessionNavigationBridgeRequest | Record<string, unknown>) => {
		const requestId = randomUUID();
		await writeFile(join(directory, "request.json"), JSON.stringify({ ...input, requestId }));
		await handler(`${token} ${requestId}`, ctx);
		return JSON.parse(await readFile(join(directory, "response.json"), "utf8")) as SessionNavigationBridgeResponse;
	};
	return {
		directory,
		token,
		command,
		handler,
		ctx,
		state,
		calls,
		request,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}

test("private bridge authenticates commands before file access and binds responses to request IDs", async () => {
	const bridge = await createBridge();
	try {
		await assert.rejects(bridge.handler(`${"0".repeat(64)} ${randomUUID()}`, bridge.ctx), /requires a host request/);
		await assert.rejects(bridge.handler(`${bridge.token} ../../request.json`, bridge.ctx), /requires a host request/);
		await assert.rejects(access(join(bridge.directory, "response.json")));
		const requestId = randomUUID();
		await writeFile(
			join(bridge.directory, "request.json"),
			JSON.stringify({ requestId: randomUUID(), operation: "navigate", targetId: "reply" }),
		);
		await bridge.handler(`${bridge.token} ${requestId}`, bridge.ctx);
		const result = JSON.parse(
			await readFile(join(bridge.directory, "response.json"), "utf8"),
		) as SessionNavigationBridgeResponse;
		assert.equal(result.requestId, requestId);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "invalid_request");
		assert.equal(bridge.calls.length, 0);
		for (const extra of [
			{ summarize: true },
			{ sessionFile: "/private/other.jsonl" },
			{ targetId: null },
			{ label: 42 },
		]) {
			const rejected = await bridge.request({ operation: "navigate", targetId: "reply", ...extra });
			assert.equal(rejected.ok, false);
			if (!rejected.ok) assert.equal(rejected.error.code, "invalid_request");
		}
		assert.equal(bridge.calls.length, 0);
	} finally {
		await bridge.cleanup();
	}
});

test("navigation uses native hooks without summaries and preserves editor text, cancellation, and failures", async () => {
	const bridge = await createBridge("reply");
	try {
		const result = await bridge.request({ operation: "navigate", targetId: "second", label: "branch" });
		assert.equal(result.ok, true);
		assert.equal(result.editorText, "second prompt");
		assert.equal(result.oldLeafId, "reply");
		assert.equal(result.leafId, "reply");
		assert.equal(result.sessionId, "fixture-session");
		assert.deepEqual(bridge.calls, [{ targetId: "second", options: { summarize: false, label: "branch" } }]);
		bridge.state.cancelled = true;
		const cancelled = await bridge.request({ operation: "navigate", targetId: "custom" });
		assert.equal(cancelled.ok, true);
		assert.equal(cancelled.cancelled, true);
		assert.equal(cancelled.leafId, "reply");
		assert.equal(cancelled.editorText, undefined);
		bridge.state.cancelled = false;
		const custom = await bridge.request({ operation: "navigate", targetId: "custom" });
		assert.equal(custom.ok && custom.editorText, "custom prompt");
		assert.equal(custom.ok && custom.leafId, "first");
		bridge.state.leafId = "second";
		const noop = await bridge.request({ operation: "navigate", targetId: "second" });
		assert.equal(noop.ok && noop.editorText, undefined);
		assert.equal(noop.ok && noop.leafId, "second");
		bridge.state.throwError = true;
		const failure = await bridge.request({ operation: "navigate", targetId: "reply" });
		assert.equal(failure.ok, false);
		if (!failure.ok) assert.equal(failure.error.code, "navigation_failed");
		assert.equal(entries.length, 6);
	} finally {
		await bridge.cleanup();
	}
});

test("busy and queued sessions reject navigation immediately", async () => {
	const bridge = await createBridge();
	try {
		for (const state of [
			{ idle: false, pending: false },
			{ idle: true, pending: true },
		]) {
			Object.assign(bridge.state, state);
			const result = await bridge.request({ operation: "navigate", targetId: "reply" });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.code, "busy");
			assert.equal(bridge.state.leafId, "second");
		}
		assert.equal(bridge.calls.length, 0);
	} finally {
		await bridge.cleanup();
	}
});

test("restore verifies exact ordinary, user, and root leaves and reports cancellation explicitly", async () => {
	const bridge = await createBridge();
	try {
		for (const leafId of ["reply", "first", null]) {
			const result = await bridge.request({ operation: "restore", leafId });
			assert.equal(result.ok, true);
			assert.equal(result.leafId, leafId);
			assert.equal(result.editorText, undefined);
		}
		bridge.state.leafId = "root";
		const root = await bridge.request({ operation: "restore", leafId: null });
		assert.equal(root.ok, true);
		assert.equal(bridge.state.leafId, null);
		bridge.state.cancelled = true;
		const cancelled = await bridge.request({ operation: "restore", leafId: "reply" });
		assert.equal(cancelled.ok, false);
		if (!cancelled.ok) assert.equal(cancelled.error.code, "restore_cancelled");
		const impossible = await bridge.request({ operation: "restore", leafId: "missing" });
		assert.equal(impossible.ok, false);
		if (!impossible.ok) assert.equal(impossible.error.code, "restore_failed");
		assert.ok(bridge.calls.every((call) => call.options?.summarize === false));
	} finally {
		await bridge.cleanup();
	}
});

test(
	"actual Pi executes private navigation without a model run and honors native tree cancellation",
	{ timeout: 30000 },
	async () => {
		const fixture = await createCoreFixture();
		const bridge = await createBridge();
		const { token, command } = bridge;
		await writeFile(
			join(fixture.agentDir, "extensions", "cancel-tree.js"),
			'export default function(pi) { pi.on("session_before_tree", event => event.preparation.label === "cancel-navigation" ? {cancel:true} : undefined); }',
		);
		const harness = new RpcHarness({
			executable: process.execPath,
			entry: fixture.entry,
			cwd: fixture.project,
			args: [
				"--extension",
				resolve(dirname(fileURLToPath(import.meta.url)), "../src/session-navigation-extension.ts"),
			],
			env: {
				...fixture.env,
				PI_DESKTOP_NAVIGATION_DIR: bridge.directory,
				PI_DESKTOP_NAVIGATION_TOKEN: token,
				PI_DESKTOP_NAVIGATION_COMMAND: command,
			},
			onEvent: () => {},
		});
		try {
			const registered = await harness.request<{ commands: { name: string }[] }>({ type: "get_commands" });
			assert.ok(registered.commands.some((entry) => entry.name === command));
			for (const message of ["first native branch", "second native branch"]) {
				const settled = harness.waitFor("agent_settled", harness.events.length);
				await harness.request({ type: "prompt", message });
				await settled;
			}
			const before = await harness.request<{ entries: SessionEntry[]; leafId: string | null }>({
				type: "get_entries",
			});
			const users = before.entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
			assert.equal(users.length, 2);
			const navigate = async (targetId: string, label?: string) => {
				const requestId = randomUUID();
				await writeFile(
					join(bridge.directory, "request.json"),
					JSON.stringify({ requestId, operation: "navigate", targetId, label }),
				);
				const response = await harness.request<{ disposition: string }>({
					type: "prompt",
					message: `/${command} ${token} ${requestId}`,
				});
				assert.equal(response.disposition, "handled");
				return JSON.parse(
					await readFile(join(bridge.directory, "response.json"), "utf8"),
				) as SessionNavigationBridgeResponse;
			};
			const eventStart = harness.events.length;
			const cancelled = await navigate(users[0].id, "cancel-navigation");
			assert.equal(cancelled.ok, true);
			assert.equal(cancelled.cancelled, true);
			assert.equal(cancelled.leafId, before.leafId);
			const selected = await navigate(users[1].id);
			assert.equal(selected.ok, true);
			assert.equal(selected.cancelled, false);
			assert.equal(selected.leafId, users[1].parentId);
			assert.equal(selected.editorText, "second native branch");
			assert.ok(!harness.events.slice(eventStart).some((event) => event.type === "agent_start"));
			const after = await harness.request<{ entries: SessionEntry[]; leafId: string | null }>({
				type: "get_entries",
			});
			assert.deepEqual(
				after.entries.map((entry) => entry.id),
				before.entries.map((entry) => entry.id),
			);
			assert.equal(after.leafId, selected.leafId);
		} finally {
			await harness.stop();
			await bridge.cleanup();
			await fixture.cleanup();
		}
	},
);
