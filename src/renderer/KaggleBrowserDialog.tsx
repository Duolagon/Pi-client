import { useState, type FormEvent } from "react";
import { Modal } from "../prototype/ui.tsx";
import { type KaggleSelection } from "../kaggle-browser.ts";
import "./kaggle-browser.css";

export function KaggleBrowserDialog({ open, close }: { open: (url: string) => Promise<void>; close: () => void }) {
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (loading) return;
		setLoading(true);
		setError("");
		try {
			await open(url.trim());
			close();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "无法打开 Kaggle 浏览器。");
		} finally {
			setLoading(false);
		}
	}
	return (
		<Modal title="打开 Kaggle Notebook" close={close}>
			<form className="simple-dialog kaggle-browser-form" onSubmit={submit}>
				<label className="field-label">
					<span>Notebook 链接</span>
					<input type="url" data-autofocus required value={url} maxLength={4096}
						placeholder="https://www.kaggle.com/code/用户名/笔记本名" onChange={(event) => setUrl(event.currentTarget.value)} />
				</label>
				<p className="subtle-note">在 Pi 的浏览器窗口中登录 Kaggle。回到当前会话后，可以让 Pi 查看 Notebook 状态和输出，或确认后运行全部单元格。</p>
				{error && <div className="live-error kaggle-browser-error" role="alert">{error}</div>}
				<div className="dialog-actions">
					<button type="button" className="secondary-button" onClick={close}>取消</button>
					<button type="submit" className="primary-button" disabled={loading || !url.trim()}>{loading ? "正在打开…" : "打开 Notebook"}</button>
				</div>
			</form>
		</Modal>
	);
}

export function KaggleSelectionDialog({ selection, attachDisabled, onAttach, close }: {
	selection: KaggleSelection; attachDisabled: string | undefined; onAttach: () => void; close: () => void;
}) {
	return (
		<Modal title="预览 Kaggle Notebook 输出" close={close} wide>
			<div className="simple-dialog kaggle-browser-form">
				<p className="subtle-note kaggle-browser-source">{selection.notebookUrl}</p>
				<pre className="kaggle-browser-output" tabIndex={0}>{selection.text}</pre>
				{selection.truncated && <p className="subtle-note">输出较长。预览和草稿只保留前 16,000 个字符。</p>}
				<p className="subtle-note">{attachDisabled ?? "确认后将文本加入当前会话的草稿，发送前仍可编辑。"}</p>
				<div className="dialog-actions">
					<button type="button" className="secondary-button" data-autofocus onClick={close}>取消</button>
					<button type="button" className="primary-button" disabled={Boolean(attachDisabled)} onClick={onAttach}>附加到草稿</button>
				</div>
			</div>
		</Modal>
	);
}
