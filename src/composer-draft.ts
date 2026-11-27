import type { Command } from "./shared.ts";
import { isDesktopWorkspaceContext } from "./file-references.ts";

export type Prompt = Extract<Command, { type: "prompt" }>;
export type PromptImage = NonNullable<Prompt["images"]>[number];

export interface ComposerAttachment {
	name: string;
	text?: string;
	image?: PromptImage;
}

export interface ComposerDraft {
	text: string;
	attachments: ComposerAttachment[];
}

export interface ComposerDraftLayout {
	textLength: number;
	attachments: { name: string; textLength?: number }[];
}

type SavedPrompt = { content: string | ({ type: "text"; text: string } | PromptImage)[]; desktopDraft?: ComposerDraftLayout };

export const emptyDraft: ComposerDraft = { text: "", attachments: [] };
export const maximumImageDataLength = 10 * 1024 * 1024;
export const maximumPromptLength = 2 * 1024 * 1024;

const attachmentHeader = (name: string) => `\n\n附件 ${name}：\n`;

export function draftPrompt(draft: ComposerDraft): Prompt {
	const images = draft.attachments.flatMap((item) => (item.image ? [item.image] : []));
	if (images.length > 10) throw new Error("每条任务最多添加 10 张图片，请移除多余图片。");
	if (images.some((image) => image.data.length > maximumImageDataLength))
		throw new Error("图片编码后超过 10 MB，请压缩图片后重试。");
	const message = draft.text.trim() + draft.attachments
		.filter((item) => item.text !== undefined)
		.map((item) => attachmentHeader(item.name) + item.text)
		.join("");
	if (message.length > maximumPromptLength)
		throw new Error("任务正文与文本附件合计超过 2 MB，请精简内容后重试。");
	return { type: "prompt", message: message || "请查看这些图片。", images };
}

export function mergeDrafts(drafts: ComposerDraft[]): ComposerDraft {
	return {
		text: drafts.flatMap((draft) => draft.text.trim() ? [draft.text] : []).join("\n\n"),
		attachments: drafts.flatMap((draft) => draft.attachments),
	};
}

export function composerDraftLayout(draft: ComposerDraft): ComposerDraftLayout {
	return {
		textLength: draft.text.trim().length,
		attachments: draft.attachments.map(({ name, text }) => ({ name, ...(text === undefined ? {} : { textLength: text.length }) })),
	};
}

/** Old transcripts keep their exact text and images when attachment boundaries are unknown. */
export function restoreComposerDraft(message: SavedPrompt): ComposerDraft {
	const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const text = blocks.flatMap((block, index) =>
		block.type === "text" && !(index > 0 && isDesktopWorkspaceContext(block.text)) ? [block.text] : []).join("");
	const images = blocks.filter((block): block is PromptImage => block.type === "image");
	const fallback = { text, attachments: images.map((image, index) => ({ name: `图片 ${index + 1}`, image })) };
	const layout = message.desktopDraft;
	if (!layout || !Array.isArray(layout.attachments) || !Number.isSafeInteger(layout.textLength) ||
		layout.textLength < 0 || layout.textLength > text.length) return fallback;
	const namedImages = layout.attachments.filter((attachment) => attachment?.textLength === undefined).length === images.length;
	const attachments: ComposerAttachment[] = [];
	let cursor = layout.textLength;
	let imageIndex = 0;
	for (const item of layout.attachments) {
		if (typeof item?.name !== "string") return fallback;
		if (item.textLength === undefined) {
			if (namedImages) attachments.push({ name: item.name, image: images[imageIndex++] });
			continue;
		}
		const header = attachmentHeader(item.name);
		if (!Number.isSafeInteger(item.textLength) || item.textLength < 0 || !text.startsWith(header, cursor)) return fallback;
		cursor += header.length;
		const end = cursor + item.textLength;
		if (end > text.length) return fallback;
		attachments.push({ name: item.name, text: text.slice(cursor, end) });
		cursor = end;
	}
	return { text: text.slice(0, layout.textLength), attachments: namedImages ? attachments : [...attachments, ...fallback.attachments] };
}
