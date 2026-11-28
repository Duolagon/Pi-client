export type GitCheckpointStatus = "pending" | "ready" | "partially-restored" | "restored";
export type GitSnapshotKind = "missing" | "file" | "symlink" | "directory";

export interface GitSnapshotChange {
	path: string;
	status: "added" | "modified" | "deleted" | "type-changed";
	beforeKind: GitSnapshotKind;
	afterKind: GitSnapshotKind;
	beforeSize: number;
	afterSize: number;
	beforeMode?: number;
	afterMode?: number;
	binary: boolean;
}

export interface GitCheckpoint {
	id: string;
	project: string;
	conversationId: string;
	label: string;
	/** Native Pi entry for the prompt that started this run. Older and manual checkpoints omit it. */
	userEntryId?: string;
	kind?: "discard-undo";
	createdAt: number;
	finishedAt?: number;
	status: GitCheckpointStatus;
	beforeHead?: string;
	afterHead?: string;
	changes: GitSnapshotChange[];
	excludedFiles?: number;
	restoredPaths: string[];
}

export interface GitCheckpointDiff {
	/** Fingerprint of the complete task delta, including file contents and modes. */
	fingerprint?: string;
	checkpointId: string;
	excludedFiles?: number;
	truncated?: boolean;
	files: (GitSnapshotChange & { diff: string; truncated: boolean })[];
}

export interface GitRestoreConflict {
	path: string;
	reason: string;
}

export interface GitRestoreResult {
	status: "restored" | "unchanged" | "conflict" | "partial";
	checkpoint: GitCheckpoint;
	restored: string[];
	skipped: string[];
	conflicts: GitRestoreConflict[];
}
