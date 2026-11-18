import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

let cachedSupport: Promise<{ supported: boolean; reason?: string }> | undefined;

/** Probe once whether macOS Seatbelt sandbox-exec can apply in this host environment. */
export async function probeSeatbeltSupport(): Promise<{ supported: boolean; reason?: string }> {
	if (process.platform !== "darwin") {
		return { supported: false, reason: "OS 命令行沙箱当前仅支持 macOS (sandbox-exec)。" };
	}
	if (!cachedSupport) {
		cachedSupport = exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 3000 })
			.then(() => ({ supported: true }))
			.catch((error: unknown) => ({
				supported: false,
				reason: error instanceof Error ? error.message : String(error),
			}));
	}
	return cachedSupport;
}

function escapeSeatbeltString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Build a Seatbelt profile restricting file writes to the workspace and temp directories.
 * Reads stay unrestricted so language toolchains and system headers work cleanly.
 */
export function buildSeatbeltProfile(project: string, extraWritablePaths: string[] = []): string {
	const roots = [project, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", ...extraWritablePaths]
		.filter(Boolean)
		.map((item) => `(subpath "${escapeSeatbeltString(item)}")`)
		.join("\n    ");
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write*`,
		`    (literal "/dev/null")`,
		`    (literal "/dev/tty")`,
		`    (regex #"^/dev/fd/")`,
		`    ${roots})`,
	].join("\n");
}
