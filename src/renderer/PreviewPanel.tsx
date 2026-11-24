import type { PreviewCheck } from "../shared.ts";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, Monitor, RefreshCw, Smartphone, X } from "lucide-react";
import { IconButton } from "../prototype/ui.tsx";
import { useExitGhost } from "./Presence.tsx";
import { DEFAULT_LOCAL_PREVIEW_URL } from "../preview-check-types.ts";

function normalizeLocalUrl(raw: string): string | null {
	try {
		const url = new URL(raw.trim().startsWith("http") ? raw.trim() : `http://${raw.trim()}`);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
		const host = url.hostname.toLowerCase();
		// CSP frame-src cannot express IPv6 hosts with a port wildcard, so only these two are previewable.
		if (host !== "localhost" && host !== "127.0.0.1") return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function PreviewPanel({
	url,
	close,
	onReport,
	onNavigate,
}: {
	url: string;
	close: () => void;
	onReport?: (report: string) => void;
	onNavigate: (url: string) => void;
}) {
	const [inputUrl, setInputUrl] = useState(url);
	const activeUrl = normalizeLocalUrl(url) ?? DEFAULT_LOCAL_PREVIEW_URL;
	const [reloadKey, setReloadKey] = useState(0);
	const [mobile, setMobile] = useState(false);
	const [error, setError] = useState("");
	const [checking, setChecking] = useState(false);
	const [report, setReport] = useState<{ url: string; mobile: boolean; result: PreviewCheck } | null>(null);
	const result = report?.url === activeUrl && report.mobile === mobile ? report.result : null;
	const [reachable, setReachable] = useState<boolean | null>(null);
	const asideRef = useRef<HTMLElement>(null);
	useExitGhost(asideRef, "inspector", { skipOnResize: true, durationMs: 195 });
	useEffect(() => setInputUrl(url), [url]);
	useEffect(() => {
		let cancelled = false;
		setReachable(null);
		void window.pi
			.probePreview(activeUrl)
			.then((ok) => {
				if (!cancelled) setReachable(ok);
			})
			.catch(() => {
				if (!cancelled) setReachable(false);
			});
		return () => {
			cancelled = true;
		};
	}, [activeUrl, reloadKey]);

	const verify = async () => {
		setChecking(true);
		setError("");
		setReport(null);
		try {
			setReport({ url: activeUrl, mobile, result: await window.pi.checkPreview(activeUrl, mobile) });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setChecking(false);
		}
	};

	const navigate = (e: React.FormEvent) => {
		e.preventDefault();
		const normalized = normalizeLocalUrl(inputUrl);
		if (!normalized) {
			setError("出于安全限制，网页预览仅支持 localhost / 127.0.0.1 本地开发地址。");
			return;
		}
		setError("");
		setReport(null);
		onNavigate(normalized);
		setInputUrl(normalized);
		setReloadKey((k) => k + 1);
	};

	return (
		<aside ref={asideRef} className="inspector cc-preview-panel" aria-label="本地应用预览">
			<header className="inspector-header">
				<span className="cc-preview-heading">
					<span className={`cc-preview-dot ${reachable === true ? "ok" : reachable === false ? "err" : "pending"}`} aria-hidden="true" />
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
					placeholder={DEFAULT_LOCAL_PREVIEW_URL}
				/>
				<button type="submit" className="cc-mini-btn" disabled={checking}>
					访问
				</button>
				<button type="button" className="cc-mini-btn" disabled={checking} onClick={() => void verify()}>{checking ? "验证中…" : "验证页面"}</button>
			</form>
			{result && <section className="cc-preview-result">
				<strong>HTTP {result.status || "未知"} · {result.elapsedMs} ms</strong>
				{result.title && <p>{result.title}</p>}
				<p>{result.errors.length ? `${result.errors.length} 条浏览器错误` : "未捕获浏览器错误"}</p>
				{result.errors.length > 0 && <ul>{result.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
				{onReport && <button type="button" className="cc-mini-btn" onClick={() => onReport(`浏览器验证 ${result.url} · HTTP ${result.status} · ${result.elapsedMs} ms\n${result.errors.join("\n")}`)}>加入会话草稿</button>}
			</section>}
			{error && <div className="live-error" role="alert">{error}</div>}
			<div className="cc-preview-stage">
				{reachable === false && (
					<div className="cc-empty-state cc-preview-empty" role="status">
						<Globe size={22} aria-hidden="true" />
						<strong>{new URL(activeUrl).host} 无法连接</strong>
						<p>先在终端启动本地开发服务器，再点右上角的刷新。</p>
					</div>
				)}
				<iframe
					key={`${activeUrl}-${reloadKey}`}
					title="本地应用网页预览"
					src={activeUrl}
					className={mobile ? "mobile" : ""}
					sandbox="allow-scripts allow-same-origin allow-forms"
				/>
			</div>
		</aside>
	);
}
