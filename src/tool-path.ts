import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Finder does not inherit Homebrew/nvm PATH; capture just tool lookup, never credential values. */
export async function captureToolPath(): Promise<string> {
	const fallback = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		`${homedir()}/.local/bin`,
		process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
	].join(":");
	if (process.platform !== "darwin") return process.env.PATH ?? fallback;
	try {
		const marker = "__PI_DESKTOP_TOOL_PATH__";
		const { stdout } = await exec(
			process.env.SHELL ?? "/bin/zsh",
			["-l", "-i", "-c", `printf '${marker}'; printf '%s' "$PATH"; printf '${marker}'`],
			{ timeout: 8000, maxBuffer: 1024 * 1024 },
		);
		return stdout.split(marker)[1] || fallback;
	} catch {
		return fallback;
	}
}
