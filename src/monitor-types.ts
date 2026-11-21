/** `shell` is a background Bash command (Bash run_in_background) whose output is buffered for BashOutput. */
export type MonitorKind = "command" | "websocket" | "shell";
export type MonitorStatus = "running" | "stopped" | "exited" | "timed_out" | "error";

export interface MonitorRecord {
	id: string;
	conversationId: string;
	rootConversationId: string;
	kind: MonitorKind;
	description: string;
	target: string;
	status: MonitorStatus;
	persistent: boolean;
	timeoutMs: number;
	createdAt: number;
	updatedAt: number;
	eventCount: number;
	exitCode?: number | null;
	stopReason?: string;
	error?: string;
	/** Background shells: characters of output produced so far (including dropped ones). */
	outputChars?: number;
}

export interface MonitorStartInput {
	description?: string;
	command?: string;
	url?: string;
	timeout_ms?: number;
	persistent?: boolean;
}

export type MonitorEvent =
	| { type: "monitor_updated"; monitor: MonitorRecord }
	| { type: "monitor_removed"; id: string; conversationId: string };
