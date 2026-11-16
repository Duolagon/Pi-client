import type { DesktopService } from "./backend.ts";
import type { SessionCopyInput } from "./session-types.ts";

type Handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>) => void;

/** Expose session operations through the main process's sender and origin gate. */
export function installSessionHandlers(handle: Handle, service: DesktopService): void {
	handle("pi:session:fork", (value) => {
		const input = object(value);
		return service.forkSession({ ...copyInput(input), entryId: id(input.entryId) });
	});
	handle("pi:session:clone", (value) => service.cloneSession(copyInput(object(value ?? {}))));
	handle("pi:session:entries", (value) => {
		const input = object(value ?? {});
		return service.sessionEntries({ conversationId: optionalId(input.conversationId), since: optionalId(input.since) });
	});
	handle("pi:session:tree", (conversationId) => service.sessionTree(optionalId(conversationId)));
	handle("pi:session:fork-messages", (conversationId) => service.sessionForkMessages(optionalId(conversationId)));
	handle("pi:session:navigate", (value) => {
		const input = object(value);
		return service.navigateSession({
			conversationId: optionalId(input.conversationId),
			targetId: id(input.targetId),
			label: optionalText(input.label, 1000),
		});
	});
	handle("pi:session:history", (value) => {
		const input = object(value ?? {});
		return service.discoverSessionHistory({
			project: optionalText(input.project),
			sessionDir: optionalText(input.sessionDir),
		});
	});
	handle("pi:session:import-history", (value) => {
		const input = object(value);
		return service.importSessionHistory({ token: id(input.token), activate: optionalBoolean(input.activate) });
	});
}

function copyInput(input: Record<string, unknown>): SessionCopyInput {
	return {
		conversationId: optionalId(input.conversationId),
		title: optionalText(input.title, 160),
		activate: optionalBoolean(input.activate),
	};
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话参数格式错误。");
	return value as Record<string, unknown>;
}
function optionalText(value: unknown, max = 32768): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error("会话文本格式错误。");
	return value;
}
function id(value: unknown): string {
	const result = optionalText(value, 256);
	if (!result || !/^[a-zA-Z0-9._-]+$/.test(result)) throw new Error("会话标识符格式错误。");
	return result;
}
function optionalId(value: unknown): string | undefined {
	return value === undefined ? undefined : id(value);
}
function optionalBoolean(value: unknown): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") throw new Error("会话选项格式错误。");
	return value;
}
