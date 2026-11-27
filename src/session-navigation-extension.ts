import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { composerDraftLayout, restoreComposerDraft, type ComposerDraft, type ComposerDraftLayout } from "./composer-draft.ts";

export type SessionNavigationBridgeRequest =
	| { requestId: string; operation: "navigate"; targetId: string; label?: string }
	| { requestId: string; operation: "restore"; leafId: string | null };

export type SessionNavigationBridgeResponse =
	| {
			requestId: string;
			ok: true;
			operation: SessionNavigationBridgeRequest["operation"];
			cancelled: boolean;
			oldLeafId: string | null;
			leafId: string | null;
			sessionId: string;
			targetId?: string;
			editorText?: string;
			editorDraft?: ComposerDraft;
	  }
	| {
			requestId: string;
			ok: false;
			error: {
				code:
					| "invalid_request"
					| "busy"
					| "target_not_found"
					| "navigation_failed"
					| "restore_failed"
					| "restore_cancelled";
				message: string;
			};
			leafId: string | null;
	  };

/** Carry attachment boundaries through the native text/queue RPC without changing the model prompt. */
export function tagComposerPrompt(text: string, draft: ComposerDraft, token: string): string {
	const layout = Buffer.from(JSON.stringify(composerDraftLayout(draft))).toString("base64url");
	const signature = createHmac("sha256", token).update(layout).digest("hex");
	return `${text}\n\n[pi-desktop-draft:${signature}:${layout}]`;
}

function readComposerTag(text: string, token: string): { text: string; layout: ComposerDraftLayout } | undefined {
	for (const match of text.matchAll(/\n\n\[pi-desktop-draft:([a-f0-9]{64}):([A-Za-z0-9_-]+)\]/g)) {
		const signature = createHmac("sha256", token).update(match[2]).digest("hex");
		if (!timingSafeEqual(Buffer.from(signature), Buffer.from(match[1]))) continue;
		return {
			text: text.slice(0, match.index) + text.slice(match.index + match[0].length),
			layout: JSON.parse(Buffer.from(match[2], "base64url").toString("utf8")) as ComposerDraftLayout,
		};
	}
}

/** Add a host-only RPC command that uses Pi's native tree hooks without a model call. */
export default function sessionNavigation(pi: ExtensionAPI): void {
	const directory = process.env.PI_DESKTOP_NAVIGATION_DIR;
	const token = process.env.PI_DESKTOP_NAVIGATION_TOKEN;
	const command = process.env.PI_DESKTOP_NAVIGATION_COMMAND;
	if (!directory && !token && !command) return;
	// These values are supplied only by the host, never by a renderer or slash-command argument.
	if (
		!directory ||
		!isAbsolute(directory) ||
		!token ||
		!/^[a-f0-9]{64}$/.test(token) ||
		!command ||
		!/^desktop-navigate-[a-f0-9]{32}$/.test(command)
	) {
		throw new Error("Invalid desktop session navigation configuration");
	}
	const expectedToken = Buffer.from(token);
	pi.on("message_end", ({ message }) => {
		if (message.role !== "user") return;
		const first = typeof message.content === "string" ? message.content : message.content[0];
		const text = typeof first === "string" ? first : first?.type === "text" ? first.text : undefined;
		const tag = text?.includes("[pi-desktop-draft:") ? readComposerTag(text, token) : undefined;
		if (!tag) return;
		const content = typeof message.content === "string" ? tag.text
			: [{ type: "text" as const, text: tag.text }, ...message.content.slice(1)];
		const saved = { ...message, content, desktopDraft: tag.layout };
		return { message: saved };
	});
	pi.on("context", ({ messages }) => {
		if (!messages.some((message) => message.role === "user" && "desktopDraft" in message)) return;
		return { messages: messages.map((message) => {
			if (message.role !== "user" || !("desktopDraft" in message)) return message;
			return { role: message.role, content: message.content, timestamp: message.timestamp };
		}) };
	});
	const requestPath = join(directory, "request.json");
	const responsePath = join(directory, "response.json");
	pi.registerCommand(command, {
		description: "Desktop internal session navigation",
		handler: async (args, ctx) => {
			// Authenticate before accessing either fixed file; command arguments cannot supply paths.
			const match = /^([a-f0-9]{64}) ([a-f0-9-]{36})$/.exec(args);
			if (!match || !timingSafeEqual(Buffer.from(match[1]), expectedToken)) {
				throw new Error("Desktop session navigation requires a host request");
			}
			const requestId = match[2];
			const respond = (response: SessionNavigationBridgeResponse) =>
				writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
			const fail = (
				code: Extract<SessionNavigationBridgeResponse, { ok: false }>["error"]["code"],
				message: string,
			) => respond({ requestId, ok: false, error: { code, message }, leafId: ctx.sessionManager.getLeafId() });
			let request: SessionNavigationBridgeRequest;
			try {
				request = parseRequest(JSON.parse(await readFile(requestPath, "utf8")), requestId);
			} catch (error) {
				await fail("invalid_request", error instanceof Error ? error.message : String(error));
				return;
			}
			if (ctx.mode !== "rpc") {
				await fail("invalid_request", "Desktop session navigation requires RPC mode");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				await fail("busy", "Wait for the current response and queued messages before navigating the session tree");
				return;
			}
			const oldLeafId = ctx.sessionManager.getLeafId();
			if (request.operation === "restore") {
				try {
					await restoreLeaf(request.leafId, ctx);
					await respond({
						requestId,
						ok: true,
						operation: "restore",
						cancelled: false,
						oldLeafId,
						leafId: ctx.sessionManager.getLeafId(),
						sessionId: ctx.sessionManager.getSessionId(),
					});
				} catch (error) {
					await fail(
						error instanceof RestoreCancelledError ? "restore_cancelled" : "restore_failed",
						error instanceof Error ? error.message : String(error),
					);
				}
				return;
			}
			const target = ctx.sessionManager.getEntry(request.targetId);
			if (!target) {
				await fail("target_not_found", `Session tree entry ${request.targetId} was not found`);
				return;
			}
			try {
				const result = await ctx.navigateTree(request.targetId, { summarize: false, label: request.label });
				let editorText: string | undefined;
				let editorDraft: ComposerDraft | undefined;
				if (!result.cancelled && request.targetId !== oldLeafId) {
					if (target.type === "message" && target.message.role === "user") {
						editorDraft = restoreComposerDraft(target.message);
						editorText = editorDraft.text;
					} else if (target.type === "custom_message") {
						editorText = contentText(target.content, "");
					}
				}
				await respond({
					requestId,
					ok: true,
					operation: "navigate",
					targetId: request.targetId,
					cancelled: result.cancelled,
					oldLeafId,
					leafId: ctx.sessionManager.getLeafId(),
					sessionId: ctx.sessionManager.getSessionId(),
					...(editorText !== undefined ? { editorText } : {}),
					...(editorDraft ? { editorDraft } : {}),
				});
			} catch (error) {
				await fail("navigation_failed", error instanceof Error ? error.message : String(error));
			}
		},
	});
}

