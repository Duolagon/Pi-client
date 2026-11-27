import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { clearModalExit, showModalExit } from "../renderer/Presence.tsx";

export function IconButton({
	icon: Icon,
	label,
	onClick,
	active,
	className = "",
	disabled = false,
}: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
	active?: boolean;
	className?: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className={`icon-button ${active ? "active" : ""} ${className}`}
			aria-label={label}
			title={label}
			onClick={onClick}
			aria-pressed={active}
			disabled={disabled}
		>
			<Icon size={17} strokeWidth={1.7} />
		</button>
	);
}
export function PiMark({ small = false }: { small?: boolean }) {
	return (
		<span className={`pi-mark ${small ? "small" : ""}`} aria-label="Pi">
			π
		</span>
	);
}
export function Modal({
	title,
	children,
	close,
	wide = false,
	className = "",
}: {
	title: string;
	children: ReactNode;
	close: () => void;
	wide?: boolean;
	className?: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	// Captured during the first render, before any child autoFocus runs, so it is the control that opened the dialog.
	const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
	useEffect(() => {
		const node = dialog.current;
		if (!node) return;
		clearModalExit();
		// Children marked with autoFocus cannot take focus while the dialog is still closed, and showModal()
		// would otherwise focus the header close button. Pick the intended target explicitly after opening.
		node.showModal();
		const target =
			node.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ??
			node.querySelector<HTMLElement>(
				".modal-shell > :not(header) :is(input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled]))",
			);
		if (target) {
			target.focus();
			if (target instanceof HTMLInputElement && (target.type === "text" || target.type === "search")) target.select();
		}
		const returnTo = opener.current;
		return () => {
			node.close();
			if (returnTo instanceof HTMLElement && returnTo.isConnected && returnTo !== document.body) {
				requestAnimationFrame(() => {
					if (returnTo.isConnected && (document.activeElement === document.body || !document.activeElement)) returnTo.focus();
				});
			}
		};
	}, []);
	useLayoutEffect(() => {
		const node = dialog.current;
		return () => {
			const shell = node?.querySelector<HTMLElement>(".modal-shell") ?? null;
			if (node) showModalExit(shell, node.className);
		};
	}, []);
	return (
		<dialog
			ref={dialog}
			className={`modal ${wide ? "wide" : ""} ${className}`.trim()}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
			aria-label={title}
		>
			<div className="cc-modal-window-drag" aria-hidden="true" />
			<div className="modal-shell">
				<header>
					<h2>{title}</h2>
					<IconButton icon={X} label="关闭对话框" onClick={close} />
				</header>
				{children}
			</div>
		</dialog>
	);
}
export function Menu({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="popover" role="group" aria-label={label}>
			{children}
		</div>
	);
}
export function Tag({ children }: { children: ReactNode }) {
	return <span className="tag">{children}</span>;
}
export function highlightCode(text: string): ReactNode[] {
	return text
		.split(
			/("[^"\n]*"|'[^'\n]*'|\b(?:export|function|const|return|interface|import|from|type|true|false|string|number|void)\b)/g,
		)
		.map((part, index) => (
			<span
				key={`${index}-${part}`}
				className={
					/^["']/.test(part)
						? "syntax-string"
						: /^(export|function|const|return|interface|import|from|type|true|false|string|number|void)$/.test(part)
							? "syntax-keyword"
							: undefined
				}
			>
				{part}
			</span>
		));
}

/** Arrow / Home / End navigation between the enabled menu items inside a role="menu" container. */
export function menuKeyNav(event: ReactKeyboardEvent<HTMLElement>) {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const items = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
	);
	if (!items.length) return;
	event.preventDefault();
	const at = items.indexOf(document.activeElement as HTMLElement);
	const next =
		event.key === "Home" ? 0
		: event.key === "End" ? items.length - 1
		: event.key === "ArrowDown" ? (at + 1) % items.length
		: (at - 1 + items.length) % items.length;
	items[next].focus();
}
