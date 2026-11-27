import type { ReactNode } from "react";

const KEYWORDS = new Set([
	"import", "from", "export", "default", "const", "let", "var", "function", "return", "async", "await",
	"if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally",
	"throw", "new", "class", "extends", "implements", "interface", "type", "enum", "struct", "fn", "pub",
	"use", "mod", "match", "impl", "trait", "def", "lambda", "with", "as", "pass", "yield", "raise",
	"in", "of", "typeof", "instanceof", "void", "delete", "true", "false", "null", "undefined", "None",
	"True", "False", "self", "this", "super", "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE",
]);

const HASH_COMMENT_LANGS = new Set([
	"py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "toml", "rb", "ruby",
	"dockerfile", "conf", "ini", "env", "makefile", "mk", "r", "perl", "pl",
]);

const SLASH_TOKEN_RE =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`])*`|"(?:\\[\s\S]|[^"\n])*"|'(?:\\[\s\S]|[^'\n])*')|\b(\d+(?:\.\d+)?(?:n|px|em|rem|ms|s|%)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

const HASH_TOKEN_RE =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^`])*`|"(?:\\[\s\S]|[^"\n])*"|'(?:\\[\s\S]|[^'\n])*')|\b(\d+(?:\.\d+)?(?:n|px|em|rem|ms|s|%)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

// When language is unknown (e.g. unified diff lines), only treat `# ...` as a comment if `#` is at start/whitespace AND followed by space or `!` (shebang), never matching CSS hex `#f2c96b`, `#root`, `#[derive]`, or `#include`.
const AUTO_TOKEN_RE =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<=^|\s)#(?:!|\s)[^\n]*)|(`(?:\\[\s\S]|[^`])*`|"(?:\\[\s\S]|[^"\n])*"|'(?:\\[\s\S]|[^'\n])*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:n|px|em|rem|ms|s|%)?\b)|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

export function inferLangFromPath(filePath?: string): string | undefined {
	if (!filePath) return undefined;
	const base = (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
	if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
	if (base === "makefile" || base === "gnumakefile") return "makefile";
	if (base === ".env" || base.startsWith(".env.")) return "env";
	if (base === ".bashrc" || base === ".zshrc" || base === ".profile") return "sh";
	const dot = base.lastIndexOf(".");
	return dot >= 0 ? base.slice(dot + 1) : undefined;
}

/** Lightweight, zero-dependency syntax highlighter returning styled spans for a single line or code block. */
export function highlightCode(text: string, lang?: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	const normLang = lang?.toLowerCase().trim();
	const re = normLang
		? HASH_COMMENT_LANGS.has(normLang)
			? HASH_TOKEN_RE
			: SLASH_TOKEN_RE
		: AUTO_TOKEN_RE;
	re.lastIndex = 0;

	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
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
