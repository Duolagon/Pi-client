import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcResponse,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcSessionState,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
import type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
import type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";
import type { DesktopTask, TaskEvent, TaskStartInput } from "./task-types.ts";
import type { DesktopSessionAPI } from "./session-types.ts";
import type { LiveTranscript } from "./transcript.ts";
import type { DesktopToolsAPI, DesktopPermissionsAPI } from "./control-types.ts";
import type { DelegatedTaskResult } from "./delegation-types.ts";
import type { DesktopExternalAgentsAPI } from "./external-types.ts";
import type { DesktopAgentsAPI } from "./agent-types.ts";
import type { DesktopMcpAPI } from "./mcp-types.ts";
export type * from "./external-types.ts";
export type * from "./agent-types.ts";
export type * from "./mcp-types.ts";
export type * from "./control-types.ts";
export type * from "./permission-types.ts";
export type * from "./tool-control-types.ts";

export type * from "./session-types.ts";
export type * from "./session-history-types.ts";

export type { GitCheckpoint, GitCheckpointDiff, GitRestoreResult } from "./git-types.ts";
export type { TerminalCreateInput, TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal-types.ts";
export type { WorktreeCreateInput, WorktreeInfo, WorktreeMergeResult, WorktreeRemoveResult } from "./worktree-types.ts";
export type { DesktopTask, TaskEvent, TaskStartInput, TaskStatus } from "./task-types.ts";

export interface CheckpointInput {
	conversationId?: string;
	label?: string;
}
export interface CheckpointTarget {
	checkpointId: string;
	conversationId?: string;
}
export interface DesktopGitAPI {
	begin(input?: CheckpointInput): Promise<GitCheckpoint>;
	finish(input: CheckpointTarget): Promise<GitCheckpoint>;
	list(conversationId?: string): Promise<GitCheckpoint[]>;
	diff(input: CheckpointTarget & { path?: string }): Promise<GitCheckpointDiff>;
	restore(input: CheckpointTarget & { paths?: string[] }): Promise<GitRestoreResult>;
}
export interface DesktopTerminalAPI {
	create(
		input?: Omit<TerminalCreateInput, "project" | "conversationId"> & { conversationId?: string },
	): Promise<TerminalInfo>;
	list(conversationId?: string): Promise<TerminalInfo[]>;
	write(id: string, data: string): Promise<void>;
	resize(id: string, cols: number, rows: number): Promise<void>;
	close(id: string): Promise<void>;
	replay(id: string, afterSequence?: number): Promise<TerminalReplay>;
	onEvent(listener: (event: TerminalEvent) => void): () => void;
}
export interface DesktopTaskAPI {
	start(input: TaskStartInput): Promise<DesktopTask>;
	list(): Promise<DesktopTask[]>;
	snapshot(id: string): Promise<Snapshot>;
	cancel(id: string): Promise<DesktopTask>;
	result(id: string, options?: { block?: boolean; timeout?: number }): Promise<DelegatedTaskResult>;
	command(id: string, command: Command): Promise<unknown>;
	respond(id: string, response: RpcExtensionUIResponse): Promise<void>;
	files(id: string, path: string): Promise<FileEntry[]>;
	readFile(id: string, path: string): Promise<{ path: string; content: string }>;
	workspace(id: string): Promise<Workspace>;
	diff(id: string, path: string): Promise<string>;
	onEvent(listener: (event: TaskEvent) => void): () => void;
}
export interface DesktopWorktreeAPI {
	create(input: WorktreeCreateInput): Promise<WorktreeInfo>;
	list(project?: string): Promise<WorktreeInfo[]>;
	remove(id: string): Promise<WorktreeRemoveResult>;
	merge(id: string): Promise<WorktreeMergeResult>;
}

export type PermissionMode = "ask" | "acceptEdits" | "auto" | "read";
export type ProjectTrustDecision = "trusted" | "untrusted";
export interface ProjectTrustState {
	project: string;
	/** Resources that Pi would load only after a trust decision. */
	resources: string[];
	required: boolean;
	decision?: ProjectTrustDecision;
}
export type Message = Extract<RpcResponse, { command: "get_messages"; success: true }>["data"]["messages"][number];
export type BashResult = Extract<RpcResponse, { command: "bash"; success: true }>["data"];
export type ThinkingLevel = RpcSessionState["thinkingLevel"];
export type SlashCommand = Extract<RpcResponse, { command: "get_commands"; success: true }>["data"]["commands"][number];
export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "deepseek";
export type ConnectionMode = "preset" | "custom";
export type ConnectionProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "openai-completions"
	| "google-generative-ai";
export interface ConnectionInput {
	provider: Provider;
	mode?: ConnectionMode;
	apiKey?: string;
	baseUrl?: string;
	modelId?: string;
	api?: ConnectionProtocol;
}
export interface ConnectionTestResult {
	success: boolean;
	message: string;
	model?: string;
	latencyMs?: number;
}
export interface ProviderModelPreset {
	id: string;
	name: string;
	api: ConnectionProtocol;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
}
export interface ProviderPreset {
	provider: Provider;
	name: string;
	baseUrl: string;
	api: ConnectionProtocol;
	defaultModelId: string;
	models: ProviderModelPreset[];
}
export interface Model {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
}
export interface Conversation {
	id: string;
	title: string;
	project: string;
	sessionFile?: string;
	parentConversationId?: string;
	forkEntryId?: string;
	origin?: "fork" | "clone" | "cli";
	sourceSessionId?: string;
	/** Selected native tree cursor, including an explicitly empty root. */
	sessionLeafId?: string | null;
	updatedAt: number;
}
export interface Project {
	path: string;
	name: string;
}
export interface Settings {
	agentDir?: string;
	defaultModel?: { provider: string; id: string };
	permission: PermissionMode;
	theme: "light" | "dark" | "system";
	configuredProviders: Provider[];
	connections: Partial<
		Record<Provider, { baseUrl?: string; modelId?: string; api?: ConnectionProtocol; mode?: ConnectionMode }>
	>;
}
export interface FileEntry {
	name: string;
	path: string;
	directory: boolean;
}
export interface Change {
	path: string;
	status: string;
	staged?: boolean;
	unstaged?: boolean;
}
export interface Workspace {
	branch: string;
	changes: Change[];
	isGit: boolean;
}
export interface GitCommitResult {
	hash: string;
	summary: string;
	workspace: Workspace;
}
export interface MemoryFileEntry {
	file: "AGENTS.md" | "CLAUDE.md";
	path: string;
	content: string;
	exists: boolean;
}
export interface Snapshot {
	/** Sequence of the last host event included in this snapshot. */
	eventSequence?: number;
	/** Current output omitted from Pi's finalized get_messages transcript. */
	liveTranscript?: LiveTranscript;
	archived?: boolean;
	projects: Project[];
	conversations: Conversation[];
	active?: Conversation;
	state?: RpcSessionState;
	models: Model[];
	providerPresets: ProviderPreset[];
	settings: Settings;
	messages: Message[];
	stats?: SessionStats;
	engineStatus: "ready" | "starting" | "error";
	engineError?: string;
	pendingUI: RpcExtensionUIRequest[];
	thinkingLevels: ThinkingLevel[];
	commands: SlashCommand[];
	/** Trust state for the active project; absent when no project is active. */
	trust?: ProjectTrustState;
}
export type DesktopEvent = {
	conversationId: string;
	/** Monotonic within this desktop host; used to replay events crossing a snapshot. */
	sequence?: number;
	event:
		| JsonAgentSessionEvent
		| RpcExtensionUIRequest
		| { type: "desktop_error"; message: string }
		| { type: "extension_error"; extensionPath: string; event: string; error: string };
};
export type Command = RpcCommand;
export interface DesktopAPI {
	externalAgents: DesktopExternalAgentsAPI;
	agents: DesktopAgentsAPI;
	mcp: DesktopMcpAPI;
	tools: DesktopToolsAPI;
	permissions: DesktopPermissionsAPI;
	sessions: DesktopSessionAPI;
	git: DesktopGitAPI;
	terminals: DesktopTerminalAPI;
	tasks: DesktopTaskAPI;
	worktrees: DesktopWorktreeAPI;
	snapshot(): Promise<Snapshot>;
	openProject(): Promise<Snapshot | null>;
	selectProject(path: string): Promise<Snapshot>;
	setProjectTrust(input: { project: string; decision: ProjectTrustDecision }): Promise<Snapshot>;
	newConversation(): Promise<Snapshot>;
	selectConversation(id: string): Promise<Snapshot>;
	renameConversation(id: string, title: string): Promise<Snapshot>;
	command(command: Command): Promise<unknown>;
	respond(response: RpcExtensionUIResponse): Promise<void>;
	files(path: string): Promise<FileEntry[]>;
	readFile(path: string): Promise<{ path: string; content: string }>;
	workspace(): Promise<Workspace>;
	diff(path: string): Promise<string>;
	gitStage(paths?: string[]): Promise<Workspace>;
	gitUnstage(paths?: string[]): Promise<Workspace>;
	gitDiscard(paths: string[]): Promise<Workspace>;
	gitCommit(message: string): Promise<GitCommitResult>;
	readMemory(): Promise<MemoryFileEntry[]>;
	writeMemory(file: "AGENTS.md" | "CLAUDE.md", content: string): Promise<MemoryFileEntry>;
	saveSettings(settings: {
		agentDir?: string;
		permission: PermissionMode;
		theme: Settings["theme"];
		provider?: Provider;
		mode?: ConnectionMode;
		apiKey?: string;
		baseUrl?: string;
		modelId?: string;
		api?: ConnectionProtocol;
	}): Promise<Snapshot>;
	testConnection(input: ConnectionInput): Promise<ConnectionTestResult>;
	exportConversation(): Promise<string | null>;
	onEvent(listener: (event: DesktopEvent) => void): () => void;
}
export type { RpcSessionState, SessionStats, RpcExtensionUIRequest, RpcExtensionUIResponse };
declare global {
	interface Window {
		pi: DesktopAPI;
	}
}
