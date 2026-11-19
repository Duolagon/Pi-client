/** Host-resolved tool authorization. These rules are not an OS sandbox. */
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionScope = "global" | "project" | "conversation";
export type PermissionCommandSelector =
	| { type: "exact"; value: string }
	| { type: "prefix"; argv: string[] };

export interface PermissionRule {
	id: string;
	scope: PermissionScope;
	project?: string;
	conversationId?: string;
	action: PermissionAction;
	/** Tool-name glob: * and ?; mcp__server__* can select one MCP server. */
	tool: string;
	/** Project-relative or absolute path glob. * stays in one segment; ** crosses segments. */
	path?: string;
	/** A literal Bash command, or a token prefix (an executable and optional leading arguments). */
	command?: PermissionCommandSelector;
	/** URL host for WebFetch-style tools: `example.com` or `*.example.com`. */
	domain?: string;
}

export interface RuntimePermissionPolicy {
	version: 1;
	mode: "ask" | "acceptEdits" | "auto" | "read" | "plan";
	/** Automatically deny any tool that would require an interactive confirmation prompt. */
	dontAsk?: boolean;
	/** The host resolves global/project/conversation scopes before writing this list. */
	rules: PermissionRule[];
	disabledTools: string[];
	project: string;
}

export interface PermissionToolCall {
	toolName: string;
	input: unknown;
}

export interface PermissionDecision {
	action: PermissionAction;
	reason: string;
	ruleId?: string;
	targets?: string[];
}
