import { useMemo } from "react";
import { highlightCode } from "./highlight.tsx";

interface DiffLine {
	type: "hunk" | "add" | "del" | "ctx" | "meta";
	text: string;
	oldNum?: number;
	newNum?: number;
}

/** Parse a unified git diff string into structured lines with line numbers. */
function parseUnifiedDiff(raw: string): DiffLine[] {
	const lines = raw.split("\n");
	const out: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const line of lines) {
		if (
			line.startsWith("diff --git ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("# ")
		) {
			out.push({ type: "meta", text: line });
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			out.push({ type: "hunk", text: line });
			continue;
		}
		if (line.startsWith("+")) {
			out.push({ type: "add", text: line.slice(1), newNum: newLine++ });
		} else if (line.startsWith("-")) {
			out.push({ type: "del", text: line.slice(1), oldNum: oldLine++ });
		} else if (line.startsWith(" ")) {
			out.push({ type: "ctx", text: line.slice(1), oldNum: oldLine++, newNum: newLine++ });
		} else if (line.length > 0) {
			out.push({ type: "meta", text: line });
		}
	}
	return out;
}

/** Compute a simple line-level diff between oldText and newText for inline Edit tool cards. */
export function computeLineDiff(oldText: string, newText: string): { lines: DiffLine[]; additions: number; removals: number } {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const m = a.length;
	const n = b.length;

	// For very large edits, fall back to simple del+add block to keep rendering fast.
	if (m * n > 40000) {
		const lines: DiffLine[] = [
			...a.map((text, idx) => ({ type: "del" as const, text, oldNum: idx + 1 })),
			...b.map((text, idx) => ({ type: "add" as const, text, newNum: idx + 1 })),
		];
		return { lines, additions: n, removals: m };
	}

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	let additions = 0;
	let removals = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			lines.push({ type: "ctx", text: a[i], oldNum: i + 1, newNum: j + 1 });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			lines.push({ type: "del", text: a[i], oldNum: i + 1 });
			removals++;
			i++;
		} else {
			lines.push({ type: "add", text: b[j], newNum: j + 1 });
			additions++;
			j++;
		}
	}
	while (i < m) {
		lines.push({ type: "del", text: a[i], oldNum: i + 1 });
		removals++;
		i++;
	}
	while (j < n) {
		lines.push({ type: "add", text: b[j], newNum: j + 1 });
		additions++;
		j++;
	}
	return { lines, additions, removals };
}

export function UnifiedDiffView({ diff, className = "" }: { diff: string; className?: string }) {
	const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
	if (!diff.trim()) {
		return <div className={`cc-diff empty ${className}`}>此文件没有可显示的文本差异。</div>;
	}
	return (
		<div className={`cc-diff ${className}`}>
			{parsed.map((line, idx) => (
				<div key={idx} className={`cc-diff-line cc-diff-${line.type}`}>
					<span className="cc-diff-num">{line.oldNum ?? ""}</span>
					<span className="cc-diff-num">{line.newNum ?? ""}</span>
					<span className="cc-diff-sign">
						{line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "ctx" ? " " : ""}
					</span>
					<span className="cc-diff-code">
						{line.type === "add" || line.type === "del" || line.type === "ctx" ? highlightCode(line.text || " ") : line.text || " "}
					</span>
				</div>
			))}
		</div>
	);
}

export function InlineEditDiff({ oldText, newText }: { oldText: string; newText: string }) {
	const { lines } = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
	return (
		<div className="cc-diff cc-diff-inline">
			{lines.map((line, idx) => (
				<div key={idx} className={`cc-diff-line cc-diff-${line.type}`}>
					<span className="cc-diff-num">{line.oldNum ?? line.newNum ?? ""}</span>
					<span className="cc-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
					<span className="cc-diff-code">
						{line.type === "add" || line.type === "del" || line.type === "ctx" ? highlightCode(line.text || " ") : line.text || " "}
					</span>
				</div>
			))}
		</div>
	);
}

export function CodeLines({ content, startLine = 1 }: { content: string; startLine?: number }) {
	const lines = useMemo(() => content.split("\n"), [content]);
	return (
		<div className="cc-code-lines">
			{lines.map((line, idx) => (
				<div key={idx} className="cc-code-line">
					<span className="cc-code-num">{startLine + idx}</span>
					<span className="cc-code-text">{highlightCode(line || " ")}</span>
				</div>
			))}
		</div>
	);
}
