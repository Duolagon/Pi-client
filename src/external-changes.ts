import type { GitCheckpointDiff } from "./git-types.ts";
import type { ExternalChangeSummary } from "./external-types.ts";

export const MAX_SUMMARY_FILES = 200;

/** Count added and removed lines of a unified diff, ignoring its headers. */
export function diffLineCounts(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) inHunk = false;
		else if (line.startsWith("@@ ")) inHunk = true;
		else if (inHunk && line.startsWith("+")) additions++;
		else if (inHunk && line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

/** Summarize a finished checkpoint: changed files (tracked and untracked) and line counts. */
export function summarizeCheckpoint(diff: GitCheckpointDiff): ExternalChangeSummary {
	let additions = 0;
	let deletions = 0;
	let truncated = Boolean(diff.truncated || diff.excludedFiles || diff.files.length > MAX_SUMMARY_FILES);
	const files = diff.files.slice(0, MAX_SUMMARY_FILES).map((file) => {
		const summary = { path: file.path, status: file.status };
		if (file.truncated) truncated = true;
		if (file.binary) return { ...summary, binary: true };
		if (file.truncated) return summary;
		const counts = diffLineCounts(file.diff);
		additions += counts.additions;
		deletions += counts.deletions;
		return { ...summary, ...counts };
	});
	return { files, truncated, additions, deletions, checkpointId: diff.checkpointId };
}

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
	return lines.join("\n");
}
