import type { SVGProps } from "react";

/** Glowing Fate-inspired Holy Grail chalice icon. */
export function HolyGrailIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
			<path d="M7.5 8.5C7.5 12.8 9.2 15.5 12 15.5C14.8 15.5 16.5 12.8 16.5 8.5Z" fill="currentColor" fillOpacity="0.16" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M6 8.5H18" strokeLinecap="round" />
			<path d="M7.5 10C5.4 10 4.5 11.1 5 12.6C5.4 13.8 6.8 14.2 8.4 14" strokeLinecap="round" />
			<path d="M16.5 10C18.6 10 19.5 11.1 19 12.6C18.6 13.8 17.2 14.2 15.6 14" strokeLinecap="round" />
			<path d="M12 15.5V19.5" strokeLinecap="round" />
			<path d="M8.5 19.5H15.5" strokeLinecap="round" />
			<circle cx="12" cy="5.2" r="1.4" fill="currentColor" stroke="none" opacity="0.9" />
			<path d="M12 2.2V3.2M15.4 3.4L14.6 4.2M8.6 3.4L9.4 4.2" strokeLinecap="round" opacity="0.65" />
		</svg>
	);
}

/** Crimson/Gold Fate Command Seal (令咒) glyph for Master prompts and Send trigger. */
export function CommandSealIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" {...props}>
			<path d="M12 2.5L14.8 8.2L20.5 10.5L14.8 12.8L12 21.5L9.2 12.8L3.5 10.5L9.2 8.2Z" fill="currentColor" fillOpacity="0.18" strokeLinejoin="round" />
			<path d="M12 6.5V15.5M8.5 10.5H15.5" strokeLinecap="round" />
		</svg>
	);
}

/** Rotating miniature magic circle spinner for Servant chanting / working indicator. */
export function MagicCircleLoader({ size = 18, className = "" }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 48 48"
			fill="none"
			className={`grail-spin ${className}`}
			aria-hidden="true"
		>
			<circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.8" strokeDasharray="6 4" opacity="0.55" />
			<circle cx="24" cy="24" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.8" />
			<polygon points="24,8 37.8,32 10.2,32" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.85" />
			<polygon points="24,40 37.8,16 10.2,16" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.55" />
			<circle cx="24" cy="24" r="3" fill="currentColor" />
		</svg>
	);
}

/** Ambient summoning magic circle SVG rendered behind the canvas in Grail theme. */
export function MagicCircleBackdrop() {
	return (
		<div className="grail-magic-backdrop" aria-hidden="true">
			<svg className="grail-magic-ring" viewBox="0 0 520 520" fill="none">
				<circle cx="260" cy="260" r="244" stroke="url(#grailRingGold)" strokeWidth="1.2" strokeDasharray="10 6" />
				<circle cx="260" cy="260" r="226" stroke="url(#grailRingGold)" strokeWidth="1" opacity="0.7" />
				<circle cx="260" cy="260" r="196" stroke="url(#grailRingAzure)" strokeWidth="1" strokeDasharray="3 7" />
				<circle cx="260" cy="260" r="154" stroke="url(#grailRingGold)" strokeWidth="1.1" opacity="0.65" />
				<polygon points="260,34 456,373 64,373" stroke="url(#grailRingGold)" strokeWidth="1" opacity="0.5" />
				<polygon points="260,486 456,147 64,147" stroke="url(#grailRingAzure)" strokeWidth="1" opacity="0.45" />
				<rect x="150" y="150" width="220" height="220" transform="rotate(45 260 260)" stroke="url(#grailRingGold)" strokeWidth="0.9" opacity="0.4" />
				<circle cx="260" cy="260" r="64" stroke="url(#grailRingAzure)" strokeWidth="1" opacity="0.6" />
				<circle cx="260" cy="34" r="5" fill="#f5c542" opacity="0.75" />
				<circle cx="456" cy="373" r="5" fill="#38bdf8" opacity="0.7" />
				<circle cx="64" cy="373" r="5" fill="#38bdf8" opacity="0.7" />
				<circle cx="260" cy="486" r="5" fill="#f5c542" opacity="0.75" />
				<defs>
					<linearGradient id="grailRingGold" x1="0" y1="0" x2="520" y2="520" gradientUnits="userSpaceOnUse">
						<stop stopColor="#f5c542" />
						<stop offset="1" stopColor="#fb923c" />
					</linearGradient>
					<linearGradient id="grailRingAzure" x1="520" y1="0" x2="0" y2="520" gradientUnits="userSpaceOnUse">
						<stop stopColor="#38bdf8" />
						<stop offset="1" stopColor="#a78bfa" />
					</linearGradient>
				</defs>
			</svg>
		</div>
	);
}

