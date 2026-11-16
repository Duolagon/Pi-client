import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildPtyHelper } from "../scripts/build-pty.mjs";
import { TerminalService } from "../src/terminal-service.ts";
import type { TerminalEvent } from "../src/terminal-types.ts";

let directory: string, helper: string;
before(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-desktop-pty-"));
	helper = await buildPtyHelper(join(directory, "pty-host"));
});
after(async () => {
	await rm(directory, { recursive: true, force: true });
});

function setup(maxBufferBytes?: number) {
	const service = new TerminalService({
		helperPath: helper,
		shell: "/bin/bash",
		maxBufferBytes,
		env: {
			HOME: directory,
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			PS1: "pty> ",
			PI_DESKTOP_KEY_OPENAI: "must-not-reach-shell",
			PI_DESKTOP_CONNECTIONS: "must-not-reach-shell",
			ELECTRON_RUN_AS_NODE: "1",
		},
	});
	const events: TerminalEvent[] = [];
	service.subscribe((event) => events.push(event));
	return { service, events };
}
async function waitForOutput(service: TerminalService, id: string, pattern: RegExp, timeout = 5000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const output = service
			.replay(id)
			.chunks.map((chunk) => chunk.data)
			.join("");
		if (pattern.test(output)) return output;
		await delay(20);
	}
	assert.fail(`Missing ${pattern} in ${JSON.stringify(service.replay(id))}`);
}
async function waitForExit(service: TerminalService, id: string) {
	const started = Date.now();
	while (Date.now() - started < 5000) {
		if (service.replay(id).terminal.status === "exited") return;
		await delay(20);
	}
	assert.fail("Terminal did not exit");
}
async function open(service: TerminalService, conversationId: string, cols?: number, rows?: number) {
	const terminal = await service.create({ conversationId, project: directory, cols, rows });
	await service.write(terminal.id, "set +H; printf '%s%s\\n' 'SHELL_' 'READY'\n");
	await waitForOutput(service, terminal.id, /SHELL_READY/);
	return terminal;
}

test(
	"persistent PTY has a controlling terminal, accepts input, resizes, and streams Unicode",
	{ timeout: 15000 },
	async () => {
		const { service, events } = setup();
		try {
			const terminal = await open(service, "session-one", 91, 27);
			assert.equal(terminal.status, "running");
			assert.ok(terminal.pid);
			await service.write(
				terminal.id,
				"if test -t 0 && test -t 1 && test -t 2; then printf 'isatty:%s\\n' yes; fi; printf 'size:%s\\n' \"$(stty size)\"\n",
			);
			await waitForOutput(service, terminal.id, /isatty:yes/);
			await waitForOutput(service, terminal.id, /size:27 91/);
			await service.write(
				terminal.id,
				'printf \'cwd:%s\\n\' "$PWD"; printf \'private:%s:%s:%s\\n\' "${PI_DESKTOP_KEY_OPENAI-unset}" "${PI_DESKTOP_CONNECTIONS-unset}" "${ELECTRON_RUN_AS_NODE-unset}"\n',
			);
			await waitForOutput(service, terminal.id, /private:unset:unset:unset/);
			await service.resize(terminal.id, 132, 42);
			await service.write(
				terminal.id,
				"printf 'size:%s\\n' \"$(stty size)\"; read -r answer; printf 'answer:%s\\n' \"$answer\"\n",
			);
			await waitForOutput(service, terminal.id, /size:42 132/);
			await service.write(terminal.id, "你好🦉\n");
			const output = await waitForOutput(service, terminal.id, /answer:你好🦉/);
			assert.match(output, /cwd:.*pi-desktop-pty-/);
			const chunks = service.replay(terminal.id).chunks;
			assert.deepEqual(
				chunks.map((chunk) => chunk.sequence),
				[...chunks.map((chunk) => chunk.sequence)].sort((a, b) => a - b),
			);
			const next = service.replay(terminal.id, chunks.at(-1)!.sequence);
			assert.deepEqual(next.chunks, []);
			assert.ok(events.some((event) => event.type === "terminal_data" && event.conversationId === "session-one"));
			await service.write(terminal.id, "exit 7\n");
			await waitForExit(service, terminal.id);
			assert.equal(service.replay(terminal.id).terminal.exitCode, 7);
			assert.ok(events.some((event) => event.type === "terminal_exit" && event.exitCode === 7));
			assert.throws(() => service.write(terminal.id, "echo late\n"), /已关闭/);
		} finally {
			await service.dispose();
		}
	},
);

test("Ctrl-C interrupts a foreground job and leaves the interactive shell usable", { timeout: 10000 }, async () => {
	const { service } = setup();
	try {
		const terminal = await open(service, "interrupt");
		await service.write(terminal.id, "sleep 30; printf 'cancel-status:%s\\n' \"$?\"\n");
		await delay(150);
		await service.write(terminal.id, "\u0003");
		await service.write(terminal.id, "printf '%s%s\\n' 'AFTER_' 'INTERRUPT'\n");
		await waitForOutput(service, terminal.id, /AFTER_INTERRUPT/);
		assert.equal(service.replay(terminal.id).terminal.status, "running");
	} finally {
		await service.dispose();
	}
});

