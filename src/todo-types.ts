export const todoStatuses = ["pending", "in_progress", "completed", "deleted"] as const;
export type TodoStatus = (typeof todoStatuses)[number];

export interface TodoRecord {
	id: string;
	subject: string;
	description: string;
	status: TodoStatus;
	activeForm?: string;
	owner?: string;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
	estimatedSeconds?: number;
	startedAt?: number;
	completedAt?: number;
	createdAt: number;
	updatedAt: number;
}

export interface TodoCreateInput {
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	blocks?: string[];
	blockedBy?: string[];
	metadata?: Record<string, unknown>;
	estimatedSeconds?: number;
}

export interface TodoGetInput {
	id: string;
}

export interface TodoUpdateInput {
	id: string;
	subject?: string;
	description?: string;
	status?: TodoStatus;
	activeForm?: string;
	owner?: string;
	addBlocks?: string[];
	addBlockedBy?: string[];
	metadata?: Record<string, unknown>;
	estimatedSeconds?: number;
}

export interface TodoListInput {
	include_completed?: boolean;
}

export interface TodoEvent {
	type: "todos_updated";
	rootConversationId: string;
	todos: TodoRecord[];
}
