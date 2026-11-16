import { useState } from "react";
import { Terminal as TerminalIcon, Plus, X, ChevronDown } from "lucide-react";
import { IconButton } from "./ui";
interface Props {
	close: () => void;
	status: string;
	project: string;
}
export function Terminal({ close, status, project }: Props) {
	const [command, setCommand] = useState("");
	const [history, setHistory] = useState<{ command: string; output: string }[]>([]);
	const [tab, setTab] = useState(1);
	const run = () => {
		if (!command.trim()) return;
		const output =
			command === "pwd"
				? `~/Projects/${project}`
				: command === "clear"
					? ""
					: command === "help"
						? "可预览的命令：pwd、git status、npm run check、clear。所有输出均为演示数据。"
						: command.includes("git status")
							? "On branch feature/session-search\nChanges not staged for commit:\n  modified: src/components/SessionList.tsx\n  modified: src/styles/sidebar.css\n  new file: src/components/SearchInput.tsx\n\n[示例输出，未执行 Git]"
							: command.includes("npm run check")
								? "> pi-desktop check\n> tsc --noEmit\n\nType check passed. [演示输出]"
								: "此原型不会执行系统命令。输入 help 查看可预览的命令。";
		setHistory((items) => (command === "clear" ? [] : [...items, { command, output }]));
		setCommand("");
	};
	return (
		<section className="terminal-panel" aria-label="集成终端">
			<header>
				<span>
					<TerminalIcon size={14} />
					终端
				</span>
				<button className="terminal-tab" onClick={() => setTab(tab === 1 ? 2 : 1)}>
					zsh {tab}
					<ChevronDown size={10} />
				</button>
				<span className="terminal-demo">模拟终端</span>
				<IconButton
					icon={Plus}
					label="新建终端标签"
					onClick={() => {
						setTab((count) => count + 1);
						setHistory([]);
					}}
				/>
				<IconButton icon={X} label="关闭终端" onClick={close} />
			</header>
			<div className="terminal-output">
				<p className="terminal-muted">Pi Desktop · 终端交互预览，不执行真实命令</p>
				{status === "done" && (
					<>
						<p>
							<span className="terminal-prompt">❯</span> npm run check
						</p>
						<p className="terminal-success">✓ Format check passed</p>
						<p className="terminal-success">
							✓ Type check passed <span className="terminal-muted">[演示结果]</span>
						</p>
					</>
				)}
				{history.map((entry, index) => (
					<div key={`${index}-${entry.command}`}>
						<p>
							<span className="terminal-prompt">❯</span> {entry.command}
						</p>
						<pre>{entry.output}</pre>
					</div>
				))}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						run();
					}}
				>
					<label htmlFor="terminal-command">
						<span className="terminal-path">{project}</span> <span className="terminal-prompt">❯</span>
					</label>
					<input
						id="terminal-command"
						aria-label="终端命令"
						value={command}
						onChange={(event) => setCommand(event.target.value)}
						placeholder="输入 help 查看演示命令"
						autoComplete="off"
						spellCheck={false}
					/>
				</form>
			</div>
		</section>
	);
}
