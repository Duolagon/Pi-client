import type { GitCheckpointDiff } from "./git-types.ts";
import type { ExternalChangeSummary, ExternalChangedFile } from "./external-types.ts";
import { createHash } from "node:crypto";

export const MAX_SUMMARY_FILES = 200;
export const MAX_INLINE_PATCH_BYTES = 8 * 1024;

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
	const files = diff.files.slice(0, MAX_SUMMARY_FILES).map<ExternalChangedFile>((file) => {
		const summary = { path: file.path, status: file.status };
		if (file.truncated) truncated = true;
		if (file.binary) return { ...summary, binary: true };
		if (file.truncated) return summary;
		const counts = diffLineCounts(file.diff);
		additions += counts.additions;
		deletions += counts.deletions;
		return { ...summary, ...counts };
	});
	const hash = createHash("sha256");
	let patch = "";
	let inline = !truncated;
	for (const file of diff.files) {
		if (file.binary || !file.diff.trim()) inline = false;
		const segment = file.diff.endsWith("\n") ? file.diff : `${file.diff}\n`;
		if (inline && Buffer.byteLength(patch) + Buffer.byteLength(segment) <= MAX_INLINE_PATCH_BYTES)
			patch += segment;
		else inline = false;
		if (!truncated && !file.binary) hash.update(JSON.stringify([file.path, file.status, file.diff]));
	}
	return { files, truncated, additions, deletions, checkpointId: diff.checkpointId,
		...(inline && patch ? { patch } : {}),
		...(!truncated && files.length && files.every((file) => !file.binary) ? { fingerprint: hash.digest("hex") } : {}) };
}

export { formatChangeSummary } from "./external-change-format.ts";
