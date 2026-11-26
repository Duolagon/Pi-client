// A local, deterministic provider that checks what arrived at the model boundary.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const provider = "engine-check";
const api = "engine-check-api";
const faux = fauxProvider({
	provider, api, models: [{ id: "engine-check-1", name: "本地链路验证模型" }], tokensPerSecond: 4000,
});
const alpha = "packages/alpha/feature.mjs";
const beta = "packages/beta/feature.mjs";
const alphaTest = "node --test packages/alpha/feature.test.mjs";
const betaTest = "node --test packages/beta/feature.test.mjs";
const textOf = (content) => typeof content === "string" ? content : content?.map((block) => block.text ?? "").join("\n") ?? "";
const tools = (...calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const write = (path, value) => fauxToolCall("write", { path, content: `export const value = "${value}";\n` });

function nextResponse(results) {
	switch (results.length) {
		case 0: return tools(write(alpha, "unreviewed"));
		case 1:
			if (!results[0].isError || !textOf(results[0].content).includes("E2E_ALPHA_RULE"))
				return fauxAssistantMessage("链路失败：首次写入未带回 Alpha 规则。");
			return tools(write(alpha, "ALPHA"));
		case 2:
			if (results[1].isError) return fauxAssistantMessage("链路失败：阅读规则后无法写入 Alpha。");
			return tools(fauxToolCall("read", { path: beta }));
		case 3:
			if (results[2].isError || !textOf(results[2].content).includes("E2E_BETA_RULE"))
				return fauxAssistantMessage("链路失败：读取 Beta 未带回路径规则。");
			return tools(fauxToolCall("bash", { command: alphaTest }), fauxToolCall("bash", { command: betaTest }));
		case 5: {
			const betaResult = results[4];
			const preview = textOf(betaResult.content);
			const id = /Tool output archived: ([a-f0-9]{32})\./.exec(preview)?.[1];
			if (results[3].isError || !betaResult.isError || !id || preview.includes("BETA_LOG_MIDDLE"))
				return fauxAssistantMessage("链路失败：两条测试的长输出未产生可回读的短预览。");
			return tools(fauxToolCall("ReadToolOutput", { id, offset: 6000, limit: 4000 }));
		}
		case 6:
			if (results[5].isError || !textOf(results[5].content).includes("BETA_LOG_MIDDLE"))
				return fauxAssistantMessage("链路失败：没有从归档取回 Beta 诊断。");
			return tools(write(beta, "BETA"));
		case 7:
			if (results[6].isError) return fauxAssistantMessage("链路失败：修复 Beta 时写入失败。");
			return tools(fauxToolCall("bash", { command: betaTest }));
		case 8:
			return fauxAssistantMessage(results[7].isError ? "链路失败：修复后测试失败。" : "两个子目录已修复，已从完整日志找回 Beta 诊断，可以复核。");
		default: return fauxAssistantMessage("链路失败：工具调用数不符。");
	}
}

export default function engineEnhancementsProvider(pi) {
	pi.registerProvider(provider, {
		api, apiKey: "offline-test-unused", baseUrl: "http://127.0.0.1:0", models: faux.models,
		streamSimple(model, context, options) {
			const userIndex = context.messages.findLastIndex((message) => message.role === "user");
			const results = context.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
			faux.setResponses([nextResponse(results)]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
}
