import { useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck, WifiOff } from "lucide-react";
import type { SandboxStatus } from "../shared.ts";

export function SandboxControl({
	enabled,
	offline,
	status,
	projectPath,
	disabled,
	open,
	onOpenChange,
	onChange,
}: {
	enabled: boolean;
	offline: boolean;
	status: SandboxStatus | null;
	projectPath?: string;
	disabled?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChange: (next: { sandbox: boolean; sandboxOffline: boolean }) => Promise<void> | void;
}) {
	const [busy, setBusy] = useState(false);
	const [draftEnabled, setDraftEnabled] = useState(enabled);
	const [draftOffline, setDraftOffline] = useState(offline);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setDraftEnabled(enabled);
		setDraftOffline(offline);
	}, [enabled, offline]);

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) onOpenChange(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onOpenChange(false);
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open, onOpenChange]);

	const unsupported = status?.supported === false;
	const stateClass = draftEnabled ? (draftOffline ? "offline" : "on") : "off";
	const pillText = draftEnabled ? (draftOffline ? "离线沙箱" : "Seatbelt 沙箱") : "无沙箱";

	const apply = async (next: { sandbox: boolean; sandboxOffline: boolean }) => {
		if (busy || disabled) return;
		const prevEnabled = draftEnabled;
		const prevOffline = draftOffline;
		setDraftEnabled(next.sandbox);
		setDraftOffline(next.sandbox && next.sandboxOffline);
		setBusy(true);
		try {
			await onChange(next);
		} catch {
			setDraftEnabled(prevEnabled);
			setDraftOffline(prevOffline);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="cc-sandbox-wrap" ref={rootRef}>
			<button
				type="button"
				className={`cl-pill cc-sandbox-pill ${stateClass} ${open ? "open" : ""}`}
				aria-label="命令沙箱设置"
				aria-expanded={open}
				disabled={disabled}
				title={
					draftEnabled
						? draftOffline
								? "已开启命令沙箱与内置文件保护，Bash 无法联网"
								: "已开启命令沙箱与内置文件保护"
						: "当前未开启 OS 命令沙箱，点击配置"
				}
				onClick={() => onOpenChange(!open)}
			>
				{draftEnabled ? (
					draftOffline ? (
						<WifiOff size={12} />
					) : (
						<ShieldCheck size={13} />
					)
				) : (
					<ShieldAlert size={13} />
				)}
				<span>{pillText}</span>
			</button>
			{open && (
				<div className="cc-sandbox-popover" role="region" aria-label="命令沙箱控制">
					<div className="cc-sandbox-head">
						<div>
							<strong>macOS Seatbelt 命令沙箱</strong>
							<span className={`cc-sandbox-badge ${stateClass}`}>
								{unsupported ? "不可用" : draftEnabled ? (draftOffline ? "离线隔离" : "已保护") : "未开启"}
							</span>
						</div>
						<p>Seatbelt 隔离 Bash 与 Monitor。开启沙箱时，内置文件工具也会限制写入范围并保护凭据。</p>
					</div>

					<label className={`cc-sandbox-toggle ${unsupported && !draftEnabled ? "disabled" : ""}`}>
						<input
							type="checkbox"
							aria-label="快捷开启 macOS Seatbelt 命令沙箱"
							checked={draftEnabled}
							disabled={busy || disabled || (!draftEnabled && unsupported)}
							onChange={(event) => void apply({ sandbox: event.target.checked, sandboxOffline: event.target.checked ? draftOffline : false })}
						/>
						<span>
							<strong>开启 OS 命令沙箱</strong>
							<small>命令可写工作区、附加目录与系统临时目录</small>
						</span>
					</label>

					<label className={`cc-sandbox-toggle ${!draftEnabled ? "disabled" : ""}`}>
						<input
							type="checkbox"
							aria-label="快捷禁止 Bash 命令访问网络"
							checked={draftEnabled && draftOffline}
							disabled={busy || disabled || !draftEnabled}
							onChange={(event) => void apply({ sandbox: true, sandboxOffline: event.target.checked })}
						/>
						<span>
							<strong>禁止 Bash 访问网络（离线沙箱）</strong>
							<small>阻止命令行工具发起外部网络请求</small>
						</span>
					</label>

					{unsupported && status?.reason && (
						<div className="cc-sandbox-warn">{status.reason}</div>
					)}

					<div className="cc-sandbox-scope">
						<div>
							<span>文件工具可写</span>
							<code>{projectPath || "当前项目目录"}及附加目录</code>
						</div>
						<div>
							<span>保护凭据</span>
							<code>~/.ssh · ~/.aws · ~/.gnupg · ~/.kube · ~/.netrc · Keychains</code>
						</div>
						<p>内置文件工具也会保护 .env 文件。交互终端、MCP 与 Hooks 使用各自的权限。</p>
					</div>
				</div>
			)}
		</div>
	);
}
