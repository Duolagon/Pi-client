import { useMemo } from "react";
import { highlightCode } from "./highlight.tsx";

import { parseUnifiedDiff, type DiffLine } from "./diff-lines.ts";

export interface DiffReviewAnchor {
	side: "old" | "new";
	line: number;
	text: string;
	section?: string;
	hunk?: number;
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

export function UnifiedDiffView({
	diff,
	mode = "unified",
	className = "",
	hideFileHeader = false,
	onReview,
}: {
	diff: string;
	mode?: "unified" | "split";
	className?: string;
	hideFileHeader?: boolean;
	onReview?: (anchor: DiffReviewAnchor) => void;
}) {
	const parsed = useMemo(() => {
		const lines = parseUnifiedDiff(diff);
		return hideFileHeader ? lines.filter((line) => line.type !== "meta" || !/^(?:diff --git |index |--- |\+\+\+ )/.test(line.text)) : lines;
	}, [diff, hideFileHeader]);
	const splitRows = useMemo(() => {
		if (mode !== "split") return [];
		const rows: Array<{ left?: DiffLine; right?: DiffLine; meta?: DiffLine }> = [];
		let idx = 0;
		while (idx < parsed.length) {
			const line = parsed[idx];
			if (line.type === "meta" || line.type === "hunk") {
				rows.push({ meta: line });
				idx++;
			} else if (line.type === "ctx") {
				rows.push({ left: line, right: line });
				idx++;
			} else {
				const dels: DiffLine[] = [];
				const adds: DiffLine[] = [];
				while (idx < parsed.length && parsed[idx].type === "del") dels.push(parsed[idx++]);
				while (idx < parsed.length && parsed[idx].type === "add") adds.push(parsed[idx++]);
				const len = Math.max(dels.length, adds.length);
				for (let k = 0; k < len; k++) rows.push({ left: dels[k], right: adds[k] });
			}
		}
		return rows;
	}, [parsed, mode]);

	const number = (side: "old" | "new", row?: DiffLine) => {
		const line = side === "old" ? row?.oldNum : row?.newNum;
		return onReview && row && line !== undefined
			? <button
				type="button"
				className="cc-diff-num cc-review-line"
				aria-label={`评审${side === "old" ? "原" : "新"}行 ${line}`}
				title="添加逐行评审意见"
				onClick={() => onReview({ side, line, text: row.text, section: row.section, hunk: row.hunk })}
			>{line}</button>
			: <span className="cc-diff-num">{line ?? ""}</span>;
	};

	if (!diff.trim()) {
		return <div className={`cc-diff empty ${className}`}>此文件没有可显示的文本差异。</div>;
	}
	if (mode === "split") {
		return (
			<div className={`cc-diff cc-diff-split ${className}`}>
				{splitRows.map((row, idx) =>
					row.meta ? (
						<div key={idx} className={`cc-diff-line cc-diff-${row.meta.type}`} data-diff-hunk={row.meta.hunk}>
							<span className="cc-diff-code">{row.meta.text || " "}</span>
						</div>
					) : (
						<div key={idx} className="cc-diff-split-row">
							<div className={`cc-diff-split-cell ${row.left ? `cc-diff-${row.left.type}` : "cc-diff-pad"}`}>
								{number("old", row.left)}
								<span className="cc-diff-sign">{row.left?.type === "del" ? "-" : " "}</span>
								<span className="cc-diff-code">{row.left ? highlightCode(row.left.text || " ") : ""}</span>
							</div>
							<div className={`cc-diff-split-cell ${row.right ? `cc-diff-${row.right.type}` : "cc-diff-pad"}`}>
								{number("new", row.right)}
								<span className="cc-diff-sign">{row.right?.type === "add" ? "+" : " "}</span>
								<span className="cc-diff-code">{row.right ? highlightCode(row.right.text || " ") : ""}</span>
							</div>
						</div>
					),
				)}
			</div>
		);
	}
	return (
		<div className={`cc-diff ${className}`}>
			{parsed.map((line, idx) => (
				<div key={idx} className={`cc-diff-line cc-diff-${line.type}`} data-diff-hunk={line.type === "hunk" ? line.hunk : undefined}>
					{number("old", line)}
					{number("new", line)}
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

export function CodeLines({ content, startLine = 1, activeLine }: { content: string; startLine?: number; activeLine?: number }) {
	const lines = useMemo(() => content.replace(/\r?\n$/, "").split("\n"), [content]);
	return (
		<div className="cc-code-lines">
			{lines.map((line, idx) => (
				<div key={idx} id={`workspace-line-${startLine + idx}`} className={`cc-code-line${activeLine === startLine + idx ? " active" : ""}`}>
					<span className="cc-code-num">{startLine + idx}</span>
					<span className="cc-code-text">{highlightCode(line || " ")}</span>
				</div>
			))}
		</div>
	);
}
