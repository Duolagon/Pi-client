import { AgentProcess } from "../../src/rpc.ts";
import type { Command, DesktopEvent } from "../../src/shared.ts";

type Event = DesktopEvent["event"];
export class RpcHarness {
	events: Event[] = [];
	process: AgentProcess;
	private listeners = new Set<(event: Event) => void>();
	constructor(options: ConstructorParameters<typeof AgentProcess>[0]) {
		this.process = new AgentProcess({
			...options,
			onEvent: (event) => {
				this.events.push(event);
				options.onEvent(event);
				for (const listener of [...this.listeners]) listener(event);
			},
		});
	}
	waitFor<T extends Event["type"]>(type: T, since = 0): Promise<Extract<Event, { type: T }>> {
		const previous = this.events.slice(since).find((event) => event.type === type);
		if (previous) return Promise.resolve(previous as Extract<Event, { type: T }>);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(
					new Error(
						`Timed out waiting for ${type}; saw ${this.events
							.slice(since)
							.map((event) => event.type)
							.join(",")}`,
					),
				);
			}, 15000);
			const listener = (event: Event) => {
				if (event.type !== type) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(event as Extract<Event, { type: T }>);
			};
			this.listeners.add(listener);
		});
	}
	request<T>(command: Command) {
		return this.process.request<T>(command);
	}
	stop() {
		return this.process.stop();
	}
}
