import { useEffect, useMemo, useState } from "react";
import { Check, FileCode2, HelpCircle, ShieldCheck, Terminal } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import { CodeLines, InlineEditDiff } from "./DiffView.tsx";
import { inferLangFromPath } from "./highlight.tsx";
import type { DesktopAPI, RpcExtensionUIRequest, TaskPendingApproval } from "../shared.ts";

type Response = Parameters<DesktopAPI["respond"]>[0];
export interface SubagentApprovalSource {
	taskId: string;
	name?: string;
	description: string;
	subagentType?: string;
	depth: number;
	rootConversationId: string;
}

export function PermissionDialog({
	request,
	inline = false,
	conversationId,
	project,
	subagentSource,
	queuePosition,
	respond,
	defer,
	fail,
}: {
	request: RpcExtensionUIRequest | TaskPendingApproval;
	inline?: boolean;
	conversationId?: string;
	project?: string;
	/** Present when this approval bubbled up from a delegated sub-agent. */
	subagentSource?: SubagentApprovalSource;
	queuePosition?: { index: number; total: number };
	respond: (response: Response) => Promise<void>;
	defer?: () => void;
	fail: (error: unknown) => void;
}) {
	const [value, setValue] = useState("");
	const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({});
	const [questionCustom, setQuestionCustom] = useState<Record<string, string>>({});
	const [pending, setPending] = useState(false);
	useEffect(() => {
		setValue(request.method === "editor" ? (request.prefill ?? "") : "");
		setQuestionAnswers({});
		setQuestionCustom({});
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
	const isAskQuestions = request.method === "input" && request.title === "__PI_ASK_QUESTIONS__";
	const parsedQuestions = useMemo(() => {
		if (!isAskQuestions || !("placeholder" in request) || !request.placeholder) return null;
		try {
			const data = JSON.parse(request.placeholder) as {
				questions?: Array<{
					header?: string;
					question: string;
					multiSelect?: boolean;
					options: Array<{ label: string; description?: string }>;
				}>;
			};
			return Array.isArray(data?.questions) ? data.questions : null;
		} catch {
			return null;
		}
	}, [isAskQuestions, request]);
	const title = isAskQuestions ? "请回答以下确认问题" : "title" in request ? request.title : "Pi 需要你的输入";
	const answersComplete = parsedQuestions?.every((_, index) =>
		Boolean(questionAnswers[String(index)]?.length || questionCustom[String(index)]?.trim()),
	);
	const toolMatch = /^允许执行\s+([^\s？?（]+)(（远端写入，仅本次）)?[？?]?$/.exec(title);
	const inferredTool = toolMatch?.[1];
	const singleRemoteUse = Boolean(toolMatch?.[2]);

	const parsedConfirm = useMemo(() => {
		if (request.method !== "confirm") return null;
		const msg = request.message ?? "";
		const splitAt = msg.indexOf("\n\n");
		if (splitAt === -1) return null;
		const reason = msg.slice(0, splitAt);
		try {
			const input = JSON.parse(msg.slice(splitAt + 2)) as Record<string, unknown>;
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

	// Narrow the remembered rule like Claude Code: a command prefix for bash and
	// a host for WebFetch, never the whole tool when a narrower selector exists.
	const allowSelector = useMemo((): { label: string; extra: Record<string, unknown> } | null | undefined => {
		if (!inferredTool || singleRemoteUse) return null;
		const input = parsedConfirm?.input;
		if (inferredTool === "bash") {
			const command = typeof input?.command === "string" ? input.command.trim() : "";
			// Compound commands get no remembered rule; later arguments may be quoted.
			if (!command || /[;&|\n\r`]|\$\(/.test(command)) return null;
			const words = command.split(/\s+/);
			const plain = /^[\w./@%+=,:-]+$/;
			const wrappers = ["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".", "env", "sudo", "doas", "exec", "command", "xargs", "timeout", "time", "nice", "nohup", "stdbuf"];
			if (!plain.test(words[0]) || wrappers.includes(words[0].split("/").at(-1)!) || /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(words[0])) return null;
			// Keep a subcommand or option (`git commit`, `rm -rf`, `node build.js`) so one click never allows the whole executable.
			const argv = words.length > 1 && plain.test(words[1]) ? words.slice(0, 2) : words.length === 1 ? words : null;
			if (!argv) return null;
			return { label: `${argv.join(" ")} *`, extra: { command: { type: "prefix", argv } } };
		}
		if (inferredTool === "WebFetch") {
			try {
				const host = new URL(String(input?.url ?? "")).hostname.toLowerCase().replace(/\.$/, "");
				const valid = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host);
				return valid ? { label: `WebFetch(${host})`, extra: { domain: host } } : null;
			} catch {
				return null;
			}
		}
		return { label: inferredTool, extra: {} };
	}, [inferredTool, parsedConfirm, singleRemoteUse]);

	const alwaysAllow = async () => {
		if (!inferredTool || !allowSelector) return;
		setPending(true);
		try {
			if (subagentSource) {
				await window.pi.permissions.upsert({
					id: `allow-tree-${inferredTool}-${Date.now().toString(36)}`,
					scope: "conversation",
					conversationId: subagentSource.rootConversationId,
					delegatedOnly: true,
					action: "allow",
					tool: inferredTool,
					...allowSelector.extra,
				});
			} else {
				const scope = project ? "project" : conversationId ? "conversation" : "global";
				await window.pi.permissions.upsert({
					id: `allow-${inferredTool}-${Date.now().toString(36)}`,
					scope,
					...(scope === "project" ? { project } : {}),
					...(scope === "conversation" ? { conversationId } : {}),
					action: "allow",
					tool: inferredTool,
					...allowSelector.extra,
				});
			}
			await respond({ type: "extension_ui_response", id: request.id, confirmed: true });
		} catch (error) {
			fail(error);
			setPending(false);
		}
	};

	const subagentLabel = subagentSource
		? `子 Agent ‹${subagentSource.name || subagentSource.description}› (${subagentSource.subagentType || "general-purpose"})`
		: undefined;
	const queueTag = queuePosition && queuePosition.total > 1 ? ` [${queuePosition.index + 1}/${queuePosition.total}]` : "";
	const modalTitle = subagentLabel ? `${subagentLabel} 请求：${title}${queueTag}` : `${title}${queueTag}`;

	const canDefer = Boolean(defer) && !("timeout" in request && request.timeout);
	const reason = parsedConfirm?.reason;
	const detailReason = inline && reason === "此工具操作需要确认。" ? "" : reason;
	const confirmedPath = parsedConfirm?.input.path;
	const filePath = typeof confirmedPath === "string" ? confirmedPath : undefined;
	const fileReason = parsedConfirm && <p className="cc-perm-reason">
		{detailReason && <span>{detailReason}{!inline && " · "}</span>}
		<code>{String(parsedConfirm.input.path ?? "")}</code>
	</p>;
	const controls = (
		<>
			{canDefer && request.method !== "confirm" && (
				<button type="button" className="cc-mini-btn cc-defer-approval cc-defer-top" disabled={pending} onClick={defer}>稍后处理</button>
			)}
			<div className="simple-dialog permission-dialog">
				{!inline && <div className="live-permission-note">
					<ShieldCheck size={17} />
					<span>
						{subagentLabel
							? `此请求来自 ${subagentLabel}；按 Esc 仅拒绝本次调用，不会停止子 Agent。`
							: "此操作正在等待你决定。"}
					</span>
				</div>}
				{request.method === "confirm" && (
					<>
						{parsedConfirm && editHunks.length > 0 ? (
							<div className="cc-perm-preview">
								{fileReason}
								<div className="cc-perm-scroll">
									{editHunks.map((hunk, idx) => (
										<div key={idx} className={idx > 0 ? "cc-edit-hunk-sep" : undefined}>
											<InlineEditDiff oldText={hunk.oldText} newText={hunk.newText} filePath={filePath} />
										</div>
									))}
								</div>
							</div>
						) : parsedConfirm && inferredTool === "write" && typeof parsedConfirm.input.content === "string" ? (
							<div className="cc-perm-preview">
								{fileReason}
								<div className="cc-perm-scroll">
									<CodeLines content={parsedConfirm.input.content} lang={inferLangFromPath(filePath)} />
								</div>
							</div>
						) : parsedConfirm && inferredTool === "bash" && typeof parsedConfirm.input.command === "string" ? (
							<div className="cc-perm-preview">
								{detailReason && <p className="cc-perm-reason">{detailReason}</p>}
								<pre className="permission-detail cc-bash-out">{`$ ${parsedConfirm.input.command}`}</pre>
							</div>
						) : (
							<pre className="permission-detail">{request.message}</pre>
						)}
						<div className="dialog-actions">
							{canDefer && (
								<button type="button" className="cc-mini-btn cc-defer-approval" disabled={pending} onClick={defer}>
									稍后处理
								</button>
							)}
							<button
								type="button"
								autoFocus={!inline}
								data-autofocus={!inline || undefined}
								disabled={pending}
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, confirmed: false })}
								className="secondary-button"
							>
								拒绝
							</button>
							{inferredTool && allowSelector && (
								<button
									type="button"
									disabled={pending}
									onClick={() => void alwaysAllow()}
									className="secondary-button"
									title={
										subagentSource
											? `对当前会话的所有子 Agent（委派树）始终允许 ${allowSelector.label}，不放宽主会话自身`
											: `在当前${project ? "项目" : "会话"}始终允许 ${allowSelector.label}`
									}
								>
									{subagentSource ? `对所有子 Agent 始终允许 ${allowSelector.label}` : `始终允许 ${allowSelector.label}`}
								</button>
							)}
							<button
								type="button"
								disabled={pending}
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, confirmed: true })}
								className="primary-button"
							>
								{singleRemoteUse ? "仅本次执行" : "允许执行"}
							</button>
						</div>
					</>
				)}
				{request.method === "select" && (
					<div className="live-options">
						{(request.options ?? []).map((option) => (
							<button
								type="button"
								disabled={pending}
								key={option}
								className="secondary-button"
								onClick={() => void answer({ type: "extension_ui_response", id: request.id, value: option })}
							>
								{option}
							</button>
						))}
						<button type="button" className="secondary-button" disabled={pending} onClick={cancel}>
							取消
						</button>
					</div>
				)}
				{isAskQuestions && parsedQuestions ? (
					<form
						className="cc-ask-form"
						onSubmit={(event) => {
							event.preventDefault();
						if (pending || !answersComplete) return;
							const formatted: Record<string, string | string[]> = {};
							parsedQuestions.forEach((q, idx) => {
								const key = q.header || `Q${idx + 1}`;
								const selected = questionAnswers[String(idx)] ?? [];
								const custom = (questionCustom[String(idx)] ?? "").trim();
								const combined = custom ? [...selected, custom] : selected;
								formatted[key] = q.multiSelect ? combined : (combined[0] ?? "");
							});
							void answer({ type: "extension_ui_response", id: request.id, value: JSON.stringify({ answers: formatted }) });
						}}
					>
						{parsedQuestions.map((q, idx) => {
							const k = String(idx);
							const selected = questionAnswers[k] ?? [];
							const toggleOption = (label: string) => {
								setQuestionAnswers((prev) => {
									const cur = prev[k] ?? [];
									if (q.multiSelect) {
										return { ...prev, [k]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
									}
									return { ...prev, [k]: [label] };
								});
							};
							return (
								<div key={idx} className="cc-ask-card">
									<div className="cc-ask-head">
										{q.header && <span className="cc-source-tag">{q.header}</span>}
										<strong>{q.question}</strong>
									</div>
									<div className="cc-ask-options">
										{q.options.map((opt) => {
											const checked = selected.includes(opt.label);
											return (
												<button
													type="button"
													key={opt.label}
													className={`cc-ask-opt ${checked ? "active" : ""}`}
													onClick={() => toggleOption(opt.label)}
													disabled={pending}
												>
													<span className={`cc-ask-check ${q.multiSelect ? "multi" : "single"} ${checked ? "checked" : ""}`} aria-hidden="true">
														{checked && <Check size={11} strokeWidth={2.6} />}
													</span>
													<span className="cc-ask-copy">
														<strong>{opt.label}</strong>
														{opt.description && <span>{opt.description}</span>}
													</span>
												</button>
											);
										})}
									</div>
									<input
										aria-label={`补充说明 ${idx + 1}`}
										placeholder="或填写其他补充说明（可选）…"
										value={questionCustom[k] ?? ""}
										onChange={(e) => setQuestionCustom((prev) => ({ ...prev, [k]: e.target.value }))}
										disabled={pending}
									/>
								</div>
							);
						})}
						<div className="dialog-actions">
							<button disabled={pending} type="button" className="secondary-button" onClick={cancel}>
								取消
							</button>
							<button disabled={pending || !answersComplete} className="primary-button">
								提交回答
							</button>
						</div>
					</form>
				) : (request.method === "input" || request.method === "editor") && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void answer({ type: "extension_ui_response", id: request.id, value });
						}}
					>
						<label className="field-label">
							{request.method === "editor" ? (
								<textarea
									autoFocus={!inline} data-autofocus={!inline || undefined}
									rows={9}
									aria-label="扩展编辑器"
									value={value}
									onChange={(event) => setValue(event.target.value)}
								/>
							) : (
								<input
									autoFocus={!inline} data-autofocus={!inline || undefined}
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
		</>
	);
	if (inline) {
		const HeaderIcon = isAskQuestions
			? HelpCircle
			: inferredTool === "bash"
				? Terminal
				: inferredTool === "edit" || inferredTool === "write"
					? FileCode2
					: ShieldCheck;
		return (
			<section className={`cc-inline-approval ${isAskQuestions ? "is-question" : ""}`.trim()} role="region" aria-label={modalTitle} tabIndex={-1}>
				<div className="cc-inline-approval-head">
					<span className="cc-inline-approval-icon" aria-hidden="true">
						<HeaderIcon size={15} />
					</span>
					<h3>{modalTitle}</h3>
				</div>
				{controls}
			</section>
		);
	}
	return <Modal title={modalTitle} close={cancel}>{controls}</Modal>;
}
