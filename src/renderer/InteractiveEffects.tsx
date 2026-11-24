import { useEffect } from "react";
import { prefersReducedMotion } from "./Presence.tsx";

const SPOTLIGHT_SELECTOR =
	".cc-starter-card, .cl-composer-box, .cc-completion-card, .cc-inline-approval, .cc-status-card, .cc-tool-ctrl-row";

/**
 * Zero-rerender pointer-tracking spotlight & window-resize choreography controller.
 * Updates `--mx` / `--my` CSS variables via rAF directly on hovered interactive surfaces
 * for 120fps specular glow & border illumination without touching React state.
 */
export function InteractiveEffects() {
	useEffect(() => {
		if (typeof window === "undefined" || typeof document === "undefined") return;

		let resizeTimer = 0;
		const onResize = () => {
			document.documentElement.dataset.resizing = "true";
			window.clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(() => {
				delete document.documentElement.dataset.resizing;
			}, 230);
		};
		window.addEventListener("resize", onResize, { passive: true });

		let frame = 0;
		let lastTarget: HTMLElement | null = null;
		let clientX = 0;
		let clientY = 0;

		const flushPointer = () => {
			frame = 0;
			if (!lastTarget || !lastTarget.isConnected) return;
			const rect = lastTarget.getBoundingClientRect();
			const x = Math.round(clientX - rect.left);
			const y = Math.round(clientY - rect.top);
			lastTarget.style.setProperty("--mx", `${x}px`);
			lastTarget.style.setProperty("--my", `${y}px`);
		};

		const onPointerMove = (event: PointerEvent) => {
			if (event.pointerType === "touch" || prefersReducedMotion()) return;
			const origin = event.target instanceof Element ? event.target : null;
			const card = origin?.closest<HTMLElement>(SPOTLIGHT_SELECTOR) ?? null;
			if (lastTarget && lastTarget !== card) {
				lastTarget.removeAttribute("data-spot");
			}
			lastTarget = card;
			if (!card) return;
			card.dataset.spot = "true";
			clientX = event.clientX;
			clientY = event.clientY;
			if (!frame) frame = window.requestAnimationFrame(flushPointer);
		};

		const onPointerLeaveWindow = () => {
			if (lastTarget) {
				lastTarget.removeAttribute("data-spot");
				lastTarget = null;
			}
		};

		window.addEventListener("pointermove", onPointerMove, { passive: true });
		document.addEventListener("mouseleave", onPointerLeaveWindow, { passive: true });

		return () => {
			window.removeEventListener("resize", onResize);
			window.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("mouseleave", onPointerLeaveWindow);
			window.clearTimeout(resizeTimer);
			if (frame) window.cancelAnimationFrame(frame);
			delete document.documentElement.dataset.resizing;
		};
	}, []);

	return null;
}
