export type HookEventName =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop"
	| "SessionStart"
	| "Notification";

export type HookScope = "user" | "project";

export interface HookEntry {
	id: string;
	event: HookEventName;
	matcher?: string;
	command: string;
	timeout?: number;
	scope: HookScope;
	sourceFile: string;
	editable: boolean;
}

export interface HookSaveInput {
	id?: string;
	event: HookEventName;
	matcher?: string;
	command: string;
	timeout?: number;
	scope: HookScope;
	project?: string;
}

export interface HookRemoveInput {
	id: string;
	scope: HookScope;
	project?: string;
}

export interface HookRunResult {
	blocked: boolean;
	permissionDecision?: "allow" | "deny" | "ask";
	reason?: string;
	additionalContext?: string;
	systemMessage?: string;
	executedCount: number;
}

export interface HookTestInput {
	event: HookEventName;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	prompt?: string;
	project?: string;
}

export interface DesktopHooksAPI {
	list(project?: string): Promise<HookEntry[]>;
	save(input: HookSaveInput): Promise<HookEntry[]>;
	remove(input: HookRemoveInput): Promise<HookEntry[]>;
	test(input: HookTestInput): Promise<HookRunResult>;
}
