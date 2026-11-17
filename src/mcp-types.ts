export type McpScope = "user" | "project";
export type McpTransport = "stdio" | "http";

export interface McpServerInfo {
	name: string;
	scope: McpScope;
	transport: McpTransport;
	command?: string;
	args?: string[];
	url?: string;
	description?: string;
	enabled: boolean;
	/** Config file that owns the effective entry. */
	source: string;
	/** Project entry that only overrides enabled/exposure of a user server. */
	overridden?: boolean;
}

export interface McpSaveInput {
	name: string;
	scope: McpScope;
	transport: McpTransport;
	command?: string;
	args?: string[];
	url?: string;
	description?: string;
	enabled?: boolean;
	/** Update only enabled/description on an existing project override. */
	overrideOnly?: boolean;
	project?: string;
}

export interface McpRemoveInput {
	name: string;
	scope: McpScope;
	project?: string;
}

export interface DesktopMcpAPI {
	list(project?: string): Promise<McpServerInfo[]>;
	save(input: McpSaveInput): Promise<McpServerInfo[]>;
	remove(input: McpRemoveInput): Promise<McpServerInfo[]>;
}
