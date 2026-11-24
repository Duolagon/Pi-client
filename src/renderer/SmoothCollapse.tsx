import { useLayoutEffect, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./Presence.tsx";

/**
 * Smooth height + opacity accordion primitive built on CSS Grid `0fr -> 1fr`.
 * Mounts immediately on open (animating from 0fr to 1fr on the next frame) and
 * unmounts cleanly after closing so collapsed trees do not linger in the DOM.
 */
export function SmoothCollapse({
	open,
	className = "",
	innerClassName = "",
	children,
}: {
	open: boolean;
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

	if (!open && (!mounted || reducedMotion)) return null;

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
