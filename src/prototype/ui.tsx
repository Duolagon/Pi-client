import { useEffect, useRef, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";

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
}: {
	title: string;
	children: ReactNode;
	close: () => void;
	wide?: boolean;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const node = dialog.current;
		node?.showModal();
		return () => node?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			className={`modal ${wide ? "wide" : ""}`}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
			aria-label={title}
		>
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
