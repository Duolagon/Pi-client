export interface KaggleSelection {
	conversationId: string;
	notebookUrl: string;
	text: string;
	truncated: boolean;
}

export interface KaggleNotebookSnapshot {
	notebookUrl: string;
	runAllAvailable: boolean;
	statuses: string[];
	output: string[];
	truncated: boolean;
}

const kaggleHosts = new Set(["www.kaggle.com", "kaggle.com"]);
const browserHosts = new Set([...kaggleHosts, "accounts.google.com"]);
const notebookPath = /^\/code\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/(?:edit|notebook))?\/?$/i;
const maxSelectionLength = 16_000;

function httpsUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		if (url.protocol === "https:" && !url.username && !url.password && !url.port) return url;
	} catch {
		// Invalid input is handled by the caller.
	}
}

export function kaggleNotebookUrl(value: string): URL | undefined {
	const url = httpsUrl(value);
	if (url && kaggleHosts.has(url.hostname) && notebookPath.test(url.pathname)) return url;
}

export function allowsKaggleBrowserNavigation(value: string): boolean {
	const url = httpsUrl(value);
	return Boolean(url && browserHosts.has(url.hostname));
}

function sourceUrl(value: string): string | undefined {
	const url = kaggleNotebookUrl(value);
	return url ? `${url.origin}${url.pathname}` : undefined;
}

/** Query parameters may contain private identifiers. Retain only a validated notebook version. */
export function kaggleNotebookReference(value: string): string | undefined {
	const url = kaggleNotebookUrl(value);
	if (!url) return;
	const version = url.searchParams.get("scriptVersionId");
	return `${url.origin}${url.pathname}${version && /^[1-9][0-9]{0,19}$/.test(version) ? `?scriptVersionId=${version}` : ""}`;
}

export function kaggleNotebookSelection(input: {
	conversationId: string;
	pageUrl: string;
	frameUrl: string;
	text: string;
	editable: boolean;
}): KaggleSelection | undefined {
	const notebookUrl = sourceUrl(input.pageUrl);
	if (!notebookUrl || input.editable) return;
	const frame = httpsUrl(input.frameUrl);
	const isNotebookFrame = !input.frameUrl || input.frameUrl === "about:blank" || input.frameUrl === "about:srcdoc" ||
		(frame && (kaggleNotebookUrl(frame.href) || frame.hostname.endsWith(".kaggleusercontent.com")));
	if (!isNotebookFrame) return;
	const value = input.text.trim();
	if (!value) return;
	const text = value.slice(0, maxSelectionLength).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	if (!text) return;
	return { conversationId: input.conversationId, notebookUrl, text, truncated: value.length > maxSelectionLength };
}

export function formatKaggleSelection(selection: KaggleSelection): string {
	const cited = selection.text.split(/\r\n|\r|\n/).map((line) => `> ${line}`).join("\n");
	return `从 Kaggle Notebook 选择的外部文本${selection.truncated ? "（部分）" : ""}\n${selection.notebookUrl}\n\n${cited}`;
}
