import { useEffect, useState } from "react";
import type { DesktopAPI, MonitorRecord } from "../shared.ts";

export function useBackgroundShells(api: DesktopAPI): Record<string, MonitorRecord> {
	const [shells, setShells] = useState<Record<string, MonitorRecord>>({});
	useEffect(() => {
		let mounted = true;
		let seenDuringList: Set<string> | undefined = new Set();
		const unsubscribe = api.monitors.onEvent((event) => {
			const id = event.type === "monitor_updated" ? event.monitor.id : event.id;
			seenDuringList?.add(id);
			if (event.type === "monitor_updated") {
				if (event.monitor.kind !== "shell") return;
				const record = event.monitor;
				setShells((current) => {
					const previous = current[id];
					if (record.status === "running" && previous?.status === "running") return current;
					return { ...current, [id]: record };
				});
			} else {
				setShells((current) => {
					if (!current[id]) return current;
					const next = { ...current };
					delete next[id];
					return next;
				});
			}
		});
		void api.monitors.list().then((records) => {
			if (!mounted) return;
			const seen = seenDuringList;
			setShells((current) => {
				const next = { ...current };
				for (const record of records) {
					if (record.kind === "shell" && !seen?.has(record.id)) next[record.id] = record;
				}
				return next;
			});
		}).catch(() => {}).finally(() => { seenDuringList = undefined; });
		return () => { mounted = false; unsubscribe(); };
	}, [api]);
	return shells;
}
