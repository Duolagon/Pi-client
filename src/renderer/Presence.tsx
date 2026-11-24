import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from "react";

let lastWindowResizeAt = 0;
if (typeof window !== "undefined") {
	window.addEventListener(
		"resize",
		() => {
			lastWindowResizeAt = Date.now();
			clearExitGhosts();
		},
		{ passive: true },
	);
}

export function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export type ExitGhostVariant = "modal" | "side" | "inspector" | "terminal" | "bar";

export function clearExitGhosts(variant?: ExitGhostVariant): void {
	if (typeof document === "undefined") return;
	const selector = variant ? `.cc-exit-ghost-layer.cc-exit-${variant}` : ".cc-exit-ghost-layer";
	for (const el of document.querySelectorAll(selector)) el.remove();
}

/**
 * Spawns a non-interactive, ARIA-inert fixed visual clone at the node's last live
 * bounding box so panels, drawers, and modals play silky GPU-composited exit transitions
 * without delaying layout updates, breaking `>` CSS combinators, or blocking clicks.
 */
export function spawnExitGhost(
	node: HTMLElement | null,
	variant: ExitGhostVariant,
	options?: { skipOnResize?: boolean; durationMs?: number; extraClass?: string; withBackdrop?: boolean },
): void {
	if (!node || typeof document === "undefined" || prefersReducedMotion()) return;
	if (options?.skipOnResize && Date.now() - lastWindowResizeAt < 260) return;
	const rect = node.getBoundingClientRect();
	if (rect.width < 4 || rect.height < 4) return;
	// Full-window review mode occupies the entire viewport (left ~ 0); let chat cross-fade cleanly instead of sliding full screen.
	if (variant === "inspector" && rect.left <= 8) return;

	clearExitGhosts(variant);
	const durationMs = options?.durationMs ?? 185;
	const layer = document.createElement("div");
	layer.className = `cc-exit-ghost-layer cc-exit-${variant} ${options?.withBackdrop ? "has-backdrop" : ""} ${options?.extraClass ?? ""}`.trim();
	layer.setAttribute("aria-hidden", "true");
	(layer as HTMLElement & { inert?: boolean }).inert = true;

	const clone = node.cloneNode(true) as HTMLElement;
	clone.classList.add("cc-exit-ghost-node", `cc-exit-ghost-${variant}`);
	clone.style.position = "fixed";
	clone.style.left = `${rect.left}px`;
	clone.style.top = `${rect.top}px`;
	clone.style.width = `${rect.width}px`;
	clone.style.height = `${rect.height}px`;
	clone.style.margin = "0";
	clone.style.pointerEvents = "none";

	for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))]) {
		el.removeAttribute("id");
		el.removeAttribute("role");
		el.removeAttribute("aria-label");
		el.removeAttribute("aria-labelledby");
		el.removeAttribute("title");
		el.removeAttribute("autofocus");
		el.removeAttribute("data-autofocus");
		if (
			el instanceof HTMLInputElement ||
			el instanceof HTMLTextAreaElement ||
			el instanceof HTMLSelectElement ||
			el instanceof HTMLButtonElement
		) {
			el.tabIndex = -1;
		}
	}

	// Convert live DOM text nodes into CSS pseudo-element text so Playwright `getByText` / `hasText`
	// never matches a fading-out ghost while keeping 100% identical visual pixels during exit.
	const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let current = walker.nextNode();
	while (current) {
		if (current.nodeValue && current.nodeValue.trim()) textNodes.push(current as Text);
		current = walker.nextNode();
	}
	for (const textNode of textNodes) {
		const parent = textNode.parentElement;
		if (!parent || parent.tagName === "STYLE" || parent.tagName === "SCRIPT" || parent.tagName === "OPTION") {
			textNode.nodeValue = "";
			continue;
		}
		const span = document.createElement("span");
		span.className = "cc-ghost-txt";
		span.setAttribute("data-t", textNode.nodeValue ?? "");
		textNode.replaceWith(span);
	}

	layer.appendChild(clone);
	document.body.appendChild(layer);
	window.setTimeout(() => layer.remove(), durationMs);
}

/**
 * Attaches an automatic unmount exit transition to a panel/bar ref.
 */
export function useExitGhost(
	ref: RefObject<HTMLElement | null>,
	variant: ExitGhostVariant,
	options?: { skipOnResize?: boolean; durationMs?: number },
): void {
	const optsRef = useRef(options);
	optsRef.current = options;
	useLayoutEffect(() => {
		const node = ref.current;
		return () => {
			spawnExitGhost(node, variant, optsRef.current);
		};
	}, [ref, variant]);
}

export function Presence({
	show,
	exitMs = 190,
	instantExit = false,
	className = "",
	style,
	children,
}: {
	show: boolean;
	exitMs?: number;
	instantExit?: boolean;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}) {
	const [mounted, setMounted] = useState(show);
	const cachedRef = useRef<ReactNode>(show ? children : null);
	const hostRef = useRef<HTMLDivElement>(null);

	if (show) {
		cachedRef.current = children;
	}

	useLayoutEffect(() => {
		if (show) {
			setMounted(true);
			return;
		}
		if (instantExit || prefersReducedMotion()) {
			setMounted(false);
			return;
		}
		const timer = window.setTimeout(() => setMounted(false), exitMs);
		return () => window.clearTimeout(timer);
	}, [show, exitMs, instantExit]);

	const exiting = !show && mounted && !instantExit;

	useLayoutEffect(() => {
		const node = hostRef.current as (HTMLDivElement & { inert?: boolean }) | null;
		if (!node) return;
		node.inert = exiting;
	}, [exiting, mounted]);

	useEffect(() => {
		if (!mounted && !show) {
			cachedRef.current = null;
		}
	}, [mounted, show]);

	if (!show && (!mounted || instantExit)) return null;

	return (
		<div
			ref={hostRef}
			className={`cc-presence ${exiting ? "is-exiting" : "is-present"} ${className}`.trim()}
			data-state={exiting ? "exiting" : "present"}
			aria-hidden={exiting ? "true" : undefined}
			style={style}
		>
			{show ? children : cachedRef.current}
		</div>
	);
}
