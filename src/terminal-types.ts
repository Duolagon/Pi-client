export interface TerminalCreateInput {
	conversationId: string;
	project: string;
	cols?: number;
	rows?: number;
	shell?: string;
}

export interface TerminalInfo {
	id: string;
	conversationId: string;
	project: string;
	shell: string;
	label?: string;
	cols: number;
	rows: number;
	pid?: number;
	status: "starting" | "running" | "closing" | "exited";
	createdAt: number;
	exitCode?: number | null;
	signal?: string;
}

export interface TerminalOutputChunk {
	sequence: number;
	data: string;
}

export interface TerminalReplay {
	terminal: TerminalInfo;
	chunks: TerminalOutputChunk[];
	earliestSequence: number;
	nextSequence: number;
	truncated: boolean;
}

export type TerminalEvent =
	| { type: "terminal_data"; terminalId: string; conversationId: string; sequence: number; data: string }
	| { type: "terminal_exit"; terminalId: string; conversationId: string; exitCode: number | null; signal?: string };
