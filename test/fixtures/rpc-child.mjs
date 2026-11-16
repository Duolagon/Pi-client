// Controlled subprocess for byte framing and process failure regression tests.
let buffer = "";
const scenario = process.env.PI_RPC_TEST_SCENARIO;
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const command = JSON.parse(line);
    if (scenario === "hang") continue;
    if (scenario === "exit") { process.exit(43); return; }
    if (scenario === "error") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Expected rejection" }) + "\n");
      continue;
    }
    const record = Buffer.from(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "中文\u2028line\u2029tail" } }) + "\r\n");
    const split = record.indexOf(Buffer.from("中文")) + 1;
    process.stdout.write(record.subarray(0, split));
    setTimeout(() => process.stdout.write(record.subarray(split)), 5);
  }
});
process.stdin.on("end", () => process.exit(0));
