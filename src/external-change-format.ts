import type { ExternalChangeSummary } from "./external-types.ts";

/** File names are untrusted; keep every path on one line inside the notification markup. */
function formatPath(path: string): string {
	return path.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Text block for a task notification or tool result: a diff stat the controller can act on. */
export function formatChangeSummary(changes: ExternalChangeSummary | undefined, worktreePath?: string): string {
	if (!changes) return "";
	const lines = [`<changes files="${changes.files.length}${changes.truncated ? "+" : ""}" additions="${changes.additions}" deletions="${changes.deletions}">`];
	if (worktreePath) lines.push(`worktree: ${formatPath(worktreePath)}`);
	if (!changes.files.length && !changes.truncated) lines.push("(no files changed)");
	for (const file of changes.files.slice(0, 60)) {
		const counts = file.binary ? " (binary)" : file.additions === undefined || file.deletions === undefined
			? " (line counts unavailable)" : ` +${file.additions} -${file.deletions}`;
		lines.push(`${file.status.padEnd(8)} ${formatPath(file.path)}${counts}`);
	}
	if (changes.files.length > 60 || changes.truncated) lines.push("… summary is partial; inspect the worktree for the full changes");
	lines.push("</changes>");
	if (changes.patch) lines.push("<patch>", changes.patch.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").trimEnd(), "</patch>");
	return lines.join("\n");
}
