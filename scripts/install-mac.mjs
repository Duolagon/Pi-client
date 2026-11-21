// Replace-installs the packaged app into /Applications so only one Pi Desktop exists on the machine.
// Run after `npm run package` (or use `npm run install:app`, which packages first).
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.error("install:app 只支持 macOS。");
	process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Pi Desktop.app";
const built = join(repo, "release/desktop", process.arch === "arm64" ? "mac-arm64" : "mac", appName);
const target = join("/Applications", appName);
const staging = join("/Applications", `.${appName}.installing`);
const lsregister =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function plistValue(app, key) {
	try {
		return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], {
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

function runningCopies() {
	try {
		return execFileSync("/usr/bin/pgrep", ["-fl", "Pi Desktop.app/Contents/MacOS/Pi Desktop"], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

if (!existsSync(built)) {
	console.error(`没有找到构建产物：${built}\n请先运行 npm run package。`);
	process.exit(1);
}

// Never terminate the user's running client; ask them to quit it instead.
const running = runningCopies();
if (running.length) {
	console.error("Pi Desktop 正在运行。请先用 ⌘Q 退出，再重新运行安装。");
	process.exit(1);
}

const builtId = plistValue(built, "CFBundleIdentifier");
const installedId = existsSync(target) ? plistValue(target, "CFBundleIdentifier") : undefined;
if (installedId && installedId !== builtId) {
	console.error(`/Applications 里的 ${appName} 属于另一个应用（${installedId}），已停止，没有覆盖。`);
	process.exit(1);
}

// Copy next to the target first, then swap, so a failed copy never leaves /Applications without an app.
rmSync(staging, { recursive: true, force: true });
execFileSync("/usr/bin/ditto", [built, staging]);
const backup = join("/Applications", `.${appName}.old`);
rmSync(backup, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, backup);
try {
	renameSync(staging, target);
} catch (error) {
	if (existsSync(backup) && !existsSync(target)) renameSync(backup, target);
	throw error;
}
try {
	rmSync(backup, { recursive: true, force: true });
} catch {
	console.warn(`旧版本没能删干净，残留在 ${backup}，可以手动删除。`);
}

// Drop the build copy so Launchpad and Spotlight show a single Pi Desktop.
rmSync(built, { recursive: true, force: true });
try {
	execFileSync(lsregister, ["-u", built], { stdio: "ignore" });
} catch {
	// The build copy may never have been registered.
}
execFileSync(lsregister, ["-f", target], { stdio: "ignore" });

const version = plistValue(target, "CFBundleShortVersionString") ?? "?";
console.log(`已替换安装 ${target}（${version}）。构建目录里的副本已移除。`);
