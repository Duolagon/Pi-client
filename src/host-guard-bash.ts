// Guarded foreground bash for the tool-control extension (ESM). Kept apart from host-guard.ts because
// host-guard.ts is bundled into the CommonJS main process, where @earendil-works/pi-coding-agent cannot load.
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { DEFAULT_NICE_VALUE, HostResourceGuard, buildSafeComputeEnv, killProcessGroup, resolveNiceCommand, sharedHostGuard } from "./host-guard.ts";

function resolveUnixShell(shellPath?: string): string {
	if (shellPath && existsSync(shellPath)) return shellPath;
	if (existsSync("/bin/bash")) return "/bin/bash";
	return "/bin/sh";
}

/**
 * Drop-in `BashOperations` for foreground `bash` calls:
 * - runs at low CPU priority (`nice -n 10`) so OS UI and networking stay responsive
 * - sets safe default BLAS/OpenMP thread-pool caps
 * - registers the detached process group with `HostResourceGuard` for OOM/swap-storm circuit-breaking
 * - kills the entire process group reliably (`SIGSTOP` + `SIGKILL` on macOS) on abort, timeout, or guard kill
 */
export function createGuardedBashOperations(options?: {
	shellPath?: string;
	guard?: HostResourceGuard;
	niceValue?: number;
}): BashOperations {
	if (process.platform === "win32") {
		return createLocalBashOperations({ shellPath: options?.shellPath });
	}
	const guard = options?.guard ?? sharedHostGuard;
	const niceValue = options?.niceValue ?? DEFAULT_NICE_VALUE;
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const shell = resolveUnixShell(options?.shellPath);
			const launch = resolveNiceCommand(shell, ["-c", command], niceValue);
			const child = spawn(launch.command, launch.args, {
				cwd,
				detached: true,
				env: buildSafeComputeEnv(env ?? process.env),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			let timedOut = false;
			let guardKillReason: string | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const pid = child.pid;

			if (pid) {
				guard.register(pid, {
					label: command.trim().slice(0, 80) || "bash",
					onKill: (reason) => {
						guardKillReason = reason;
						try {
							onData(Buffer.from(`\n${reason}\n`, "utf8"));
						} catch {}
					},
				});
			}

			const onAbort = () => {
				if (pid) killProcessGroup(pid);
			};

			try {
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (pid) killProcessGroup(pid);
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				const exitCode = await new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", (code) => resolve(code));
				});

				if (guardKillReason) throw new Error(guardKillReason);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);

				const signalCode = child.signalCode;
				const resolvedExitCode = exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
				return { exitCode: resolvedExitCode };
			} finally {
				if (pid) guard.unregister(pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}
