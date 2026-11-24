import { useEffect, useState, type ReactNode } from "react";

/**
 * Smooth height + opacity accordion primitive built on CSS Grid `0fr -> 1fr`.
 * Mounts immediately on open (animating from 0fr to 1fr on the next frame) and
 * unmounts cleanly after closing so collapsed trees do not linger in the DOM.
 */
export function SmoothCollapse({
	open,
	className = "",
	innerClassName = "",
	durationMs = 240,
	children,
}: {
	open: boolean;
	className?: string;
	innerClassName?: string;
	durationMs?: number;
	children: ReactNode;
}) {
	const [mounted, setMounted] = useState(open);
	const [expanded, setExpanded] = useState(open);

	if (open && !mounted) {
		setMounted(true);
	}

	useEffect(() => {
		if (open) {
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
		const timer = setTimeout(() => setMounted(false), durationMs + 30);
		return () => clearTimeout(timer);
	}, [open, durationMs]);

	if (!open && !mounted) return null;

	return (
		<div
			className={`cc-smooth-collapse ${expanded ? "is-expanded" : ""} ${className}`.trim()}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && !open) {
					setMounted(false);
				}
			}}
		>
			<div className={`cc-smooth-collapse-inner ${innerClassName}`.trim()}>{children}</div>
		</div>
	);
}
