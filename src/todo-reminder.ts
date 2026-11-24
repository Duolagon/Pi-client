/** Remind the model only about unfinished items after the checklist goes stale. */
export function staleTodoReminder(
	checklist: "simple" | "shared",
	items: readonly { content: string; status: string }[],
): string | undefined {
	const unfinished = items.filter(({ status }) => status === "pending" || status === "in_progress");
	if (!unfinished.length) return;
	const update = checklist === "simple" ? "TodoWrite with the full checklist" : "TodoUpdate for the items that changed";
	return [
		"<system-reminder>",
		`The checklist has not been updated for several steps. If an item started or finished, call ${update}.`,
		...unfinished.slice(0, 20).map(({ content, status }) => `- [${status}] ${content.slice(0, 160)}`),
		"</system-reminder>",
	].join("\n");
}
