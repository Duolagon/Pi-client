// Scripted local model for real desktop interaction tests and README captures.
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const options = {
	provider: "desktop-demo",
	api: "desktop-demo-api",
	models: [
		{ id: "desktop-demo-1", name: "本地演示模型", reasoning: true, input: ["text", "image"] },
		{ id: "desktop-demo-2", name: "本地演示模型 · 备用", reasoning: true, input: ["text", "image"] },
	],
	tokensPerSecond: 1200,
};
const fast = fauxProvider(options);
const slow = fauxProvider({ ...options, tokensPerSecond: 30, tokenSize: { min: 1, max: 1 } });

export default function uiProvider(pi) {
	pi.registerCommand("demo-note", {
		description: "将验证步骤放入输入框",
		handler: async (_args, ctx) => ctx.ui.setEditorText("请继续完善测试。"),
	});
	pi.registerProvider(options.provider, {
		api: options.api,
		apiKey: "local-demo-unused",
		baseUrl: "http://127.0.0.1:0",
		models: fast.models,
		streamSimple(model, context, streamOptions) {
			const index = context.messages.findLastIndex((message) => message.role === "user");
			const user = context.messages[index];
			const prompt = typeof user?.content === "string" ? user.content : (user?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "");
			const results = context.messages.slice(index + 1).filter((message) => message.role === "toolResult");
			if (prompt.includes("停止生成验证")) {
				slow.setResponses([fauxAssistantMessage("流式恢复验证：" + "正在检查项目结构与测试结果。".repeat(500))]);
				return slow.provider.streamSimple(model, context, streamOptions);
			}
			let response;
			if (prompt.includes("模型上下文验证")) {
				const system = [context.systemPrompt, ...context.messages.filter((message) => message.role === "system")
					.flatMap((message) => [message.content, ...Object.values(message.sections ?? {})])].join("\n");
				response = fauxAssistantMessage(["PI_PRIVATE_MEMORY_FIXTURE", "PI_RULE_FIXTURE", "PI_REFERENCE_FIXTURE"].every((marker) => system.includes(marker))
					? "收到项目记忆、规则和文件引用。"
					: "项目上下文缺失。");
			} else if (prompt.includes("实现问候函数")) {
				const steps = [
					fauxAssistantMessage([
						fauxThinking("先读取现有函数，再补全实现，最后运行项目测试。"),
						fauxToolCall("read", { path: "src/greeting.mjs" }),
					], { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("write", { path: "src/greeting.mjs", content: 'export function greet(name) {\n  return `你好，${name}！`;\n}\n' }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("bash", { command: "node --test test/greeting.test.mjs" }), { stopReason: "toolUse" }),
				];
				response = results.length < steps.length ? steps[results.length] : fauxAssistantMessage(results.some((result) => result.isError)
					? "本地演示验证失败，请检查工具输出。"
					: "已完成问候函数，并通过项目测试。\n\n- 补全 `greet(name)`，返回中文问候语。\n- 使用真实文件工具更新 `src/greeting.mjs`。\n- 运行 `node --test`，测试全部通过。\n\n可以在右侧审核代码差异，再继续下一步。\n\n```js\ngreet(\"Pi\"); // 你好，Pi！\n```");
			} else if (prompt === "提交本地演示计划") {
				response = results.length ? fauxAssistantMessage("本地演示计划已提交。")
					: fauxAssistantMessage(fauxToolCall("ExitPlanMode", { title: "E2E Plan", plan: "1. Review the implementation." }), { stopReason: "toolUse" });
			} else if (prompt === "为啥要排队，现在在跑什么") {
				const commands = [
					".venv/bin/kaggle kernels status research/demo",
					"KAGGLE_FIXTURE=1; .venv/bin/kaggle kernels delete -k research/demo; .venv/bin/kaggle kernels delete -k research/demo-other",
					"test -d . && .venv/bin/kaggle kernels push -p notebook",
				];
				response = results.length < commands.length
					? fauxAssistantMessage(fauxToolCall("bash", { command: commands[results.length] }), { stopReason: "toolUse" })
					: fauxAssistantMessage("演示队列状态查询结束。");
			} else if (prompt === "请删除演示云端作业") {
				response = results.length ? fauxAssistantMessage("演示远端操作结束。")
					: fauxAssistantMessage(fauxToolCall("bash", { command: ".venv/bin/kaggle kernels delete -k research/demo" }), { stopReason: "toolUse" });
			} else if (prompt === "登记旧的本机后台命令" || prompt === "登记本轮本机后台命令") {
				const previous = prompt === "登记旧的本机后台命令";
				const description = previous ? "演示旧轮后台命令" : "演示本轮后台命令";
				const path = previous ? "previous-shell.pid" : "current-shell.pid";
				response = results.length ? fauxAssistantMessage(`${description}已登记。`)
					: fauxAssistantMessage(fauxToolCall("bash", {
							command: `printf '%s\\n' $$ > ${path}; exec /bin/sleep 120`, description, run_in_background: true, timeout: 120,
						}), { stopReason: "toolUse" });
			} else if (prompt === "验证后台检查的退出结果") {
				const steps = [
					fauxToolCall("write", { path: "background-checked.txt", content: "example change\n" }),
					fauxToolCall("bash", { command: "node --test test/background-check.test.mjs", run_in_background: true, timeout: 30 }),
				];
				response = results.length < steps.length ? fauxAssistantMessage(steps[results.length], { stopReason: "toolUse" })
					: fauxAssistantMessage("后台检查已登记，等待退出结果。");
			} else if (prompt.includes("审批拒绝验证")) {
				response = results.length ? fauxAssistantMessage(results[0].isError ? "写入已按你的选择取消。" : "写入已执行。")
					: fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt", content: "should be denied\n" }), { stopReason: "toolUse" });
			} else if (prompt.includes("子Agent审批面板验证")) {
				response = results.length
					? fauxAssistantMessage("已派发后台子 Agent 并准备处理结果。")
					: fauxAssistantMessage(
							fauxToolCall("Agent", {
								description: "E2E 子审批",
								prompt: "审批拒绝验证",
								subagent_type: "general-purpose",
								run_in_background: true,
							}),
							{ stopReason: "toolUse" },
						);
			} else {
				response = fauxAssistantMessage("已收到补充指令，客户端与 Pi 引擎连接正常。");
			}
			fast.setResponses([response]);
			return fast.provider.streamSimple(model, context, streamOptions);
		},
	});
}