test("closing a terminal terminates foreground and background descendants", { timeout: 15000 }, async () => {
	const { service } = setup();
	const marker = join(directory, "child-survived");
	try {
		const terminal = await open(service, "cleanup");
		await service.write(
			terminal.id,
			"sleep 30 & child=$!; printf 'background-pid:%s\\n' \"$child\"; (sleep 2; touch child-survived) & printf '%s%s\\n' 'JOBS_' 'READY'; sleep 30\n",
		);
		const output = await waitForOutput(service, terminal.id, /JOBS_READY/);
		const child = Number(output.match(/background-pid:(\d+)/)?.[1]);
		assert.ok(child > 0);
		await service.close(terminal.id);
		await service.close(terminal.id);
		assert.equal(service.replay(terminal.id).terminal.status, "exited");
		if (service.replay(terminal.id).terminal.signal) assert.equal(service.replay(terminal.id).terminal.exitCode, null);
		await delay(2200);
		await assert.rejects(access(marker));
		assert.throws(() => process.kill(child, 0), /ESRCH/);
	} finally {
		await service.dispose();
	}
});

test(
	"bounded replay retains recent output and validates terminal ownership operations",
	{ timeout: 10000 },
	async () => {
		const { service } = setup(1024);
		try {
			const terminal = await open(service, "bounded");
			await service.write(terminal.id, "head -c 10000 /dev/zero | tr '\\0' x; printf '%s%s\\n' 'OUTPUT_' 'END'\n");
			await waitForOutput(service, terminal.id, /OUTPUT_END/);
			const replay = service.replay(terminal.id);
			assert.ok(replay.truncated);
			assert.ok(Buffer.byteLength(replay.chunks.map((chunk) => chunk.data).join("")) <= 1024);
			assert.equal(service.list("bounded").length, 1);
			assert.equal(service.list("another-session").length, 0);
			await assert.rejects(service.resize(terminal.id, 0, 80), /尺寸/);
			assert.throws(() => service.write("missing", "x"), /不存在/);
			assert.throws(() => service.replay(terminal.id, -1), /序号/);
			await service.closeConversation("bounded");
			assert.equal(service.list("bounded")[0].status, "exited");
		} finally {
			await service.dispose();
		}
		await assert.rejects(service.create({ conversationId: "closed", project: directory }), /已关闭/);
	},
);

test("terminal startup failures reject without hanging or leaking a process", { timeout: 10000 }, async () => {
	const { service } = setup();
	try {
		await assert.rejects(
			service.create({ conversationId: "bad", project: directory, shell: "/does-not-exist" }),
			/ENOENT/,
		);
		const invalidShell = join(directory, "invalid-shell");
		await writeFile(invalidShell, "invalid executable\n");
		await chmod(invalidShell, 0o700);
		await assert.rejects(
			service.create({ conversationId: "bad-exec", project: directory, shell: invalidShell }),
			/execute|启动/,
		);
		await assert.rejects(service.create({ conversationId: "bad", project: join(directory, "missing") }), /ENOENT/);
		await assert.rejects(service.create({ conversationId: "bad", project: directory, cols: 1001 }), /尺寸/);
		assert.ok(service.list().every((terminal) => terminal.status === "exited"));
	} finally {
		await service.dispose();
	}
});

test(
	"concurrent terminal creation respects the limit and disposal closes the survivor",
	{ timeout: 10000 },
	async () => {
		const service = new TerminalService({
			helperPath: helper,
			shell: "/bin/bash",
			maxTerminals: 1,
			env: { HOME: directory },
		});
		try {
			const created = await Promise.allSettled([
				service.create({ conversationId: "one", project: directory }),
				service.create({ conversationId: "two", project: directory }),
			]);
			assert.equal(created.filter((result) => result.status === "fulfilled").length, 1);
			assert.equal(created.filter((result) => result.status === "rejected").length, 1);
			assert.equal(service.list().filter((terminal) => terminal.status === "running").length, 1);
			await service.dispose();
			assert.ok(service.list().every((terminal) => terminal.status === "exited"));
		} finally {
			await service.dispose();
		}
	},
);

