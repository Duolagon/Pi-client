import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const config = {
	provider: "desktop-test", api: "desktop-test-api",
	models: [{ id: "desktop-test-1", name: "Scoped delegation fixture", reasoning: false }], tokensPerSecond: 10000,
};
const faux = fauxProvider(config);
const text = (message) => typeof message?.content === "string" ? message.content :
	(message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

export default function scopedDelegationProvider(pi) {
	pi.registerProvider(config.provider, {
		api: config.api, apiKey: "fixture-local-secret", baseUrl: "http://127.0.0.1:0", models: faux.models,
		streamSimple(model, context, options) {
			const index = context.messages.findLastIndex((message) => message.role === "user");
			const input = text(context.messages[index]);
			const results = context.messages.slice(index + 1).filter((message) => message.role === "toolResult");
			let response;
			if (input === "SCOPED_PARENT" && !results.length) {
				response = fauxAssistantMessage(fauxToolCall("Agent", {
					description: "Read assigned files", prompt: "SCOPED_CHILD", subagent_type: "Explore",
					scope_paths: ["assigned"], run_in_background: false,
				}), { stopReason: "toolUse" });
			} else if (input === "SCOPED_CHILD" && !results.length) {
				response = fauxAssistantMessage([
					fauxToolCall("read", { path: "sibling.txt" }),
					fauxToolCall("read", { path: "assigned/inside.txt" }),
				], { stopReason: "toolUse" });
			} else if (input === "SCOPED_CHILD") {
				response = fauxAssistantMessage("OUTSIDE_BLOCKED " + results[0].isError + "\n" + text(results[1]));
			} else {
				response = fauxAssistantMessage("SCOPED_PARENT_DONE");
			}
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
}