/** Radiant Holy Grail summoning crest for the empty / welcome state. */
export function GrailEmblem() {
	return (
		<div className="grail-emblem" aria-hidden="true">
			<svg className="grail-emblem-orbit" viewBox="0 0 112 112" fill="none">
				<circle cx="56" cy="56" r="50" stroke="#f5c542" strokeWidth="1.2" strokeDasharray="5 5" opacity="0.55" />
				<circle cx="56" cy="56" r="40" stroke="#38bdf8" strokeWidth="1" opacity="0.45" />
				<polygon points="56,10 95,78 17,78" stroke="#f5c542" strokeWidth="0.9" opacity="0.35" />
				<polygon points="56,102 95,34 17,34" stroke="#38bdf8" strokeWidth="0.9" opacity="0.3" />
			</svg>
			<div className="grail-emblem-core">
				<HolyGrailIcon width={34} height={34} />
			</div>
		</div>
	);
}

export interface ServantInfo {
	className: string;
	rarity: "SSR" | "SR" | "R";
	title: string;
	accent: string;
}

/** Map active model ID to a Fate-style Servant class badge. */
export function getServantInfo(modelId?: string): ServantInfo {
	const id = (modelId ?? "").toLowerCase();
	if (id.includes("opus")) return { className: "Ruler", rarity: "SSR", title: "苍穹魔术师", accent: "#38bdf8" };
	if (id.includes("sonnet")) return { className: "Saber", rarity: "SSR", title: "苍银剑士", accent: "#f5c542" };
	if (id.includes("haiku") || id.includes("flash") || id.includes("mini")) {
		return { className: "Assassin", rarity: "SR", title: "疾风影使", accent: "#34d399" };
	}
	if (id.includes("gemini")) return { className: "Foreigner", rarity: "SSR", title: "星穹占星师", accent: "#a78bfa" };
	if (id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4") || id.includes("codex")) {
		return { className: "Caster", rarity: "SSR", title: "翠玉智者", accent: "#34d399" };
	}
	if (id.includes("deepseek")) return { className: "Archer", rarity: "SSR", title: "深渊星矢", accent: "#60a5fa" };
	return { className: "Servant", rarity: "SR", title: "契约从者", accent: "#f5c542" };
}

/** Cracked chalice — the "杂音/愿未达成" omen when a turn errors or fails verification. */
export function CrackedGrailIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
			<path d="M7.5 8.5C7.5 12.8 9.2 15.5 12 15.5C14.8 15.5 16.5 12.8 16.5 8.5Z" fill="currentColor" fillOpacity="0.1" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M6 8.5H18" strokeLinecap="round" />
			<path d="M12 15.5V19.5M8.5 19.5H15.5" strokeLinecap="round" />
			{/* Lightning crack across the bowl. */}
			<path d="M11 8.8L9.6 11.4L12.4 12.1L10.8 15" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** Dim ember — the neutral "悬而未验" omen when code changed but no check ran. */
export function EmberIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
			<circle cx="12" cy="13" r="6" fill="currentColor" fillOpacity="0.12" />
			<path d="M12 5.5C12 5.5 9 8.5 9 11.5" strokeLinecap="round" opacity="0.7" />
			<path d="M12 10.5V13.5M12 16.2V16.4" strokeLinecap="round" />
		</svg>
	);
}

/** Pick the glyph for a quality omen. "grail" reuses the Holy Grail chalice. */
export function OmenGlyph({ omen, ...props }: { omen: "grail" | "problem" | "unverified" | "none" } & SVGProps<SVGSVGElement>) {
	if (omen === "grail") return <HolyGrailIcon {...props} />;
	if (omen === "problem") return <CrackedGrailIcon {...props} />;
	if (omen === "unverified") return <EmberIcon {...props} />;
	return null;
}
