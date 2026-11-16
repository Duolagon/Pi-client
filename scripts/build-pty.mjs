import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Compile the platform-native terminal host without npm dependency lifecycle scripts. */
export async function buildPtyHelper(destination = resolve(appDir, "dist/native/pty-host")) {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new Error("The PTY host currently supports macOS and Linux.");
	const output = resolve(destination);
	await mkdir(dirname(output), { recursive: true });
	const flags = ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", resolve(appDir, "native/pty-host.c"), "-o", output];
	if (process.platform === "linux") flags.push("-lutil");
	await exec("cc", flags, { maxBuffer: 1024 * 1024 });
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	console.log(await buildPtyHelper(process.argv[2]));
