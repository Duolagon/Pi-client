// This test-only provider emits scripted model output; the actual Pi tools still execute.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const providerName = "desktop-test";
const options = {
	provider: providerName,
	api: "desktop-test-api",
	models: [
		{ id: "desktop-test-1", name: "Desktop Test One", reasoning: true },
		{ id: "desktop-test-2", name: "Desktop Test Two", reasoning: true },
	],
	tokensPerSecond: 2000,
};
const faux = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 8, tokenSize: { min: 1, max: 1 } });

function lastPrompt(context) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const message = context.messages[index];
	const text =
		typeof message?.content === "string"
			? message.content
			: (message?.content
					?.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n") ?? "");
	return { text, results: context.messages.slice(index + 1).filter((message) => message.role === "toolResult") };
}

export default function desktopTestProvider(pi) {
	pi.registerProvider(providerName, {
		api: options.api,
		apiKey: "local-faux-key-never-sent",
		baseUrl: "http://127.0.0.1:0",
		models: faux.models.map((model) => ({
			...model,
			baseUrl: "http://test-user:test-password@127.0.0.1:0/api?token=desktop-runtime-secret",
			headers: { Authorization: "desktop-runtime-secret" },
		})),
		streamSimple(model, context, streamOptions) {
			const { text, results } = lastPrompt(context);
			if (text.includes("slow-stream")) {
				slow.setResponses([fauxAssistantMessage("Cancellable stream ".repeat(500))]);
				return slow.provider.streamSimple(model, context, streamOptions);
			}
			let response;
			if (text.includes("read-write-bash")) {
				const steps = [
					fauxToolCall("read", { path: "seed.txt" }),
					fauxToolCall("write", { path: "generated.txt", content: "written by real Pi tool\n" }),
					fauxToolCall("bash", { command: "printf 'real-pi-command\\n' > command.txt" }),
				];
				response =
					results.length < steps.length
						? fauxAssistantMessage(steps[results.length], { stopReason: "toolUse" })
						: fauxAssistantMessage(
								"TOOLS_COMPLETE: " +
									results.map((message) => `${message.toolName}:${message.isError ? "error" : "ok"}`).join(","),
							);
			} else if (text.includes("deny-write")) {
				response =
					results.length === 0
						? fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt", content: "must not exist\n" }), {
								stopReason: "toolUse",
							})
						: fauxAssistantMessage(results[0].isError ? "WRITE_DENIED" : "WRITE_ALLOWED");
			} else {
				response = fauxAssistantMessage(`STREAM_COMPLETE ${model.id}: ${text}`);
			}
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
