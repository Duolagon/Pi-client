import { useEffect, useState, type FormEvent } from "react";
import { truncateText } from "../delegation-limits.ts";
import type { ExternalExecutor, ExternalProvider, ExternalTask } from "../external-types.ts";
import { candidateDelta, groupExternalComparisons, type CandidateDelta } from "./external-comparisons.ts";

interface DraftAlternative { executor: ExternalProvider; model: string; effort: string }

export function ExternalTaskComparisons({ task, tasks, executors, executorLabel, statusLabel, onOpenTask, fail }: {
	task: ExternalTask;
	tasks: ExternalTask[];
	executors: ExternalExecutor[];
	executorLabel(id: ExternalProvider): string;
	statusLabel(status: string): string;
	onOpenTask(task: ExternalTask): Promise<void>;
	fail(error: unknown): void;
}) {
	const [draft, setDraft] = useState<DraftAlternative[]>();
	const [busy, setBusy] = useState(false);
	const available = executors.filter((executor) => executor.enabled && executor.available && executor.compatibility !== "incompatible");
	const defaultOrder = [...available.filter((executor) => executor.id !== task.executor), ...available.filter((executor) => executor.id === task.executor)];
	const reviewer = defaultOrder.find((executor) => executor.id !== task.executor && executor.capabilities.readOnly);
	const reviewSource = task.reviewOf && tasks.find((candidate) => candidate.id === task.reviewOf);
	const reviews = tasks.filter((candidate) => candidate.reviewOf === task.id);
	const comparison = task.comparisonId ? tasks.filter((candidate) => candidate.comparisonId === task.comparisonId) : [];
	if (task.comparisonId && !comparison.some((candidate) => candidate.id === task.id)) comparison.push(task);
	// The selected checkpoint and revision change when a candidate continues or a file is discarded.
	const selection = JSON.stringify(comparison.flatMap((entry) => entry.status === "completed" && entry.changes?.checkpointId
		? [[entry.id, entry.changes.checkpointId, entry.revision]] : []));
	const [loaded, setLoaded] = useState<{ selection: string; deltas: Map<string, CandidateDelta> }>();
	useEffect(() => {
		let current = true;
		const selected: Array<[string, string, number]> = JSON.parse(selection);
		if (!selected.length) return;
		void Promise.allSettled(selected.map(async ([id, checkpoint]) => {
			const diff = await window.pi.externalAgents.diff(id, checkpoint, undefined, false);
			return [id, candidateDelta(diff)] as const;
		})).then((entries) => {
			if (current) setLoaded({ selection, deltas: new Map(entries.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : [])) });
		});
		return () => { current = false; };
	}, [selection]);
	const deltas = loaded?.selection === selection ? loaded.deltas : new Map<string, CandidateDelta>();
	const groups = groupExternalComparisons(comparison, deltas);
	const canCompare = !task.readOnly && task.status === "completed";
	const canReview = canCompare && Boolean(task.changes?.checkpointId && (task.turn > 1 || task.changes.files.length));
	if (!canCompare && !reviews.length && !reviewSource && !groups.length) return null;

	const review = async () => {
		if (!reviewer || busy) return;
		setBusy(true);
		try { await onOpenTask(await window.pi.externalAgents.review({ taskId: task.id, executor: reviewer.id })); }
		catch (error) { fail(error); }
		finally { setBusy(false); }
	};

	const newAlternative = (index: number): DraftAlternative => ({ executor: defaultOrder[index % defaultOrder.length].id, model: "", effort: "" });
	const updateDraft = (index: number, update: Partial<DraftAlternative>) => setDraft((previous) => previous?.map((entry, position) => position === index ? { ...entry, ...update } : entry));
	const compare = async (event: FormEvent) => {
		event.preventDefault();
		if (!draft || busy) return;
		setBusy(true);
		try {
			const { tasks: launched, errors } = await window.pi.externalAgents.compare({ taskId: task.id, candidates: draft.map(({ executor, model, effort }) => ({
				executor,
				...(model.trim() ? { model: model.trim() } : {}),
				...(effort.trim() ? { effort: effort.trim() } : {}),
			})) });
			if (errors?.length) fail(new Error(`方案启动失败\n${errors.join("\n")}`));
			setDraft(undefined);
			if (launched[0]) await onOpenTask(launched[0]);
		} catch (error) { fail(error); }
		finally { setBusy(false); }
	};

	return (
		<section className="cc-external-comparisons" aria-label="外部任务审查与方案对比">
			{(reviewSource || reviews.length > 0 || canCompare) && (
				<div className="cc-tool-ctrl-actions cc-external-comparison-actions">
					{reviewSource && <button type="button" className="cc-mini-btn" onClick={() => void onOpenTask(reviewSource)}>查看被审查任务</button>}
					{reviews.map((candidate) => <button type="button" className="cc-mini-btn" key={candidate.id} onClick={() => void onOpenTask(candidate)}>{executorLabel(candidate.executor)} 审查 · {statusLabel(candidate.status)}</button>)}
					{canReview && <button type="button" className="cc-mini-btn" title={reviewer ? `交给 ${executorLabel(reviewer.id)} 只读审查` : "需要另一家可用的只读执行器"} disabled={busy || !reviewer} onClick={() => void review()}>独立审查</button>}
					{canCompare && <button type="button" className="cc-mini-btn" disabled={busy || !available.length} onClick={() => setDraft((current) => current ? undefined : [newAlternative(0), newAlternative(1)])}>比较多种方案</button>}
				</div>
			)}
			{draft && <form onSubmit={(event) => void compare(event)}>
				<fieldset className="cc-external-comparison-form" disabled={busy}>
					<legend>启动方案对比</legend>
					<p className="subtle-note">每个候选会在独立 Worktree 中处理原始任务，并使用对应执行器的额度。</p>
					{draft.map((alternative, index) => (
						<div className="cc-external-candidate-config" key={index}>
							<span>方案 {index + 1}</span>
							<select aria-label={`方案 ${index + 1} 执行器`} value={alternative.executor}
								onChange={(change) => updateDraft(index, { executor: change.target.value as ExternalProvider, model: "", effort: "" })}>
								{available.map((executor) => <option key={executor.id} value={executor.id}>{executorLabel(executor.id)}</option>)}
							</select>
							<input aria-label={`方案 ${index + 1} 模型`} placeholder="模型 · 默认" value={alternative.model} maxLength={200} spellCheck={false} onChange={(change) => updateDraft(index, { model: change.target.value })} />
							<input aria-label={`方案 ${index + 1} 思考强度`} placeholder="思考强度 · 默认" value={alternative.effort} maxLength={32} spellCheck={false} onChange={(change) => updateDraft(index, { effort: change.target.value })} />
						</div>
					))}
					<div className="cc-tool-ctrl-actions cc-external-comparison-actions">
						{draft.length === 2
							? <button type="button" className="secondary-button" disabled={!available.length} onClick={() => setDraft([...draft, newAlternative(2)])}>添加第三种方案</button>
							: <button type="button" className="secondary-button" onClick={() => setDraft(draft.slice(0, 2))}>移除第三种方案</button>}
						<button type="button" className="secondary-button" onClick={() => setDraft(undefined)}>取消</button>
						<button type="submit" className="primary-button" disabled={draft.some((entry) => !available.some((executor) => executor.id === entry.executor))}>运行 {draft.length} 种方案</button>
					</div>
				</fieldset>
			</form>}
			{groups.length > 0 && <>
				<h3>方案对比</h3>
				<div className="cc-external-candidate-grid">
					{groups.map((group) => {
						const candidate = group.find((entry) => entry.id === task.id) ?? group[0];
						const preview = candidate.error || candidate.output;
						const delta = deltas.get(candidate.id);
						return <article className="cc-external-candidate" key={group[0].id}>
							<h4>{executorLabel(candidate.executor)} <span className="cc-source-tag">{statusLabel(candidate.status)}</span></h4>
							{(candidate.model || candidate.effort) && <p className="subtle-note">{[candidate.model, candidate.effort].filter(Boolean).join(" · ")}</p>}
							{delta && <p className="subtle-note">累计 {delta.paths}{delta.partial ? "+" : ""} 个路径</p>}
							{group.length > 1 && <p className="subtle-note">相同结果 ×{group.length}</p>}
							{preview && <pre className="cc-bash-out">{truncateText(preview, 1600)}{preview.length > 1600 ? "…" : ""}</pre>}
							<button type="button" className="cc-mini-btn" disabled={candidate.id === task.id} onClick={() => void onOpenTask(candidate)}>{candidate.id === task.id ? "当前任务" : "查看任务"}</button>
						</article>;
					})}
				</div>
			</>}
		</section>
	);
}
