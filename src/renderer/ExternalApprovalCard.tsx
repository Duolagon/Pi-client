import { useState, type FormEvent } from "react";
import { Bot, Check, HelpCircle } from "lucide-react";
import type { ExternalApprovalRequest, ExternalApprovalResponse, ExternalTask } from "../external-types.ts";
import { externalQuestionFields } from "./external-questions.ts";
import { SelectPopover } from "./SelectPopover.tsx";
import "./external-approval.css";

export function ExternalApprovalCard({
	task,
	request,
	onRespond,
	fail,
}: {
	task: ExternalTask;
	request: ExternalApprovalRequest;
	onRespond: (response: ExternalApprovalResponse) => Promise<void>;
	fail: (error: unknown) => void;
}) {
	const [answers, setAnswers] = useState<NonNullable<ExternalApprovalResponse["answers"]>>({});
	const [pending, setPending] = useState(false);
	const question = request.kind === "question";
	const fields = question ? externalQuestionFields(request, task.executor) : undefined;
	const usable = fields?.every((field) => {
		const answer = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
		if (Array.isArray(answer)) return answer.length >= field.min && answer.length <= field.max;
		return typeof answer === "string" && answer.trim() ? true : !field.required;
	});
	const respond = async (response: ExternalApprovalResponse) => {
		if (pending) return;
		setPending(true);
		try { await onRespond(response); } catch (error) { fail(error); setPending(false); }
	};
	const submitAnswers = (event: FormEvent) => {
		event.preventDefault();
		if (!usable) return;
		const filled = Object.entries(answers).filter(([, answer]) => Array.isArray(answer) ? answer.length > 0 : Boolean(answer.trim()));
		void respond({ decision: "allow", answers: Object.fromEntries(filled) });
	};
	const selectMultiple = (id: string, value: string, checked: boolean) => {
		setAnswers((previous) => {
			const existing = Object.hasOwn(previous, id) ? previous[id] : undefined;
			const selected = Array.isArray(existing) ? existing : [];
			return { ...previous, [id]: checked ? [...selected, value] : selected.filter((item) => item !== value) };
		});
	};
	const choices = request.options?.filter((option) => !option.kind || option.kind === "allow_once" || option.kind === "reject_once");
	const details = request.input.command ?? request.input.path ?? request.input.file_path ?? (question ? undefined : request.input);
	const detailText = details === undefined ? undefined : typeof details === "string" ? details : JSON.stringify(details, null, 2);
	const decline = <button type="button" className="secondary-button" disabled={pending}
		onClick={() => void respond({ decision: question ? "cancel" : "deny" })}>{question ? "取消回答" : "拒绝"}</button>;
	return (
		<section className="cc-inline-approval cc-external-approval" aria-label={question ? "外部 Agent 提问" : "外部 Agent 审批"}>
			<div className="cc-inline-approval-head">
				<span className="cc-inline-approval-icon" aria-hidden="true">
					{question ? <HelpCircle size={15} /> : <Bot size={15} />}
				</span>
				<h3>{task.executor} · {task.title} · {question ? "需要回答" : request.toolName}</h3>
			</div>
			{request.description && <p className="subtle-note">{request.description}</p>}
			{detailText && <pre className="permission-detail cc-bash-out">{detailText}</pre>}
			{fields ? (
				<form onSubmit={submitAnswers}>
					{fields.map((field) => {
						const answer = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
						return (
							<fieldset key={field.id} disabled={pending} className="cc-external-field">
								<legend>{field.label}</legend>
								{field.description && <p className="subtle-note">{field.description}</p>}
								{field.multiple ? (
									<div className="cc-ask-options">
										{field.options.map((option) => {
											const checked = Array.isArray(answer) && answer.includes(option.value);
											return (
												<button
													key={option.value}
													type="button"
													role="checkbox"
													aria-checked={checked}
													disabled={pending}
													className={`cc-ask-opt ${checked ? "active" : ""}`.trim()}
													onClick={() => selectMultiple(field.id, option.value, !checked)}
												>
													<span className={`cc-ask-check multi ${checked ? "checked" : ""}`.trim()} aria-hidden="true">
														{checked && <Check size={11} strokeWidth={2.6} />}
													</span>
													<span className="cc-ask-copy">
														<strong>{option.label}</strong>
													</span>
												</button>
											);
										})}
									</div>
								) : field.options.length ? (
									<SelectPopover
										ariaLabel={field.label}
										field
										direction="down"
										placeholder="请选择"
										value={typeof answer === "string" ? answer : ""}
										disabled={pending}
										options={[
											{ value: "", label: "请选择" },
											...field.options.map((option) => ({ value: option.value, label: option.label })),
										]}
										onChange={(val) => setAnswers({ ...answers, [field.id]: val })}
									/>
								) : (
									<input type="text" aria-label={field.label} value={typeof answer === "string" ? answer : ""} maxLength={32768}
										onChange={(event) => setAnswers({ ...answers, [field.id]: event.target.value })} />
								)}
							</fieldset>
						);
					})}
					<div className="dialog-actions">{decline}<button className="primary-button" disabled={pending || !usable}>提交回答</button></div>
				</form>
			) : (
				<>
					{question && !choices?.length && <p className="subtle-note">当前问题的格式无法在客户端作答。</p>}
					<div className="dialog-actions">
						{decline}
						{choices?.map((choice) => (
							<button key={choice.id} type="button" className="secondary-button" disabled={pending}
								onClick={() => void respond({ decision: choice.kind === "reject_once" ? "deny" : "allow", optionId: choice.id })}>{choice.label}</button>
						))}
						{!question && request.kind !== "permissions" && !request.options?.length && (
							<button type="button" className="primary-button" disabled={pending}
								onClick={() => void respond({ decision: "allow" })}>仅本次允许</button>
						)}
					</div>
				</>
			)}
		</section>
	);
}
