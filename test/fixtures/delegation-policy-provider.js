// Isolated scripted model. The host, Pi child processes, policy hooks, and file tools are real.
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const options = {
	provider: "policy-delegation-test", api: "policy-delegation-test-api",
	models: [{ id: "policy-delegation-1", name: "Policy delegation fixture", reasoning: false }],
	tokensPerSecond: 10000,
};
const faux = fauxProvider(options);
function current(context) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const message = context.messages[index];
	const text = typeof message?.content === "string" ? message.content : message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
	return { text, results: context.messages.slice(index + 1).filter((message) => message.role === "toolResult") };
}
function tool(name, input) { return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }); }
function resultText(result) { return result?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? ""; }

export default function delegationPolicyProvider(pi) {
	pi.registerTool({
		name: "policy_pause", label: "Test synchronization gate", description: "Wait for the isolated permission regression test to release a gate.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute(_id, _input, signal) {
			const file = process.env.PI_POLICY_TEST_GATE;
			if (!file) throw new Error("Missing isolated test gate");
			await writeFile(`${file}.entered`, "entered");
			const started = Date.now();
			while (!(await access(file).then(() => true, () => false))) {
				if (Date.now() - started > 15000) throw new Error("Policy test gate timed out");
				await delay(20, undefined, { signal });
			}
			return { content: [{ type: "text", text: "gate released" }] };
		},
	});
	pi.registerProvider(options.provider, {
		api: options.api, apiKey: "local-scripted-fixture", baseUrl: "http://127.0.0.1:0", models: faux.models,
		streamSimple(model, context, streamOptions) {
			const { text, results } = current(context);
			let response;
			if (text.startsWith("POLICY_PARENT")) {
				response = results.length === 0
					? tool("Agent", { description: "Verify child policy inheritance", prompt: text.includes("LIVE") ? "POLICY_CHILD_LIVE" : "POLICY_CHILD_INITIAL", subagent_type: "general-purpose", run_in_background: false })
					: fauxAssistantMessage("POLICY_PARENT_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("POLICY_CHILD")) {
				const steps = [
					...(text.includes("LIVE") ? [["policy_pause", {}]] : []),
					["read", { path: "seed.txt" }],
					["write", { path: "allowed.txt", content: "child policy still permits this write\n" }],
					["write", { path: "denied.txt", content: "must not exist" }],
					["bash", { command: "printf forbidden > forbidden-shell.txt" }],
				];
				response = results.length < steps.length
					? tool(...steps[results.length])
					: fauxAssistantMessage("POLICY_CHILD_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}`).join(","));
			} else response = fauxAssistantMessage("UNEXPECTED_POLICY_PROMPT " + text);
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
