/** Copies text, falling back to a hidden textarea when the async clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (!navigator.clipboard) throw new Error("no clipboard");
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		const previous = document.activeElement as HTMLElement | null;
		document.body.append(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		area.remove();
		previous?.focus?.();
		return ok;
	}
}
