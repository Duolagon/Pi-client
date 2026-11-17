import type { ReactNode } from "react";

const KEYWORDS = new Set([
	"import", "from", "export", "default", "const", "let", "var", "function", "return", "async", "await",
	"if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally",
	"throw", "new", "class", "extends", "implements", "interface", "type", "enum", "struct", "fn", "pub",
	"use", "mod", "match", "impl", "trait", "def", "lambda", "with", "as", "pass", "yield", "raise",
	"in", "of", "typeof", "instanceof", "void", "delete", "true", "false", "null", "undefined", "None",
	"True", "False", "self", "this", "super", "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE",
]);

const TOKEN_RE =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^`])*`|"(?:\\[\s\S]|[^"\n])*"|'(?:\\[\s\S]|[^'\n])*')|\b(\d+(?:\.\d+)?(?:n|px|em|rem|ms|s|%)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

/** Lightweight, zero-dependency syntax highlighter returning styled spans for a single line or code block. */
export function highlightCode(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	TOKEN_RE.lastIndex = 0;

	for (let match = TOKEN_RE.exec(text); match !== null; match = TOKEN_RE.exec(text)) {
		if (match.index > last) {
			out.push(text.slice(last, match.index));
		}
		const [full, comment, str, num, ident] = match;
		if (comment) {
			out.push(
				<span key={key++} className="tok-comment">
					{comment}
				</span>,
			);
		} else if (str) {
			out.push(
				<span key={key++} className="tok-string">
					{str}
				</span>,
			);
		} else if (num) {
			out.push(
				<span key={key++} className="tok-number">
					{num}
				</span>,
			);
		} else if (ident) {
			if (KEYWORDS.has(ident)) {
				out.push(
					<span key={key++} className="tok-keyword">
						{ident}
					</span>,
				);
			} else if (/^[A-Z][A-Za-z0-9_]*$/.test(ident)) {
				out.push(
					<span key={key++} className="tok-type">
						{ident}
					</span>,
				);
			} else {
				out.push(full);
			}
		}
		last = match.index + full.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}
