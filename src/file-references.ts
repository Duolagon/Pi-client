export interface FileReference {
	path: string;
	from: number;
	to: number;
}

const desktopContextStart = "<pi-desktop-workspace-context>\n";
const desktopContextEnd = "\n</pi-desktop-workspace-context>";

export function wrapDesktopWorkspaceContext(text: string): string {
	return desktopContextStart + text + desktopContextEnd;
}

export function isDesktopWorkspaceContext(text: string): boolean {
	return text.startsWith(desktopContextStart) && text.endsWith(desktopContextEnd);
}

/** Remove the model-only appendix from plain-text draft or history previews. */
export function visiblePromptText(text: string): string {
	if (!text.endsWith(desktopContextEnd)) return text;
	const start = text.lastIndexOf(desktopContextStart);
	return start < 0 ? text : text.slice(0, start).trimEnd();
}

interface ReferenceQuery {
	query: string;
	from: number;
	to: number;
}

function maskCode(text: string): string {
	return text.replace(
		/^```[^\n]*\n[\s\S]*?^```[^\n]*|`[^`\n]*`|(^|[\s(])@"(?:\\[^\r\n]|[^"\\\r\n])*"/gm,
		(block, referencePrefix) => referencePrefix === undefined ? block.replace(/[^\n]/g, " ") : block,
	);
}

export function isReferenceablePath(path: string): boolean {
	return !path.split("/").some((part) =>
		!part || part === "." || part === ".." || /[\0\r\n\\:]/.test(part) ||
		/^(?:\.git|\.env(?:\..*)?|\.ssh|auth\.json|.*\.(?:pem|key))$/i.test(part),
	);
}

export function formatFileReference(path: string): string {
	return /^[\p{L}\p{N}_./-]+$/u.test(path) && !path.endsWith(".") ? `@${path}` : `@${JSON.stringify(path)}`;
}

export function fileReferences(text: string): FileReference[] {
	const result: FileReference[] = [];
	for (const match of maskCode(text).matchAll(/(^|[\s(])@(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"|([\p{L}\p{N}_./-]+))/gu)) {
		try {
			const from = match.index + match[1].length;
			const token = match[0].slice(match[1].length);
			const path = match[2] === undefined ? match[3].replace(/[.]$/, "") : JSON.parse(`"${match[2]}"`) as string;
			if (path && !path.endsWith("/")) result.push({ path, from, to: from + token.length - Number(match[2] === undefined && token.endsWith(".")) });
		} catch { /* Incomplete or invalid quoting stays in the draft. */ }
	}
	return result;
}

export function referenceQuery(text: string, cursor: number): ReferenceQuery | undefined {
	const left = text.slice(0, cursor);
	const match = /(^|[\s(])@(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"|([\p{L}\p{N}_./-]*))$/u.exec(left);
	if (!match) return;
	const from = match.index + match[1].length;
	if (maskCode(text)[from] !== "@") return;
	const quoted = match[2] !== undefined;
	const next = text.slice(cursor);
	const tail = quoted ? /^(?:\\[^\r\n]|[^"\\\r\n])*"/.exec(next) : /^[\p{L}\p{N}_./-]+/u.exec(next);
	let query = quoted ? match[2] : match[3];
	if (quoted) {
		try { query = JSON.parse(`"${query}"`) as string; } catch { /* Accept partial quoted input. */ }
	}
	return { query, from, to: cursor + (tail?.[0].length ?? 0) };
}

export function insertFileReference(text: string, reference: ReferenceQuery, path: string, directory: boolean) {
	const normalized = directory ? `${path}/` : path;
	const formatted = formatFileReference(normalized);
	const before = text.slice(0, reference.from);
	const after = text.slice(reference.to);
	const insertion = directory
		? formatted.startsWith('@"') ? formatted.slice(0, -1) : formatted
		: formatted + (after.length && /^\s/.test(after) ? "" : " ");
	return { text: before + insertion + after, cursor: before.length + insertion.length };
}

export function removeFileReference(text: string, reference: FileReference, selection: { start: number; end: number }) {
	const before = text.slice(0, reference.from);
	const after = text.slice(reference.to);
	const remaining = before === "" || /[ \t]$/.test(before) ? after.replace(/^[ \t]+/, "") : after;
	const removedEnd = reference.to + after.length - remaining.length;
	const adjust = (position: number) => position - Math.max(0, Math.min(position, removedEnd) - reference.from);
	return { text: before + remaining, selection: { start: adjust(selection.start), end: adjust(selection.end) } };
}
