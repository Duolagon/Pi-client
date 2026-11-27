import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopService } from "../src/backend.ts";
import { wrapDesktopWorkspaceContext } from "../src/file-references.ts";
import { SessionHistoryService } from "../src/session-history.ts";
import { installSessionHandlers } from "../src/session-ipc.ts";

const timestamp = "2026-01-02T03:04:05.000Z";
const entry = fileURLToPath(new URL("../src/session-history-entry.ts", import.meta.url));
const message = (id: string, parentId: string | null, content: string) => ({
	type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: Date.parse(timestamp) },
});

async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-session-search-"));
	const sessions = join(dataDir, "sessions");
	const project = join(dataDir, "project");
	const agentDir = join(dataDir, "agent");
	await Promise.all([mkdir(sessions), mkdir(project), mkdir(agentDir)]);
	const env = { HOME: dataDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	const options = { dataDir, env, executable: process.execPath };
	const service = new SessionHistoryService({ ...options, entry });
	const writeSession = async (id: string, entries: object[], tail = "") => {
		const sessionFile = join(sessions, `${id}.jsonl`);
		const header = { type: "session", version: 3, id, timestamp, cwd: project };
		await writeFile(sessionFile, [header, ...entries].map((item) => JSON.stringify(item)).join("\n") + "\n" + tail);
		return { conversationId: id, sessionFile };
	};
	const cleanup = () => rm(dataDir, { recursive: true, force: true });
	return { options, project, service, writeSession, cleanup };
}

test("history search follows the selected branch across compaction and matches visible normalized text", async () => {
	const data = await fixture();
	try {
		const file = await data.writeSession("branch", [
			message("root", null, 'Earlier "cafe\u0301"\n\t in this branch'),
			message("keep", "root", `Kept message\n\n${wrapDesktopWorkspaceContext("hidden metadata marker")}`),
			{ type: "compaction", id: "compact", parentId: "keep", timestamp, firstKeptEntryId: "keep", tokensBefore: 1000, summary: "Short summary" },
			message("retired", "root", "Abandoned branch marker"),
		]);
		const find = (query: string, leafId: string | null = "compact") => data.service.searchSessions({ query, sessions: [{ ...file, leafId }] });
		assert.deepEqual(await find('"CAFÉ"  in this'), {
			matches: [{ conversationId: "branch", snippet: 'Earlier "café" in this branch' }], partial: false,
		});
		for (const query of ["Abandoned branch marker", "Short summary", "hidden metadata marker"]) {
			assert.deepEqual(await find(query), { matches: [], partial: false }, query);
		}
		assert.deepEqual(await find("Earlier", null), { matches: [], partial: false });
		assert.equal((await find("Abandoned branch marker", "retired")).matches.length, 1);
	} finally { await data.cleanup(); }
});

test("history search accepts full conversation files above the old limit and reports incomplete coverage", async () => {
	const data = await fixture();
	try {
		const large = await data.writeSession("large", [message("one", null, "large message marker " + "x".repeat(4 * 1024 * 1024))]);
		const oversized = await data.writeSession("oversized", [message("one", null, "oversized message")]);
		await truncate(oversized.sessionFile, 64 * 1024 * 1024 + 1);
		const append = await data.writeSession("append", [message("one", null, "large message marker before append")], '{"type":"mess');
		const result = await data.service.searchSessions({ query: "large message marker", sessions: [oversized, large, append] });
		assert.deepEqual(result.matches.map((match) => match.conversationId), ["large", "append"]);
		assert.equal(result.partial, true);
		const missing = { conversationId: "new", sessionFile: join(data.options.dataDir, "sessions", "new.jsonl") };
		assert.equal((await data.service.searchSessions({ query: "missing", sessions: [missing] })).partial, true);
		assert.equal((await data.service.searchSessions({ query: "missing", sessions: [{ ...missing, unmaterialized: true }] })).partial, false);
	} finally { await data.cleanup(); }
});

async function savedConversations(data: Awaited<ReturnType<typeof fixture>>) {
	const create = async (id: string, parentConversationId?: string, origin?: "fork") => ({
		...await data.writeSession(id, [message("one", null, `${id} marker`)]),
		id, title: id, project: data.project, updatedAt: 1, parentConversationId, origin,
	});
	const root = await create("root");
	const child = await create("child", root.id);
	const fork = await create("fork", root.id, "fork");
	await writeFile(join(data.options.dataDir, "desktop.json"), JSON.stringify({
		projects: [{ path: data.project, name: "project" }], conversations: [root, child, fork],
		settings: { permission: "ask", theme: "light", sandbox: false }, keys: {},
		tasks: [{ id: child.id, conversationId: child.id, project: data.project, workingDirectory: data.project,
			title: "delegated child", prompt: "test", status: "completed", createdAt: 1, updatedAt: 1, revision: 1,
			parentConversationId: root.id, parentToolCallId: "test", subagentType: "general-purpose",
			delegationDepth: 1, readOnly: false, runInBackground: true }],
	}));
}

test("desktop history search excludes actual delegated conversations and keeps user-created forks", async () => {
	const data = await fixture();
	const desktop = new DesktopService({ ...data.options, historyEntry: entry });
	try {
		await savedConversations(data);
		assert.equal((await desktop.initialize()).conversations.find((item) => item.id === "child")?.kind, "subagent");
		const result = await desktop.searchConversations("marker");
		assert.deepEqual(result.matches.map((match) => match.conversationId), ["root", "fork"]);
		assert.equal(result.partial, false);
	} finally { await desktop.close(); await data.cleanup(); }
});

test("empty search IPC and desktop shutdown terminate an in-flight search helper", { timeout: 15000 }, async () => {
	const data = await fixture();
	const marker = join(data.options.dataDir, "started");
	const historyEntry = join(data.options.dataDir, "holding-sidecar.mjs");
	const desktop = new DesktopService({ ...data.options, historyEntry });
	let closed = false;
	try {
		await savedConversations(data);
		await writeFile(historyEntry, `
import { writeFile } from "node:fs/promises";
for await (const chunk of process.stdin) { /* accept matching request */ }
await writeFile(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000);
`);
		await desktop.initialize();
		const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		installSessionHandlers((channel, action) => handlers.set(channel, action), desktop);
		const search = handlers.get("pi:session:search-content")!;
		for (const cancel of [() => search(""), () => { closed = true; return desktop.close(); }]) {
			const running = search("marker");
			let pid: number | undefined;
			for (let attempt = 0; attempt < 100 && !pid; attempt++) {
				pid = await readFile(marker, "utf8").then(Number, () => undefined);
				if (!pid) await delay(30);
			}
			assert.ok(pid, "search helper started");
			await cancel();
			assert.deepEqual(await running, { matches: [], partial: false });
			assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
			await rm(marker);
		}
	} finally { if (!closed) await desktop.close(); await data.cleanup(); }
});
