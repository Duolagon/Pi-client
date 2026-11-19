// Local scripted model only. Pi and desktop delegation execute the real tools and subprocesses.
// Branches read the whole context, because SendMessage adds later user messages to a child.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const options = {
	provider: "resume-test", api: "resume-test-api",
	models: [{ id: "resume-test-1", name: "Resume integration fixture", reasoning: false }],
	tokensPerSecond: 10000,
};
const faux = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 30, tokenSize: { min: 1, max: 1 } });
const PREFIX = "[Message from parent agent";

function textOf(message) {
	if (typeof message?.content === "string") return message.content;
	return message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
}
function userTexts(context) { return context.messages.filter((message) => message.role === "user").map(textOf); }
const isNotification = (message) => message.role === "user" && textOf(message).includes("<task-notification>");
/**
 * The prompt being answered and its tool results. A background result queued for the next
 * turn can arrive right after the user's prompt; the prompt is answered first, and a
 * notification is answered on its own only after that.
 */
function current(context) {
	const last = context.messages.findLastIndex((message) => message.role === "user");
	const prompt = context.messages.findLastIndex((message) => message.role === "user" && !isNotification(message));
	let index = last;
	if (prompt >= 0 && prompt < last) {
		const answered = context.messages.slice(prompt + 1).some((message) => message.role === "assistant" && message.stopReason !== "toolUse" && textOf(message));
		if (!answered) index = prompt;
	}
	return {
		text: textOf(context.messages[index]),
		results: context.messages.slice(index + 1).filter((message) => message.role === "toolResult"),
	};
}
function tool(name, input) { return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }); }
function resultText(result) { return result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""; }
function remembered(context) {
	for (const text of userTexts(context)) {
		const match = /^CHILD_(?:SLOW_)?REMEMBER (\S+)/.exec(text);
		if (match) return match[1];
	}
	return "none";
}

export default function resumeFixture(pi) {
	pi.registerProvider(options.provider, {
		api: options.api, apiKey: "isolated-local-scripted-model", baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			const { text, results } = current(context);
			const users = userTexts(context);
			const first = users[0] ?? "";
			let response;
			if (first.startsWith("CHILD_STEERABLE")) {
				// Keep working (one real bash call per turn) until a steered message arrives.
				const steer = users.find((item) => item.includes("STEER_TOKEN_"));
				const calls = context.messages.filter((message) => message.role === "toolResult").length;
				if (steer) response = fauxAssistantMessage(`CHILD_STEERED ${/STEER_TOKEN_\w+/.exec(steer)[0]} prefix:${steer.startsWith(PREFIX) ? "yes" : "no"}`);
				else if (calls < 200) response = tool("bash", { command: "sleep 0.2" });
				else response = fauxAssistantMessage("CHILD_NOT_STEERED");
			} else if (text.includes("<task-notification>")) {
				response = fauxAssistantMessage("PARENT_NOTIFIED");
			} else if (text.startsWith("PARENT_TOOLS_PROBE")) {
				// Declared tools: the request's tools and the transcript's tool declarations.
				const declared = new Set((context.tools ?? []).map((item) => item.name));
				for (const message of context.messages) for (const item of message.toolsAdded ?? []) declared.add(item.name);
				response = fauxAssistantMessage(`PARENT_TOOLS sendmessage:${declared.has("SendMessage") ? "yes" : "no"} agentsend:${declared.has("AgentSend") ? "yes" : "no"} agent:${declared.has("Agent") ? "yes" : "no"}`);
			} else if (text.startsWith("PARENT_START_SLOW ")) {
				response = results.length === 0
					? tool("Agent", { description: "Remember a token slowly", prompt: `CHILD_SLOW_REMEMBER ${text.split(/\s+/)[1]}`, name: "slowmemo", run_in_background: true })
					: fauxAssistantMessage("PARENT_STARTED " + resultText(results[0]));
			} else if (text.startsWith("PARENT_STEER_START")) {
				response = results.length === 0
					? tool("Agent", { description: "Steerable work", prompt: "CHILD_STEERABLE", name: "steer", run_in_background: true })
					: fauxAssistantMessage("PARENT_STARTED " + resultText(results[0]));
			} else if (text.startsWith("PARENT_START ")) {
				const [, token, mode] = text.split(/\s+/);
				response = results.length === 0
					? tool("Agent", { description: "Remember a token", prompt: `CHILD_REMEMBER ${token}`, name: "memo", run_in_background: mode === "bg" })
					: fauxAssistantMessage("PARENT_STARTED " + resultText(results[0]));
			} else if (text.startsWith("PARENT_SEND ")) {
				// PARENT_SEND <to> <bg|fg> <message…>
				const [, to, mode, ...rest] = text.split(" ");
				response = results.length === 0
					? tool("SendMessage", { to, message: rest.join(" "), run_in_background: mode === "bg" })
					: fauxAssistantMessage(`PARENT_SENT ${results[0].isError ? "ERROR " : ""}${resultText(results[0])}`);
			} else if (text.includes("CHILD_WRITE_PROBE")) {
				response = results.length === 0
					? tool("write", { path: "resume-write.txt", content: "must not exist\n" })
					: fauxAssistantMessage(`CHILD_WRITE_${results[0].isError ? "DENIED" : "ALLOWED"}`);
			} else if (text.includes("CHILD_RECALL")) {
				response = fauxAssistantMessage(`CHILD_RECALLED ${remembered(context)} prefix:${text.startsWith(PREFIX) ? "yes" : "no"} turns:${users.length}`);
			} else if (text.startsWith("CHILD_SLOW_REMEMBER ")) {
				slow.setResponses([fauxAssistantMessage("CHILD_SLOW_WORKING " + "long work ".repeat(2000))]);
				return slow.provider.streamSimple(model, context, streamOptions);
			} else if (text.startsWith("CHILD_REMEMBER ")) {
				response = fauxAssistantMessage(`CHILD_REMEMBERED ${text.split(/\s+/)[1]}`);
			} else response = fauxAssistantMessage("UNEXPECTED_PROMPT " + text.slice(0, 200));
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