test(
	"PTY framing preserves NUL bytes and output truncation preserves UTF-8 boundaries",
	{ timeout: 15000 },
	async () => {
		const { service } = setup(1024);
		try {
			const terminal = await open(service, "binary-and-unicode");
			await service.write(
				terminal.id,
				"stty -echo -icanon min 1 time 0; printf '%s%s\\n' 'RAW_' 'READY'; dd bs=1 count=3 2>/dev/null | od -An -tu1; stty sane; printf '%s%s\\n' 'RAW_' 'DONE'\n",
			);
			await waitForOutput(service, terminal.id, /RAW_READY/);
			await service.write(terminal.id, "\0A\0");
			const raw = await waitForOutput(service, terminal.id, /RAW_DONE/);
			assert.match(raw, /\b0\s+65\s+0\b/);
			await service.write(
				terminal.id,
				"for i in $(seq 1 2000); do printf '中文🙂'; done; printf '<%s%s>\\n' 'UNICODE_' 'END'\n",
			);
			const unicode = await waitForOutput(service, terminal.id, /<UNICODE_END>/);
			assert.ok(!unicode.includes("\ufffd"));
			assert.ok(Buffer.byteLength(unicode) <= 1024);
			assert.equal(service.replay(terminal.id).truncated, true);
		} finally {
			await service.dispose();
		}
	},
);

test("closing a PTY does not wait for a blocked input consumer", { timeout: 10000 }, async () => {
	const { service } = setup();
	try {
		const terminal = await open(service, "blocked-input");
		await service.write(terminal.id, "stty -echo; printf '%s%s\\n' 'BLOCK_' 'READY'; sleep 30\n");
		await waitForOutput(service, terminal.id, /BLOCK_READY/);
		assert.throws(() => service.write(terminal.id, "x".repeat(1024 * 1024 + 1)), /1 MB/);
		const writing = service.write(terminal.id, "x".repeat(1024 * 1024));
		await delay(20);
		const started = Date.now();
		await service.close(terminal.id);
		await Promise.allSettled([writing]);
		assert.ok(Date.now() - started < 3000);
		assert.equal(service.replay(terminal.id).terminal.status, "exited");
	} finally {
		await service.dispose();
	}
});

test("large awaited paste applies backpressure without terminating the shell", { timeout: 15000 }, async () => {
	const { service } = setup();
	try {
		const terminal = await open(service, "large-paste");
		await service.write(
			terminal.id,
			"stty -echo -icanon min 1 time 0; printf '%s%s\\n' 'PASTE_' 'READY'; head -c 8388608 > large-paste.bin; stty sane; printf '%s%s\\n' 'PASTE_' 'DONE'\n",
		);
		await waitForOutput(service, terminal.id, /PASTE_READY/);
		for (let index = 0; index < 8; index++) await service.write(terminal.id, "x".repeat(1024 * 1024));
		await waitForOutput(service, terminal.id, /PASTE_DONE/);
		assert.equal((await stat(join(directory, "large-paste.bin"))).size, 8 * 1024 * 1024);
		assert.equal(service.replay(terminal.id).terminal.status, "running");
	} finally {
		await service.dispose();
	}
});

test("excess concurrent input is rejected without killing the existing shell", { timeout: 15000 }, async () => {
	const { service } = setup();
	try {
		const terminal = await open(service, "bounded-input");
		await service.write(
			terminal.id,
			"stty -echo -icanon min 1 time 0; printf '%s%s\\n' 'QUEUE_' 'READY'; head -c 16777216 > bounded-input.bin; stty sane\n",
		);
		await waitForOutput(service, terminal.id, /QUEUE_READY/);
		const payload = "x".repeat(256 * 1024);
		const results = await Promise.allSettled(
			Array.from({ length: 32 }, () => Promise.resolve().then(() => service.write(terminal.id, payload))),
		);
		const rejected = results.filter((result) => result.status === "rejected");
		assert.ok(rejected.length > 0);
		assert.ok(rejected.every((result) => result.status === "rejected" && /输入缓冲已满/.test(String(result.reason))));
		const expectedBytes = results.filter((result) => result.status === "fulfilled").length * Buffer.byteLength(payload);
		const started = Date.now();
		while ((await stat(join(directory, "bounded-input.bin"))).size < expectedBytes && Date.now() - started < 5000)
			await delay(20);
		assert.equal((await stat(join(directory, "bounded-input.bin"))).size, expectedBytes);
		await service.write(terminal.id, "\u0003");
		await service.write(terminal.id, "printf '%s%s\\n' 'AFTER_QUEUE_' 'LIMIT'\n");
		await waitForOutput(service, terminal.id, /AFTER_QUEUE_LIMIT/);
		assert.equal(service.replay(terminal.id).terminal.status, "running");
	} finally {
		await service.dispose();
	}
});

test(
	"terminal close escalates cleanup for descendants that ignore hangup and termination",
	{ timeout: 10000 },
	async () => {
		const { service } = setup();
		const pids: number[] = [];
		try {
			const terminal = await open(service, "resistant-jobs");
			await service.write(
				terminal.id,
				'sh -c \'trap "" HUP TERM; echo $$ > resistant.pid; sleep 30 & echo $! > resistant-child.pid; printf "%s%s\\n" "RESISTANT_" "READY"; wait\' &\n',
			);
			await waitForOutput(service, terminal.id, /RESISTANT_READY/);
			for (const name of ["resistant.pid", "resistant-child.pid"])
				pids.push(Number(await readFile(join(directory, name), "utf8")));
			await service.close(terminal.id);
			await delay(100);
			for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
		} finally {
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await service.dispose();
		}
	},
);
