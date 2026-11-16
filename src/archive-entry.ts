import { readFile } from "node:fs/promises";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

// This read-only helper reuses the packaged Pi session parser without loading its SDK into Electron's CJS host.
const [sessionFile, project] = process.argv.slice(2);
if (!sessionFile || !project) throw new Error("缺少会话存档路径。");
const entries = parseSessionEntries(await readFile(sessionFile, "utf8"));
const messages = SessionManager.inMemory(project, undefined, entries).buildSessionContext().messages;
process.stdout.write(JSON.stringify(messages));
