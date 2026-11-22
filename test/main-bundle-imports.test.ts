import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

// pi-coding-agent's config module reads import.meta.url, which is undefined in the CommonJS main
// process bundle, so the packaged app crashed at startup when main.ts reached it.
test("the main process bundle does not pull in @earendil-works/pi-coding-agent at runtime", async () => {
	const result = await build({
		entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs", write: false, metafile: true,
		external: ["electron"], packages: "bundle", logLevel: "silent",
	});
	const inputs = Object.keys(result.metafile.inputs).filter((path) => path.includes("@earendil-works/pi-coding-agent/dist/config"));
	assert.deepEqual(inputs, []);
});

test("host-guard.ts stays free of pi-coding-agent imports", () => {
	const source = readFileSync("src/host-guard.ts", "utf8");
	assert.equal(/from "@earendil-works\/pi-coding-agent"/.test(source), false);
	if (existsSync("dist/main.cjs")) assert.equal(readFileSync("dist/main.cjs", "utf8").includes("pi-coding-agent/dist/config"), false);
});
