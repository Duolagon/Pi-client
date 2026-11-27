import { useEffect, useState, type ReactNode } from "react";
import {
	Archive,
	BookOpen,
	Bot,
	Command as CommandIcon,
	FileCode2,
	Files,
	FolderOpen,
	GitCompareArrows,
	GitFork,
	Globe,
	History,
	Layers,
	ListTodo,
	Plug,
	Plus,
	Search,
	Settings,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Terminal,
} from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { SlidingTabList } from "./SegmentedTabs.tsx";
import type { FileEntry } from "../shared.ts";

export interface PaletteAction {
	id: string;
	label: string;
	shortcut?: string;
	keywords?: string;
	disabled?: boolean;
	run: () => void;
}

function actionIcon(id: string): ReactNode {
	switch (id) {
		case "new":
			return <Plus size={14} />;
		case "search":
		case "find":
			return <Search size={14} />;
		case "open":
			return <FolderOpen size={14} />;
		case "sandbox":
		case "perms":
			return <ShieldCheck size={14} />;
		case "theme":
		case "init":
			return <Sparkles size={14} />;
		case "plan":
		case "tasks":
			return <ListTodo size={14} />;
		case "rewind":
			return <History size={14} />;
		case "agents":
			return <Bot size={14} />;
		case "mcp":
			return <Plug size={14} />;
		case "hooks":
		case "skills":
		case "tools":
			return <SlidersHorizontal size={14} />;
		case "sessions":
			return <GitFork size={14} />;
		case "memory":
			return <BookOpen size={14} />;
		case "context":
		case "status":
			return <Layers size={14} />;
		case "preview":
			return <Globe size={14} />;
		case "terminal":
			return <Terminal size={14} />;
		case "changes":
			return <GitCompareArrows size={14} />;
		case "files":
			return <Files size={14} />;
		case "quick-file":
			return <FileCode2 size={14} />;
		case "compact":
			return <Archive size={14} />;
		case "settings":
			return <Settings size={14} />;
		default:
			return <CommandIcon size={14} />;
	}
}

function highlightQuery(text: string, rawQuery: string): ReactNode {
	const needle = rawQuery.trim();
	if (!needle) return text;
	const idx = text.toLowerCase().indexOf(needle.toLowerCase());
	if (idx === -1) return text;
	return (
		<>
			{text.slice(0, idx)}
			<mark className="cc-search-mark">{text.slice(idx, idx + needle.length)}</mark>
			{text.slice(idx + needle.length)}
		</>
	);
}

export function CommandPalette({
	actions,
	conversationId,
	onOpenFile,
	close,
}: {
	actions: PaletteAction[];
	conversationId?: string;
	onOpenFile?: (path: string) => void;
	close: () => void;
}) {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const [fileSearch, setFileSearch] = useState<{ query: string; conversationId: string; hits: FileEntry[] }>();
	const term = query.trim();
	const searchEnabled = Boolean(onOpenFile);
	const currentFileSearch = fileSearch?.query === term && fileSearch.conversationId === conversationId ? fileSearch : undefined;
	const pendingFiles = Boolean(term && conversationId && searchEnabled && !currentFileSearch);

	useEffect(() => {
		setFileSearch(undefined);
		if (!term || !conversationId || !searchEnabled) {
			return;
		}
		let cancelled = false;
		const settle = (entries: FileEntry[]) => {
			if (!cancelled) setFileSearch({ query: term, conversationId, hits: entries.filter((entry) => !entry.directory).slice(0, 8) });
		};
		const timer = window.setTimeout(() => {
			void window.pi.searchFiles(conversationId, term).then(settle, () => settle([]));
		}, 60);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [term, conversationId, searchEnabled]);

	const matchedActions = actions.filter((a) =>
		!a.disabled && `${a.label} ${a.keywords ?? ""}`.toLowerCase().includes(term.toLowerCase()),
	);
	const fileActions: PaletteAction[] = onOpenFile
		? (currentFileSearch?.hits ?? []).map((entry) => ({
				id: `file:${entry.path}`,
				label: `打开文件：${entry.name}`,
				keywords: entry.path,
				run: () => onOpenFile(entry.path),
			}))
		: [];
	const filtered = [...matchedActions, ...fileActions];
	const activeIdx = filtered.length ? Math.min(index, filtered.length - 1) : 0;

	useEffect(() => {
		const item = filtered[activeIdx];
		if (item) document.getElementById(`cc-cmd-${item.id}`)?.scrollIntoView({ block: "nearest" });
	}, [activeIdx, filtered]);

	return (
		<Modal title="命令面板 (⌘P)" close={close}>
			<div className="simple-dialog cc-command-palette">
				<div className="search-dialog-input">
					<CommandIcon size={16} />
					<input
						autoFocus data-autofocus
						role="combobox"
						aria-expanded="true"
						aria-controls="cc-cmd-results"
						aria-activedescendant={filtered[activeIdx] ? `cc-cmd-${filtered[activeIdx].id}` : undefined}
						aria-label="搜索客户端命令"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setIndex(0);
						}}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing) return;
							if (e.key === "ArrowDown" && filtered.length) {
								e.preventDefault();
								setIndex((i) => (i + 1) % filtered.length);
							} else if (e.key === "ArrowUp" && filtered.length) {
								e.preventDefault();
								setIndex((i) => (i - 1 + filtered.length) % filtered.length);
							} else if (e.key === "Enter" && filtered.length) {
								e.preventDefault();
								filtered[activeIdx].run();
								close();
							}
						}}
						placeholder="搜索命令、快捷键，或输入文件名快速预览…"
					/>
					<span className="cc-palette-count" aria-hidden="true">{filtered.length}</span>
				</div>
				<SlidingTabList variant="list" className="search-results" id="cc-cmd-results" role="listbox" aria-label="命令" aria-busy={pendingFiles}>
					{filtered.map((item, idx) => (
						<button
							type="button"
							key={item.id}
							id={`cc-cmd-${item.id}`}
							role="option"
							aria-selected={idx === activeIdx}
							tabIndex={-1}
							className={idx === activeIdx ? "active" : ""}
							onMouseEnter={() => setIndex(idx)}
							onClick={() => {
								item.run();
								close();
							}}
						>
							<div className="cc-palette-row-main">
								<span className="cc-palette-icon" aria-hidden="true">
									{actionIcon(item.id.startsWith("file:") ? "quick-file" : item.id)}
								</span>
								<div className="cc-palette-result-text">
									<strong>{highlightQuery(item.label, query)}</strong>
									{item.keywords && <span>{highlightQuery(item.keywords, query)}</span>}
								</div>
							</div>
							{item.shortcut && <kbd>{item.shortcut}</kbd>}
						</button>
					))}
					{!filtered.length && <p className="subtle-note cc-search-empty" role="status">{pendingFiles ? "正在搜索文件…" : "没有匹配的命令或文件。"}</p>}
				</SlidingTabList>
				<div className="cc-palette-foot" aria-hidden="true">
					<span><kbd>↑↓</kbd> 导航</span>
					<span><kbd>↵</kbd> 执行</span>
					<span><kbd>Esc</kbd> 关闭</span>
				</div>
			</div>
		</Modal>
	);
}
