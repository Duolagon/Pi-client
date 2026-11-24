import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function clearModalExit(): void {
	for (const el of document.querySelectorAll(".cc-exit-ghost-layer")) el.remove();
}

/** Copies the visible dialog during its brief exit after the native top layer releases focus. */
export function showModalExit(node: HTMLElement | null, dialogClassName: string): void {
	if (!node || prefersReducedMotion()) return;
	const rect = node.getBoundingClientRect();
	if (rect.width < 4 || rect.height < 4) return;

	clearModalExit();
	const layer = document.createElement("div");
	layer.className = "cc-exit-ghost-layer";
	layer.setAttribute("aria-hidden", "true");
	layer.inert = true;
	const context = document.createElement("div");
	context.className = dialogClassName;
	context.style.display = "contents";

	const clone = node.cloneNode(true) as HTMLElement;
	clone.classList.add("cc-exit-ghost-modal");
	clone.style.position = "fixed";
	clone.style.left = `${rect.left}px`;
	clone.style.top = `${rect.top}px`;
	clone.style.width = `${rect.width}px`;
	clone.style.height = `${rect.height}px`;
	clone.style.margin = "0";
	clone.style.pointerEvents = "none";

	const originalElements = [node, ...node.querySelectorAll<HTMLElement>("*")];
	const clonedElements = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
	const scrollOffsets = originalElements.map(({ scrollTop, scrollLeft }) => ({ scrollTop, scrollLeft }));
	for (const el of clonedElements) {
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

	context.appendChild(clone);
	layer.appendChild(context);
	document.body.appendChild(layer);
	for (const [index, { scrollTop, scrollLeft }] of scrollOffsets.entries()) {
		const element = clonedElements[index];
		if (scrollTop) element.scrollTop = scrollTop;
		if (scrollLeft) element.scrollLeft = scrollLeft;
	}
	window.setTimeout(() => layer.remove(), 180);
}

/** Retains the actual panel through exit so its layout can reverse from the current frame. */
export function Presence({ show, className, children }: { show: boolean; className: string; children: ReactNode }) {
	const [mounted, setMounted] = useState(show);
	const lastChildren = useRef<ReactNode>(null);
	useLayoutEffect(() => {
		if (show) lastChildren.current = children;
	}, [show, children]);
	useLayoutEffect(() => {
		if (show) {
			setMounted(true);
			return;
		}
		if (!mounted) return;
		const finish = () => {
			lastChildren.current = null;
			setMounted(false);
		};
		if (prefersReducedMotion()) {
			finish();
			return;
		}
		const timer = window.setTimeout(finish, 220);
		return () => window.clearTimeout(timer);
	}, [show, mounted]);
	if (!show && !mounted) return null;
	return (
		<div className={className} data-open={show} inert={!show} aria-hidden={!show || undefined}>
			{show ? children : lastChildren.current}
		</div>
	);
}
