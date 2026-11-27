import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, DesktopAPI, DesktopEvent, DesktopPromptResult, Snapshot, RpcExtensionUIRequest, BashResult, SessionActivity } from "../shared.ts";
import { emptyDraft, mergeDrafts, type ComposerAttachment, type ComposerDraft, type Prompt } from "../composer-draft.ts";
import { temporaryModelNotice } from "../model-routing.ts";
import { readDraft, writeDraft } from "./draft-storage.ts";
import { phaseFromEvent, phaseFromSnapshot, type RunPhase } from "./run-status.ts";
import { applyEvent, transcript, type Transcript } from "./messages.ts";

type CompactionEnd = Extract<DesktopEvent["event"], { type: "compaction_end" }>;
type CompactionCompletion = Pick<CompactionEnd, "reason"> & Pick<NonNullable<CompactionEnd["result"]>, "tokensBefore" | "estimatedTokensAfter">;

export function useDesktop(api: DesktopAPI) {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [history, setHistory] = useState<Transcript>(() => transcript([]));
	const [running, setRunning] = useState(false);
	const [changing, setChanging] = useState(false);
	const [bashBusy, setBashBusy] = useState(false);
	const [terminalOutput, setTerminalOutput] = useState<Record<string, string>>({});
	const appendTerminal = (id: string, delta: string) => setTerminalOutput((output) => ({ ...output, [id]: ((output[id] ?? "") + delta).slice(-200000) }));
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [compactionCompletions, setCompactionCompletions] = useState<Record<string, CompactionCompletion>>({});
	const dismissCompaction = (id: string) => setCompactionCompletions((previous) => {
		if (!previous[id]) return previous;
		const next = { ...previous };
		delete next[id];
		return next;
	});
	const [draft, putDraft] = useState(emptyDraft);
	const [draftLoading, setDraftLoading] = useState(false);
	const [activity, setActivity] = useState<Record<string, SessionActivity>>({});
	const [runPhases, setRunPhases] = useState<Record<string, RunPhase>>({});
	const drafts = useRef(new Map<string, Partial<ComposerDraft>>());
	const loadedDrafts = useRef(new Set<string>());
	const getDraft = (id: string) => ({ ...emptyDraft, ...drafts.current.get(id) });
	const updateDraft = (id: string, patch: Partial<ComposerDraft>) => {
		const next = { ...drafts.current.get(id), ...patch };
		drafts.current.set(id, next);
		if (activeId.current === id) putDraft({ ...emptyDraft, ...next });
		void writeDraft(id, patch).catch(() => {
			if (activeId.current === id) fail(new Error("无法保存草稿，内容暂时保留在当前窗口。"));
		});
	};
	const setDraft = (text: string) => {
		if (activeId.current) updateDraft(activeId.current, { text });
	};
	const updateAttachments = (id: string, update: (items: ComposerAttachment[]) => ComposerAttachment[]) => {
		updateDraft(id, { attachments: update(getDraft(id).attachments) });
	};
	const prependDrafts = async (id: string, restored: ComposerDraft[]) => {
		if (!loadedDrafts.current.has(id)) await loadDraft(id);
		updateDraft(id, mergeDrafts([...restored, getDraft(id)]));
	};
	const forgetDraft = (id: string) => {
		drafts.current.delete(id);
		loadedDrafts.current.delete(id);
		void writeDraft(id, emptyDraft).catch(fail);
	};
	const [requests, setRequests] = useState<RpcExtensionUIRequest[]>([]);
	const [revision, setRevision] = useState(0);
	const activeId = useRef<string | undefined>(undefined);
	const generation = useRef(0);
	const selecting = useRef(false);
	const appliedSequence = useRef(0);
	const buffered = useRef<{ packet: DesktopEvent; bytes: number }[]>([]);
	const bufferedBytes = useRef(0);
	const droppedThrough = useRef(new Map<string, number>());
	const refreshLatest = useRef<() => Promise<void>>(async () => {});
	const listener = useRef<(packet: DesktopEvent, replay?: boolean) => void>(() => {});
	const fail = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : String(cause));
	}, []);
	const loadDraft = useCallback(async (id: string) => {
		try {
			const saved = await readDraft(id);
			if (loadedDrafts.current.has(id)) return;
			const next = { ...saved, ...drafts.current.get(id) };
			drafts.current.set(id, next);
			loadedDrafts.current.add(id);
			if (activeId.current === id) putDraft(next);
		} catch {
			if (activeId.current === id) fail(new Error("无法读取保存的草稿。"));
		} finally {
			if (activeId.current === id) setDraftLoading(false);
		}
	}, [fail]);
	const apply = useCallback((next: Snapshot) => {
		const id = next.active?.id;
		const sequence = next.eventSequence ?? 0;
		if (id && (droppedThrough.current.get(id) ?? 0) > sequence) {
			// A long IPC pause exceeded the bounded replay window. Fetch a new full projection.
			void refreshLatest.current();
			return;
		}
		const changed = activeId.current !== next.active?.id;
		activeId.current = next.active?.id;
		appliedSequence.current = sequence;
		setSnapshot(next);
		setActivity(next.activity ?? {});
		const currentPhase = next.pendingUI.length ? "approval"
			: next.engineStatus === "error" ? "failed"
			: next.state?.isCompacting ? "compacting"
			: phaseFromSnapshot(next.messages, next.liveTranscript?.tools ?? {}, Boolean(next.state?.isStreaming));
		if (id && currentPhase) setRunPhases((previous) => ({
			...previous,
			[id]: currentPhase === "running" && previous[id] === "retrying" ? "retrying" : currentPhase,
		}));
		setBashBusy(Boolean(next.bashBusy));
		setHistory(transcript(next.messages, next.liveTranscript));
		setRunning(Boolean(next.state?.isStreaming || next.state?.isCompacting));
		setRequests(next.pendingUI.filter((request) => ["confirm", "select", "input", "editor"].includes(request.method)));
		if (changed) {
			putDraft(id ? { ...emptyDraft, ...drafts.current.get(id) } : emptyDraft);
			setDraftLoading(Boolean(id && !loadedDrafts.current.has(id)));
			if (id && !loadedDrafts.current.has(id)) void loadDraft(id);
			setNotice("");
		}
		if (id && next.eventSequence !== undefined) {
			for (const { packet } of buffered.current) {
				if (packet.conversationId === id && packet.sequence !== undefined && packet.sequence > sequence)
					listener.current(packet, true);
			}
			droppedThrough.current.delete(id);
		}
		// A snapshot only carries a replay cursor for its active session. While selecting,
		// retain events from other sessions that arrived after the snapshot was formed.
		if (id && next.eventSequence !== undefined) {
			for (const { packet } of buffered.current) {
				if (packet.conversationId !== id && packet.sequence !== undefined && packet.sequence > (next.activitySequence ?? Infinity))
					listener.current(packet, true);
			}
		}
		setRevision((value) => value + 1);
	}, [loadDraft]);
	const refresh = useCallback(async () => {
		if (selecting.current) return;
		const token = ++generation.current;
		try {
			const next = await api.snapshot();
			if (token === generation.current) apply(next);
		} catch (cause) {
			if (token === generation.current) fail(cause);
		}
	}, [api, apply, fail]);
	refreshLatest.current = refresh;
	listener.current = (packet, replay = false) => {
		const { conversationId, event, sequence, queuedPromptGroups, turn } = packet;
		if (!replay && sequence !== undefined) {
			const bytes = JSON.stringify(packet).length * 2;
			buffered.current.push({ packet, bytes });
			bufferedBytes.current += bytes;
			while (buffered.current.length > 512 || bufferedBytes.current > 4 * 1024 * 1024) {
				const removed = buffered.current.shift()!;
				bufferedBytes.current -= removed.bytes;
				droppedThrough.current.set(
					removed.packet.conversationId,
					Math.max(droppedThrough.current.get(removed.packet.conversationId) ?? 0, removed.packet.sequence!),
				);
				if (droppedThrough.current.size > 32)
					droppedThrough.current.delete(droppedThrough.current.keys().next().value!);
			}
		}
		const interactive = event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method);
		const ended = event.type === "agent_settled" || event.type === "desktop_error" ||
			(event.type === "compaction_end" && !event.willRetry);
		if (interactive || ended || event.type === "agent_start" || event.type === "compaction_start") {
			setActivity((previous) => {
				const next = { ...previous };
				if (ended) delete next[conversationId];
				else next[conversationId] = interactive ? "approval" : "running";
				return next;
			});
		}
		if (event.type !== "message_update" && event.type !== "tool_execution_update") {
			setRunPhases((previous) => {
				const phase = phaseFromEvent(previous[conversationId], event);
				return phase && phase !== previous[conversationId] ? { ...previous, [conversationId]: phase } : previous;
			});
		}
		if (!replay && event.type === "bash_execution_update") appendTerminal(conversationId, event.delta);
		if (!replay && event.type === "compaction_start") dismissCompaction(conversationId);
		if (!replay && event.type === "compaction_end" && event.result && !event.aborted && !event.errorMessage) {
			const { tokensBefore, estimatedTokensAfter } = event.result;
			setCompactionCompletions((previous) => ({ ...previous, [conversationId]: { reason: event.reason, tokensBefore, estimatedTokensAfter } }));
		}
		if (conversationId !== activeId.current) return;
		if (sequence !== undefined) {
			if (sequence <= appliedSequence.current) return;
			appliedSequence.current = sequence;
		}
		if (turn) setSnapshot((previous) => previous?.active?.id === conversationId ? { ...previous, turn } : previous);
		if (event.type === "desktop_error") {
			fail(event.message);
			setRunning(false);
			setBashBusy(false);
			setRequests([]);
			return;
		}
		if (event.type === "extension_ui_request") {
			if (["confirm", "select", "input", "editor"].includes(event.method))
				setRequests((items) => (items.some((item) => item.id === event.id) ? items : [...items, event]));
			else if (event.method === "notify") {
				if (event.notifyType === "error") fail(event.message);
				else setNotice(event.message);
			} else if (event.method === "setStatus") setNotice(event.statusText ?? "");
			else if (event.method === "set_editor_text") updateDraft(conversationId, { text: event.text });
			return;
		}
		if (event.type === "agent_start" || event.type === "compaction_start") setRunning(true);
		if (event.type === "agent_settled") {
			setRunning(false);
			setRequests([]);
			void refresh();
		}
		if (event.type === "compaction_end") {
			if (event.errorMessage) fail(event.errorMessage);
			if (!event.willRetry) {
				setRunning(false);
				void refresh();
			}
		}
		if (event.type === "auto_retry_start")
			setNotice(`正在重试 ${event.attempt}/${event.maxAttempts}：${event.errorMessage}`);
		if (event.type === "auto_retry_end") {
			if (!event.success) fail(event.finalError ?? "重试失败");
			else setNotice("");
		}
		if (event.type === "extension_error") fail(event.error);
		if (event.type === "session_info_changed")
			setSnapshot((previous) =>
				previous
					? {
							...previous,
							active: previous.active ? { ...previous.active, title: event.name ?? previous.active.title } : undefined,
							conversations: previous.conversations.map((session) =>
								session.id === conversationId ? { ...session, title: event.name ?? session.title } : session,
							),
							state: previous.state ? { ...previous.state, sessionName: event.name } : undefined,
						}
					: previous,
			);
		if (event.type === "thinking_level_changed")
			setSnapshot((previous) =>
				previous?.state ? { ...previous, state: { ...previous.state, thinkingLevel: event.level } } : previous,
			);
		if (event.type === "queue_update")
			setSnapshot((previous) =>
				previous?.state
					? {
							...previous,
							state: { ...previous.state, pendingMessageCount: event.steering.length + event.followUp.length },
							queuedMessages: [...event.steering, ...event.followUp],
							queuedPromptGroups: queuedPromptGroups ?? { steering: [...event.steering], followUp: [...event.followUp] },
						}
					: previous,
			);
		if (event.type === "tool_execution_end") setRevision((value) => value + 1);
			if (temporaryModelNotice(event)) void refresh();
		setHistory((state) => applyEvent(state, event));
	};
	useEffect(() => {
		const unsubscribe = api.onEvent((packet) => listener.current(packet));
		void refresh();
		return unsubscribe;
	}, [api, refresh]);
	useEffect(() => {
		if (!snapshot) return;
		const media = matchMedia("(prefers-color-scheme: dark)");
		const applyTheme = () => {
			document.documentElement.dataset.theme =
				snapshot.settings.theme === "system" ? (media.matches ? "dark" : "light") : snapshot.settings.theme;
		};
		applyTheme();
		media.addEventListener("change", applyTheme);
		return () => media.removeEventListener("change", applyTheme);
	}, [snapshot?.settings.theme]);
	const switchTo = async (operation: () => Promise<Snapshot | null>, afterApply?: () => void) => {
		if (selecting.current) return;
		selecting.current = true;
		setChanging(true);
		setError("");
		const token = ++generation.current;
		try {
			const next = await operation();
			if (next && token === generation.current) {
				apply(next);
				afterApply?.();
			}
		} catch (cause) {
			fail(cause);
		} finally {
			selecting.current = false;
			setChanging(false);
			if (droppedThrough.current.size && activeId.current && droppedThrough.current.has(activeId.current)) void refresh();
		}
	};
	const command = async (value: Command) => {
		setError("");
		try {
			await api.command(value, activeId.current);
			await refresh();
		} catch (cause) {
			fail(cause);
		}
	};
	const send = async (value: Prompt, input?: ComposerDraft, delivery?: Prompt["streamingBehavior"]) => {
		const id = activeId.current;
		if (!id) return;
		const previous = running;
		const submittedDraft = getDraft(id);
		setError("");
		setNotice("");
		setRunning(true);
		try {
			const streamingBehavior = delivery ?? (previous ? "steer" : undefined);
			const result = input
				? await api.sendPrompt(id, input, streamingBehavior)
				: await api.command({ ...value, streamingBehavior }, id) as DesktopPromptResult;
			const remaining = getDraft(id);
			const patch: Partial<ComposerDraft> = {};
			if (remaining.text === submittedDraft.text) patch.text = "";
			if (input?.attachments.length) {
				const submitted = new Set(input.attachments);
				patch.attachments = remaining.attachments.filter((item) => !submitted.has(item));
			}
			if (Object.keys(patch).length) updateDraft(id, patch);
			if (activeId.current === id && (result.disposition === "handled" || result.disposition === "forked_skill")) {
				setRunning(previous);
				await refresh();
			}
			return result;
		} catch (cause) {
			if (activeId.current === id) {
				fail(cause);
				setRunning(previous);
			}
			throw cause;
		}
	};
	const respond: DesktopAPI["respond"] = async (response) => {
		const id = activeId.current;
		await api.respond(response, id);
		if (activeId.current !== id) return;
		setRequests((items) => items.filter((item) => item.id !== response.id));
		await refresh();
	};
	const bash = async (value: string) => {
		const id = activeId.current;
		if (!id) return;
		setBashBusy(true);
		setError("");
		appendTerminal(id, `\n$ ${value}\n`);
		try {
			const result = (await api.command({ type: "bash", command: value }, id)) as BashResult;
			appendTerminal(id, `\n[退出码 ${result.exitCode ?? "—"}${result.cancelled ? "，已取消" : ""}]\n`);
			if (activeId.current === id) await refresh();
		} catch (cause) {
			if (activeId.current === id) fail(cause);
		} finally {
			if (activeId.current === id) setBashBusy(false);
		}
	};
	return {
		prependDrafts,
		replaceDraft: (id: string, next: ComposerDraft) => updateDraft(id, next),
		updateAttachments,
		forgetDraft,
		snapshot,
		activity,
		runPhases,
		history,
		running,
		changing,
		bashBusy,
		terminal: snapshot?.active?.id ? terminalOutput[snapshot.active.id] ?? "" : "",
		error,
		notice,
		compactionCompletion: snapshot?.active ? compactionCompletions[snapshot.active.id] : undefined,
		dismissCompaction,
		draft: draft.text,
		attachments: draft.attachments,
		draftLoading,
		requests,
		revision,
		fail,
		setError,
		setNotice,
		setDraft,
		apply,
		refresh,
		switchTo,
		command,
		send,
		respond,
		bash,
	};
}
