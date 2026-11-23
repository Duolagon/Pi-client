import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComposerDraft } from "../src/composer-draft.ts";
import { QueuedPrompts } from "../src/queued-prompts.ts";

test("queue withdrawal retains the later attachment when identical text is consumed", async () => {
	const queue = new QueuedPrompts();
	const draft = (name: string): ComposerDraft => ({
		text: "same caption",
		attachments: [{ name, image: { type: "image", mimeType: "image/png", data: "AA==" } }],
	});
	const earlier = draft("earlier.png");
	const later = draft("later.png");
	await queue.send("steering", earlier, async () => queue.update({ steering: ["same caption"], followUp: [] }));
	await queue.send("steering", later, async () => queue.update({ steering: ["same caption", "same caption"], followUp: [] }));
	const result = await queue.take(async () => {
		// The first pending message entered the run before the RPC cleared the remaining queue.
		queue.update({ steering: ["same caption"], followUp: [] });
		queue.update({ steering: [], followUp: [] });
		return { steering: ["same caption"], followUp: [] };
	});
	assert.deepEqual(result, [later]);
	assert.deepEqual(queue.preview(), []);
});

test("an empty native queue never replays a prompt that has already started", async () => {
	const queue = new QueuedPrompts();
	await queue.send("followUp", { text: "already delivered", attachments: [] }, async () => {
		queue.update({ followUp: ["already delivered"], steering: [] });
	});
	const result = await queue.take(async () => {
		queue.update({ followUp: [], steering: [] });
		return { followUp: [], steering: [] };
	});
	assert.deepEqual(result, []);
});
