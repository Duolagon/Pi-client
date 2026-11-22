// Stale TodoWrite reminder: when the model keeps working without updating its checklist,
// the progress panel (which shows the last TodoWrite call) drifts out of date. This builds
// a short reminder for the system prompt once too many tool calls ran since the last update.

export const TODO_STALE_TOOL_CALLS = 10;

type Todo = { id?: unknown; content?: unknown; status?: unknown };
type Block = { type?: unknown; name?: unknown; arguments?: unknown };
type Message = { role?: unknown; content?: unknown };

/** Returns reminder text, or undefined when the checklist is current or never used. */
export function staleTodoReminder(messages: readonly unknown[], threshold = TODO_STALE_TOOL_CALLS): string | undefined {
	let callsSince = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const block = msg.content[j] as Block;
			if (block?.type !== "toolCall") continue;
			if (block.name !== "TodoWrite") {
				callsSince++;
				continue;
			}
			const todos = (block.arguments as { todos?: unknown })?.todos;
			if (!Array.isArray(todos) || callsSince < threshold) return undefined;
			const items = todos as Todo[];
			if (!items.some((t) => t?.status !== "completed")) {
				// Finished checklist, but the model kept working: the panel has nothing to show for the new work.
				return [
					"<system-reminder>",
					"Every item in your TodoWrite checklist is completed, but you are still doing more work.",
					"If this new work has several steps, call TodoWrite with a new checklist for it so the user can follow progress.",
					"Do not mention this reminder to the user.",
					"</system-reminder>",
				].join("\n");
			}
			const list = items
				.map((t) => `- [${String(t?.status ?? "pending")}] ${String(t?.content ?? "").slice(0, 200)}`)
				.join("\n");
			return [
				"<system-reminder>",
				"Your TodoWrite checklist has not been updated for a while, so the progress the user sees is out of date.",
				"If you have finished or started any of these items, call TodoWrite now with the current statuses",
				"(mark finished items completed, keep exactly one in_progress, add or drop items if the plan changed).",
				"Do not mention this reminder to the user.",
				"",
				"Current checklist:",
				list,
				"</system-reminder>",
			].join("\n");
		}
	}
	return undefined;
}
