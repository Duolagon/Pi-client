import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";

type Transport = {
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
};

interface RpcResponse {
	type: "rpc_result";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface StartMessage {
	type: "start";
	script: string;
}

function createTransport(): Promise<Transport> {
	const parentPort = (process as unknown as {
		parentPort?: {
			on(event: string, listener: (ev: { data?: unknown; ports?: Array<{ postMessage(msg: unknown): void; on(ev: string, fn: (m: { data: unknown }) => void): void; start?(): void }> }) => void): void;
			once(event: string, listener: (ev: { data?: unknown; ports?: Array<{ postMessage(msg: unknown): void; on(ev: string, fn: (m: { data: unknown }) => void): void; start?(): void }> }) => void): void;
			postMessage(msg: unknown): void;
		};
	}).parentPort;

	if (parentPort) {
		return new Promise((resolve) => {
			parentPort.once("message", (event) => {
				const port = event.ports?.[0];
				if (port) {
					port.start?.();
					resolve({
						send: (msg) => port.postMessage(msg),
						onMessage: (handler) => port.on("message", (e) => handler(e.data)),
					});
					return;
				}
				resolve({
					send: (msg) => parentPort.postMessage(msg),
					onMessage: (handler) => parentPort.on("message", (e) => handler(e.data)),
				});
			});
		});
	}

	return Promise.resolve({
		send: (msg) => process.send?.(msg),
		onMessage: (handler) => process.on("message", (msg) => handler(msg)),
	});
}

function buildSafeMath(): Record<string, unknown> {
	const safeMath: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(Math)) {
		if (key === "random") continue;
		safeMath[key] = (Math as unknown as Record<string, unknown>)[key];
	}
	Object.defineProperty(safeMath, "random", {
		enumerable: false,
		value() {
			throw new Error("Math.random() is forbidden in workflow scripts");
		},
	});
	return Object.freeze(safeMath);
}

function buildSafeDate(): unknown {
	const RealDate = Date;
	function SafeDate(...args: unknown[]) {
		if (args.length === 0) {
			throw new Error("Date() without explicit timestamp is forbidden in workflow scripts");
		}
		if (new.target) {
			return Reflect.construct(RealDate, args) as Date;
		}
		return RealDate.UTC(1970, 0, 1);
	}
	Object.defineProperty(SafeDate, "now", {
		enumerable: false,
		value() {
			throw new Error("Date.now() is forbidden in workflow scripts");
		},
	});
	SafeDate.parse = RealDate.parse;
	SafeDate.UTC = RealDate.UTC;
	SafeDate.prototype = RealDate.prototype;
	return SafeDate;
}

