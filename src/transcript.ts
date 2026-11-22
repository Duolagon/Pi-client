import type { DesktopEvent, Message } from "./shared.ts";

type Assistant = Extract<Message, { role: "assistant" }>;
type ResultContent = Extract<Message, { role: "toolResult" }>["content"];
export interface ToolProgress {
	id: string;
	name: string;
	args: unknown;
	output: string;
	status: "running" | "done" | "error";
	startedAt?: number;
}
export interface Transcript {
	messages: Message[];
	streamingIndex: number | null;
	tools: Record<string, ToolProgress>;
}
/** Only the current assistant and unfinished tool executions are retained by the host. */
export interface LiveTranscript {
	assistant?: Assistant;
	tools: Record<string, ToolProgress>;
}
export function transcript(messages: Message[], live?: LiveTranscript): Transcript {
	return {
		messages: live?.assistant ? [...messages, live.assistant] : messages,
		streamingIndex: live?.assistant ? messages.length : null,
		tools: live?.tools ?? {},
	};
}

/** Project active output without caching finalized conversation history or raw events. */
export function applyLiveEvent(state: LiveTranscript, event: DesktopEvent["event"]): LiveTranscript {
	if (event.type === "agent_settled" || event.type === "desktop_error") return { tools: {} };
	if (event.type === "message_start" && event.message.role === "assistant")
		return { ...state, assistant: event.message };
	if (event.type === "message_update" && state.assistant) {
		const updated = applyEvent({ messages: [state.assistant], streamingIndex: 0, tools: {} }, event);
		return { ...state, assistant: updated.messages[0] as Assistant };
	}
	if (event.type === "message_end") {
		if (event.message.role === "assistant") return { ...state, assistant: undefined };
		if (event.message.role === "toolResult") {
			const tools = { ...state.tools };
			delete tools[event.message.toolCallId];
			return { ...state, tools };
		}
	}
	if (event.type === "tool_execution_end") {
		// Nested tools have no transcript message_end, so completed progress must be released here.
		const tools = { ...state.tools };
		delete tools[event.toolCallId];
		return { ...state, tools };
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_update")
		return { ...state, tools: applyEvent({ messages: [], streamingIndex: null, tools: state.tools }, event).tools };
	return state;
}

/** Reconstruct delta-only RPC messages; message_end is authoritative. */
export function applyEvent(state: Transcript, event: DesktopEvent["event"]): Transcript {
	if (event.type === "message_start" && event.message.role === "assistant") {
		return { ...state, messages: [...state.messages, event.message], streamingIndex: state.messages.length };
	}
	if (event.type === "message_end") {
		const index = event.message.role === "assistant" ? state.streamingIndex : null;
		const messages = [...state.messages];
		if (index !== null) messages[index] = event.message;
		else messages.push(event.message);
		return { ...state, messages, streamingIndex: event.message.role === "assistant" ? null : state.streamingIndex };
	}
	if (event.type === "message_update" && state.streamingIndex !== null) {
		const index = state.streamingIndex;
		const current = state.messages[index];
		if (current.role !== "assistant") return state;
		const update = event.assistantMessageEvent;
		const content = [...current.content];
		if ("contentIndex" in update) {
			const at = update.contentIndex;
			const block = content[at];
			switch (update.type) {
				case "text_start":
					content[at] = { type: "text", text: "" };
					break;
				case "text_delta":
					content[at] = { type: "text", text: (block?.type === "text" ? block.text : "") + update.delta };
					break;
				case "text_end":
					content[at] = { type: "text", text: update.content };
					break;
				case "thinking_start":
					content[at] = { type: "thinking", thinking: "" };
					break;
				case "thinking_delta":
					content[at] = {
						type: "thinking",
						thinking: (block?.type === "thinking" ? block.thinking : "") + update.delta,
					};
					break;
				case "thinking_end":
					content[at] = { type: "thinking", thinking: update.content };
					break;
				case "toolcall_start":
					content[at] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} };
					break;
				case "toolcall_end":
					content[at] = update.toolCall;
					break;
			}
		}
		const messages = [...state.messages];
		messages[index] = { ...current, content, usage: event.usage };
		return { ...state, messages };
	}
	if (event.type === "tool_execution_start") {
		return {
			...state,
			tools: {
				...state.tools,
				[event.toolCallId]: {
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					output: "",
					status: "running",
					startedAt: Date.now(),
				},
			},
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			...state,
			tools: {
				...state.tools,
				[event.toolCallId]: {
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					// Upstream tool results allow arbitrary detail types; content uses the message contract.
					output: (event.partialResult.content as ResultContent)
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					status: "running",
				},
			},
		};
	}
	if (event.type === "tool_execution_end") {
		const previous = state.tools[event.toolCallId];
		return {
			...state,
			tools: {
				...state.tools,
				[event.toolCallId]: {
					id: event.toolCallId,
					name: event.toolName,
					args: previous?.args ?? {},
					output: (event.result.content as ResultContent)
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					status: event.isError ? "error" : "done",
				},
			},
		};
	}
	return state;
}
export type { Assistant };
