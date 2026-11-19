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
	output?: string;
	structuredOutput?: unknown;
	error?: string;
	usage?: { totalTokens: number; cost: number };
	completedAt: number;
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
	result?: unknown;
	error?: string;
	pendingApproval?: WorkflowApprovalRequest;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowRunInput {
	title?: string;
	script: string;
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
