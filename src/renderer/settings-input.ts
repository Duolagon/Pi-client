/**
 * Parse the "前台子 Agent 最长等待（分钟）" field. Returns undefined for anything that is not
 * a whole number of minutes in 0–1440. An empty field is invalid: `Number("")` is 0, which
 * would silently mean "wait without limit".
 */
export function parseForegroundMinutes(value: string): number | undefined {
	const text = value.trim();
	if (!/^\d+$/.test(text)) return undefined;
	const minutes = Number(text);
	return Number.isSafeInteger(minutes) && minutes <= 1440 ? minutes : undefined;
}
