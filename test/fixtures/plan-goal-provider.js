import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";

const options = {
	provider: "desktop-test",
	api: "desktop-plan-goal-test",
	models: [{ id: "desktop-test-1", name: "Local plan and goal test model" }],
	tokensPerSecond: 10000,
};
const faux = fauxProvider(options);
const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

export default function planGoalFixture(pi) {
	pi.on("before_agent_start", (event, ctx) => {
		if (event.prompt === "GOAL_HISTORY_FIXTURE") {
			ctx.sessionManager.appendUsage("fixture-history", options.provider, "desktop-test-1", {
				input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
				cost: { input: 0, output: 1.5, cacheRead: 0, cacheWrite: 0, total: 1.5 },
			});
		}
	});
	pi.registerProvider(options.provider, {
		api: options.api,
		apiKey: "isolated-local-fixture",
		baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			const index = context.messages.findLastIndex((message) => message.role === "user");
			const source = context.messages[index]?.content;
			const text = typeof source === "string" ? source : (source ?? []).map((block) => block.text ?? "").join("\n");
			const results = context.messages.slice(index + 1).filter((message) => message.role === "toolResult");
			const hasChildResult = context.messages.some((message) => {
				const content = typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("\n");
				return content.includes("<task-notification>") && content.includes("GOAL_CHILD_RESULT");
			});
			let response;
			if (text.startsWith("WORKSPACE_CONTEXT_FIRST")) {
				const system = [context.systemPrompt, ...context.messages.filter((message) => message.role === "system")
					.flatMap((message) => [message.content, ...Object.values(message.sections ?? {})])].join("\n");
				response = fauxAssistantMessage(system.includes("LARGE_DESKTOP_INSTRUCTION_START") &&
					!system.includes("LARGE_DESKTOP_INSTRUCTION_END") && !system.includes("FROZEN_FILE_CONTENT") &&
					!system.includes("PATH_SCOPED_CONTEXT") && text.includes("FROZEN_FILE_CONTENT") &&
					text.includes("PATH_SCOPED_CONTEXT") && !text.includes("DENIED_FILE_CONTENT")
					? "WORKSPACE_CONTEXT_READY" : "WORKSPACE_CONTEXT_MISSING");
			} else if (text === "WORKSPACE_CONTEXT_NEXT") {
				const remembered = context.messages.some((message) => message.role === "user" &&
					(typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n")).includes("FROZEN_FILE_CONTENT"));
				response = fauxAssistantMessage(remembered ? "WORKSPACE_CONTEXT_PRESERVED" : "WORKSPACE_CONTEXT_LOST");
			} else if (text === "PLAN_FILE_FIXTURE") {
				const description = getCurrentTools(context.messages).find((item) => item.name === "ExitPlanMode")?.description;
				const planPath = description?.match(/`(\.pi\/plans\/[a-zA-Z0-9._-]+\.md)`/)?.[1];
				const steps = [
					["ExitPlanMode", {}],
					["write", { path: planPath, content: "# Checked plan\n\n1. Verify the file." }],
					["ExitPlanMode", {}],
				];
				response = results.length < steps.length ? tool(...steps[results.length]) : fauxAssistantMessage("PLAN_FIXTURE_COMPLETE");
			} else if (text === "GOAL_HISTORY_FIXTURE") {
				response = fauxAssistantMessage("Earlier output.");
			} else if (text === "GOAL_CHILD_GATED") {
				response = async (_context, opts) => {
					const end = Date.now() + 12000;
					while (!existsSync(process.env.PI_TEST_GOAL_CHILD_GATE) && Date.now() < end && !opts?.signal?.aborted)
						await wait(30);
					return fauxAssistantMessage("GOAL_CHILD_RESULT");
				};
			} else if (hasChildResult) {
				response = fauxAssistantMessage("GOAL_READY\n<goal-achieved/>");
			} else if (text.includes("GOAL_WITH_CHILD") && text.includes("[目标模式已启动")) {
				response = results.length
					? fauxAssistantMessage("Awaiting the child, so I will not output <goal-achieved/> yet.")
					: tool("Agent", {
						description: "Gate an isolated background child",
						prompt: "GOAL_CHILD_GATED",
						subagent_type: "Explore",
						run_in_background: true,
					});
			} else {
				response = fauxAssistantMessage("GOAL_EMPTY_CONTINUATION");
			}
			faux.setResponses([response]);
			return faux.provider.streamSimple(model, context, streamOptions);
		},
	});
}
