// Local scripted model only. Pi and desktop delegation execute the real tools and subprocesses.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const options = {
	provider: "delegation-test", api: "delegation-test-api",
	models: [{ id: "delegation-test-1", name: "Delegation integration fixture", reasoning: false }],
	tokensPerSecond: 10000,
};
const faux = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 30, tokenSize: { min: 1, max: 1 } });
const slowParent = fauxProvider({ ...options, tokensPerSecond: 30, tokenSize: { min: 1, max: 1 } });
function current(context) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const message = context.messages[index];
	const text = typeof message?.content === "string" ? message.content : message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
	return { text, results: context.messages.slice(index + 1).filter((message) => message.role === "toolResult") };
}
function tool(name, input) { return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }); }
function resultText(result) { return result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""; }
function parsed(result) { try { return JSON.parse(resultText(result)); } catch { return {}; } }
// Agent returns the native text result; its agentId line names the child task.
function agentId(result) { return /agentId: ([A-Za-z0-9._-]+)/.exec(resultText(result))?.[1]; }
// Providers receive the system prompt as leading system messages (content plus named sections).
function systemPrompt(context) {
	const parts = typeof context.systemPrompt === "string" ? [context.systemPrompt] : [];
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		parts.push(typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("\n"));
		for (const section of Object.values(message.sections ?? {})) if (typeof section === "string") parts.push(section);
	}
	return parts.join("\n");
}

