import assert from "node:assert/strict";
import { test } from "node:test";
import { previousTodoLists, todoDelta, todoLabel, visibleTodos, type TodoLike } from "../src/renderer/todo-list.ts";

const item = (id: string, status: TodoLike["status"], activeForm?: string): TodoLike => ({ id, content: `做 ${id}`, status, ...(activeForm ? { activeForm } : {}) });

test("the item in progress reads in its present-continuous form", () => {
	assert.equal(todoLabel(item("a", "in_progress", "正在做 a")), "正在做 a");
	assert.equal(todoLabel(item("a", "pending", "正在做 a")), "做 a");
	assert.equal(todoLabel(item("a", "in_progress", "  ")), "做 a", "a blank activeForm falls back to the content");
});

test("a long list keeps the current item in view and counts what it hides", () => {
	const short = [item("a", "completed"), item("b", "in_progress")];
	assert.deepEqual(visibleTodos(short, 8), { rows: short, hiddenBefore: 0, hiddenBeforeDone: true, hiddenAfter: 0 });
	const long = Array.from({ length: 12 }, (_, index) => item(String(index), index < 6 ? "completed" : index === 6 ? "in_progress" : "pending"));
	const view = visibleTodos(long, 5);
	assert.deepEqual(view.rows.map((row) => row.id), ["5", "6", "7", "8", "9"], "one finished item stays above the current one");
	assert.equal(view.hiddenBefore, 5);
	assert.equal(view.hiddenAfter, 2);
	assert.equal(view.hiddenBeforeDone, true);
	// Out-of-order work: rows hidden above may still be pending, and the label must not call them done.
	const outOfOrder = Array.from({ length: 10 }, (_, index) => item(String(index), index === 9 ? "in_progress" : "pending"));
	assert.equal(visibleTodos(outOfOrder, 8).hiddenBeforeDone, false);
	const nearEnd = visibleTodos(long.map((row, index) => ({ ...row, status: index < 11 ? "completed" : "in_progress" } as TodoLike)), 5);
	assert.deepEqual([nearEnd.hiddenBefore, nearEnd.hiddenAfter, nearEnd.rows.length], [7, 0, 5], "the window never runs past the end");
	const allDone = visibleTodos(long.map((row) => ({ ...row, status: "completed" } as TodoLike)), 5);
	assert.equal(allDone.rows.at(-1)?.id, "11");
});

test("each TodoWrite call reports what it changed against the list before it", () => {
	const first = [item("a", "in_progress"), item("b", "pending")];
	assert.equal(todoDelta(undefined, first), "创建了 2 项任务 · 0/2");
	const second = [item("a", "completed"), item("b", "in_progress")];
	assert.equal(todoDelta(first, second), "完成「做 a」，开始「做 b」 · 1/2");
	assert.equal(todoDelta(second, [...second, item("c", "pending")]), "新增 1 项 · 1/3");
	assert.equal(todoDelta(second, [item("b", "in_progress")]), "移除 1 项 · 0/1");
	assert.equal(todoDelta(second, second), "更新了任务清单 · 1/2");
	assert.equal(todoDelta(second, []), "清空了任务清单");
	assert.match(todoDelta(first, [item("a", "completed"), item("b", "completed")]), /^完成 2 项/);
});

test("the list a call replaced is the previous call's list, in transcript order", () => {
	const calls = [{ id: "t1", todos: [item("a", "pending")] }, { id: "t2", todos: [item("a", "completed")] }];
	const previous = previousTodoLists(calls);
	assert.equal(previous.get("t1"), undefined);
	assert.equal(previous.get("t2"), calls[0].todos);
});
