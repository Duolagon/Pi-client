import type { CSSProperties } from "react";

export function WolfFangEmblem({ size = 14, className = "" }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			className={`cc-ww-icon cc-ww-wolf ${className}`.trim()}
			aria-hidden="true"
		>
			<path
				d="M4.2 3.4L8.8 7.6L12 6.4L15.2 7.6L19.8 3.4L18.9 10.6L20.6 14.4L16.4 18.8L12 21.2L7.6 18.8L3.4 14.4L5.1 10.6L4.2 3.4Z"
				fill="currentColor"
				fillOpacity="0.16"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinejoin="round"
			/>
			<path d="M8.1 12.1L10.5 13.3L8.6 14.2Z" fill="currentColor" />
			<path d="M15.9 12.1L13.5 13.3L15.4 14.2Z" fill="currentColor" />
			<path
				d="M9.8 17.2L12 18.7L14.2 17.2"
				stroke="currentColor"
				strokeWidth="1.55"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function VillagerSealEmblem({ size = 14, className = "" }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			className={`cc-ww-icon cc-ww-villager ${className}`.trim()}
			aria-hidden="true"
		>
			<path
				d="M12 2.8L19.4 5.9V11.8C19.4 16.5 16.2 19.9 12 21.4C7.8 19.9 4.6 16.5 4.6 11.8V5.9L12 2.8Z"
				fill="currentColor"
				fillOpacity="0.15"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinejoin="round"
			/>
			<path
				d="M8.7 12.3L11.0 14.6L15.6 9.8"
				stroke="currentColor"
				strokeWidth="1.9"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function SeerEyeEmblem({
	size = 14,
	animated = false,
	className = "",
}: {
	size?: number;
	animated?: boolean;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			className={`cc-ww-icon cc-ww-seer ${animated ? "is-scanning" : ""} ${className}`.trim()}
			aria-hidden="true"
		>
			{animated && (
				<circle
					cx="12"
					cy="12"
					r="9.8"
					stroke="currentColor"
					strokeWidth="1.35"
					strokeLinecap="round"
					strokeDasharray="16 46"
					className="cc-ww-orbit"
				/>
			)}
			<path
				d="M2.8 12C4.7 7.9 8.1 5.8 12 5.8C15.9 5.8 19.3 7.9 21.2 12C19.3 16.1 15.9 18.2 12 18.2C8.1 18.2 4.7 16.1 2.8 12Z"
				fill="currentColor"
				fillOpacity="0.12"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinejoin="round"
			/>
			<circle cx="12" cy="12" r="2.7" fill="currentColor" />
		</svg>
	);
}

export function MoonWatchIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			className={`cc-ww-icon cc-ww-moon ${className}`.trim()}
			aria-hidden="true"
		>
			<path
				d="M19.8 14.6A8.2 8.2 0 0 1 9.4 4.2A8.3 8.3 0 1 0 19.8 14.6Z"
				fill="currentColor"
				fillOpacity="0.16"
				stroke="currentColor"
				strokeWidth="1.75"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="16.8" cy="6.8" r="1.3" fill="currentColor" />
		</svg>
	);
}

export function MetricRingGauge({
	value,
	tone = "indigo",
	size = 36,
}: {
	value?: number;
	tone?: "crimson" | "emerald" | "indigo" | "amber";
	size?: number;
}) {
	const r = 13.5;
	const c = 2 * Math.PI * r;
	const clamped = value === undefined ? 0 : Math.max(0, Math.min(1, value));
	const dashOffset = c * (1 - clamped);
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 34 34"
			className={`cc-ww-ring tone-${tone} ${value === undefined ? "is-empty" : ""}`.trim()}
			style={{ "--ring-c": c, "--ring-offset": dashOffset } as CSSProperties}
			aria-hidden="true"
		>
			<circle cx="17" cy="17" r={r} className="cc-ww-ring-track" />
			{value !== undefined && <circle cx="17" cy="17" r={r} className="cc-ww-ring-fill" />}
		</svg>
	);
}
