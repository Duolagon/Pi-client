import type { ExternalTask } from "../external-types.ts";

import type { GitCheckpointDiff } from "../git-types.ts";

export interface CandidateDelta { fingerprint?: string; paths: number; partial: boolean }

export function candidateDelta(diff: GitCheckpointDiff): CandidateDelta {
	return { fingerprint: diff.fingerprint, paths: diff.files.length, partial: Boolean(diff.truncated || diff.excludedFiles) };
}

/** Keep candidates ordered by creation and group only completed, equivalent results. */
export function groupExternalComparisons(tasks: ExternalTask[], deltas: ReadonlyMap<string, CandidateDelta>): ExternalTask[][] {
	const groups = new Map<string, ExternalTask[]>();
	for (const task of [...tasks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
		let key = `task:${task.id}`;
		if (task.status === "completed") {
			const delta = deltas.get(task.id);
			if (delta?.fingerprint && !delta.partial) key = `patch:${delta.fingerprint}`;
			else if (delta && !delta.partial && !delta.paths && !task.truncated && task.output.trim())
				key = `output:${task.output.replaceAll("\r\n", "\n").trim()}`;
		}
		const previous = groups.get(key);
		if (previous) previous.push(task);
		else groups.set(key, [task]);
	}
	return [...groups.values()];
}
