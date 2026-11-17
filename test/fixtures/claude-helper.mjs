import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
let run;
let writes = Promise.resolve();
let sessionId = "claude-wire-session";
const send = (value) => {
	const bytes = Buffer.from(JSON.stringify(value) + "\n");
	writes = writes.then(() => new Promise((resolve) => {
		const cut = bytes.indexOf(Buffer.from("中文")) + 1;
		process.stdout.write(bytes.subarray(0, Math.max(1, cut)));
		setImmediate(() => process.stdout.write(bytes.subarray(Math.max(1, cut)), resolve));
	}));
};
const response = (id, value) => send({ type: "response", id, ok: true, value });
createInterface({ input: process.stdin }).on("line", (line) => {
	const input = JSON.parse(line);
	if (input.type === "init") { sessionId = input.config.resumeSessionId ?? sessionId; response(input.id); }
	else if (input.type === "run") {
		if (input.prompt === "broken") { process.stdout.write("not-json\n"); return; }
		if (input.prompt === "exit") process.exit(17);
		run = input;
		if (input.prompt === "wait-child") {
			const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
			send({ type: "event", event: { type: "diagnostic", message: `CHILD_PID:${child.pid}` } });
		}
		send({ type: "event", event: { type: "session", sessionId } });
		send({ type: "event", event: { type: "tool_start", id: "native-tool", name: "Bash", input: { command: "printf hello" } } });
		send({ type: "permission", request: { id: "approval-" + input.id, kind: "command", toolName: "Bash", input: { command: "printf hello" } } });
	} else if (input.type === "permission_response") {
		if (!run || run.prompt.startsWith("wait")) return;
		send({ type: "event", event: { type: "text_delta", text: "中文 hello " + run.prompt } });
		send({ type: "event", event: { type: "tool_end", id: "native-tool", isError: input.response.decision !== "allow" } });
		response(run.id, { status: "completed", text: "中文 hello " + run.prompt, sessionId });
		run = undefined;
	} else if (input.type === "interrupt") {
		if (run) { response(run.id, { status: "cancelled", text: "", sessionId }); run = undefined; }
		response(input.id);
	} else if (input.type === "close") { response(input.id); writes.then(() => process.exit(0)); }
});
