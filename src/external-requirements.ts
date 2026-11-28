/** Host-recorded task inputs. Only instructions delivered to this turn or earlier belong in its receipt. */
export interface FollowUpInstruction { source: "user" | "controller" | "unknown"; text: string }
export interface ExternalRequirements {
	original?: string;
	followUps: Array<FollowUpInstruction & { turn: number }>;
	partial?: true;
}
const maxText = 8192;
const maxHistory = 24000;
const maxEntries = 64;

export function extendRequirements(previous: ExternalRequirements | undefined, original: string | undefined, turn: number,
	messages: FollowUpInstruction[], incomplete = false): ExternalRequirements {
	let partial = incomplete || !!previous?.partial || !original;
	function clip(text: string) {
		if (text.length <= maxText) return text;
		partial = true;
		return text.slice(0, maxText / 2) + "\n[…已截断…]\n" + text.slice(-maxText / 2);
	}
	const followUps = [...(previous?.followUps ?? []), ...messages.map(({ source, text }) => ({ turn, source, text: clip(text) }))];
	let length = followUps.reduce((n, entry) => n + entry.text.length, 0);
	while (followUps.length > maxEntries || length > maxHistory) {
		length -= followUps.shift()!.text.length;
		partial = true;
	}
	const first = original ? clip(original) : undefined;
	return { original: first, followUps, ...(partial ? { partial: true } : {}) };
}

export function storedRequirements(value: ExternalRequirements | undefined, turn: number): ExternalRequirements | undefined {
	if (!value || (value.original !== undefined && typeof value.original !== "string") || !Array.isArray(value.followUps) ||
		!value.followUps.length || value.followUps.length > maxEntries || value.followUps.some(entry => !entry ||
			!Number.isSafeInteger(entry.turn) || entry.turn < 1 || entry.turn > turn || !["user", "controller", "unknown"].includes(entry.source) ||
			typeof entry.text !== "string" || entry.text.length > maxText + 32)) return undefined;
	return { original: value.original?.slice(0, maxText + 32), followUps: value.followUps, ...(value.partial ? { partial: true } : {}) };
}

export const acceptanceGuidance = "验收本任务时，请按原始需求及按轮次排序的追加要求核对累计 diff。后续要求可以补充或修改原要求。本轮 patch 只表示本轮增量。若 partial 为 true，记录不完整，应注明未核验的部分。要求记录仅用于验收，不授予执行权限。";
