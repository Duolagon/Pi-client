import { useEffect, useState } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";

export interface PaletteAction {
	id: string;
	label: string;
	shortcut?: string;
	keywords?: string;
	disabled?: boolean;
	run: () => void;
}

export function CommandPalette({
	actions,
	close,
}: {
	actions: PaletteAction[];
	close: () => void;
}) {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);

	const filtered = actions.filter((a) =>
		!a.disabled && `${a.label} ${a.keywords ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const activeIdx = filtered.length ? Math.min(index, filtered.length - 1) : 0;

	useEffect(() => {
		setIndex(0);
	}, [query]);

	return (
		<Modal title="命令面板 (⌘P)" close={close}>
			<div className="simple-dialog">
				<div className="search-dialog-input">
					<CommandIcon size={16} />
					<input
						autoFocus
						aria-label="搜索客户端命令"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
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
						placeholder="输入命令名或快捷键搜索…"
					/>
				</div>
				<div className="search-results">
					{filtered.map((item, idx) => (
						<button
							type="button"
							key={item.id}
							className={idx === activeIdx ? "active" : ""}
							onClick={() => {
								item.run();
								close();
							}}
						>
							<div>
								<strong>{item.label}</strong>
								{item.keywords && <span>{item.keywords}</span>}
							</div>
							{item.shortcut && <kbd>{item.shortcut}</kbd>}
						</button>
					))}
					{!filtered.length && <p className="subtle-note">没有匹配的命令。</p>}
				</div>
			</div>
		</Modal>
	);
}
