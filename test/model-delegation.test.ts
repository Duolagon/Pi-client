import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelDelegation } from "../src/model-delegation.ts";
import type { DelegationCallbacks, DelegationMetadata, DelegatedTaskResult } from "../src/delegation-types.ts";
import type { DesktopTask } from "../src/task-types.ts";
import type { Conversation, Message } from "../src/shared.ts";
import type { WorktreeInfo } from "../src/worktree-types.ts";

function fixture(notifications = false) {
	const tasks: DesktopTask[] = [];
	const trees: WorktreeInfo[] = [];
	const inputs: unknown[] = [];
	const notices: DelegatedTaskResult[] = [];
	const conversations = new Map<string, Conversation>([
		["parent", { id: "parent", title: "parent", project: "/project", updatedAt: 0 }],
		["other", { id: "other", title: "other", project: "/other", updatedAt: 0 }],
	]);
	let messages: Message[] = [];
	let pending: unknown[] = [];
	const callbacks: DelegationCallbacks = {
		getConversation: async (id) => {
			const item = conversations.get(id);
			if (!item) throw new Error("missing conversation");
			return item;
		},
		getSelection: async () => ({ model: { provider: "fixture", id: "parent-model" }, thinkingLevel: "high" }),
		listTasks: async () => structuredClone(tasks),
		startTask: async (input, metadata) => {
			inputs.push({ input, metadata });
			const task: DesktopTask = {
				id: `task-${tasks.length + 1}`,
				conversationId: `child-${tasks.length + 1}`,
				project: input.project!,
				workingDirectory: input.isolation === "worktree" ? "/worktrees/child" : input.project!,
				worktreeId: input.worktreeId,
				title: input.title!, prompt: input.message, status: "running", createdAt: 0, updatedAt: 0, revision: 0,
				...metadata,
			};
			tasks.push(task);
			conversations.set(task.conversationId, { id: task.conversationId, title: task.title, project: task.workingDirectory, updatedAt: 0 });
			return structuredClone(task);
		},
		cancelTask: async (id) => {
			const task = tasks.find((item) => item.id === id)!;
			task.status = "cancelled";
			return structuredClone(task);
		},
		taskSnapshot: async () => ({ messages, pendingUI: pending as never[] }),
		listWorktrees: async () => structuredClone(trees),
		createWorktree: async (input) => {
			const item: WorktreeInfo = {
				id: `tree-${trees.length + 1}`, repository: input.project, path: "/worktrees/new", branch: "test-branch",
				baseRef: input.baseRef ?? "HEAD", baseCommit: "abc", createdAt: 0,
				conversationId: input.conversationId, status: "ready",
			};
			trees.push(item);
			return item;
		},
		removeWorktree: async (id) => ({ worktreeId: id, branch: "test-branch", branchRetained: true }),
		mergeWorktree: async (id) => ({ status: "blocked", worktreeId: id, repository: "/project", reason: "parent is active" }),
		isGit: async () => true,
		canRunShared: async (_parent, readOnly) => readOnly,
		...(notifications ? { notify: async (_owner: string, result: DelegatedTaskResult) => { notices.push(result); } } : {}),
	};
	const service = new ModelDelegation(callbacks);
	return { service, tasks, trees, inputs, notices, conversations, callbacks,
		setMessages: (items: Message[]) => { messages = items; },
		setPending: (items: unknown[]) => { pending = items; },
	};
}
const context = { conversationId: "parent", toolCallId: "call-1" };
const background = { description: "Implement independent task", prompt: "Add a function and test it", subagent_type: "general-purpose", run_in_background: true };

function completedText(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

test("Agent pins project and model, creates a fresh isolated task, and persists parent/tool-call linkage", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	const result = await data.service.handle(context, "Agent", background) as DelegatedTaskResult;
	assert.equal(result.task_id, "task-1");
	assert.equal(result.parent_tool_call_id, "call-1");
	assert.equal(result.status, "running");
	assert.deepEqual(data.inputs[0], {
		input: { project: "/project", message: background.prompt, title: background.description, isolation: "worktree", worktreeId: undefined,
			model: { provider: "fixture", id: "parent-model" }, thinkingLevel: "high" },
		metadata: { parentConversationId: "parent", parentToolCallId: "call-1", subagentType: "general-purpose", delegationDepth: 1,
			readOnly: false, runInBackground: true },
	});
	await assert.rejects(data.service.handle({ ...context, toolCallId: "call-2" }, "Agent", { ...background, project: "/private" }), /Unsupported/);
	await assert.rejects(data.service.handle({ ...context, toolCallId: "call-2" }, "Agent", { ...background, model: "cheaper" }), /Unsupported/);
});

