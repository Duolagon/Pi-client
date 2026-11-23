import type { Command } from "./shared.ts";

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

export const emptyDraft: ComposerDraft = { text: "", attachments: [] };
export const maximumImageDataLength = 10 * 1024 * 1024;
export const maximumPromptLength = 2 * 1024 * 1024;

export function draftPrompt(draft: ComposerDraft): Prompt {
	const images = draft.attachments.flatMap((item) => (item.image ? [item.image] : []));
	if (images.length > 10) throw new Error("每条任务最多添加 10 张图片，请移除多余图片。");
	if (images.some((image) => image.data.length > maximumImageDataLength))
		throw new Error("图片编码后超过 10 MB，请压缩图片后重试。");
	const message = draft.text.trim() + draft.attachments
		.filter((item) => item.text !== undefined)
		.map((item) => `\n\n附件 ${item.name}：\n${item.text}`)
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