export default function delegationFixture(pi) {
	pi.registerProvider(options.provider, {
		api: options.api, apiKey: "isolated-local-scripted-model", baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			const { text, results } = current(context);
			let response;
			if (text.includes("<task-notification>") && text.includes("<task-id>") && text.includes("<status>")) {
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
					slow.setResponses([fauxAssistantMessage("CHILD_SLOW_COMPLETE " + "independent work ".repeat(text.includes("LONG") ? 1000 : text.includes("MEDIUM") ? 40 : 5))]);
					return slow.provider.streamSimple(model, context, streamOptions);
				}
			} else if (text.startsWith("CHILD_PROMPT_PROBE")) {
				// Report where the agent definition landed: the system prompt, not the first user message.
				const system = systemPrompt(context);
				response = fauxAssistantMessage(`CHILD_PROMPT_PROBE_COMPLETE system:${system.includes("PROBE_DEFINITION_BODY") ? "yes" : "no"} builtin:${system.includes("file search specialist") ? "yes" : "no"} user:${text.includes("PROBE_DEFINITION_BODY") ? "yes" : "no"} listing:${system.includes("# Available agent types") ? "yes" : "no"}`);
			} else if (text.startsWith("PARENT_MEMORY_PROBE")) {
				// The agent listing must not displace other prompt sections such as user memory.
				const system = systemPrompt(context);
				response = fauxAssistantMessage(`PARENT_MEMORY_PROBE_COMPLETE listing:${system.includes("# Available agent types") ? "yes" : "no"} memory:${system.includes("USER_MEMORY_MARKER") ? "yes" : "no"} tools:${system.includes("- Agent: Launch a new agent") ? "yes" : "no"}`);
			} else if (text.startsWith("PARENT_MIXED_BATCH")) {
				// A writable Agent and the parent's own write in one message: Pi runs them in parallel.
				const explore = text.includes("EXPLORE");
				response = results.length === 0
					? fauxAssistantMessage([
						fauxToolCall("Agent", explore
							? { description: "Inspect beside a write", prompt: "CHILD_QUICK", subagent_type: "Explore", run_in_background: false }
							: { description: "Shared write beside a write", prompt: "CHILD_IMPLEMENT" }),
						fauxToolCall("write", { path: "parent-output.txt", content: "parent write\n" }),
					], { stopReason: "toolUse" })
					: fauxAssistantMessage("PARENT_MIXED_BATCH_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}:${resultText(item).slice(0, 300)}`).join("\n"));
			} else if (text.startsWith("PARENT_FOREGROUND_SLOW")) {
				// A foreground shared writer (outside Git) that outlasts a short HTTP client timeout.
				response = results.length === 0
					? tool("Agent", { description: "Slow shared foreground work", prompt: "CHILD_SLOW_MEDIUM", run_in_background: false })
					: fauxAssistantMessage("PARENT_FOREGROUND_SLOW_COMPLETE " + results.map((item) => `${item.toolName}:${item.isError ? "error" : "ok"}:${resultText(item).slice(0, 300)}`).join("\n"));
			} else if (text.startsWith("PARENT_LISTING")) {
				const system = systemPrompt(context);
				// The listing is a prompt section: a changed listing arrives as a later section patch.
				const section = system.slice(system.lastIndexOf("# Available agent types"));
				response = fauxAssistantMessage(`PARENT_LISTING_COMPLETE listing:${system.includes("# Available agent types") ? "yes" : "no"} probe:${section.includes("- prober:") ? "yes" : "no"} explore:${section.includes("- Explore:") ? "yes" : "no"}`);
			} else if (text.startsWith("PARENT_PROBE_DEFINITION")) {
				response = results.length === 0
					? tool("Agent", { description: "Probe the definition prompt", prompt: "CHILD_PROMPT_PROBE", subagent_type: "prober", run_in_background: false })
					: fauxAssistantMessage("PARENT_PROBE_DEFINITION_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_PROBE_BUILTIN")) {
				response = results.length === 0
					? tool("Agent", { description: "Probe the builtin prompt", prompt: "CHILD_PROMPT_PROBE", subagent_type: "Explore", run_in_background: false })
					: fauxAssistantMessage("PARENT_PROBE_BUILTIN_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_DEFAULT_BACKGROUND")) {
				// No subagent_type and no run_in_background: a general-purpose child in the background.
				response = results.length === 0
					? tool("Agent", { description: "Default background implementation", prompt: "CHILD_IMPLEMENT" })
					: fauxAssistantMessage("PARENT_DEFAULT_LAUNCHED " + resultText(results[0]));
			} else if (text.startsWith("CHILD_QUICK")) {
				response = fauxAssistantMessage("CHILD_QUICK_COMPLETE quick result");
			} else if (text.startsWith("PARENT_STREAMING_BACKGROUND")) {
				// Launch a fast background child, then keep streaming long enough for it to finish mid-run.
				if (!results.length) response = tool("Agent", { description: "Quick background inspection", prompt: "CHILD_QUICK", subagent_type: "Explore", run_in_background: true });
				else {
					slowParent.setResponses([fauxAssistantMessage("PARENT_STREAMING_DONE " + "streaming ".repeat(200))]);
					return slowParent.provider.streamSimple(model, context, streamOptions);
				}
			} else if (text.startsWith("PARENT_EXPLORE")) {
				response = results.length === 0 ? tool("Agent", { description: "Inspect seed with read-only ceiling", prompt: "CHILD_EXPLORE", subagent_type: "Explore", run_in_background: false }) : fauxAssistantMessage("PARENT_EXPLORE_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_IMPLEMENT")) {
				response = results.length === 0 ? tool("Agent", { description: "Implement an isolated file", prompt: "CHILD_IMPLEMENT", subagent_type: "general-purpose", run_in_background: false }) : fauxAssistantMessage("PARENT_IMPLEMENT_COMPLETE " + resultText(results[0]));
			} else if (text.startsWith("PARENT_BACKGROUND")) {
				const prompt = text.startsWith("PARENT_BACKGROUND_LONG") ? "CHILD_SLOW_LONG" : "CHILD_SLOW";
				response = results.length === 0 ? tool("Agent", { description: "Background seed inspection", prompt, subagent_type: "Explore", run_in_background: true }) : fauxAssistantMessage("BACKGROUND_LAUNCHED " + resultText(results[0]));
			} else if (text.startsWith("PARENT_CANCEL_TOOL")) {
				if (!results.length) response = tool("Agent", { description: "Cancellable seed inspection", prompt: "CHILD_SLOW_LONG", subagent_type: "Explore", run_in_background: true });
				else if (results.length === 1) response = tool("TaskStop", { task_id: agentId(results[0]) });
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
