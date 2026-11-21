/** Shared types for the PreviewCheck model tool and Electron headless verification. */

export type PreviewInteraction =
	| { type: "click"; selector: string }
	| { type: "fill"; selector: string; value: string }
	| { type: "wait"; ms: number }
	| { type: "wait_for"; selector: string; timeoutMs?: number }
	| { type: "scroll"; y?: number; selector?: string };

export interface PreviewInspectInput {
	url: string;
	mobile?: boolean;
	actions?: PreviewInteraction[];
	selector?: string;
	readDom?: boolean;
	screenshot?: boolean;
	screenshotDir?: string;
}

export interface PreviewInteractiveElement {
	tag: string;
	text: string;
	selector: string;
	type?: string;
	disabled?: boolean;
}

export interface PreviewInspectResult {
	url: string;
	title: string;
	status: number;
	elapsedMs: number;
	errors: string[];
	actionLog: string[];
	domText?: string;
	domHtml?: string;
	interactiveElements?: PreviewInteractiveElement[];
	screenshotPath?: string;
	screenshotBase64?: string;
}

export function formatPreviewInspectSummary(result: PreviewInspectResult): string {
	const lines: string[] = [
		`[PreviewCheck] ${result.url}`,
		`标题：${result.title || "(无标题)"} · HTTP ${result.status || "未知"} · 耗时 ${result.elapsedMs}ms`,
	];
	if (result.actionLog.length) {
		lines.push("", "执行动作：", ...result.actionLog.map((step) => `- ${step}`));
	}
	if (result.errors.length) {
		lines.push("", `控制台/网络错误 (${result.errors.length})：`, ...result.errors.map((err) => `- ${err}`));
	} else {
		lines.push("控制台/网络错误：无");
	}
	if (result.screenshotPath) {
		lines.push(`截图已保存：${result.screenshotPath}`);
	}
	if (result.interactiveElements?.length) {
		lines.push(
			"",
			`可交互元素（前 ${result.interactiveElements.length} 个）：`,
			...result.interactiveElements.map(
				(el) => `- <${el.tag}${el.type ? ` type="${el.type}"` : ""}${el.disabled ? " disabled" : ""}> ${el.selector}${el.text ? ` · "${el.text}"` : ""}`,
			),
		);
	}
	if (result.domText) {
		lines.push("", "页面文本摘要：", result.domText);
	}
	if (result.domHtml) {
		lines.push("", "选中节点 HTML：", result.domHtml);
	}
	return lines.join("\n").trim();
}
