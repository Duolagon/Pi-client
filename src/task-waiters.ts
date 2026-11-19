import type { DesktopTask } from "./task-types.ts";

type Waiter = () => void;

/**
 * Event-driven waits on persisted task transitions. The host wakes waiters from its
 * single task-update path, so readers never poll a child on a timer.
 */
export class TaskWaiters {
	private waiters = new Map<string, Set<Waiter>>();
	private closed = false;

	/** Wake every waiter of `id`; each re-reads the task and re-checks its predicate. */
	notify(id: string): void {
		const set = this.waiters.get(id);
		if (!set) return;
		for (const wake of [...set]) wake();
	}

	/**
	 * Resolve with the task once `predicate` holds, or with its latest state after
	 * `timeout` milliseconds. Resolves `undefined` when the task disappears.
	 */
	wait(
		id: string,
		read: () => DesktopTask | undefined,
		predicate: (task: DesktopTask) => boolean,
		signal?: AbortSignal,
		timeout = 0,
	): Promise<DesktopTask | undefined> {
		signal?.throwIfAborted();
		const initial = read();
		if (!initial || predicate(initial) || timeout <= 0 || this.closed) return Promise.resolve(initial);
		return new Promise((resolve, reject) => {
			let set = this.waiters.get(id);
			if (!set) this.waiters.set(id, (set = new Set()));
			const finish = (value: DesktopTask | undefined, error?: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", aborted);
				set!.delete(wake);
				if (!set!.size) this.waiters.delete(id);
				if (error !== undefined) reject(error);
				else resolve(value);
			};
			const wake = () => {
				const task = read();
				if (!task || predicate(task) || this.closed) finish(task);
			};
			const aborted = () => finish(undefined, signal!.reason ?? new Error("aborted"));
			const timer = setTimeout(() => finish(read()), timeout);
			timer.unref?.();
			set.add(wake);
			signal?.addEventListener("abort", aborted, { once: true });
		});
	}

	/** Release every waiter with the task's current state. */
	close(): void {
		this.closed = true;
		for (const set of [...this.waiters.values()]) for (const wake of [...set]) wake();
	}
}
