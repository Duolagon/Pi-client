export type WorkflowStatus =
	| "running"
	| "waiting_for_approval"
	| "completed"
	| "failed"
	| "cancelled";

export type WorkflowApprovalDecision = "once" | "always" | "deny";

export interface WorkflowBudget {
	maxCost?: number;
	maxTokens?: number;
	maxAgents?: number;
	spentCost: number;
	spentTokens: number;
	spawnedAgents: number;
}

export interface WorkflowApprovalRequest {
	id: string;
	workflowId: string;
	conversationId: string;
	title: string;
	detail: string;
	kind: "start_workflow" | "agent_step";
	stepKey?: string;
	createdAt: number;
}

export interface WorkflowJournalEntry {
	stepKey: string;
	status: "completed" | "failed";
	taskId?: string;
	worktreeId?: string;
	workingDirectory?: string;
	output?: string;
	structuredOutput?: unknown;
	error?: string;
	usage?: { totalTokens: number; cost: number };
	completedAt: number;
}

/** One agent() call of a run, written when it starts so the UI can show it running. */
export interface WorkflowStepRecord {
	stepKey: string;
	/** agent() description, or the step key when the script gave none. */
	label: string;
	/** Enclosing phase() name, derived from the step key; absent at the top level. */
	phase?: string;
	status: "running" | "completed" | "failed" | "replayed";
	startedAt: number;
	completedAt?: number;
	taskId?: string;
	error?: string;
	usage?: { totalTokens: number; cost: number };
}

export interface WorkflowPhaseRecord {
	name: string;
	status: "running" | "completed" | "failed";
	startedAt: number;
	completedAt?: number;
	error?: string;
}

export interface WorkflowLogRecord {
	ts: number;
	level: "info" | "warn" | "error";
	message: string;
}

export interface WorkflowRecord {
	id: string;
	conversationId: string;
	rootConversationId: string;
	project: string;
	title: string;
	script: string;
	status: WorkflowStatus;
	budget: WorkflowBudget;
	phases: WorkflowPhaseRecord[];
	logs: WorkflowLogRecord[];
	journal: Record<string, WorkflowJournalEntry>;
	/** Live per-step rows for the progress tree, keyed by step key. */
	steps: Record<string, WorkflowStepRecord>;
	/** The WorkflowRun tool call that started this run, so the transcript can anchor its tree. */
	toolCallId?: string;
	result?: unknown;
	error?: string;
	pendingApproval?: WorkflowApprovalRequest;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowRunInput {
	title?: string;
	script: string;
	/** Tool call that started the run; absent when the user started it. */
	toolCallId?: string;
	budget?: {
		maxCost?: number;
		maxTokens?: number;
		maxAgents?: number;
	};
}

export type WorkflowEvent = {
	type: "workflow_updated";
	workflow: WorkflowRecord;
};
