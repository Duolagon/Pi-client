import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, DesktopAPI, DesktopEvent, Snapshot, RpcExtensionUIRequest, BashResult } from "../shared.ts";
import { applyEvent, transcript, type Transcript } from "./messages.ts";

export function useDesktop(api: DesktopAPI) {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [history, setHistory] = useState<Transcript>(() => transcript([]));
	const [running, setRunning] = useState(false);
	const [changing, setChanging] = useState(false);
	const [bashBusy, setBashBusy] = useState(false);
	const [terminal, setTerminal] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [draft, setDraft] = useState("");
	const [requests, setRequests] = useState<RpcExtensionUIRequest[]>([]);
	const [revision, setRevision] = useState(0);
	const activeId = useRef<string | undefined>(undefined);
	const generation = useRef(0);
	const eventRevision = useRef(0);
	const fail = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : String(cause));
	}, []);
	const apply = useCallback((next: Snapshot) => {
		const changed = activeId.current !== next.active?.id;
		activeId.current = next.active?.id;
		setSnapshot(next);
		setHistory(transcript(next.messages));
		setRunning(Boolean(next.state?.isStreaming || next.state?.isCompacting));
		setRequests(next.pendingUI.filter((request) => ["confirm", "select", "input", "editor"].includes(request.method)));
		if (changed) {
			setTerminal("");
			setDraft("");
		}
		setRevision((value) => value + 1);
	}, []);
	const refresh = useCallback(async () => {
		const token = ++generation.current;
		const revision = eventRevision.current;
		try {
			const next = await api.snapshot();
			if (token === generation.current && revision === eventRevision.current) apply(next);
		} catch (cause) {
			if (token === generation.current) fail(cause);
		}
	}, [api, apply, fail]);
	const listener = useRef<(packet: DesktopEvent) => void>(() => {});
	listener.current = ({ conversationId, event }) => {
		if (conversationId !== activeId.current) return;
		eventRevision.current += 1;
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
			else if (event.method === "set_editor_text") setDraft(event.text);
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
		if (event.type === "bash_execution_update") setTerminal((value) => (value + event.delta).slice(-1000000));
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
						}
					: previous,
			);
		if (event.type === "tool_execution_end") setRevision((value) => value + 1);
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
	const switchTo = async (operation: () => Promise<Snapshot | null>) => {
		setChanging(true);
		setError("");
		++generation.current;
		try {
			const next = await operation();
			if (next) apply(next);
		} catch (cause) {
			fail(cause);
		} finally {
			setChanging(false);
		}
	};
	const command = async (value: Command) => {
		setError("");
		try {
			await api.command(value);
			await refresh();
		} catch (cause) {
			fail(cause);
		}
	};
	const send = async (value: Extract<Command, { type: "prompt" }>) => {
		const previous = running;
		const submittedDraft = draft;
		setError("");
		setNotice("");
		setRunning(true);
		try {
			const result = (await api.command({ ...value, streamingBehavior: previous ? "steer" : undefined })) as {
				disposition: "started" | "handled" | "queued";
			};
			setDraft((current) => (current === submittedDraft ? "" : current));
			if (result.disposition === "handled") {
				setRunning(previous);
				await refresh();
			}
		} catch (cause) {
			fail(cause);
			setRunning(previous);
			throw cause;
		}
	};
	const respond: DesktopAPI["respond"] = async (response) => {
		await api.respond(response);
		setRequests((items) => items.filter((item) => item.id !== response.id));
	};
	const bash = async (value: string) => {
		setBashBusy(true);
		setError("");
		setTerminal((text) => `${text}\n$ ${value}\n`);
		try {
			const result = (await api.command({ type: "bash", command: value })) as BashResult;
			setTerminal((text) => `${text}\n[退出码 ${result.exitCode ?? "—"}${result.cancelled ? "，已取消" : ""}]\n`);
			await refresh();
		} catch (cause) {
			fail(cause);
		} finally {
			setBashBusy(false);
		}
	};
	return {
		snapshot,
		history,
		running,
		changing,
		bashBusy,
		terminal,
		error,
		notice,
		draft,
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
