import type { ThinkingLevel } from "./shared.ts";

export type AgentScope = "builtin" | "project" | "user";

/** A resolved subagent definition. Built-ins have no source path. */
export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	readOnly: boolean;
	scope: AgentScope;
	source?: string;
	/** Custom definitions from `.claude/agents` are read-only in this manager. */
	removable?: boolean;
}

export interface AgentSaveInput {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	/** `provider/model-id`; omitted to inherit the parent model. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
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
