import { useState, type SetStateAction } from "react";

interface SessionWorkspace {
	pane: "changes" | "files" | null;
	previewUrl: string | null;
	terminalOpen: boolean;
	focusReview: boolean;
}
const empty: SessionWorkspace = { pane: null, previewUrl: null, terminalOpen: false, focusReview: false };

export function useSessionWorkspace(id?: string) {
	const [views, setViews] = useState<Record<string, SessionWorkspace>>({});
	const current = id ? views[id] ?? empty : empty;
	function update<K extends keyof SessionWorkspace>(key: K, value: SetStateAction<SessionWorkspace[K]>) {
		if (!id) return;
		setViews((previous) => {
			const view = previous[id] ?? empty;
			const next = typeof value === "function" ? value(view[key]) : value;
			return next === view[key] ? previous : { ...previous, [id]: { ...view, [key]: next } };
		});
	}
	return {
		...current,
		setPane: (value: SetStateAction<SessionWorkspace["pane"]>) => update("pane", value),
		setPreviewUrl: (value: SetStateAction<SessionWorkspace["previewUrl"]>) => update("previewUrl", value),
		setTerminalOpen: (value: SetStateAction<boolean>) => update("terminalOpen", value),
		toggleReviewFocus: () => update("focusReview", (previous) => !previous),
	};
}
