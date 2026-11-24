import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const provider = "desktop-test";
const api = "desktop-test-api";
const faux = fauxProvider({ provider, api, models: [{ id: "desktop-test-1" }], tokensPerSecond: 2000 });
const textOf = (message) => typeof message?.content === "string"
	? message.content
	: (message?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");

export default function workflowProvider(pi) {
	pi.registerProvider(provider, {
		api,
		baseUrl: "http://127.0.0.1:0",
		apiKey: "local-faux-key-never-sent",
		models: faux.models,
		streamSimple(model, context, options) {
			const index = context.messages.findLastIndex((message) => message.role === "user");
			const prompt = textOf(context.messages[index]);
			const result = context.messages.slice(index + 1).find((message) => message.role === "toolResult");
			const toolCall = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
			let response;
			if (prompt.startsWith("WORKFLOW_TEST_SCRIPT\n")) {
				response = result ? fauxAssistantMessage("WORKFLOW_TEST_DONE") : toolCall("WorkflowRun", {
					script: prompt.slice(prompt.indexOf("\n") + 1),
				});
			} else if (prompt.startsWith("write:")) {
				const path = prompt.slice(6);
				response = result ? fauxAssistantMessage(result.isError ? "write-failed" : "write-ok")
					: toolCall("write", { path, content: "workflow-step-output\n" });
			} else if (prompt.startsWith("read:")) {
				response = result ? fauxAssistantMessage(result.isError ? "read-failed" : textOf(result))
					: toolCall("read", { path: prompt.slice(5) });
			} else {
				response = fauxAssistantMessage("WORKFLOW_TEST_READY");
			}
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
}
