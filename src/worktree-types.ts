export interface WorktreeCreateInput {
	project: string;
	baseRef?: string;
	conversationId?: string;
}

export interface WorktreeInfo {
	id: string;
	repository: string;
	path: string;
	branch: string;
	baseRef: string;
	baseCommit: string;
	targetBranch?: string;
	createdAt: number;
	conversationId?: string;
	status: "ready" | "missing";
}

export interface WorktreeRemoveResult {
	worktreeId: string;
	branch: string;
	branchRetained: boolean;
}

export type WorktreeMergeResult =
	| { status: "merged" | "up-to-date"; worktreeId: string; repository: string; head: string }
	| { status: "blocked"; worktreeId: string; repository: string; reason: string };
