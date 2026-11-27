import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopWerewolfAPI, WerewolfState } from "../werewolf-types.ts";

export function useWerewolf(api: DesktopWerewolfAPI | undefined, conversationId?: string) {
	const [lastState, setState] = useState<WerewolfState>();
	const [toggling, setToggling] = useState(false);
	const toggleInFlight = useRef(false);
	const activeId = useRef(conversationId);
	const revision = useRef(0);
	activeId.current = conversationId;
	const state = lastState?.conversationId === conversationId ? lastState : undefined;

	useEffect(() => {
		if (!api || !conversationId) return;
		let disposed = false;
		const requestedRevision = ++revision.current;
		const unsubscribe = api.onEvent((next) => {
			if (disposed || next.conversationId !== activeId.current) return;
			revision.current++;
			setState(next);
		});
		void api.state(conversationId).then((next) => {
			if (!disposed && activeId.current === conversationId && revision.current === requestedRevision) setState(next);
		}).catch(() => {});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [api, conversationId]);

	const toggle = useCallback(async () => {
		if (!api || !state || toggleInFlight.current) return;
		toggleInFlight.current = true;
		setToggling(true);
		const requestedRevision = revision.current;
		try {
			const next = await api.setEnabled(state.conversationId, !state.enabled);
			if (activeId.current !== state.conversationId) return;
			if (revision.current === requestedRevision) setState(next);
			return next;
		} finally {
			toggleInFlight.current = false;
			setToggling(false);
		}
	}, [api, state]);

	return { state, toggle, toggling };
}
