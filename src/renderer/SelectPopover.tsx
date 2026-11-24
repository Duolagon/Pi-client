import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectPopoverOption {
	value: string;
	label: string;
	shortLabel?: string;
	hint?: string;
	dotClass?: string;
	disabled?: boolean;
}

/** Select-only combobox. Focus stays on the trigger as users navigate the options. */
export function SelectPopover({
	ariaLabel,
	value,
	options,
	placeholder = "未选择",
	icon,
	dotClass,
	disabled = false,
	align = "left",
	direction = "up",
	field = false,
	className = "",
	pillClassName = "",
	title,
	onChange,
}: {
	ariaLabel: string;
	value: string;
	options: SelectPopoverOption[];
	placeholder?: string;
	icon?: ReactNode;
	dotClass?: string;
	disabled?: boolean;
	align?: "left" | "right";
	direction?: "up" | "down";
	field?: boolean;
	className?: string;
	pillClassName?: string;
	title?: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [activeValue, setActiveValue] = useState<string>();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listboxId = useId();
	const displayId = `${listboxId}-value`;

	const selectedOption = options.find((opt) => opt.value === value);
	const displayLabel = selectedOption ? (selectedOption.shortLabel ?? selectedOption.label) : placeholder;
	const enabledOptions = options.filter((opt) => !opt.disabled);
	const activeOption = enabledOptions.find((opt) => opt.value === activeValue)
		?? enabledOptions.find((opt) => opt.value === value)
		?? enabledOptions[0];
	const activeIndex = activeOption ? options.indexOf(activeOption) : -1;
	const activeId = activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined;
	const unavailable = disabled || !enabledOptions.length;

	useEffect(() => {
		if (unavailable && open) setOpen(false);
	}, [unavailable, open]);

	useEffect(() => {
		if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [open, activeId]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const reveal = () => {
		setActiveValue(undefined);
		setOpen(true);
	};

	const choose = (nextValue: string) => {
		triggerRef.current?.focus({ preventScroll: true });
		setOpen(false);
		if (nextValue !== value) onChange(nextValue);
	};

	return (
		<div
			ref={rootRef}
			className={`cc-select-popover ${field ? "is-field" : ""} ${open ? "is-open" : ""} ${className}`.trim()}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
		>
			<button
				ref={triggerRef}
				type="button"
				role="combobox"
				disabled={unavailable}
				title={title ?? ariaLabel}
				aria-label={ariaLabel}
				aria-describedby={displayId}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				aria-activedescendant={open ? activeId : undefined}
				className={`cc-select-trigger ${pillClassName}`.trim()}
				onClick={() => {
					if (open) setOpen(false);
					else reveal();
				}}
				onKeyDown={(event) => {
					if (unavailable) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						if (!open) {
							reveal();
							return;
						}
						const pos = activeOption ? enabledOptions.indexOf(activeOption) : 0;
						const delta = event.key === "ArrowDown" ? 1 : -1;
						const nextPos = (pos + delta + enabledOptions.length) % enabledOptions.length;
						setActiveValue(enabledOptions[nextPos].value);
					} else if (open && (event.key === "Home" || event.key === "End")) {
						event.preventDefault();
						setActiveValue(enabledOptions[event.key === "Home" ? 0 : enabledOptions.length - 1].value);
					} else if (open && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						if (activeOption) choose(activeOption.value);
					} else if (open && event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
					}
				}}
			>
				{dotClass && <span className={`cc-perm-dot ${dotClass}`} aria-hidden="true" />}
				{icon && <span className="cc-select-icon" aria-hidden="true">{icon}</span>}
				<span className="cc-select-label" id={displayId}>{displayLabel}</span>
				<ChevronDown size={12} className="cc-select-chevron" aria-hidden="true" />
			</button>

			{open && (
				<div
					id={listboxId}
					role="listbox"
					aria-label={`${ariaLabel} 选项`}
					className={`cc-select-menu align-${align} dir-${direction}`}
				>
					{options.map((opt, idx) => {
						const isSelected = opt.value === value;
						const isActive = idx === activeIndex;
						return (
							<button
								key={opt.value}
								id={`${listboxId}-${idx}`}
								type="button"
								value={opt.value}
								role="option"
								tabIndex={-1}
								disabled={opt.disabled}
								aria-selected={isSelected}
								className={`cc-select-option ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`.trim()}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => choose(opt.value)}
							>
								<span className="cc-select-option-main">
									{opt.dotClass && <span className={`cc-perm-dot ${opt.dotClass}`} aria-hidden="true" />}
									<span className="cc-select-option-title">{opt.label}</span>
									{opt.hint && <span className="cc-select-option-hint">{opt.hint}</span>}
								</span>
								<Check size={13} className={`cc-select-check ${isSelected ? "visible" : ""}`} aria-hidden="true" />
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
