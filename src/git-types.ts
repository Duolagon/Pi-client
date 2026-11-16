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
	createdAt: number;
	finishedAt?: number;
	status: GitCheckpointStatus;
	beforeHead?: string;
	afterHead?: string;
	changes: GitSnapshotChange[];
	restoredPaths: string[];
}

export interface GitCheckpointDiff {
	checkpointId: string;
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
