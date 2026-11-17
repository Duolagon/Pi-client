// Local scripted parent model. Native external adapters are injected by the integration test.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const options = { provider: "external-delegation-test", api: "external-delegation-test-api", models: [{ id: "external-parent", name: "External parent integration", reasoning: false }], tokensPerSecond: 20000 };
const faux = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 10, tokenSize: { min: 1, max: 1 } });
const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const textOf = (message) => typeof message?.content === "string" ? message.content : message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
const parsed = (message) => { try { return JSON.parse(textOf(message)); } catch { return {}; } };

export default function externalDelegationProvider(pi) {
	pi.registerProvider(options.provider, {
		api: options.api, apiKey: "isolated-scripted-external-parent", baseUrl: "http://127.0.0.1:0", models: faux.models,
		streamSimple(model, context, streamOptions) {
			const index = context.messages.findLastIndex((message) => message.role === "user");
			const text = textOf(context.messages[index]);
			const results = context.messages.slice(index + 1).filter((message) => message.role === "toolResult");
			const executor = text.split(" ")[1] ?? "codex";
			let response;
			if (text.includes('"task_id"') && text.includes('"parent_conversation_id"') && text.includes('"executor"')) {
				response = fauxAssistantMessage("EXTERNAL_HANDBACK_COMPLETE " + text);
			} else if (text.startsWith("EXTERNAL_CONTINUE ")) {
				if (!results.length) response = tool("AgentExecutors", {});
				else if (results.length === 1) response = tool("Agent", { executor, description: "External implementation", prompt: "WRITE first", subagent_type: "general-purpose" });
				else if (results.length === 2) response = tool("AgentSend", { task_id: parsed(results[1]).task_id, message: "WRITE second" });
				else if (results.length === 3) response = tool("TaskOutput", { task_id: parsed(results[1]).task_id, block: false });
				else if (results.length === 4) response = tool("TaskList", {});
				else response = fauxAssistantMessage("EXTERNAL_CONTINUE_COMPLETE " + results.map((result) => `${result.toolName}:${result.isError ? "error" : "ok"}:${textOf(result)}`).join("\n"));
			} else if (text.startsWith("EXTERNAL_APPROVAL ")) {
				response = !results.length ? tool("Agent", { executor, description: "Native approval", prompt: "WAIT_APPROVAL", subagent_type: "general-purpose" }) : fauxAssistantMessage("EXTERNAL_APPROVAL_RETURNED " + textOf(results[0]));
			} else if (text.startsWith("EXTERNAL_BACKGROUND ")) {
				response = !results.length ? tool("Agent", { executor, description: "External background", prompt: "SLOW_DONE", subagent_type: "general-purpose", run_in_background: true }) : fauxAssistantMessage("EXTERNAL_BACKGROUND_LAUNCHED " + textOf(results[0]));
			} else if (text.startsWith("EXTERNAL_CANCEL_TOOL ")) {
				if (!results.length) response = tool("Agent", { executor, description: "Cancelable external", prompt: "BLOCK", subagent_type: "general-purpose", run_in_background: true });
				else if (results.length === 1) response = tool("TaskStop", { task_id: parsed(results[0]).task_id });
				else response = fauxAssistantMessage("EXTERNAL_CANCEL_COMPLETE " + textOf(results[1]));
			} else if (text.startsWith("EXTERNAL_BLOCK ")) {
				response = !results.length ? tool("Agent", { executor, description: "External parent cancellation", prompt: "BLOCK", subagent_type: "general-purpose", run_in_background: true }) : fauxAssistantMessage("EXTERNAL_BLOCK_LAUNCHED " + textOf(results[0]));
			} else if (text.startsWith("EXTERNAL_FOREIGN ")) {
				response = !results.length ? tool("AgentSend", { task_id: text.split(" ")[1], message: "WRITE forbidden" }) : fauxAssistantMessage("EXTERNAL_FOREIGN_COMPLETE " + (results[0].isError ? "DENIED " : "ALLOWED ") + textOf(results[0]));
			} else if (text.startsWith("PI_MANUAL_SLOW")) {
				slow.setResponses([fauxAssistantMessage("MANUAL_PI_RUNNING ".repeat(1000))]);
				return slow.provider.streamSimple(model, context, streamOptions);
			} else response = fauxAssistantMessage("UNEXPECTED_EXTERNAL_PROMPT " + text);
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
