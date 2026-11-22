import assert from "node:assert/strict";
import { test } from "node:test";
import { staleTodoReminder } from "../src/todo-reminder.ts";

const todo = (todos: Array<{ id: string; content: string; status: string }>) => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "t", name: "TodoWrite", arguments: { todos } }],
});
const bash = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ role: "assistant", content: [{ type: "toolCall", id: `b${i}`, name: "bash", arguments: {} }] }));
const open = [
	{ id: "1", content: "download data", status: "in_progress" },
	{ id: "2", content: "submit baseline", status: "pending" },
];

test("no reminder without any TodoWrite", () => {
	assert.equal(staleTodoReminder(bash(30)), undefined);
});

test("no reminder while the checklist is recent", () => {
	assert.equal(staleTodoReminder([todo(open), ...bash(9)]), undefined);
});

test("reminds after the threshold with the current checklist", () => {
	const text = staleTodoReminder([todo(open), ...bash(10)]);
	assert.ok(text);
	assert.match(text, /\[in_progress\] download data/);
	assert.match(text, /\[pending\] submit baseline/);
});

test("no reminder when every item is completed", () => {
	const done = open.map((t) => ({ ...t, status: "completed" }));
	assert.equal(staleTodoReminder([todo(done), ...bash(40)]), undefined);
});

test("a newer TodoWrite resets the count", () => {
	assert.equal(staleTodoReminder([todo(open), ...bash(20), todo(open), ...bash(3)]), undefined);
});

test("counts several tool calls inside one assistant message", () => {
	const multi = { role: "assistant", content: Array.from({ length: 10 }, (_, i) => ({ type: "toolCall", id: `m${i}`, name: "Read", arguments: {} })) };
	assert.ok(staleTodoReminder([todo(open), multi]));
});