test("Explore and Plan are shared read-only children; writable shared work fails fast", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", { ...background, subagent_type: "Explore" });
	assert.equal(data.tasks[0].readOnly, true);
	assert.equal((data.inputs[0] as { input: { isolation: string } }).input.isolation, "shared");
	await assert.rejects(data.service.handle({ ...context, toolCallId: "call-2" }, "Agent", { ...background, isolation: "shared" }), /cannot run alongside/);
});

test("custom agents control prompt, model, thinking and read-only isolation", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	data.callbacks.resolveAgent = async (_project, name) =>
		name === "reviewer"
			? {
					name: "reviewer",
					description: "Reviews changes",
					prompt: "You are a strict reviewer.",
					readOnly: true,
					scope: "project",
					model: { provider: "fixture", id: "reviewer-model" },
					thinkingLevel: "low",
				}
			: undefined;
	await data.service.handle(context, "Agent", { ...background, subagent_type: "reviewer" });
	const sent = data.inputs[0] as { input: { message: string; isolation: string; model: unknown; thinkingLevel: string }; metadata: { readOnly: boolean; subagentType: string } };
	assert.match(sent.input.message, /You are a strict reviewer\./);
	assert.match(sent.input.message, /Add a function and test it/);
	assert.equal(sent.input.isolation, "shared");
	assert.deepEqual(sent.input.model, { provider: "fixture", id: "reviewer-model" });
	assert.equal(sent.input.thinkingLevel, "low");
	assert.equal(sent.metadata.readOnly, true);
	assert.equal(sent.metadata.subagentType, "reviewer");
	await assert.rejects(
		data.service.handle({ ...context, toolCallId: "call-unknown" }, "Agent", { ...background, subagent_type: "missing" }),
		/Unknown subagent_type/,
	);
});

test("task output, cancellation and task listing are scoped to the immutable delegating conversation", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", background);
	await assert.rejects(data.service.handle({ conversationId: "other", toolCallId: "x" }, "TaskOutput", { task_id: "task-1" }), /not found/);
	await assert.rejects(data.service.handle({ conversationId: "other", toolCallId: "x" }, "TaskStop", { task_id: "task-1" }), /not found/);
	assert.deepEqual(await data.service.handle({ conversationId: "other", toolCallId: "x" }, "TaskList", {}), { tasks: [], truncated: false });
	const result = await data.service.handle(context, "TaskStop", { task_id: "task-1" }) as DelegatedTaskResult;
	assert.equal(result.status, "cancelled");
});

test("subagent launch is idempotent per parent tool-call and the outstanding cap is atomic", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await Promise.all([data.service.handle(context, "Agent", background), data.service.handle(context, "Agent", background)]);
	assert.equal(data.tasks.length, 1);
	const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
		data.service.handle({ ...context, toolCallId: `parallel-${index}` }, "Agent", background)));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 7);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	assert.equal(data.tasks.length, 8);
});

test("children cannot recursively delegate or manage additional worktrees", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", background);
	const child = { conversationId: "child-1", toolCallId: "nested" };
	await assert.rejects(data.service.handle(child, "Agent", background), /cannot spawn nested/);
	await assert.rejects(data.service.handle(child, "WorktreeCreate", {}), /cannot spawn nested/);
});

test("Worktree tools pin the source project and only expose owned parent/child worktrees", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	const tree = await data.service.handle(context, "WorktreeCreate", { base_ref: "main" }) as WorktreeInfo;
	assert.equal(tree.repository, "/project");
	assert.equal(tree.conversationId, "parent");
	data.trees.push({ ...tree, id: "foreign-owner", conversationId: "other" }, { ...tree, id: "foreign-project", repository: "/private" });
	const listing = await data.service.handle(context, "WorktreeList", {}) as { worktrees: WorktreeInfo[] };
	assert.deepEqual(listing.worktrees.map((item) => item.id), [tree.id]);
	await assert.rejects(data.service.handle(context, "WorktreeRemove", { worktree_id: "foreign-owner" }), /not found/);
	await assert.rejects(data.service.handle(context, "WorktreeCreate", { project: "/private" }), /Unsupported/);
	await data.service.handle(context, "Agent", { ...background, worktree_id: tree.id });
	data.trees[0].conversationId = "child-1";
	assert.equal((await data.service.handle(context, "WorktreeList", {}) as { worktrees: WorktreeInfo[] }).worktrees.length, 1);
	assert.equal((await data.service.handle(context, "WorktreeMerge", { worktree_id: tree.id }) as { status: string }).status, "blocked");
});

