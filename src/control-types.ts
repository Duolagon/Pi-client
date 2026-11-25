import type { DesktopToolInfo } from "./tool-control-types.ts";
import type { PermissionRule, RuntimePermissionPolicy } from "./permission-types.ts";
import type { PermissionMode, Snapshot } from "./shared.ts";

export interface ControlScope {
	scope?: "global" | "project" | "conversation";
	conversationId?: string;
	project?: string;
}
export interface ToolToggleInput extends ControlScope {
	name: string;
	/** null removes the desktop override and restores the inherited Pi setting. */
	enabled: boolean | null;
}
export interface ControlEvent {
	type: "tools_changed" | "permissions_changed" | "agents_changed";
	conversationIds: string[];
}
export interface PermissionSettings {
	rules: PermissionRule[];
	effective: RuntimePermissionPolicy;
}
export interface PermissionCheckInput {
	conversationId?: string;
	toolName: string;
	input: Record<string, unknown>;
}
export interface PermissionCheckResult {
	action: "allow" | "ask" | "deny";
	reason: string;
	ruleId?: string;
	targets?: string[];
}
export interface DesktopToolsAPI {
	list(conversationId?: string): Promise<DesktopToolInfo[]>;
	setEnabled(input: ToolToggleInput): Promise<DesktopToolInfo[]>;
	onEvent(listener: (event: ControlEvent) => void): () => void;
}
export interface DesktopPermissionsAPI {
	setMode(conversationId: string, mode: PermissionMode): Promise<Snapshot>;
	setProjectLocalCompute(conversationId: string, blocked: boolean): Promise<PermissionSettings>;
	list(conversationId?: string): Promise<PermissionSettings>;
	upsert(rule: PermissionRule): Promise<PermissionSettings>;
	remove(id: string): Promise<PermissionSettings>;
	check(input: PermissionCheckInput): Promise<PermissionCheckResult>;
	onEvent(listener: (event: ControlEvent) => void): () => void;
}
