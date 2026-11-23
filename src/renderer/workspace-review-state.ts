import type { DiffReviewAnchor } from "./DiffView.tsx";

export type ReviewScope = "turn" | "workspace";
export type ReviewPosition = { path?: string; hunk: number; top: number };
export type ReviewNote = DiffReviewAnchor & {
	id: string;
	path: string;
	source: string;
	version: string;
	note: string;
};
export type ReviewView = {
	scope?: ReviewScope;
	turn: ReviewPosition & { checkpointId?: string };
	workspace: ReviewPosition;
	files: { directory: string; path?: string; top: number; line?: number };
	diffMode: "unified" | "split";
	notes: ReviewNote[];
	draft?: ReviewNote;
};

const reviewViews = new Map<string, ReviewView>();
const storagePrefix = "pi-desktop.workspace-review.";

export function readReviewView(key: string): ReviewView {
	const cached = reviewViews.get(key);
	if (cached) return cached;
	let saved: Partial<ReviewView> = {};
	try {
		saved = JSON.parse(localStorage.getItem(storagePrefix + key) ?? "{}") ?? {};
	} catch {
		// Workspace review remains available when local storage is unavailable.
	}
	const view: ReviewView = {
		turn: saved.turn ?? { hunk: 0, top: 0 },
		workspace: saved.workspace ?? { hunk: 0, top: 0 },
		files: saved.files ?? { directory: "", top: 0 },
		diffMode: saved.diffMode === "split" ? "split" : "unified",
		scope: saved.scope === "turn" || saved.scope === "workspace" ? saved.scope : undefined,
		notes: Array.isArray(saved.notes) ? saved.notes : [],
		draft: saved.draft,
	};
	reviewViews.set(key, view);
	return view;
}

export function saveReviewView(key: string, view: ReviewView): void {
	reviewViews.set(key, view);
	try {
		localStorage.setItem(storagePrefix + key, JSON.stringify(view));
	} catch {
		// Keep the in-window state even if the local store cannot accept more data.
	}
}

export async function reviewRevision(diff: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function reviewLocation(note: DiffReviewAnchor & { path: string }): string {
	return `${note.path} · ${note.section ? `${note.section} · ` : ""}${note.side === "old" ? "原文件" : "新文件"}第 ${note.line} 行`;
}

export function formatReviewNotes(notes: ReviewNote[]): string {
	const entries = notes.map((note, index) => {
		const line = note.text.trim();
		const excerpt = line.length > 240 ? `${line.slice(0, 240)}…` : line;
		return `${index + 1}. ${reviewLocation(note)}\n   该行内容：${excerpt || "（空行）"}\n   意见：${note.note.trim()}`;
	});
	return `请处理以下代码评审意见。\n\n${entries.join("\n\n")}`;
}
