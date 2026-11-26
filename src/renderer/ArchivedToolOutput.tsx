import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, FileText } from "lucide-react";
import type { ToolOutputPage, ToolOutputReference } from "../tool-output-types.ts";
import { copyText } from "./clipboard.ts";

function formatArchiveBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

export function ArchivedToolOutput({ reference }: { reference: ToolOutputReference }) {
	const [page, setPage] = useState<ToolOutputPage>();
	const [offsets, setOffsets] = useState<number[]>([0]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);

	const load = async (positions: number[]) => {
		setLoading(true);
		setError("");
		try {
			setPage(await window.pi.readToolOutput(reference.conversationId, reference.id, positions.at(-1)));
			setOffsets(positions);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method.*?: Error: /, "") : "无法读取工具输出。");
		} finally {
			setLoading(false);
		}
	};

	const currentOffset = offsets.at(-1) ?? 0;
	const endByte = page ? (page.nextOffset ?? reference.bytes) : 0;

	return (
		<div className="cc-archive-viewer">
			<div className="cc-archive-bar">
				<span className="cc-archive-meta">
					<FileText size={12} aria-hidden="true" />
					<span>归档输出 · {formatArchiveBytes(reference.bytes)}</span>
					{page && (
						<span className="cc-source-tag">
							第 {offsets.length} 页 ({formatArchiveBytes(currentOffset)}–{formatArchiveBytes(Math.max(currentOffset, endByte))})
						</span>
					)}
				</span>
				<div className="cc-archive-actions">
					{!page ? (
						<button type="button" className="cc-mini-btn" disabled={loading} onClick={() => void load([0])}>
							{loading ? "读取中…" : reference.partial ? "查看保留输出" : "查看完整输出"}
						</button>
					) : (
						<>
							<button
								type="button"
								className={`cc-mini-btn ${copied ? "is-copied" : ""}`.trim()}
								aria-label="复制当前页输出"
								onClick={() => {
									void copyText(page.text).then((ok) => {
										if (!ok) return;
										setCopied(true);
										setTimeout(() => setCopied(false), 1400);
									});
								}}
							>
								{copied ? <Check size={12} /> : <Copy size={12} />}
								<span>{copied ? "已复制" : "复制本页"}</span>
							</button>
							<button
								type="button"
								className="cc-mini-btn"
								disabled={loading || offsets.length === 1}
								onClick={() => void load(offsets.slice(0, -1))}
							>
								<ChevronLeft size={12} /> 上一页
							</button>
							<button
								type="button"
								className="cc-mini-btn"
								disabled={loading || page.nextOffset === null}
								onClick={() => {
									if (page.nextOffset !== null) void load([...offsets, page.nextOffset]);
								}}
							>
								下一页 <ChevronRight size={12} />
							</button>
						</>
					)}
				</div>
			</div>
			{page && reference.partial && <p className="cl-truncated">此工具的原始输出超过记录上限，以下为保留内容。</p>}
			{error && (
				<div className="live-error cc-archive-error" role="alert">
					{error}
				</div>
			)}
			{page && (
				<pre className={`cc-bash-out ${loading ? "is-loading" : ""}`.trim()} aria-label="工具原文">
					{page.text}
				</pre>
			)}
		</div>
	);
}
