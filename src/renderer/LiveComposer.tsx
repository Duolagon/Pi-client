import { useRef, useState } from "react";
import { ArrowUp, Brain, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { Command, PermissionMode, Snapshot, ThinkingLevel } from "../shared.ts";

type Image = NonNullable<Extract<Command, { type: "prompt" }>["images"]>[number];
interface Attachment {
	name: string;
	text?: string;
	image?: Image;
}
const DEFAULT_DESKTOP_KEYBINDINGS = { submit: "Enter" };
const PERMISSION_LABEL: Record<PermissionMode, string> = { ask: "手动确认", auto: "自动执行", read: "只读模式" };
export function LiveComposer({
	snapshot,
	draft,
	setDraft,
	running,
	changing,
	send,
	stop,
	command,
	setPermission,
	openSettings,
	fail,
}: {
	snapshot: Snapshot;
	draft: string;
	setDraft: (value: string) => void;
	running: boolean;
	changing: boolean;
	send: (prompt: Extract<Command, { type: "prompt" }>) => Promise<void>;
	stop: () => void;
	command: (value: Command) => Promise<void>;
	setPermission: (value: PermissionMode) => void;
	openSettings: () => void;
	fail: (error: unknown) => void;
}) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [sending, setSending] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const hasModel = snapshot.models.length > 0 && Boolean(snapshot.state?.model);
	const disabled = changing || sending || snapshot.engineStatus !== "ready" || !snapshot.active || !hasModel;
	const attach = async (files: File[]) => {
		try {
			const added: Attachment[] = [];
			for (const file of files) {
				if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请缩小后再添加。`);
				if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
					const data = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result).split(",")[1]);
						reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
						reader.readAsDataURL(file);
					});
					added.push({ name: file.name, image: { type: "image", mimeType: file.type, data } });
				} else {
					if (file.size > 1024 * 1024 || file.type === "application/pdf")
						throw new Error(`${file.name} 暂不支持。请添加不超过 1 MB 的文本或代码文件。`);
					const text = await file.text();
					if (text.includes("\0")) throw new Error(`${file.name} 是二进制文件，无法作为文本添加。`);
					added.push({ name: file.name, text });
				}
			}
			setAttachments((items) => [...items, ...added]);
		} catch (error) {
			fail(error);
		}
	};
	const submit = async () => {
		if (disabled || (!draft.trim() && !attachments.length)) return;
		setSending(true);
		const text =
			draft.trim() +
			attachments
				.filter((item) => item.text !== undefined)
				.map((item) => `\n\n附件 ${item.name}：\n${item.text}`)
				.join("");
		try {
			await send({
				type: "prompt",
				message: text || "请查看这些图片。",
				images: attachments.flatMap((item) => (item.image ? [item.image] : [])),
			});
			setAttachments([]);
		} catch {
			/* The controller keeps the draft and displays the failure. */
		} finally {
			setSending(false);
		}
	};
	const selected = snapshot.state?.model;
	return (
		<div className="cl-composer">
			<form
				className="cl-composer-box"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					void attach(Array.from(event.dataTransfer.files));
				}}
			>
				{attachments.length > 0 && (
					<div className="cl-attachments">
						{attachments.map((item, index) => (
							<span key={`${item.name}-${index}`}>
								{item.name}
								<button
									type="button"
									aria-label={`移除附件 ${item.name}`}
									onClick={() => setAttachments((items) => items.filter((_, at) => at !== index))}
								>
									<X size={13} />
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					aria-label="输入任务"
					value={draft}
					rows={3}
					placeholder={
						snapshot.active
							? hasModel
								? "描述任务，或在运行中补充指令…"
								: "先在设置中连接 Pi 的模型配置"
							: "先打开项目文件夹"
					}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={(event) => {
						if (event.clipboardData.files.length) {
							event.preventDefault();
							void attach(Array.from(event.clipboardData.files));
						}
					}}
					onKeyDown={(event) => {
						if (event.key === DEFAULT_DESKTOP_KEYBINDINGS.submit && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				<div className="cl-composer-row">
					<button className="cl-icon-btn" type="button" aria-label="添加附件" onClick={() => fileInput.current?.click()}>
						<Paperclip size={17} />
					</button>
					<span className="cl-composer-hint">
						{running ? "发送补充指令会进入 Pi 的引导队列" : "Enter 发送 · Shift Enter 换行"}
					</span>
					{running ? (
						<button type="button" className="cl-send stop" aria-label="停止任务" onClick={stop}>
							<Square size={13} fill="currentColor" />
						</button>
					) : (
						<button
							type="submit"
							className="cl-send"
							aria-label="发送任务"
							disabled={disabled || (!draft.trim() && !attachments.length)}
						>
							<ArrowUp size={17} />
						</button>
					)}
				</div>
			</form>
			<div className="cl-composer-bar">
				<div className="cl-pills">
					<label className="cl-pill">
						<span className="cl-pill-select">
							<select
								aria-label="选择模型"
								value={selected ? `${selected.provider}\0${selected.id}` : ""}
								disabled={changing || running || !snapshot.models.length}
								onChange={(event) => {
									const [provider, modelId] = event.target.value.split("\0");
									void command({ type: "set_model", provider, modelId });
								}}
							>
								<option value="" disabled>
									未连接模型
								</option>
								{snapshot.models.map((model) => (
									<option key={`${model.provider}/${model.id}`} value={`${model.provider}\0${model.id}`}>
										{model.name || model.id}
									</option>
								))}
							</select>
						</span>
					</label>
					{snapshot.thinkingLevels.length > 0 && (
						<label className="cl-pill">
							<Brain size={13} />
							<span className="cl-pill-select">
								<select
									aria-label="思考强度"
									value={snapshot.state?.thinkingLevel ?? "off"}
									disabled={changing || running || !snapshot.thinkingLevels.length}
									onChange={(event) =>
										void command({ type: "set_thinking_level", level: event.target.value as ThinkingLevel })
									}
								>
									{snapshot.thinkingLevels.map((level) => (
										<option key={level}>{level}</option>
									))}
								</select>
							</span>
						</label>
					)}
					<label className="cl-pill">
						<ShieldCheck size={13} />
						<span className="cl-pill-select">
							<select
								aria-label="权限模式"
								value={snapshot.settings.permission}
								disabled={changing || running}
								onChange={(event) => setPermission(event.target.value as PermissionMode)}
							>
								{(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((mode) => (
									<option key={mode} value={mode}>
										{PERMISSION_LABEL[mode]}
									</option>
								))}
							</select>
						</span>
					</label>
				</div>
				{snapshot.commands.length > 0 && (
					<details className="cl-skills">
						<summary>Skills · {snapshot.commands.length}</summary>
						<div className="cl-skills-list">
							{snapshot.commands.map((item) => (
								<button
									key={`${item.source}-${item.name}`}
									onClick={() => setDraft(`/${item.name} `)}
									title={item.description}
								>
									/{item.name}
									<span>{item.description}</span>
								</button>
							))}
						</div>
					</details>
				)}
				{!snapshot.commands.length && (
					<button type="button" className="cl-config" onClick={openSettings}>
						配置
					</button>
				)}
			</div>
			<input
				ref={fileInput}
				type="file"
				multiple
				className="visually-hidden"
				aria-label="选择附件"
				onChange={(event) => {
					void attach(Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
			/>
		</div>
	);
}
