import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
const exec = promisify(execFile);

/**
 * Network variables worth inheriting from the login shell. Finder-launched apps
 * miss them, which breaks model requests behind a corporate proxy. Nothing
 * else is read, so credentials exported in shell profiles stay out.
 */
export const INHERITED_NETWORK_ENV = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"NO_PROXY",
	"no_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NODE_EXTRA_CA_CERTS",
] as const;

export interface ShellEnvironment {
	path: string;
	network: Partial<Record<(typeof INHERITED_NETWORK_ENV)[number], string>>;
}

const marker = "__PI_DESKTOP_SHELL_ENV__";

/** Parses the marker-delimited output; exported for tests. */
export function parseShellEnvironment(stdout: string): ShellEnvironment | undefined {
	const parts = stdout.split(marker);
	if (parts.length < 3) return undefined;
	const [path, ...values] = parts.slice(1, 2 + INHERITED_NETWORK_ENV.length);
	const network: ShellEnvironment["network"] = {};
	INHERITED_NETWORK_ENV.forEach((name, index) => {
		const value = values[index];
		if (value && value.length <= 4096 && !/[\r\n\0]/.test(value)) network[name] = value;
	});
	return { path, network };
}

/** Finder does not inherit Homebrew/nvm PATH or proxy settings; capture only those. */
export async function captureShellEnvironment(): Promise<ShellEnvironment> {
	const fallback = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		`${homedir()}/.local/bin`,
		process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
	].join(":");
	if (process.platform !== "darwin") return { path: process.env.PATH ?? fallback, network: {} };
	try {
		const script = [`printf '${marker}'; printf '%s' "$PATH"`, ...INHERITED_NETWORK_ENV.map((name) => `printf '${marker}'; printf '%s' "$${name}"`), `printf '${marker}'`].join("; ");
		const { stdout } = await exec(process.env.SHELL ?? "/bin/zsh", ["-l", "-i", "-c", script], {
			timeout: 8000,
			maxBuffer: 1024 * 1024,
		});
		const parsed = parseShellEnvironment(stdout);
		return parsed ? { path: parsed.path || fallback, network: parsed.network } : { path: fallback, network: {} };
	} catch {
		return { path: fallback, network: {} };
	}
}

/** Adds shell network variables without overriding values the app was launched with. */
export function mergeNetworkEnvironment(target: NodeJS.ProcessEnv, network: ShellEnvironment["network"]): void {
	for (const [name, value] of Object.entries(network)) {
		const upper = name.toUpperCase();
		if (target[name] === undefined && target[upper] === undefined && target[upper.toLowerCase()] === undefined)
			target[name] = value;
	}
}
