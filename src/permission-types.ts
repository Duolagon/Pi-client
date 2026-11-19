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
	/**
	 * When true on a `conversation`-scoped rule, the rule applies only to delegated
	 * descendants of `conversationId` (the delegation tree) and does not relax the root
	 * conversation itself.
	 */
	delegatedOnly?: boolean;
	action: PermissionAction;
	/** Tool-name glob: * and ?; mcp__server__* can select one MCP server. */
	tool: string;
	/** Project-relative or absolute path glob. * stays in one segment; ** crosses segments. */
	path?: string;
	/** A literal Bash command, or a token prefix (an executable and optional leading arguments). */
	command?: PermissionCommandSelector;
	/** URL host for WebFetch-style tools: `example.com` or `*.example.com`. */
	domain?: string;
	/** Agent type glob for Agent tool: `general-purpose`, `code-reviewer`, or `*`. */
	agentType?: string;
}

export interface RuntimePermissionPolicy {
	version: 1;
	mode: "ask" | "acceptEdits" | "auto" | "read" | "plan";
	/** Automatically deny any tool that would require an interactive confirmation prompt. */
	dontAsk?: boolean;
	/** The host resolves global/project/conversation scopes before writing this list. */
	rules: PermissionRule[];
	disabledTools: string[];
	/** When set, restricts `mcp__<server>__*` tool calls to these MCP server names. */
	allowedMcpServers?: string[];
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
