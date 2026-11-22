import type { GrailCitation, GrailGrade, GrailState, GrailStep, GrailVerdict } from "../shared.ts";

/** Copy for the user-initiated judgement. The Grail theme uses 圣杯/愿望 wording; light and dark stay neutral. */
export interface GrailWording {
	start: string;
	running: string;
	seal: string;
	report: string;
	grades: Record<GrailGrade, string>;
	steps: Record<GrailStep, string>;
}

const STEPS: Record<GrailStep, string> = {
	diff: "读取改动",
	objective: "客观检查（测试、类型检查、lint）",
	distortion: "扭曲扫描",
	blind: "盲解",
	comparison: "对照评审",
};

export function grailWording(grailTheme: boolean): GrailWording {
	if (grailTheme)
		return {
			start: "请圣杯鉴定",
			running: "圣杯鉴定中",
			seal: "封存愿望",
			report: "圣杯鉴定报告",
			grades: { grail: "圣杯显灵", granted: "愿望达成", twisted: "愿望扭曲", unfulfilled: "愿未达成", unjudgeable: "无法鉴定" },
			steps: STEPS,
		};
	return {
		start: "质量鉴定",
		running: "质量鉴定中",
		seal: "封存需求",
		report: "质量鉴定报告",
		grades: { grail: "优秀", granted: "达成", twisted: "有问题", unfulfilled: "未达成", unjudgeable: "无法鉴定" },
		steps: { ...STEPS, distortion: "作弊痕迹扫描" },
	};
}

/** Status tone of a grade, mapped to theme colour variables in CSS. */
export function gradeTone(grade: GrailGrade): "gold" | "green" | "amber" | "red" | "muted" {
	if (grade === "grail") return "gold";
	if (grade === "granted") return "green";
	if (grade === "twisted") return "amber";
	if (grade === "unfulfilled") return "red";
	return "muted";
}

export function latestVerdict(state: GrailState | null | undefined): GrailVerdict | undefined {
	return state?.verdicts.at(-1);
}

/** "上次：愿望达成；这次：圣杯显灵", or undefined for the first verdict of a wish. */
export function comparisonText(verdict: GrailVerdict, wording: GrailWording): string | undefined {
	if (!verdict.previousGrade) return undefined;
	return `上次：${wording.grades[verdict.previousGrade]}；这次：${wording.grades[verdict.grade]}`;
}

/** The better approach the reviewer named: the note of a failed "lessCode" conclusion. */
export function betterApproach(verdict: GrailVerdict): string | undefined {
	const finding = verdict.steps.comparison?.findings.find((item) => item.criterion === "lessCode" && !item.pass);
	return finding?.note.trim() || undefined;
}

export function citationText(citation: GrailCitation): string {
	return `${citation.file}:${citation.side === "-" ? "-" : "+"}${citation.line}`;
}

/**
 * Whether a fresh verdict plays the reveal now. Only a 圣杯显灵 verdict of the active
 * conversation plays; a hidden or unfocused window defers it until the user returns.
 * Reduced motion never plays it (the persistent badge is the static result).
 */
export function revealDecision(input: {
	grade: GrailGrade;
	verdictConversation: string;
	activeConversation: string | undefined;
	visible: boolean;
	reducedMotion: boolean;
}): "play" | "defer" | "skip" {
	if (input.grade !== "grail" || input.reducedMotion) return "skip";
	if (input.verdictConversation !== input.activeConversation) return "skip";
	return input.visible ? "play" : "defer";
}

export function formatCost(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
