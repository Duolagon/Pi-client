import { useMemo } from "react";
import { highlightCode, inferLangFromPath } from "./highlight.tsx";

import { computeLineDiff, parseUnifiedDiff, type DiffLine } from "./diff-lines.ts";

export interface DiffReviewAnchor {
	side: "old" | "new";
	line: number;
	text: string;
	section?: string;
	hunk?: number;
}

export function UnifiedDiffView({
	diff,
	mode = "unified",
	className = "",
	hideFileHeader = false,
	filePath,
	onReview,
}: {
	diff: string;
	mode?: "unified" | "split";
	className?: string;
	hideFileHeader?: boolean;
	filePath?: string;
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
	const renderCode = (line: DiffLine, side: "old" | "new") => {
		const candidates = side === "old" ? [line.oldPath, line.newPath] : [line.newPath, line.oldPath];
		return highlightCode(line.text || " ", inferLangFromPath(candidates[0] ?? candidates[1] ?? filePath));
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
								<span className="cc-diff-code">{row.left ? renderCode(row.left, "old") : ""}</span>
							</div>
							<div className={`cc-diff-split-cell ${row.right ? `cc-diff-${row.right.type}` : "cc-diff-pad"}`}>
								{number("new", row.right)}
								<span className="cc-diff-sign">{row.right?.type === "add" ? "+" : " "}</span>
								<span className="cc-diff-code">{row.right ? renderCode(row.right, "new") : ""}</span>
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
						{line.type === "add" || line.type === "del" || line.type === "ctx" ? renderCode(line, line.type === "del" ? "old" : "new") : line.text || " "}
					</span>
				</div>
			))}
		</div>
	);
}

export function InlineEditDiff({ oldText, newText, filePath }: { oldText: string; newText: string; filePath?: string }) {
	const lang = useMemo(() => inferLangFromPath(filePath), [filePath]);
	const { lines } = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
	return (
		<div className="cc-diff cc-diff-inline">
			{lines.map((line, idx) => (
				<div key={idx} className={`cc-diff-line cc-diff-${line.type}`}>
					<span className="cc-diff-num">{line.oldNum ?? line.newNum ?? ""}</span>
					<span className="cc-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
					<span className="cc-diff-code">
						{line.type === "add" || line.type === "del" || line.type === "ctx" ? highlightCode(line.text || " ", lang) : line.text || " "}
					</span>
				</div>
			))}
		</div>
	);
}

export function CodeLines({
	content,
	startLine = 1,
	activeLine,
	lang,
	onLineClick,
}: {
	content: string;
	startLine?: number;
	activeLine?: number;
	lang?: string;
	onLineClick?: (line: number, column: number) => void;
}) {
	const lines = useMemo(() => content.replace(/\r?\n$/, "").split("\n"), [content]);
	return (
		<div className={`cc-code-lines ${onLineClick ? "is-interactive" : ""}`.trim()}>
			{lines.map((line, idx) => {
				const lineNum = startLine + idx;
				return (
					<div
						key={idx}
						id={`workspace-line-${lineNum}`}
						className={`cc-code-line${activeLine === lineNum ? " active" : ""}`}
						onClick={
							onLineClick
								? (event) => {
										const sel = window.getSelection();
										if (sel && !sel.isCollapsed) return;
										let col = 1;
										if (sel && sel.anchorNode && event.currentTarget.contains(sel.anchorNode)) {
											const textSpan = event.currentTarget.querySelector(".cc-code-text");
											if (textSpan) {
												const range = document.createRange();
												range.setStart(textSpan, 0);
												try {
													range.setEnd(sel.anchorNode, sel.anchorOffset);
													col = Math.max(1, range.toString().length + 1);
												} catch {
													col = 1;
												}
											}
										}
										onLineClick(lineNum, col);
									}
								: undefined
						}
					>
						<span className="cc-code-num">{lineNum}</span>
						<span className="cc-code-text">{highlightCode(line || " ", lang)}</span>
					</div>
				);
			})}
		</div>
	);
}
