import type { ComposerDraft } from "./composer-draft.ts";

type Lane = "steering" | "followUp";
export type NativeQueue = Record<Lane, readonly string[]>;
interface Entry {
	text: string;
	draft?: ComposerDraft;
}
type Entries = Record<Lane, Entry[]>;

export class QueuedPrompts {
	private entries: Entries = { steering: [], followUp: [] };
	private input?: { lane: Lane; draft: ComposerDraft };
	private clearing?: Entries;
	private operation: Promise<unknown> = Promise.resolve();

	serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operation.then(action);
		this.operation = result.catch(() => {});
		return result;
	}

	async send<T>(lane: Lane, draft: ComposerDraft, submit: () => Promise<T>): Promise<T> {
		return this.serialize(async () => {
			this.input = { lane, draft };
			try {
				return await submit();
			} finally {
				this.input = undefined;
			}
		});
	}

	update(queue: NativeQueue): void {
		if (this.clearing && !queue.steering.length && !queue.followUp.length && (this.entries.steering.length || this.entries.followUp.length))
			this.clearing = this.entries;
		this.entries = { steering: this.updateLane("steering", queue.steering), followUp: this.updateLane("followUp", queue.followUp) };
	}

	private updateLane(lane: Lane, next: readonly string[]): Entry[] {
		const previous = this.entries[lane];
		// Pi emits the new queue before it acknowledges the corresponding RPC input.
		// Its event contains expanded text, while the input holds the original draft and images.
		if (next.length === previous.length + 1 && previous.every((entry, index) => entry.text === next[index])) {
			const draft = this.input?.lane === lane ? this.input.draft : undefined;
			if (draft) this.input = undefined;
			return [...previous, { text: next[next.length - 1], draft }];
		}
		// Pi dequeues the first occurrence of a matching text. Walk back from the newest entry
		// to keep the later drafts when identical text was submitted with different attachments.
		let index = previous.length - 1;
		return next.slice().reverse().map((text) => {
			while (index >= 0 && previous[index].text !== text) index--;
			return index >= 0 ? previous[index--] : { text };
		}).reverse();
	}

	take(clear: () => Promise<NativeQueue>): Promise<ComposerDraft[]> {
		return this.serialize(async () => {
			this.clearing = this.entries;
			try {
				const result = await clear();
				const cleared = this.clearing;
				return (["steering", "followUp"] as const).flatMap((lane) => {
					const previous = cleared[lane];
					return result[lane].map((text, index) => {
						const saved = previous[index];
						return saved?.text === text && saved.draft ? saved.draft : { text, attachments: [] };
					});
				});
			} finally {
				this.clearing = undefined;
			}
		});
	}

	preview(): string[] {
		return [...this.entries.steering, ...this.entries.followUp].map(({ text, draft }) =>
			draft ? draft.text.trim() || draft.attachments.map((item) => item.name).join("、") : text);
	}
}
