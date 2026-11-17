import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { CodeLines, InlineEditDiff } from "./DiffView.tsx";
import type { DesktopAPI, RpcExtensionUIRequest } from "../shared.ts";

type Response = Parameters<DesktopAPI["respond"]>[0];
export function PermissionDialog({
	request,
	conversationId,
	project,
	respond,
	fail,
}: {
	request: RpcExtensionUIRequest;
	conversationId?: string;
	project?: string;
	respond: (response: Response) => Promise<void>;
	fail: (error: unknown) => void;
}) {
	const [value, setValue] = useState("");
	const [pending, setPending] = useState(false);
	useEffect(() => {
		setValue(request.method === "editor" ? (request.prefill ?? "") : "");
		setPending(false);
	}, [request.id]);
	const answer = async (response: Response) => {
		setPending(true);
		try {
			await respond(response);
		} catch (error) {
			fail(error);
			setPending(false);
		}
	};
	useEffect(() => {
		if (!("timeout" in request) || !request.timeout) return;
		const timer = setTimeout(() => {
			void answer({ type: "extension_ui_response", id: request.id, cancelled: true });
		}, request.timeout);
		return () => clearTimeout(timer);
	}, [request.id]);
	if (!["confirm", "select", "input", "editor"].includes(request.method)) return null;
	const cancel = () => {
		if (!pending) void answer({ type: "extension_ui_response", id: request.id, cancelled: true });
	};
	const title = "title" in request ? request.title : "Pi 需要你的输入";
	const toolMatch = /^允许执行\s+([^\s？?]+)[？?]?$/.exec(title);
	const inferredTool = toolMatch?.[1];

	const parsedConfirm = useMemo(() => {
		if (request.method !== "confirm") return null;
		const splitAt = request.message.indexOf("\n\n");
		if (splitAt === -1) return null;
		const reason = request.message.slice(0, splitAt);
		try {
			const input = JSON.parse(request.message.slice(splitAt + 2)) as Record<string, unknown>;
			if (!input || typeof input !== "object") return null;
			return { reason, input };
		} catch {
			return null;
		}
	}, [request]);

	const editHunks = useMemo(() => {
		if (!parsedConfirm || inferredTool !== "edit") return [];
		const inp = parsedConfirm.input;
		if (Array.isArray(inp.edits)) {
			return inp.edits
				.filter((e): e is { oldText: string; newText: string } => Boolean(e && typeof e === "object" && typeof (e as Record<string, unknown>).oldText === "string" && typeof (e as Record<string, unknown>).newText === "string"));
		}
		if (typeof inp.oldText === "string" && typeof inp.newText === "string") {
			return [{ oldText: inp.oldText, newText: inp.newText }];
		}
		return [];
	}, [parsedConfirm, inferredTool]);

	const alwaysAllow = async () => {
		if (!inferredTool) return;
		setPending(true);
		try {
			await window.pi.permissions.upsert({
				id: `allow-${inferredTool}-${Date.now().toString(36)}`,
				scope: project ? "project" : "global",
				project,
				conversationId: project ? undefined : conversationId,
				action: "allow",
				tool: inferredTool,
			});
			await respond({ type: "extension_ui_response", id: request.id, confirmed: true });
		} catch (error) {
			fail(error);
			setPending(false);
		}
	};

	return (
		<Modal title={title} close={cancel}>
			<div className="simple-dialog permission-dialog">
				<div className="live-permission-note">
					<ShieldCheck size={17} />
					<span>此请求来自正在运行的 Pi 会话。</span>
				</div>
				{request.method === "confirm" && (
					<>
						{parsedConfirm && editHunks.length > 0 ? (
							<div className="cc-perm-preview">
								<p className="cc-perm-reason">
									{parsedConfirm.reason} · <code>{String(parsedConfirm.input.path ?? "")}</code>
								</p>
								<div className="cc-perm-scroll">
									{editHunks.map((hunk, idx) => (
										<div key={idx} className={idx > 0 ? "cc-edit-hunk-sep" : undefined}>
											<InlineEditDiff oldText={hunk.oldText} newText={hunk.newText} />
										</div>
									))}
								</div>
							</div>
						) : parsedConfirm && inferredTool === "write" && typeof parsedConfirm.input.content === "string" ? (
							<div className="cc-perm-preview">
								<p className="cc-perm-reason">
									{parsedConfirm.reason} · <code>{String(parsedConfirm.input.path ?? "")}</code>
								</p>
								<div className="cc-perm-scroll">
									<CodeLines content={parsedConfirm.input.content} />
								</div>
							</div>
						) : parsedConfirm && inferredTool === "bash" && typeof parsedConfirm.input.command === "string" ? (
							<div className="cc-perm-preview">
								<p className="cc-perm-reason">{parsedConfirm.reason}</p>
								<pre className="permission-detail cc-bash-out">{`$ ${parsedConfirm.input.command}`}</pre>
							</div>
						) : (
							<pre className="permission-detail">{request.message}</pre>
						)}
						<div className="dialog-actions">
							<button
								disabled={pending}
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, confirmed: false })}
								className="secondary-button"
							>
								拒绝
							</button>
							{inferredTool && (
								<button
									disabled={pending}
									onClick={() => void alwaysAllow()}
									className="secondary-button"
									title={`在当前${project ? "项目" : "全局"}始终允许 ${inferredTool}`}
								>
									始终允许 {inferredTool}
								</button>
							)}
							<button
								autoFocus
								disabled={pending}
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, confirmed: true })}
								className="primary-button"
							>
								允许执行
							</button>
						</div>
					</>
				)}
				{request.method === "select" && (
					<div className="live-options">
						{request.options.map((option) => (
							<button
								disabled={pending}
								key={option}
								className="secondary-button"
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, value: option })}
							>
								{option}
							</button>
						))}
						<button disabled={pending} onClick={cancel}>
							取消
						</button>
					</div>
				)}
				{(request.method === "input" || request.method === "editor") && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void answer({ type: "extension_ui_response", id: request.id, value });
						}}
					>
						<label className="field-label">
							{request.method === "editor" ? (
								<textarea
									autoFocus
									rows={9}
									aria-label="扩展编辑器"
									value={value}
									onChange={(event) => setValue(event.target.value)}
								/>
							) : (
								<input
									autoFocus
									aria-label="扩展输入"
									placeholder={request.placeholder}
									value={value}
									onChange={(event) => setValue(event.target.value)}
								/>
							)}
						</label>
						<div className="dialog-actions">
							<button disabled={pending} type="button" className="secondary-button" onClick={cancel}>
								取消
							</button>
							<button disabled={pending} className="primary-button">
								确认
							</button>
						</div>
					</form>
				)}
			</div>
		</Modal>
	);
}