test("TaskOutput returns only bounded assistant output and approval count", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", background);
	data.tasks[0].status = "waiting_for_input";
	data.setMessages([completedText("earlier"), completedText("x".repeat(60000))]);
	data.setPending([{ id: "approval" }]);
	const started = Date.now();
	const result = await data.service.handle(context, "TaskOutput", { task_id: "task-1", block: true, timeout: 1000 }) as DelegatedTaskResult;
	assert.equal(result.output.length, 48 * 1024);
	assert.equal(result.truncated, true);
	assert.equal(result.pending_approvals, 1);
	assert.ok(Date.now() - started < 500, "waiting approvals must return promptly");
});

test("foreground Agent returns the final child result without copying its transcript into the parent", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	const call = data.service.handle(context, "Agent", { ...background, run_in_background: false });
	await delay(20);
	data.tasks[0].status = "completed";
	data.setMessages([completedText("Implemented and tested.")]);
	const result = await call as DelegatedTaskResult;
	assert.equal(result.status, "completed");
	assert.equal(result.output, "Implemented and tested.");
	assert.equal(data.tasks[0].runInBackground, false);
});

test("aborting a foreground delegation cancels its child", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	const abort = new AbortController();
	const call = data.service.handle({ ...context, signal: abort.signal }, "Agent", { ...background, run_in_background: false });
	await delay(15);
	abort.abort();
	await assert.rejects(call, /abort/i);
	assert.equal(data.tasks[0].status, "cancelled");
});

test("aborting while task creation is in flight cancels the newly created background child", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	const start = data.callbacks.startTask;
	data.callbacks.startTask = async (input, metadata) => {
		const task = await start(input, metadata);
		await delay(30);
		return task;
	};
	const abort = new AbortController();
	const call = data.service.handle({ ...context, signal: abort.signal }, "Agent", background);
	await delay(10);
	abort.abort();
	await assert.rejects(call, /abort/i);
	assert.equal(data.tasks[0].status, "cancelled");
});

test("terminal background transitions notify the parent once even when a fallback watcher races", async (t) => {
	const data = fixture(true);
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", background);
	data.tasks[0].status = "completed";
	data.tasks[0].result = { text: "Compact child result", truncated: false };
	data.service.observeTask(data.tasks[0]);
	data.service.observeTask(data.tasks[0]);
	await delay(150);
	assert.equal(data.notices.length, 1);
	assert.equal(data.notices[0].parent_tool_call_id, "call-1");
	assert.equal(data.notices[0].output, "Compact child result");
});

test("parent cancellation cascades only to its own model-created active children", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await data.service.handle(context, "Agent", background);
	data.tasks.push({ ...data.tasks[0], id: "manual", conversationId: "manual", parentConversationId: undefined });
	data.tasks.push({ ...data.tasks[0], id: "other-child", conversationId: "other-child", parentConversationId: "other" });
	await data.service.cancelChildren("parent");
	assert.equal(data.tasks[0].status, "cancelled");
	assert.equal(data.tasks[1].status, "running");
	assert.equal(data.tasks[2].status, "running");
});

test("malformed input cannot increase wait limits or bypass named operations", async (t) => {
	const data = fixture();
	t.after(() => data.service.dispose());
	await assert.rejects(data.service.handle(context, "TaskOutput", { task_id: "x", block: true, timeout: 60001 }), /60000/);
	await assert.rejects(data.service.handle(context, "Agent", { ...background, subagent_type: "root" }), /subagent_type/);
	await assert.rejects(data.service.handle(context, "WorktreeList", { project: "/private" }), /Unsupported/);
	await assert.rejects(data.service.handle(context, "anything", {}), /Unsupported/);
});
