// Local scripted model only. Pi and desktop delegation execute the real tools and subprocesses.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const options = {
	provider: "delegation-test", api: "delegation-test-api",
	models: [{ id: "delegation-test-1", name: "Delegation integration fixture", reasoning: false }],
	tokensPerSecond: 10000,
};
const faux = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 30, tokenSize: { min: 1, max: 1 } });
function current(context) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const message = context.messages[index];
	const text = typeof message?.content === "string" ? message.content : message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
	return { text, results: context.messages.slice(index + 1).filter((message) => message.role === "toolResult") };
}
function tool(name, input) { return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }); }
function resultText(result) { return result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""; }
function parsed(result) { try { return JSON.parse(resultText(result)); } catch { return {}; } }

export default function delegationFixture(pi) {
	pi.registerProvider(options.provider, {
		api: options.api, apiKey: "isolated-local-scripted-model", baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			const { text, results } = current(context);
			let response;
			if (text.includes('"parent_tool_call_id"') && text.includes('"task_id"') && text.includes('"status"')) {
				response = fauxAssistantMessage("BACKGROUND_HANDBACK_COMPLETE " + text);
			} else if (text.startsWith("CHILD_EXPLORE")) {
				const steps = [
					["read", { path: "seed.txt" }],
					["write", { path: "child-forbidden.txt", content: "must not exist" }],
					["bash", { command: "printf forbidden > child-command-forbidden.txt" }],
					["Agent", { description: "forbidden recursion", prompt: "CHILD_EXPLORE", subagent_type: "Explore" }],
				];
				response = results.length < steps.length ? tool(...steps[results.length]) : fauxAssistantMessage("CHILD_EXPLORE_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}`).join(","));
			} else if (text.startsWith("CHILD_IMPLEMENT")) {
				response = results.length === 0 ? tool("write", { path: "child-output.txt", content: "real child worktree write\n" }) : fauxAssistantMessage("CHILD_IMPLEMENT_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}`).join(","));
			} else if (text.startsWith("CHILD_SLOW")) {
				if (!results.length) response = tool("read", { path: "seed.txt" });
				else {
					slow.setResponses([fauxAssistantMessage("CHILD_SLOW_COMPLETE " + "independent work ".repeat(text.includes("LONG") ? 1000 : 5))]);
					return slow.provider.streamSimple(model, context, streamOptions);
				}
			} else if (text.startsWith("PARENT_EXPLORE")) {
				response = results.length === 0 ? tool("Agent", { description: "Inspect seed with read-only ceiling", prompt: "CHILD_EXPLORE", subagent_type: "Explore" }) : fauxAssistantMessage("PARENT_EXPLORE_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_IMPLEMENT")) {
				response = results.length === 0 ? tool("Agent", { description: "Implement an isolated file", prompt: "CHILD_IMPLEMENT", subagent_type: "general-purpose" }) : fauxAssistantMessage("PARENT_IMPLEMENT_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_BACKGROUND")) {
				response = results.length === 0 ? tool("Agent", { description: "Background seed inspection", prompt: "CHILD_SLOW", subagent_type: "Explore", run_in_background: true }) : fauxAssistantMessage("BACKGROUND_LAUNCHED " + resultText(results[0]));
			} else if (text.startsWith("PARENT_CANCEL_TOOL")) {
				if (!results.length) response = tool("Agent", { description: "Cancellable seed inspection", prompt: "CHILD_SLOW_LONG", subagent_type: "Explore", run_in_background: true });
				else if (results.length === 1) response = tool("TaskStop", { task_id: parsed(results[0]).task_id });
				else response = fauxAssistantMessage("PARENT_CANCEL_COMPLETE " + resultText(results[1]));
			} else if (text.startsWith("PARENT_FOREIGN ")) {
				response = results.length === 0 ? tool("TaskOutput", { task_id: text.split(" ")[1] }) : fauxAssistantMessage("FOREIGN_RESULT " + (results[0].isError ? "DENIED " : "ALLOWED ") + resultText(results[0]));
			} else if (text.startsWith("PARENT_WORKTREE_CHILD")) {
				if (!results.length) response = tool("Agent", { description: "Keep read-only worker active", prompt: "CHILD_SLOW_LONG", subagent_type: "Explore", run_in_background: true });
				else if (results.length === 1) response = tool("WorktreeCreate", {});
				else if (results.length === 2) response = tool("WorktreeMerge", { worktree_id: parsed(results[1]).id });
				else if (results.length === 3) response = tool("WorktreeRemove", { worktree_id: parsed(results[1]).id });
				else response = fauxAssistantMessage("WORKTREE_CHILD_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}:` + resultText(item)).join("\n"));
			} else if (text.startsWith("PARENT_WORKTREE")) {
				if (!results.length) response = tool("WorktreeCreate", {});
				else if (results.length === 1) response = tool("WorktreeMerge", { worktree_id: parsed(results[0]).id });
				else if (results.length === 2) response = tool("WorktreeRemove", { worktree_id: parsed(results[0]).id });
				else response = fauxAssistantMessage("WORKTREE_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}:` + resultText(item)).join("\n"));
			} else if (text.startsWith("PROBE_WRITE")) {
				response = results.length === 0 ? tool("write", { path: "denied.txt", content: "must not exist" }) : fauxAssistantMessage(results[0].isError ? "PROBE_WRITE_DENIED" : "PROBE_WRITE_ALLOWED");
			} else if (text.startsWith("PROBE_BASH")) {
				response = results.length === 0 ? tool("bash", { command: "printf actual-command > bash-probe.txt" }) : fauxAssistantMessage(results[0].isError ? "PROBE_BASH_DENIED" : "PROBE_BASH_ALLOWED");
			} else response = fauxAssistantMessage("UNEXPECTED_PROMPT " + text);
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
