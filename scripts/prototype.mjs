import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(app, "prototype");
await mkdir(output, { recursive: true });
await build({
	absWorkingDir: app,
	entryPoints: ["src/prototype/App.tsx"],
	outfile: "prototype/app.js",
	bundle: true,
	minify: true,
	platform: "browser",
	target: "chrome130",
	format: "iife",
	tsconfig: "tsconfig.json",
	define: { "process.env.NODE_ENV": '"production"' },
	legalComments: "none",
	logLevel: "info",
});
const [js, css] = await Promise.all([
	readFile(resolve(output, "app.js"), "utf8"),
	readFile(resolve(output, "app.css"), "utf8"),
]);
const page = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="description" content="Pi Desktop 可交互界面原型。所有会话、代码修改与执行结果均为演示数据。"><title>Pi Desktop · 交互原型</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(resolve(output, "index.html"), page);
await build({
	absWorkingDir: app,
	entryPoints: ["src/prototype/shell.ts"],
	outfile: "prototype/shell.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
	logLevel: "info",
});
await writeFile(
	resolve(output, "package.json"),
	JSON.stringify(
		{
			name: "pi-desktop-preview",
			productName: "Pi Desktop Preview",
			version: "0.1.0",
			description: "Interactive desktop interface prototype",
			author: "Pi Desktop contributors",
			main: "shell.cjs",
			private: true,
		},
		null,
		2,
	),
);
console.log(`Prototype: ${resolve(output, "index.html")}`);
if (process.argv.includes("--serve")) {
	const port = Number(process.env.PI_PREVIEW_PORT ?? 4317);
	const server = createServer(async (request, response) => {
		if (request.url !== "/" && request.url !== "/index.html" && request.url !== "/favicon.ico") {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		if (request.url === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
		});
		response.end(await readFile(resolve(output, "index.html"), "utf8"));
	});
	server.on("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	server.listen(port, "127.0.0.1", () => console.log(`Review at http://127.0.0.1:${port}`));
}
