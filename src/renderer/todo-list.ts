/** Pure helpers for the Claude Code style checklist: labels, the visible window, and per-call deltas. */

export interface TodoLike {
	id: string;
	content: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed";
}

/** The in_progress item reads in its present-continuous form, like a spinner line. */
export function todoLabel(item: TodoLike): string {
	return item.status === "in_progress" && item.activeForm?.trim() ? item.activeForm.trim() : item.content;
}

export interface TodoWindow<T extends TodoLike> {
	rows: T[];
	hiddenBefore: number;
	/** Whether every hidden row above the window is finished, so the label can say so. */
	hiddenBeforeDone: boolean;
	hiddenAfter: number;
}

/**
 * At most `max` rows, centred on the item being worked on, so a long list keeps the current step
 * in view. Finished items above it are the first to be hidden.
 */
export function visibleTodos<T extends TodoLike>(items: readonly T[], max = 8): TodoWindow<T> {
	if (items.length <= max) return { rows: [...items], hiddenBefore: 0, hiddenBeforeDone: true, hiddenAfter: 0 };
	let focus = items.findIndex((item) => item.status === "in_progress");
	if (focus < 0) focus = items.findIndex((item) => item.status !== "completed");
	if (focus < 0) focus = items.length - 1;
	// Show one finished item above the current one for context; the rest of the window goes below.
	const start = Math.max(0, Math.min(focus - 1, items.length - max));
	return {
		rows: items.slice(start, start + max),
		hiddenBefore: start,
		hiddenBeforeDone: items.slice(0, start).every((item) => item.status === "completed"),
		hiddenAfter: items.length - start - max,
	};
}

const quote = (text: string) => `「${text.length > 40 ? `${text.slice(0, 40)}…` : text}」`;

/**
 * One line describing what a TodoWrite call changed against the list before it:
 * `完成「读文件」，开始「跑测试」`. The first call of a conversation reports the new list.
 */
export function todoDelta(previous: readonly TodoLike[] | undefined, next: readonly TodoLike[]): string {
	const done = next.filter((item) => item.status === "completed").length;
	const progress = `${done}/${next.length}`;
	if (!next.length) return "清空了任务清单";
	if (!previous?.length) return `创建了 ${next.length} 项任务 · ${progress}`;
	const before = new Map(previous.map((item) => [item.id, item]));
	const completed = next.filter((item) => item.status === "completed" && before.get(item.id)?.status !== "completed");
	const started = next.filter((item) => item.status === "in_progress" && before.get(item.id)?.status !== "in_progress");
	const added = next.filter((item) => !before.has(item.id));
	const nextIds = new Set(next.map((item) => item.id));
	const removed = previous.filter((item) => !nextIds.has(item.id));
	const parts: string[] = [];
	if (completed.length) parts.push(completed.length === 1 ? `完成${quote(completed[0].content)}` : `完成 ${completed.length} 项`);
	if (started.length) parts.push(started.length === 1 ? `开始${quote(started[0].content)}` : `开始 ${started.length} 项`);
	if (added.length) parts.push(`新增 ${added.length} 项`);
	if (removed.length) parts.push(`移除 ${removed.length} 项`);
	if (!parts.length) parts.push("更新了任务清单");
	return `${parts.join("，")} · ${progress}`;
}

/** The list each TodoWrite call replaced, keyed by tool call id, scanning calls in transcript order. */
export function previousTodoLists(
	calls: Iterable<{ id: string; todos: readonly TodoLike[] }>,
): Map<string, readonly TodoLike[] | undefined> {
	const previous = new Map<string, readonly TodoLike[] | undefined>();
	let last: readonly TodoLike[] | undefined;
	for (const call of calls) {
		previous.set(call.id, last);
		last = call.todos;
	}
	return previous;
}
