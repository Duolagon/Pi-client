import { useEffect, useRef, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { IconButton } from "../prototype/ui.tsx";
import type { TerminalInfo } from "../shared.ts";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
}

export function TerminalPanel({
	conversationId,
	project,
	ready,
	blocked,
	readOnly,
	bashBusy,
	bashOutput,
	onRunBash,
	onAbortBash,
	onClose,
	fail,
}: {
	conversationId?: string;
	project?: string;
	ready: boolean;
	blocked: boolean;
	readOnly: boolean;
	bashBusy: boolean;
	bashOutput: string;
	onRunBash: (cmd: string) => Promise<void>;
	onAbortBash: () => void;
	onClose: () => void;
	fail: (error: unknown) => void;
}) {
	const [mode, setMode] = useState<"bash" | "pty">("bash");
	const [shellInput, setShellInput] = useState("");
	const [ptyInput, setPtyInput] = useState("");
	const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [ptyOutputs, setPtyOutputs] = useState<Record<string, string>>({});
	const shellRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		shellRef.current?.scrollTo({ top: shellRef.current.scrollHeight });
	}, [bashOutput, ptyOutputs, activeId, mode]);

	useEffect(() => {
		if (!conversationId) return;
		void window.pi.terminals.list(conversationId).then(async (list) => {
			setTerminals(list);
			const live = [...list].reverse().find((t) => t.status === "running" || t.status === "starting") ?? list[list.length - 1];
			if (live) {
				setActiveId(live.id);
				try {
					const rep = await window.pi.terminals.replay(live.id);
					setPtyOutputs((prev) => ({
						...prev,
						[live.id]: stripAnsi(rep.chunks.map((c) => c.data).join("")).slice(-80000),
					}));
				} catch {
					/* ignore replay error on closed terminal */
				}
			}
		}).catch(fail);

		const unsub = window.pi.terminals.onEvent((event) => {
			if (event.conversationId !== conversationId) return;
			if (event.type === "terminal_data") {
				setPtyOutputs((prev) => ({
					...prev,
					[event.terminalId]: ((prev[event.terminalId] ?? "") + stripAnsi(event.data)).slice(-80000),
				}));
			} else if (event.type === "terminal_exit") {
				setTerminals((prev) =>
					prev.map((t) => (t.id === event.terminalId ? { ...t, status: "exited", exitCode: event.exitCode } : t)),
				);
			}
		});
		return unsub;
	}, [conversationId]);

	const createPty = async () => {
		if (!conversationId || !project) return;
		try {
			const info = await window.pi.terminals.create({ conversationId, cols: 100, rows: 24 });
			setTerminals((prev) => [...prev, info]);
			setActiveId(info.id);
			setMode("pty");
		} catch (error) {
			fail(error);
		}
	};

	const activePty = terminals.find((t) => t.id === activeId);

	return (
		<section className="terminal-panel" aria-label="集成终端">
			<header>
				<span className="cc-term-title">
					<TerminalIcon size={14} />
					<button
						type="button"
						className={`cc-term-tab ${mode === "bash" ? "active" : ""}`}
						onClick={() => setMode("bash")}
					>
						单次命令
					</button>
					<button
						type="button"
						className={`cc-term-tab ${mode === "pty" ? "active" : ""}`}
						onClick={() => {
							setMode("pty");
							const live = [...terminals].reverse().find((t) => t.status === "running" || t.status === "starting");
							if (live) setActiveId(live.id);
							else void createPty();
						}}
					>
						交互 PTY ({terminals.filter((t) => t.status === "running" || t.status === "starting").length})
					</button>
				</span>
				<span className="terminal-demo">{project}</span>
				{mode === "bash" && bashBusy && <button onClick={onAbortBash}>停止命令</button>}
				{mode === "pty" && (
					<>
						<button type="button" onClick={() => void createPty()} title="新建 PTY">
							<Plus size={13} />
						</button>
						{activePty && activePty.status === "running" && (
							<button type="button" onClick={() => void window.pi.terminals.write(activePty.id, "\x03")}>
								Ctrl-C
							</button>
						)}
					</>
				)}
				<IconButton icon={X} label="关闭终端" onClick={onClose} />
			</header>

			{mode === "bash" ? (
				<div className="terminal-output" ref={shellRef}>
					<pre>{bashOutput || "直接输入命令在当前项目运行，输出会加入会话上下文。"}</pre>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (shellInput.trim()) {
								void onRunBash(shellInput.trim());
								setShellInput("");
							}
						}}
					>
						<label htmlFor="shell-command">$</label>
						<input
							id="shell-command"
							aria-label="终端命令"
							value={shellInput}
							onChange={(event) => setShellInput(event.target.value)}
							disabled={blocked || !ready || !conversationId || readOnly}
							placeholder={readOnly ? "只读模式下不可执行命令" : "输入命令后按 Enter"}
						/>
					</form>
				</div>
			) : (
				<div className="terminal-output" ref={shellRef}>
					<pre>{activeId ? ptyOutputs[activeId] || "PTY 已就绪，输入命令并回车…" : "点击上方 + 创建交互式终端"}</pre>
					{activeId && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void window.pi.terminals.write(activeId, `${ptyInput}\r`);
								setPtyInput("");
							}}
						>
							<label htmlFor="pty-command">&gt;</label>
							<input
								id="pty-command"
								aria-label="PTY 输入"
								value={ptyInput}
								onChange={(event) => setPtyInput(event.target.value)}
								disabled={!activePty || activePty.status === "exited"}
								placeholder={activePty?.status === "exited" ? "进程已退出" : "发送标准输入（支持交互命令）"}
							/>
						</form>
					)}
				</div>
			)}
		</section>
	);
}