async function main() {
	const transport = await createTransport();
	let nextRpcId = 1;
	const pending = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();

	const rpc = (method: string, payload: Record<string, unknown>): Promise<unknown> => {
		const id = `rpc_${nextRpcId++}`;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			transport.send({ type: "rpc", id, method, payload });
		});
	};

	const scopeStorage = new AsyncLocalStorage<{ prefix: string; counter: { value: number } }>();
	const nextStepKey = (explicitKey?: string): string => {
		const scope = scopeStorage.getStore();
		const prefix = scope?.prefix ?? "root";
		if (explicitKey) return `${prefix}/${explicitKey}`;
		const index = scope ? scope.counter.value++ : 0;
		return `${prefix}#${index}`;
	};

	const rootScope = { prefix: "root", counter: { value: 0 } };

	const executeScript = async (script: string) => {
		const sandbox: Record<string, unknown> = {
			agent: (input: unknown) => {
				if (!input || typeof input !== "object" || Array.isArray(input)) {
					return Promise.reject(new Error("agent(options) requires an object argument"));
				}
				const opts = input as Record<string, unknown>;
				const explicitKey = typeof opts.key === "string" && opts.key.trim() ? opts.key.trim() : undefined;
				const stepKey = nextStepKey(explicitKey);
				return rpc("agent", { stepKey, options: opts });
			},
			parallel: async (items: unknown[]) => {
				if (!Array.isArray(items)) throw new Error("parallel(tasks) requires an array");
				const parent = scopeStorage.getStore() ?? rootScope;
				const base = `${parent.prefix}/par#${parent.counter.value++}`;
				return Promise.all(
					items.map((item, idx) => {
						if (typeof item === "function") {
							return scopeStorage.run({ prefix: `${base}[${idx}]`, counter: { value: 0 } }, () =>
								Promise.resolve((item as () => unknown)()),
							);
						}
						return Promise.resolve(item);
					}),
				);
			},
			pipeline: async (...args: unknown[]) => {
				let steps: Array<(prev: unknown) => unknown>;
				let current: unknown;
				if (Array.isArray(args[0])) {
					steps = args[0] as Array<(prev: unknown) => unknown>;
					current = args[1];
				} else {
					current = args[0];
					steps = args.slice(1) as Array<(prev: unknown) => unknown>;
				}
				for (const step of steps) {
					if (typeof step !== "function") throw new Error("pipeline step must be a function");
					current = await Promise.resolve(step(current));
				}
				return current;
			},
			phase: async (name: unknown, fn: unknown) => {
				if (typeof name !== "string" || !name.trim()) throw new Error("phase(name, fn) requires a non-empty name");
				if (typeof fn !== "function") throw new Error("phase(name, fn) requires a callback function");
				const cleanName = name.trim();
				const parent = scopeStorage.getStore() ?? rootScope;
				const seq = parent.counter.value++;
				await rpc("phase_start", { name: cleanName });
				try {
					const result = await scopeStorage.run(
						{ prefix: `${parent.prefix}/phase:${cleanName}#${seq}`, counter: { value: 0 } },
						() => Promise.resolve((fn as () => unknown)()),
					);
					await rpc("phase_end", { name: cleanName, status: "completed" });
					return result;
				} catch (err) {
					await rpc("phase_end", {
						name: cleanName,
						status: "failed",
						error: err instanceof Error ? err.message : String(err),
					}).catch(() => {});
					throw err;
				}
			},
			log: (...args: unknown[]) => {
				const message = args
					.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
					.join(" ")
					.slice(0, 4000);
				void rpc("log", { level: "info", message }).catch(() => {});
			},
			budget: () => rpc("budget", {}),
			Math: buildSafeMath(),
			Date: buildSafeDate(),
			JSON,
			Promise,
			Array,
			Object,
			Map,
			Set,
			String,
			Number,
			Boolean,
			Error,
			TypeError,
			RangeError,
			require: undefined,
			module: undefined,
			exports: undefined,
			process: undefined,
			global: undefined,
			globalThis: undefined,
			Buffer: undefined,
			fetch: undefined,
			setTimeout: undefined,
			setInterval: undefined,
			setImmediate: undefined,
		};

		const context = vm.createContext(sandbox, {
			codeGeneration: { strings: false, wasm: false },
		});

		const wrapped = `(async () => {\n${script}\n})()`;
		const compiled = new vm.Script(wrapped, {
			filename: "workflow-script.js",
			importModuleDynamically: () => {
				throw new Error("import() is forbidden in workflow scripts");
			},
		} as vm.ScriptOptions);

		const resultPromise = scopeStorage.run(rootScope, () =>
			compiled.runInContext(context, { timeout: 5000 }) as Promise<unknown>,
		);
		const finalResult = await resultPromise;
		return finalResult;
	};

	transport.onMessage((raw) => {
		if (!raw || typeof raw !== "object") return;
		const msg = raw as StartMessage | RpcResponse;
		if (msg.type === "rpc_result") {
			const waiter = pending.get(msg.id);
			if (!waiter) return;
			pending.delete(msg.id);
			if (msg.ok) waiter.resolve(msg.result);
			else waiter.reject(new Error(msg.error || "Workflow RPC failed"));
			return;
		}
		if (msg.type === "start") {
			void executeScript(msg.script)
				.then((result) => {
					transport.send({ type: "done", ok: true, result: result ?? null });
				})
				.catch((error) => {
					transport.send({
						type: "done",
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}
	});

	transport.send({ type: "ready" });
}

void main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
