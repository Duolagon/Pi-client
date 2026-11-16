import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Create an isolated global extension, test credentials, and disposable project. */
export async function createCoreFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-core-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const dataDir = join(root, "desktop");
	await mkdir(project);
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(dataDir);
	await cp(
		join(dirname(fileURLToPath(import.meta.url)), "faux-provider.js"),
		join(agentDir, "extensions", "faux-provider.js"),
	);
	await writeFile(join(project, "seed.txt"), "seed-content\n");
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "desktop-test",
			defaultModel: "desktop-test-1",
			thinkingLevel: "off",
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_DESKTOP_DATA_DIR: dataDir,
		PI_DESKTOP_WORKSPACE: project,
		PI_OFFLINE: "1",
	};
	for (const key of Object.keys(env)) {
		if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|AWS_|GOOGLE_APPLICATION_CREDENTIALS)/.test(key))
			env[key] = undefined;
	}
	return {
		root,
		project,
		agentDir,
		dataDir,
		env,
		entry: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
