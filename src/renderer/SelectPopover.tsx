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

/**
 * Custom tactile floating popover selector that replaces raw OS `<select>` menus
 * while preserving an underlying synchronized `<select>` for accessibility tools
 * and programmatic combobox automation.
 */
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
	className?: string;
	pillClassName?: string;
	title?: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listboxId = useId();

	const selectedOption = options.find((opt) => opt.value === value);
	const displayLabel = selectedOption ? (selectedOption.shortLabel ?? selectedOption.label) : placeholder;

	useEffect(() => {
		if (disabled && open) setOpen(false);
	}, [disabled, open]);

	useEffect(() => {
		if (!open) return;
		const currentIdx = Math.max(
			0,
			options.findIndex((opt) => opt.value === value && !opt.disabled),
		);
		setActiveIndex(currentIdx);

		const onPointerDown = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setOpen(false);
				triggerRef.current?.focus();
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, options, value]);

	const enabledIndices = options
		.map((opt, idx) => (opt.disabled ? -1 : idx))
		.filter((idx) => idx >= 0);

	const choose = (nextValue: string) => {
		setOpen(false);
		if (nextValue !== value) onChange(nextValue);
		requestAnimationFrame(() => triggerRef.current?.focus());
	};

	return (
		<div ref={rootRef} className={`cc-select-popover ${open ? "is-open" : ""} ${className}`.trim()}>
			<select
				aria-label={ariaLabel}
				value={value}
				disabled={disabled}
				tabIndex={-1}
				className="cc-select-native-proxy"
				onChange={(event) => onChange(event.target.value)}
			>
				{!selectedOption && (
					<option value="" disabled>
						{placeholder}
					</option>
				)}
				{options.map((opt) => (
					<option key={opt.value} value={opt.value} disabled={opt.disabled}>
						{opt.label}
					</option>
				))}
			</select>

			<button
				ref={triggerRef}
				type="button"
				disabled={disabled}
				title={title ?? ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				className={`cc-select-trigger ${pillClassName}`.trim()}
				onClick={() => {
					if (!disabled && enabledIndices.length > 0) setOpen((prev) => !prev);
				}}
				onKeyDown={(event) => {
					if (disabled || !enabledIndices.length) return;
					if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						setOpen(true);
						return;
					}
					if (!open) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const pos = enabledIndices.indexOf(activeIndex);
						const delta = event.key === "ArrowDown" ? 1 : -1;
						const nextPos = pos === -1 ? 0 : (pos + delta + enabledIndices.length) % enabledIndices.length;
						const nextIdx = enabledIndices[nextPos];
						setActiveIndex(nextIdx);
						document.getElementById(`${listboxId}-${nextIdx}`)?.scrollIntoView({ block: "nearest" });
					} else if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						const target = options[activeIndex];
						if (target && !target.disabled) choose(target.value);
					}
				}}
			>
				{dotClass && <span className={`cc-perm-dot ${dotClass}`} aria-hidden="true" />}
				{icon && <span className="cc-select-icon" aria-hidden="true">{icon}</span>}
				<span className="cc-select-label">{displayLabel}</span>
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
								role="option"
								disabled={opt.disabled}
								aria-selected={isSelected}
								className={`cc-select-option ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`.trim()}
								onMouseEnter={() => {
									if (!opt.disabled) setActiveIndex(idx);
								}}
								onMouseDown={(event) => {
									event.preventDefault();
									if (!opt.disabled) choose(opt.value);
								}}
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
