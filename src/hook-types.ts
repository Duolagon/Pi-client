export type HookEventName =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "PermissionRequest"
	| "UserPromptSubmit"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "PreCompact"
	| "PostCompact"
	| "SessionStart"
	| "SessionEnd"
	| "Notification";

/** Why a conversation runtime ended; "close" means the app quit or closed it. */
export type HookSessionEndReason = "close" | "other";

export type HookHandlerType = "command" | "http";

export type HookScope = "user" | "project" | "agent";

export interface HookEntry {
	id: string;
	event: HookEventName;
	handlerType?: HookHandlerType;
	matcher?: string;
	command?: string;
	url?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
	timeout?: number;
	statusMessage?: string;
	scope: HookScope;
	sourceFile: string;
	editable: boolean;
}

export interface HookSaveInput {
	id?: string;
	event: HookEventName;
	handlerType?: HookHandlerType;
	matcher?: string;
	command?: string;
	url?: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
	timeout?: number;
	statusMessage?: string;
	scope: "user" | "project";
	project?: string;
}

export interface HookRemoveInput {
	id: string;
	scope: "user" | "project";
	project?: string;
}

export interface HookRunResult {
	blocked: boolean;
	permissionDecision?: "allow" | "deny" | "ask";
	reason?: string;
	additionalContext?: string;
	systemMessage?: string;
	updatedInput?: Record<string, unknown>;
	suppressOutput?: boolean;
	executedCount: number;
}

export interface HookTestInput {
	event: HookEventName;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	prompt?: string;
	error?: string;
	agentType?: string;
	trigger?: "manual" | "auto";
	notificationType?: string;
	project?: string;
}

export interface DesktopHooksAPI {
	list(project?: string): Promise<HookEntry[]>;
	save(input: HookSaveInput): Promise<HookEntry[]>;
	remove(input: HookRemoveInput): Promise<HookEntry[]>;
	test(input: HookTestInput): Promise<HookRunResult>;
}
