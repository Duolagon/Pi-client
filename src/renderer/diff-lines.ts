export interface DiffLine {
	type: "hunk" | "add" | "del" | "ctx" | "meta";
	text: string;
	oldNum?: number;
	newNum?: number;
	hunk?: number;
	section?: string;
}

export interface LineChangeCounts {
	additions: number;
	removals: number;
}

/** Compare only the changed range so small edits to long snippets still get exact counts. */
export function computeLineDiff(oldText: string, newText: string): { lines: DiffLine[]; counts?: LineChangeCounts } {
	const a = splitDiffLines(oldText);
	const b = splitDiffLines(newText);
	const lines: DiffLine[] = [];
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		lines.push({ type: "ctx", text: a[start], oldNum: start + 1, newNum: start + 1 });
		start++;
	}
	let oldEnd = a.length;
	let newEnd = b.length;
	while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	const m = oldEnd - start;
	const n = newEnd - start;
	let counts: LineChangeCounts | undefined;

	// Keep a bounded comparison. For a large unmatched range, display both versions without guessed counts.
	if (m * n > 40000) {
		lines.push({ type: "meta", text: "改动前（未逐行对比）" });
		for (let i = start; i < oldEnd; i++) lines.push({ type: "ctx", text: a[i], oldNum: i + 1 });
		lines.push({ type: "meta", text: "改动后（未逐行对比）" });
		for (let j = start; j < newEnd; j++) lines.push({ type: "ctx", text: b[j], newNum: j + 1 });
	} else {
		counts = { additions: 0, removals: 0 };
		let i = 0;
		let j = 0;
		if (m && n) {
			const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
			for (let row = m - 1; row >= 0; row--) {
				for (let col = n - 1; col >= 0; col--) {
					dp[row][col] = a[start + row] === b[start + col]
						? 1 + dp[row + 1][col + 1]
						: Math.max(dp[row + 1][col], dp[row][col + 1]);
				}
			}
			while (i < m && j < n) {
				if (a[start + i] === b[start + j]) {
					lines.push({ type: "ctx", text: a[start + i], oldNum: start + i + 1, newNum: start + j + 1 });
					i++;
					j++;
				} else if (dp[i + 1][j] >= dp[i][j + 1]) {
					lines.push({ type: "del", text: a[start + i], oldNum: start + i + 1 });
					counts.removals++;
					i++;
				} else {
					lines.push({ type: "add", text: b[start + j], newNum: start + j + 1 });
					counts.additions++;
					j++;
				}
			}
		}
		while (i < m) {
			lines.push({ type: "del", text: a[start + i], oldNum: start + i + 1 });
			counts.removals++;
			i++;
		}
		while (j < n) {
			lines.push({ type: "add", text: b[start + j], newNum: start + j + 1 });
			counts.additions++;
			j++;
		}
	}

	for (let i = oldEnd, j = newEnd; i < a.length; i++, j++) {
		lines.push({ type: "ctx", text: a[i], oldNum: i + 1, newNum: j + 1 });
	}
	return { lines, counts };
}

function splitDiffLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function summarizeLineChanges(edits: readonly { oldText: string; newText: string }[]): LineChangeCounts | undefined {
	const counts = { additions: 0, removals: 0 };
	for (const { oldText, newText } of edits) {
		const edit = computeLineDiff(oldText, newText).counts;
		if (!edit) return undefined;
		counts.additions += edit.additions;
		counts.removals += edit.removals;
	}
	return counts;
}

const unifiedHunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function diffHunkCount(raw: string): number {
	return raw.split("\n").filter((line) => unifiedHunk.test(line)).length;
}

/** Track hunk lengths so source lines such as `--- SQL comment` keep their line anchors. */
export function parseUnifiedDiff(raw: string): DiffLine[] {
	const result: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	let hunk = -1;
	let section: string | undefined;
	for (const text of raw.split("\n")) {
		const header = unifiedHunk.exec(text);
		if (header) {
			oldLine = Number(header[1]);
			oldRemaining = Number(header[2] ?? 1);
			newLine = Number(header[3]);
			newRemaining = Number(header[4] ?? 1);
			result.push({ type: "hunk", text, hunk: ++hunk, section });
		} else if (oldRemaining > 0 && text.startsWith("-")) {
			oldRemaining--;
			result.push({ type: "del", text: text.slice(1), oldNum: oldLine++, hunk, section });
		} else if (newRemaining > 0 && text.startsWith("+")) {
			newRemaining--;
			result.push({ type: "add", text: text.slice(1), newNum: newLine++, hunk, section });
		} else if (oldRemaining > 0 && newRemaining > 0 && text.startsWith(" ")) {
			oldRemaining--;
			newRemaining--;
			result.push({ type: "ctx", text: text.slice(1), oldNum: oldLine++, newNum: newLine++, hunk, section });
		} else if (text) {
			if (text === "# 已暂存" || text === "# 未暂存") section = text.slice(2);
			result.push({ type: "meta", text });
		}
	}
	return result;
}
