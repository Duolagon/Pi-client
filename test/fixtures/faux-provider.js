// This test-only provider emits scripted model output; the actual Pi tools still execute.
import { appendFileSync } from "node:fs";
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
			// Every provider request is recorded, whatever its prompt, for exact call counting.
			if (process.env.PI_DESKTOP_TEST_LLM_LOG)
				appendFileSync(process.env.PI_DESKTOP_TEST_LLM_LOG, `call ${JSON.stringify(text.slice(0, 80))}\n`);
			if (text.includes("slow-stream")) {
				slow.setResponses([fauxAssistantMessage("Cancellable stream ".repeat(500))]);
				return slow.provider.streamSimple(model, context, streamOptions);
			}
			let response;
			if (text.includes("ECHO_SYSTEM_MARKERS")) {
				// Report which markers reached the system prompt (system messages) versus the user message.
				const system = context.messages
					.filter((message) => message.role === "system")
					.map((message) => [typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("\n"), ...Object.values(message.sections ?? {})].join("\n"))
					.join("\n");
				const markers = ["SUBAGENT_SYSTEM_INSTRUCTIONS", "PRELOADED_SKILL_GUIDE", "PRIOR_AGENT_MEMORY"];
				response = fauxAssistantMessage(`ECHO user=${text} system=${markers.filter((marker) => system.includes(marker)).join(",")}`);
			} else if (text.includes("loop-tool-calls")) {
				// Never finishes on its own: every response asks for another tool call, so only a
				// host-enforced turn limit can end the run.
				response = fauxAssistantMessage(fauxToolCall("read", { path: "seed.txt" }), { stopReason: "toolUse" });
			} else if (text === "directory-recovery-probe") {
				if (results.length === 0) {
					response = fauxAssistantMessage(fauxToolCall("read", { path: "." }), { stopReason: "toolUse" });
				} else if (results.length === 1) {
					const text = results[0].content.map((block) => block.text ?? "").join("\n");
					response = text.includes("Use ls with the same path")
						? fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" })
						: fauxAssistantMessage("DIRECTORY_RECOVERY_MISSING");
				} else {
					const listing = results[1].content.map((block) => block.text ?? "").join("\n");
					response = fauxAssistantMessage(!results[1].isError && listing.includes("seed.txt") ? "DIRECTORY_RECOVERY_OK" : "DIRECTORY_RECOVERY_FAILED");
				}
			} else if (text.includes("read-write-bash")) {
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
			} else if (text.includes("launch-managed-shell-fixture")) {
				response = results.length === 0
					? fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30", run_in_background: true }), { stopReason: "toolUse" })
					: fauxAssistantMessage("MANAGED_SHELL_LAUNCHED");
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
