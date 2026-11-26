import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

function getXtermTheme(): ITheme {
	const mode = typeof document !== "undefined" ? document.documentElement.dataset.theme : "dark";
	if (mode === "light") {
		return {
			background: "#f8fafc",
			foreground: "#0f172a",
			cursor: "#2563eb",
			cursorAccent: "#ffffff",
			selectionBackground: "rgba(37, 99, 235, 0.18)",
			black: "#0f172a",
			red: "#dc2626",
			green: "#0f766e",
			yellow: "#b45309",
			blue: "#2563eb",
			magenta: "#7c3aed",
			cyan: "#0891b2",
			white: "#475569",
			brightBlack: "#64748b",
			brightRed: "#ef4444",
			brightGreen: "#14b8a6",
			brightYellow: "#d97706",
			brightBlue: "#3b82f6",
			brightMagenta: "#8b5cf6",
			brightCyan: "#06b6d4",
			brightWhite: "#0f172a",
		};
	}
	if (mode === "grail") {
		return {
			background: "#090e22",
			foreground: "#eef1ff",
			cursor: "#f2c96b",
			cursorAccent: "#090e22",
			selectionBackground: "rgba(242, 201, 107, 0.22)",
			black: "#0a0f24",
			red: "#ff8fa3",
			green: "#7be0b8",
			yellow: "#f2c96b",
			blue: "#8ea2ff",
			magenta: "#c4a7ff",
			cyan: "#7dd3fc",
			white: "#dbe4ff",
			brightBlack: "#64748b",
			brightRed: "#fda4af",
			brightGreen: "#6ee7b7",
			brightYellow: "#fde68a",
			brightBlue: "#a5b4fc",
			brightMagenta: "#d8b4fe",
			brightCyan: "#a5f3fc",
			brightWhite: "#ffffff",
		};
	}
	return {
		background: "#13161b",
		foreground: "#e6e9ee",
		cursor: "#5b9cff",
		cursorAccent: "#13161b",
		selectionBackground: "rgba(91, 156, 255, 0.24)",
		black: "#16191e",
		red: "#f2706d",
		green: "#4cc38a",
		yellow: "#e0a94a",
		blue: "#5b9cff",
		magenta: "#c084fc",
		cyan: "#38bdf8",
		white: "#cbd5e1",
		brightBlack: "#64748b",
		brightRed: "#f87171",
		brightGreen: "#6ee7b7",
		brightYellow: "#fbbf24",
		brightBlue: "#93c5fd",
		brightMagenta: "#d8b4fe",
		brightCyan: "#7dd3fc",
		brightWhite: "#f8fafc",
	};
}

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
			fontFamily: '"SF Mono", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
			fontSize: 12.5,
			lineHeight: 1.38,
			scrollback: 3000,
			cursorBlink: true,
			disableStdin: readOnly,
			theme: getXtermTheme(),
			linkHandler: { activate: () => {} },
		});
		terminal.current = term;
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host.current);
		const themeObserver = new MutationObserver(() => {
			if (!disposed) term.options.theme = getXtermTheme();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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
			if (!readOnly && replay.terminal.status !== "exited") {
				requestAnimationFrame(() => {
					if (!disposed) term.focus();
				});
			}
		}).catch((error) => { if (!disposed) fail(error); });
		return () => {
			disposed = true;
			terminal.current = null;
			themeObserver.disconnect();
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
