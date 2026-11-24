import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

/**
 * Drop-in segmented tab bar with a measured spring-animated sliding pill glider.
 * Tracks whichever child button currently has `aria-selected="true"`, `aria-pressed="true"`,
 * or `.active`, so existing `<button role="tab">` children work with zero API friction.
 */
export function SlidingTabList({
	children,
	className = "",
	variant = "modal",
	...rest
}: {
	children: ReactNode;
	className?: string;
	variant?: "modal" | "compact" | "pill" | "nav" | "list";
} & HTMLAttributes<HTMLDivElement>) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [glider, setGlider] = useState<{ x: number; y: number; w: number; h: number; ready: boolean }>({
		x: 0,
		y: 0,
		w: 0,
		h: 0,
		ready: false,
	});
	const hasMeasured = useRef(false);

	const measure = useCallback(() => {
		const root = containerRef.current;
		if (!root) return;
		const active = root.querySelector<HTMLElement>(
			'button[aria-selected="true"], button[aria-pressed="true"], button.active',
		);
		if (!active) {
			setGlider((prev) => (prev.w === 0 ? prev : { ...prev, w: 0 }));
			return;
		}
		const next = {
			x: active.offsetLeft,
			y: active.offsetTop,
			w: active.offsetWidth,
			h: active.offsetHeight,
			ready: hasMeasured.current,
		};
		hasMeasured.current = true;
		setGlider((prev) =>
			prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h && prev.ready === next.ready
				? prev
				: next,
		);
	}, []);

	useLayoutEffect(() => {
		measure();
	});

	useEffect(() => {
		const root = containerRef.current;
		if (!root || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(root);
		for (const btn of root.querySelectorAll("button")) observer.observe(btn);
		return () => observer.disconnect();
	}, [measure, children]);

	return (
		<div
			ref={containerRef}
			className={`cc-sliding-tabs cc-sliding-tabs-${variant} ${className}`.trim()}
			{...rest}
		>
			{glider.w > 0 && (
				<span
					aria-hidden="true"
					className={`cc-seg-glider ${glider.ready ? "is-animated" : ""}`}
					style={
						{
							transform: `translate3d(${glider.x}px, ${glider.y}px, 0)`,
							width: `${glider.w}px`,
							height: `${glider.h}px`,
						} as CSSProperties
					}
				/>
			)}
			{children}
		</div>
	);
}
