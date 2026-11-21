import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Rotation threshold for the active log file. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Rotated files kept next to the active one (pi-desktop.log.1 … .3). */
export const LOG_KEEP_FILES = 3;
export const LOG_FILE_NAME = "pi-desktop.log";
const MAX_FIELD_CHARS = 4000;

const SECRET_NAME = /^[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_.-]*$/i;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces the home directory prefix with "~" (paths shown in logs and diagnostics). */
export function tildify(text: string, home = homedir()): string {
	if (!home || home === "/" || home.length < 2) return text;
	return text.replace(new RegExp(`${escapeRegExp(home)}(?=$|[\\\\/\\s"'):,;])`, "g"), "~");
}

/**
 * Removes credentials from free text before it reaches the log file:
 * Authorization/Bearer values, API-key shaped strings, long hex/base64 tokens,
 * values of variables whose names contain KEY/TOKEN/SECRET/PASSWORD, and the home directory.
 */
export function redactLogText(input: string, home = homedir()): string {
	let text = tildify(input, home);
	// Credentials embedded in URLs: scheme://user:pass@host
	text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
	text = text.replace(/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+)?[^\s"',;}]+/gi, (_m, name: string, sep: string, scheme?: string) =>
		`${name}${sep}${scheme ? `${scheme} ` : ""}[REDACTED]`,
	);
	text = text.replace(/\bbearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
	// NAME=value, NAME: value, "NAME": "value" where NAME looks like a secret.
	// Secret-named pairs are matched directly (not anchored on the first name in the text), so a
	// secret after a non-secret "name:" token or inside a URL query string (?api_key=...) is caught.
	text = text.replace(
		/(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&"']+)/gi,
		(match, quote: string, name: string, sep: string, value: string) => {
			if (!SECRET_NAME.test(name) || value.includes("[REDACTED]")) return match;
			const wrapped = value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]";
			return `${quote}${name}${quote}${sep}${wrapped}`;
		},
	);
	text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
	text = text.replace(/\b(?:gh[pousr]_|github_pat_|xox[abpr]-|AIza)[A-Za-z0-9_-]{10,}/g, "[REDACTED]");
	text = text.replace(/\b[a-f0-9]{32,}\b/gi, "[REDACTED]");
	// Long base64/base64url runs that mix letters and digits are treated as tokens.
	text = text.replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (match) => (/\d/.test(match) && /[A-Za-z]/.test(match) ? "[REDACTED]" : match));
	return text;
}

/**
 * Short, content-free summary of an engine error for the log: first line only,
 * and a Pi process exit keeps only its exit code (stderr can echo session content).
 */
export function summarizeEngineError(message: string): string {
	const exit = /^Pi 进程已退出 \([^)]*\)/.exec(message);
	if (exit) return exit[0];
	return (message.split(/\r?\n/, 1)[0] ?? "").slice(0, 300);
}

export type LogLevel = "info" | "warn" | "error";
export type LogDetails = Record<string, string | number | boolean | undefined | null>;

/** Formats an error with its stack for the log; callers still pass it through redaction. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split("\n").slice(1, 12).join("\n")}` : ""}`;
	return String(error);
}

/** Append-only local log with size rotation. Writes are synchronous so crash records survive an exit. */
export class DesktopLog {
	readonly dir: string;
	readonly file: string;
	private maxBytes: number;
	private keep: number;
	private home: string;

	constructor(options: { dir: string; maxBytes?: number; keep?: number; home?: string }) {
		this.dir = options.dir;
		this.file = join(options.dir, LOG_FILE_NAME);
		this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
		this.keep = options.keep ?? LOG_KEEP_FILES;
		this.home = options.home ?? homedir();
	}

	info(event: string, details?: LogDetails): void {
		this.write("info", event, details);
	}
	warn(event: string, details?: LogDetails): void {
		this.write("warn", event, details);
	}
	error(event: string, details?: LogDetails): void {
		this.write("error", event, details);
	}

	write(level: LogLevel, event: string, details?: LogDetails): void {
		try {
			const fields = Object.entries(details ?? {})
				.filter(([, value]) => value !== undefined && value !== null)
				.map(([name, value]) => `${name}=${JSON.stringify(String(value).slice(0, MAX_FIELD_CHARS))}`);
			const line = redactLogText(`${new Date().toISOString()} ${level.toUpperCase()} ${event}${fields.length ? ` ${fields.join(" ")}` : ""}`, this.home) + "\n";
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			this.rotateIfNeeded(Buffer.byteLength(line));
			appendFileSync(this.file, line, { mode: 0o600 });
		} catch {
			// Logging must never take the app down.
		}
	}

	private rotateIfNeeded(incoming: number): void {
		let size = 0;
		try {
			size = statSync(this.file).size;
		} catch {
			return;
		}
		if (size + incoming <= this.maxBytes) return;
		rmSync(`${this.file}.${this.keep}`, { force: true });
		for (let index = this.keep - 1; index >= 1; index--) {
			try {
				renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`);
			} catch {
				/* missing generation */
			}
		}
		if (this.keep >= 1) renameSync(this.file, `${this.file}.1`);
		else rmSync(this.file, { force: true });
	}
}
