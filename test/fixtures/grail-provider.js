// Test-only reviewer model for Grail judgements: canned JSON, no network.
// GRAIL_TEST_CONTROL names a file whose content picks the comparison outcome;
// GRAIL_TEST_LOG receives one JSON line per request (step, cwd, prompt).
import { appendFileSync, readFileSync } from "node:fs";
import { calculateCost, createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const options = {
	provider: "grail-test",
	api: "grail-test-api",
	models: [
		{ id: "grail-judge-1", name: "本地鉴定模型", reasoning: false, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
		{ id: "grail-unpriced", name: "未设置价格的本地鉴定模型", reasoning: false },
	],
	tokensPerSecond: 4000,
};
const faux = fauxProvider(options);
const criteria = ["requirement", "broken", "cut", "hardSpots", "edge", "removable", "missing", "flawless", "beyond", "lessCode"];

function promptText(context) {
	const message = context.messages.findLast((item) => item.role === "user");
	return typeof message?.content === "string" ? message.content : (message?.content ?? []).map((block) => block.text ?? "").join("\n");
}

function addedCitations(prompt) {
	const citations = new Map();
	let file;
	for (const line of prompt.split("\n")) {
		const header = /^### (.+)$/.exec(line);
		if (header) file = header[1];
		const added = /^\+ (\d+) \| /.exec(line);
		if (file && added && !citations.has(file)) citations.set(file, { file, side: "+", line: Number(added[1]) });
	}
	return [...citations.values()];
}

export default function grailProvider(pi) {
	pi.registerProvider(options.provider, {
		api: options.api,
		apiKey: "local-grail-unused",
		baseUrl: "http://127.0.0.1:0",
		models: faux.models,
		streamSimple(model, context, streamOptions) {
			const prompt = promptText(context);
			const step = prompt.startsWith("【圣杯盲解】") ? "blind" : prompt.startsWith("【圣杯对照】") ? "comparison" : "other";
			if (process.env.GRAIL_TEST_LOG) appendFileSync(process.env.GRAIL_TEST_LOG, JSON.stringify({ step, cwd: process.cwd(), prompt }) + "\n");
			let mode = "grail";
			try {
				mode = readFileSync(process.env.GRAIL_TEST_CONTROL, "utf8").trim();
			} catch {}
			const engineCheck = prompt.includes("修复 Alpha 和 Beta 两个模块的导出值");
			let text = "{}";
			if (step === "blind")
				text = JSON.stringify(engineCheck ? {
					rootCause: "两个模块都还在导出占位值。",
					cutPoint: "只修改两个模块各自的导出。",
					files: ["packages/alpha/feature.mjs", "packages/beta/feature.mjs"],
					sizeEstimate: "各改一行",
					hardSpots: ["在各自目录确认规则"],
					tests: ["分别运行 Alpha 和 Beta 的测试"],
				} : { rootCause: "缺少 add", cutPoint: "src/add.mjs", files: ["src/add.mjs"], sizeEstimate: "3 行", hardSpots: ["负数"], tests: ["add 测试"] });
			if (step === "comparison") {
				const citations = addedCitations(prompt).slice(0, engineCheck ? 2 : 1);
				text = "```json\n" + JSON.stringify({
					findings: criteria.map((criterion) => ({
						criterion,
						pass: !(mode === "granted" && criterion === "lessCode"),
						note: criterion === "lessCode" && mode === "granted" ? "可以直接返回表达式，少写两行。" : "符合",
						citations,
					})).concat([{ criterion: "edge", pass: false, note: "没有引用，应被丢弃", citations: [] }]),
				}) + "\n```";
			}
			faux.setResponses([fauxAssistantMessage(text)]);
			const source = faux.provider.streamSimple(model, context, streamOptions);
			const stream = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done" && mode !== "zero-cost") calculateCost(model, event.message.usage);
					stream.push(event);
				}
				stream.end(await source.result());
			})();
			return stream;
		},
	});
}
