import { useEffect, useRef, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal.tsx";
import { IconButton } from "../prototype/ui.tsx";
import type { PiPackageAction, TerminalInfo } from "../shared.ts";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
}

export function TerminalPanel({
	conversationId,
	focusId,
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
	focusId?: string;
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
	const [mode, setMode] = useState<"bash" | "pty">(focusId ? "pty" : "bash");
	const [packageForm, setPackageForm] = useState(false);
	const [packageSource, setPackageSource] = useState("");
	const [sshForm, setSshForm] = useState(false);
	const [sshHost, setSshHost] = useState("");
	const [sshPi, setSshPi] = useState(true);
	const [creating, setCreating] = useState(false);
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
			const live = list.find((t) => t.id === focusId) ?? [...list].reverse().find((t) => t.status === "running" || t.status === "starting") ?? list[list.length - 1];
			if (focusId) setMode("pty");
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
	}, [conversationId, focusId]);

	const selectTerminal = async (id: string) => {
		setActiveId(id);
		setMode("pty");
		const replay = await window.pi.terminals.replay(id);
		setTerminals((prev) => [...prev.filter((item) => item.id !== id), replay.terminal]);
		setPtyOutputs((prev) => ({ ...prev, [id]: stripAnsi(replay.chunks.map((chunk) => chunk.data).join("")).slice(-80000) }));
	};

	const createPty = async (remote = false) => {
		if (!conversationId || !project || creating || readOnly) return;
		setCreating(true);
		try {
			const info = remote
				? await window.pi.terminals.ssh(conversationId, sshHost.trim(), sshPi)
				: await window.pi.terminals.create({ conversationId, cols: 100, rows: 24 });
			await selectTerminal(info.id);
			setSshForm(false);
		} catch (error) {
			fail(error);
		} finally {
			setCreating(false);
		}
	};

	const managePackage = async (action: PiPackageAction) => {
		if (!conversationId || creating || readOnly) return;
		setCreating(true);
		try {
			const info = await window.pi.terminals.packages(conversationId, action, packageSource.trim());
			await selectTerminal(info.id);
			setPackageForm(false);
		} catch (error) {
			fail(error);
		} finally {
			setCreating(false);
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
				{conversationId && <>
					<button type="button" disabled={readOnly || creating} onClick={() => { setPackageForm(false); setSshForm(!sshForm); }}>SSH</button>
					<button type="button" disabled={readOnly || creating} onClick={() => { setSshForm(false); setPackageForm(!packageForm); }}>Pi 扩展</button>
				</>}
				{mode === "pty" && terminals.length > 1 && <select aria-label="选择交互终端" value={activeId ?? ""} onChange={(event) => void selectTerminal(event.target.value).catch(fail)}>
					{terminals.map((terminal, index) => <option value={terminal.id} key={terminal.id}>{terminal.label ?? `终端 ${index + 1}`}{terminal.status === "exited" ? " · 已退出" : ""}</option>)}
				</select>}
				{mode === "bash" && bashBusy && <button onClick={onAbortBash}>停止命令</button>}
				{mode === "pty" && (
					<>
						<button type="button" disabled={readOnly || creating} onClick={() => void createPty()} title="新建 PTY">
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
			{packageForm && <div className="cc-ssh-form">
				<button type="button" disabled={creating || readOnly} onClick={() => void managePackage("list")}>列出用户扩展包</button>
				<input aria-label="npm 扩展包" placeholder="npm:包名@版本" value={packageSource} onChange={(event) => setPackageSource(event.target.value)} />
				<button type="button" disabled={creating || readOnly || !packageSource.trim()} onClick={() => {
					if (window.confirm("Pi 扩展包可以在你的账户下运行代码。确认安装此包？")) void managePackage("install");
				}}>安装</button>
				<button type="button" disabled={creating || readOnly || !packageSource.trim()} onClick={() => void managePackage("update")}>更新</button>
				<button type="button" disabled={creating || readOnly || !packageSource.trim()} onClick={() => {
					if (window.confirm("从 Pi 用户配置中移除此扩展包？")) void managePackage("remove");
				}}>移除</button>
				<small>在新会话中加载变更。</small>
			</div>}
			{sshForm && <form className="cc-ssh-form" onSubmit={(event) => { event.preventDefault(); void createPty(true); }}>
				<input aria-label="SSH 主机" placeholder="主机别名或 user@host" required value={sshHost} onChange={(event) => setSshHost(event.target.value)} />
				<label><input type="checkbox" checked={sshPi} onChange={(event) => setSshPi(event.target.checked)} /> 启动远端 Pi</label>
				<button className="cc-mini-btn" disabled={readOnly || creating}>连接</button>
			</form>}

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
			) : activePty?.label ? (
				<InteractiveTerminal key={activePty.id} id={activePty.id} readOnly={readOnly || activePty.status === "exited"} fail={fail} />
			) : (
				<div className="terminal-output" ref={shellRef}>
					<pre>{activeId ? ptyOutputs[activeId] || "PTY 已就绪，输入命令并回车…" : "点击上方 + 创建交互式终端"}</pre>
					{activeId && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void window.pi.terminals.write(activeId, `${ptyInput}\r`).catch(fail);
								setPtyInput("");
							}}
						>
							<label htmlFor="pty-command">&gt;</label>
							<input
								id="pty-command"
								aria-label="PTY 输入"
								value={ptyInput}
								onChange={(event) => setPtyInput(event.target.value)}
								disabled={readOnly || !activePty || activePty.status === "exited"}
								placeholder={activePty?.status === "exited" ? "进程已退出" : "发送标准输入（支持交互命令）"}
							/>
						</form>
					)}
				</div>
			)}
		</section>
	);
}
