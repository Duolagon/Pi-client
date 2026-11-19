import type { HookEntry } from "./hook-types.ts";
import type { ThinkingLevel } from "./shared.ts";

export type AgentScope = "builtin" | "project" | "user";
export type AgentPermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions" | "read";
export type AgentMemoryScope = "user" | "project" | "local";
export type AgentModelAlias = "sonnet" | "opus" | "haiku" | "fable" | "inherit";

/** A resolved subagent definition. Built-ins have no source path. */
export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	disallowedTools?: string[];
	model?: { provider: string; id: string };
	modelAlias?: AgentModelAlias;
	thinkingLevel?: ThinkingLevel;
	permissionMode?: AgentPermissionMode;
	maxTurns?: number;
	skills?: string[];
	memory?: AgentMemoryScope;
	isolation?: "worktree" | "shared";
	background?: boolean;
	/** MCP servers referenced by name; inline configurations are not supported. */
	mcpServers?: string[];
	/** Do not load CLAUDE.md/AGENTS.md memory files into this child. */
	omitClaudeMd?: boolean;
	/** Claude frontmatter `color`; display only, never sent to the model. */
	color?: string;
	hooks?: HookEntry[];
	readOnly: boolean;
	scope: AgentScope;
	source?: string;
	/** Custom definitions from `.claude/agents` are read-only in this manager. */
	removable?: boolean;
	/** Unknown frontmatter fields preserved across edits. */
	extra?: Record<string, string>;
	/** Non-fatal parse error (e.g. readOnly + memory conflict) surfaced if the agent is invoked. */
	definitionError?: string;
}

export interface AgentSaveInput {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	disallowedTools?: string[];
	/** `provider/model-id` or Claude alias (`sonnet`/`opus`/`haiku`/`inherit`); omitted to inherit. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	permissionMode?: AgentPermissionMode;
	maxTurns?: number;
	skills?: string[];
	memory?: AgentMemoryScope;
	isolation?: "worktree" | "shared";
	background?: boolean;
	mcpServers?: string[];
	omitClaudeMd?: boolean;
	color?: string;
	scope: "project" | "user";
	project?: string;
}

export interface AgentRemoveInput {
	name: string;
	scope: "project" | "user";
	project?: string;
}

export interface DesktopAgentsAPI {
	list(project?: string): Promise<AgentDefinition[]>;
	save(input: AgentSaveInput): Promise<AgentDefinition[]>;
	remove(input: AgentRemoveInput): Promise<AgentDefinition[]>;
}
