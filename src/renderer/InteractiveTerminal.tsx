import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

export function InteractiveTerminal({ id, readOnly, fail }: { id: string; readOnly: boolean; fail: (error: unknown) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const terminal = useRef<Terminal | null>(null);

	useEffect(() => {
		if (!host.current) return;
		let disposed = false;
		let ready = false;
		let sequence = 0;
		const queued = new Map<number, string>();
		const term = new Terminal({
			fontFamily: "SFMono-Regular, Consolas, monospace",
			fontSize: 12,
			scrollback: 3000,
			cursorBlink: true,
			disableStdin: readOnly,
			linkHandler: { activate: () => {} },
		});
		terminal.current = term;
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host.current);
		const resize = term.onResize(({ cols, rows }) => { if (ready && !disposed) void window.pi.terminals.resize(id, cols, rows).catch(() => {}); });
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host.current);
		const input = term.onData((data) => { if (ready && !disposed && !term.options.disableStdin) void window.pi.terminals.write(id, data).catch(fail); });
		const unsubscribe = window.pi.terminals.onEvent((event) => {
			if (event.terminalId !== id) return;
			if (event.type === "terminal_exit") term.options.disableStdin = true;
			else if (!ready) queued.set(event.sequence, event.data);
			else if (event.sequence > sequence) {
				sequence = event.sequence;
				term.write(event.data);
			}
		});
		void window.pi.terminals.replay(id).then((replay) => {
			if (disposed) return;
			for (const chunk of replay.chunks) term.write(chunk.data);
			sequence = replay.nextSequence - 1;
			for (const [eventSequence, data] of [...queued].sort(([a], [b]) => a - b)) {
				if (eventSequence > sequence) {
					term.write(data);
					sequence = eventSequence;
				}
			}
			queued.clear();
			ready = true;
			if (replay.terminal.status === "exited") term.options.disableStdin = true;
			fit.fit();
			void window.pi.terminals.resize(id, term.cols, term.rows).catch(() => {});
		}).catch((error) => { if (!disposed) fail(error); });
		return () => {
			disposed = true;
			terminal.current = null;
			observer.disconnect();
			unsubscribe();
			input.dispose();
			resize.dispose();
			term.dispose();
		};
	}, [id, fail]);

	useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = readOnly; }, [readOnly]);
	return <div className="cc-interactive-terminal" aria-label="交互终端画面" ref={host} />;
}
