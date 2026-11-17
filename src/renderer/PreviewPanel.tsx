import { useState } from "react";
import { ExternalLink, Globe, Monitor, RefreshCw, Smartphone, X } from "lucide-react";
import { IconButton } from "../prototype/ui.tsx";

function normalizeLocalUrl(raw: string): string | null {
	try {
		const url = new URL(raw.trim().startsWith("http") ? raw.trim() : `http://${raw.trim()}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		const host = url.hostname.toLowerCase();
		if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function PreviewPanel({
	initialUrl = "http://localhost:3000",
	close,
}: {
	initialUrl?: string;
	close: () => void;
}) {
	const [inputUrl, setInputUrl] = useState(initialUrl);
	const [activeUrl, setActiveUrl] = useState(() => normalizeLocalUrl(initialUrl) ?? "http://localhost:3000");
	const [reloadKey, setReloadKey] = useState(0);
	const [mobile, setMobile] = useState(false);
	const [error, setError] = useState("");

	const navigate = (e: React.FormEvent) => {
		e.preventDefault();
		const normalized = normalizeLocalUrl(inputUrl);
		if (!normalized) {
			setError("出于安全限制，网页预览仅支持 localhost / 127.0.0.1 本地开发地址。");
			return;
		}
		setError("");
		setActiveUrl(normalized);
		setInputUrl(normalized);
		setReloadKey((k) => k + 1);
	};

	return (
		<aside className="inspector cc-preview-panel" aria-label="本地应用预览">
			<header className="inspector-header">
				<span className="cc-preview-heading">
					<Globe size={14} /> 本地预览
				</span>
				<div>
					<IconButton icon={mobile ? Monitor : Smartphone} label={mobile ? "桌面视图" : "移动端视图"} onClick={() => setMobile((v) => !v)} />
					<IconButton icon={RefreshCw} label="刷新预览" onClick={() => setReloadKey((k) => k + 1)} />
					<a className="icon-button" href={activeUrl} target="_blank" rel="noreferrer" title="在系统浏览器打开" aria-label="在系统浏览器打开">
						<ExternalLink size={15} />
					</a>
					<IconButton icon={X} label="关闭预览面板" onClick={close} />
				</div>
			</header>
			<form className="cc-preview-bar" onSubmit={navigate}>
				<input
					aria-label="预览地址"
					value={inputUrl}
					onChange={(e) => setInputUrl(e.target.value)}
					placeholder="http://localhost:3000"
				/>
				<button type="submit" className="cc-mini-btn">
					访问
				</button>
			</form>
			{error && <div className="live-error" role="alert">{error}</div>}
			<div className="cc-preview-stage">
				<iframe
					key={`${activeUrl}-${reloadKey}`}
					title="本地应用网页预览"
					src={activeUrl}
					className={mobile ? "mobile" : ""}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
				/>
			</div>
		</aside>
	);
}
