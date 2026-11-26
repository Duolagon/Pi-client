export const toolRoundOutputBytes = 24 * 1024;
export const modelOutputPageBytes = 8 * 1024;
export const toolOutputIdPattern = /^[a-f0-9]{32}$/;
export const toolOutputOwnerPattern = /^[A-Za-z0-9_-]{1,128}$/;

export interface ToolOutputReference {
	id: string;
	conversationId: string;
	bytes: number;
	partial: boolean;
}

export interface ToolOutputPage {
	text: string;
	nextOffset: number | null;
}

export function toolOutputReference(details: unknown): ToolOutputReference | undefined {
	const reference = (details as { desktopToolOutput?: Partial<ToolOutputReference> } | undefined)?.desktopToolOutput;
	if (!reference || typeof reference.id !== "string" || !toolOutputIdPattern.test(reference.id) ||
		typeof reference.conversationId !== "string" || !toolOutputOwnerPattern.test(reference.conversationId) ||
		typeof reference.bytes !== "number" || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 ||
		typeof reference.partial !== "boolean") return undefined;
	return { id: reference.id, conversationId: reference.conversationId, bytes: reference.bytes, partial: reference.partial };
}
