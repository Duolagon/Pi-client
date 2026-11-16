import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { DesktopAPI, RpcExtensionUIRequest } from "../shared.ts";

type Response = Parameters<DesktopAPI["respond"]>[0];
export function PermissionDialog({
	request,
	respond,
	fail,
}: {
	request: RpcExtensionUIRequest;
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
	return (
		<Modal title={title} close={cancel}>
			<div className="simple-dialog permission-dialog">
				<div className="live-permission-note">
					<ShieldCheck size={17} />
					<span>此请求来自正在运行的 Pi 会话。</span>
				</div>
				{request.method === "confirm" && (
					<>
						<pre className="permission-detail">{request.message}</pre>
						<div className="dialog-actions">
							<button
								disabled={pending}
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, confirmed: false })}
								className="secondary-button"
							>
								拒绝
							</button>
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
