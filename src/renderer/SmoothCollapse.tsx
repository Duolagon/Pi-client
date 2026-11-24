import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./Presence.tsx";

/**
 * Smooth height + opacity accordion primitive built on CSS Grid `0fr -> 1fr`.
 * Mounts immediately on open (animating from 0fr to 1fr on the next frame) and
 * unmounts cleanly after closing so collapsed trees do not linger in the DOM.
 */
export function SmoothCollapse({
	open,
	keepMounted = false,
	className = "",
	innerClassName = "",
	children,
}: {
	open: boolean;
	keepMounted?: boolean;
	className?: string;
	innerClassName?: string;
	children: ReactNode;
}) {
	const [mounted, setMounted] = useState(open);
	const [expanded, setExpanded] = useState(open);

	const reducedMotion = prefersReducedMotion();

	useLayoutEffect(() => {
		if (reducedMotion) {
			setExpanded(open);
			setMounted(open);
			return;
		}
		if (open) {
			setMounted(true);
			let frame2 = 0;
			const frame1 = requestAnimationFrame(() => {
				frame2 = requestAnimationFrame(() => setExpanded(true));
			});
			return () => {
				cancelAnimationFrame(frame1);
				if (frame2) cancelAnimationFrame(frame2);
			};
		}
		setExpanded(false);
		const timer = setTimeout(() => setMounted(false), 270);
		return () => clearTimeout(timer);
	}, [open, reducedMotion]);

	if (!keepMounted && !open && (!mounted || reducedMotion)) return null;

	return (
		<div
			className={`cc-smooth-collapse ${(reducedMotion ? open : expanded) ? "is-expanded" : ""} ${className}`.trim()}
			inert={!open}
			aria-hidden={!open || undefined}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) {
					setMounted(false);
				}
			}}
		>
			<div className={`cc-smooth-collapse-inner ${innerClassName}`.trim()}>{children}</div>
		</div>
	);
}

/**
 * Drop-in animated replacement for native `<details>` + `<summary>` elements.
 * Preserves semantic `<details>` and `<summary>` markup while animating both
 * expansion and collapse smoothly via `<SmoothCollapse>`.
 */
export function AnimatedDetails({
	summary,
	children,
	className = "",
	summaryClassName = "",
	bodyClassName = "",
	defaultOpen = false,
	open: controlledOpen,
	onToggleOpen,
}: {
	summary: ReactNode;
	children: ReactNode;
	className?: string;
	summaryClassName?: string;
	bodyClassName?: string;
	defaultOpen?: boolean;
	open?: boolean;
	onToggleOpen?: (next: boolean) => void;
}) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const isOpen = controlledOpen ?? uncontrolledOpen;
	const [closingHold, setClosingHold] = useState(false);

	useEffect(() => {
		if (isOpen) {
			setClosingHold(false);
			return;
		}
		if (prefersReducedMotion()) {
			setClosingHold(false);
			return;
		}
		const timer = window.setTimeout(() => setClosingHold(false), 260);
		return () => window.clearTimeout(timer);
	}, [isOpen]);

	const toggle = () => {
		const next = !isOpen;
		if (!next && !prefersReducedMotion()) setClosingHold(true);
		if (controlledOpen === undefined) setUncontrolledOpen(next);
		onToggleOpen?.(next);
	};

	const detailsOpen = isOpen || closingHold;

	return (
		<details
			open={detailsOpen || undefined}
			className={`cc-animated-details ${isOpen ? "is-open" : ""} ${className}`.trim()}
		>
			<summary
				className={summaryClassName || undefined}
				aria-expanded={isOpen}
				onClick={(event) => {
					event.preventDefault();
					toggle();
				}}
			>
				{summary}
			</summary>
			<SmoothCollapse open={isOpen} keepMounted innerClassName={bodyClassName}>
				{children}
			</SmoothCollapse>
		</details>
	);
}
