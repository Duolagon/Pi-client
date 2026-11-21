import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPtyHelper } from "./build-pty.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = resolve(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))),
	"../..",
);
const require = createRequire(resolve(agent, "package.json"));
const backendOnly = process.argv.includes("--backend-only");
if (!backendOnly) await rm(resolve(app, "dist"), { recursive: true, force: true });
await mkdir(resolve(app, "dist"), { recursive: true });
if (process.platform === "win32") await mkdir(resolve(app, "dist/native"), { recursive: true });
else await buildPtyHelper(resolve(app, "dist/native/pty-host"));
const common = { absWorkingDir: app, bundle: true, sourcemap: true, logLevel: "info", tsconfig: "tsconfig.json" };
await Promise.all([
	build({
		...common,
		entryPoints: ["src/main.ts"],
		outfile: "dist/main.cjs",
		platform: "node",
		format: "cjs",
		external: ["electron"],
		target: "node22",
	}),
	build({
		...common,
		entryPoints: ["src/preload.ts"],
		outfile: "dist/preload.cjs",
		platform: "node",
		format: "cjs",
		external: ["electron"],
		target: "node22",
	}),
	...(backendOnly
		? []
		: [
				build({
					...common,
					entryPoints: ["src/renderer/main.tsx"],
					outfile: "dist/app.js",
					platform: "browser",
					format: "esm",
					target: "chrome130",
					define: { "process.env.NODE_ENV": '"production"' },
				}),
			]),
	build({
		...common,
		entryPoints: ["src/permission-extension.ts"],
		outfile: "dist/permission-extension.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
	}),
	build({
		...common,
		entryPoints: ["src/tool-control-extension.ts"],
		outfile: "dist/tool-control-extension.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
		// Pi resolves its own package for extensions; bundling a second copy would duplicate it.
		external: ["@earendil-works/pi-coding-agent"],
	}),
	build({
		...common,
		entryPoints: ["src/workflow-worker-entry.ts"],
		outfile: "dist/workflow-worker-entry.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
	}),
	build({
		...common,
		entryPoints: ["src/external-claude-helper.ts"],
		outfile: "dist/external-claude-helper.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
		banner: { js: 'import { createRequire as __sdkCreateRequire } from "node:module"; const require = __sdkCreateRequire(import.meta.url);' },
	}),
	build({
		...common,
		entryPoints: ["src/session-navigation-extension.ts"],
		outfile: "dist/session-navigation-extension.mjs",
		platform: "node",
		format: "esm",
		external: ["@earendil-works/pi-ai"],
		target: "node22",
	}),
	build({
		...common,
		entryPoints: ["src/session-history-entry.ts"],
		outfile: "dist/session-history-entry.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
		plugins: [
			{
				name: "packaged-session-history-sdk",
				setup(builder) {
					builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
						path: "./dist/bundle/index.js",
						external: true,
					}));
				},
			},
		],
	}),
	build({
		...common,
		entryPoints: ["src/archive-entry.ts"],
		outfile: "dist/archive-entry.mjs",
		platform: "node",
		format: "esm",
		target: "node22",
		plugins: [
			{
				name: "packaged-session-sdk",
				setup(builder) {
					builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
						path: "./dist/bundle/index.js",
						external: true,
					}));
				},
			},
		],
	}),
]);
if (!backendOnly) await cp(resolve(app, "src/renderer/index.html"), resolve(app, "dist/index.html"));
// Ship the upstream RPC bundle outside ASAR so worker URLs and extensions remain usable.
const runtime = resolve(app, "dist/runtime");
await cp(resolve(agent, "dist/bundle"), resolve(runtime, "dist/bundle"), { recursive: true });
await cp(resolve(agent, "dist/modes"), resolve(runtime, "dist/modes"), { recursive: true });
await cp(resolve(agent, "dist/core/export-html"), resolve(runtime, "dist/core/export-html"), { recursive: true });
await cp(resolve(agent, "package.json"), resolve(runtime, "package.json"));
await cp(resolve(agent, "README.md"), resolve(runtime, "README.md"));
await cp(resolve(agent, "CHANGELOG.md"), resolve(runtime, "CHANGELOG.md"));
await cp(resolve(agent, "docs"), resolve(runtime, "docs"), { recursive: true });
await cp(resolve(app, "LICENSE"), resolve(runtime, "LICENSE"));
await cp(resolve(app, "NOTICE.md"), resolve(runtime, "NOTICE.md"));
await cp(resolve(app, "dist/permission-extension.mjs"), resolve(runtime, "permission-extension.mjs"));
await cp(resolve(app, "dist/tool-control-extension.mjs"), resolve(runtime, "tool-control-extension.mjs"));
await cp(resolve(app, "dist/workflow-worker-entry.mjs"), resolve(runtime, "workflow-worker-entry.mjs"));
await cp(resolve(app, "dist/external-claude-helper.mjs"), resolve(runtime, "external-claude-helper.mjs"));
await mkdir(resolve(runtime, "licenses"), { recursive: true });
await cp(resolve(app, "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md"), resolve(runtime, "licenses/claude-agent-sdk-LICENSE.md"));
await cp(resolve(app, "dist/archive-entry.mjs"), resolve(runtime, "archive-entry.mjs"));
await cp(resolve(app, "dist/session-history-entry.mjs"), resolve(runtime, "session-history-entry.mjs"));
await cp(resolve(app, "dist/session-navigation-extension.mjs"), resolve(runtime, "session-navigation-extension.mjs"));
for (const name of ["jiti", "@silvia-odwyer/photon-node"]) {
	const location = dirname(require.resolve(`${name}/package.json`));
	await cp(location, resolve(runtime, "node_modules", name), { recursive: true });
}
const manifest = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
await writeFile(resolve(app, "dist/version.json"), JSON.stringify({ version: manifest.version }));
// Runtime modules are shipped explicitly; the application ASAR contains the bundled host and renderer.
await writeFile(
	resolve(app, "dist/package.json"),
	JSON.stringify(
		{
			name: "pi-desktop",
			productName: "Pi Desktop",
			version: manifest.version,
			description: manifest.description,
			author: manifest.author,
			license: manifest.license,
			main: "main.cjs",
			private: true,
		},
		null,
		2,
	),
);
