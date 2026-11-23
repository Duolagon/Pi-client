export interface DiffLine {
	type: "hunk" | "add" | "del" | "ctx" | "meta";
	text: string;
	oldNum?: number;
	newNum?: number;
	hunk?: number;
	section?: string;
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