function parseRequest(value: unknown, requestId: string): SessionNavigationBridgeRequest {
	// The host's JSON file is the protocol trust boundary. No paths or summarization options are accepted.
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid navigation request");
	const record = value as Record<string, unknown>;
	if (record.requestId !== requestId) throw new Error("Navigation request ID does not match the host command");
	if (record.operation === "navigate") {
		if (
			Object.keys(record).some((key) => !["requestId", "operation", "targetId", "label"].includes(key)) ||
			typeof record.targetId !== "string" ||
			!record.targetId ||
			record.targetId.length > 256 ||
			(record.label !== undefined && (typeof record.label !== "string" || record.label.length > 1000))
		)
			throw new Error("Invalid navigation target or label");
		return {
			requestId,
			operation: "navigate",
			targetId: record.targetId,
			...(record.label !== undefined ? { label: record.label as string } : {}),
		};
	}
	if (
		record.operation === "restore" &&
		Object.keys(record).every((key) => ["requestId", "operation", "leafId"].includes(key)) &&
		(record.leafId === null ||
			(typeof record.leafId === "string" && record.leafId.length > 0 && record.leafId.length <= 256))
	)
		return { requestId, operation: "restore", leafId: record.leafId };
	throw new Error("Invalid navigation operation");
}

class RestoreCancelledError extends Error {}

function navigationLeaf(entry: SessionEntry): string | null {
	return entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")
		? entry.parentId
		: entry.id;
}

async function restoreLeaf(leafId: string | null, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.sessionManager.getLeafId() === leafId) return;
	const entries = ctx.sessionManager.getEntries();
	const target = entries.find((entry) => navigationLeaf(entry) === leafId);
	if (!target)
		throw new Error(`Pi cannot restore the exact session leaf ${leafId ?? "(root)"} through native navigation`);
	// Native navigation treats selecting the current entry as a no-op, even for a user target.
	if (target.id === ctx.sessionManager.getLeafId()) {
		const intermediate = entries.find((entry) => entry.id !== target.id && navigationLeaf(entry) !== target.id);
		if (!intermediate) throw new Error("Pi cannot leave the current entry to restore the exact session root");
		if ((await ctx.navigateTree(intermediate.id, { summarize: false })).cancelled) {
			throw new RestoreCancelledError("An extension cancelled session leaf restoration");
		}
	}
	if ((await ctx.navigateTree(target.id, { summarize: false })).cancelled) {
		throw new RestoreCancelledError("An extension cancelled session leaf restoration");
	}
	if (ctx.sessionManager.getLeafId() !== leafId)
		throw new Error("Pi navigation did not restore the requested session leaf");
}
