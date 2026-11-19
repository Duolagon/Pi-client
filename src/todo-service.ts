import { readFile, rm } from "node:fs/promises";
import { managedFile, writeManagedFile } from "./managed-path.ts";
import {
	todoStatuses,
	type TodoCreateInput,
	type TodoEvent,
	type TodoGetInput,
	type TodoListInput,
	type TodoRecord,
	type TodoStatus,
	type TodoUpdateInput,
} from "./todo-types.ts";

const ROOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const TODO_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TODOS_PER_CONVERSATION = 500;
const MAX_SUBJECT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 16000;
const MAX_LABEL_LENGTH = 500;
const MAX_OWNER_LENGTH = 128;
const MAX_EDGE_LIST = 100;
const MAX_METADATA_BYTES = 16 * 1024;

interface StoredTodoBoard {
	version: 1;
	nextId: number;
	items: TodoRecord[];
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertBoundedText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
		throw new Error(`Invalid ${label}`);
	}
	return value.trim();
}

function assertOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	return assertBoundedText(value, label, maxLength);
}

function assertIdList(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_EDGE_LIST) throw new Error(`Invalid ${label}`);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !TODO_ID_PATTERN.test(entry)) throw new Error(`Invalid ${label} entry`);
		if (!seen.has(entry)) {
			seen.add(entry);
			out.push(entry);
		}
	}
	return out;
}

function validateMetadata(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	const obj = assertObject(value, "metadata");
	const copy: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(obj)) {
		if (!key || key.length > 200 || ["__proto__", "constructor", "prototype"].includes(key)) {
			throw new Error("Invalid metadata key");
		}
		copy[key] = entry;
	}
	if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_METADATA_BYTES) {
		throw new Error("Todo metadata exceeds size limit");
	}
	return copy;
}

function mergeMetadata(
	existing: Record<string, unknown> | undefined,
	patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!patch) return existing ? structuredClone(existing) : undefined;
	const merged: Record<string, unknown> = existing ? { ...existing } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	if (Object.keys(merged).length === 0) return undefined;
	if (Buffer.byteLength(JSON.stringify(merged), "utf8") > MAX_METADATA_BYTES) {
		throw new Error("Todo metadata exceeds size limit");
	}
	return merged;
}

function parseBoard(raw: unknown): StoredTodoBoard {
	const obj = assertObject(raw, "todo board");
	if (obj.version !== 1 || typeof obj.nextId !== "number" || !Number.isSafeInteger(obj.nextId) || obj.nextId < 1 || !Array.isArray(obj.items)) {
		throw new Error("Invalid todo board schema");
	}
	const items: TodoRecord[] = [];
	for (const entry of obj.items.slice(0, MAX_TODOS_PER_CONVERSATION)) {
		const item = assertObject(entry, "todo item");
		const status = item.status as TodoStatus;
		if (!todoStatuses.includes(status)) throw new Error("Invalid stored todo status");
		items.push({
			id: assertBoundedText(item.id, "id", 64),
			subject: assertBoundedText(item.subject, "subject", MAX_SUBJECT_LENGTH),
			description: assertBoundedText(item.description, "description", MAX_DESCRIPTION_LENGTH),
			status,
			...(item.activeForm !== undefined ? { activeForm: assertBoundedText(item.activeForm, "activeForm", MAX_LABEL_LENGTH) } : {}),
			...(item.owner !== undefined ? { owner: assertBoundedText(item.owner, "owner", MAX_OWNER_LENGTH) } : {}),
			blocks: assertIdList(item.blocks, "blocks"),
			blockedBy: assertIdList(item.blockedBy, "blockedBy"),
			...(item.metadata !== undefined ? { metadata: validateMetadata(item.metadata) } : {}),
			createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
			updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
		});
	}
	return { version: 1, nextId: obj.nextId, items };
}

/** Ensures `blockerId` -> `blockedId` cannot create a cycle in active `blocks` edges. */
function assertNoCycle(items: Map<string, TodoRecord>, blockerId: string, blockedId: string): void {
	if (blockerId === blockedId) throw new Error("A task cannot block itself");
	const stack = [blockedId];
	const visited = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === blockerId) {
			throw new Error(`Adding dependency ${blockerId} -> ${blockedId} would create a dependency cycle`);
		}
		if (visited.has(current)) continue;
		visited.add(current);
		const node = items.get(current);
		if (!node || node.status === "deleted") continue;
		for (const next of node.blocks) stack.push(next);
	}
}

export class TodoService {
	private dataDir: () => string;
	private locks = new Map<string, Promise<unknown>>();
	private listeners = new Set<(event: TodoEvent) => void>();

	constructor(options: { dataDir: () => string }) {
		this.dataDir = options.dataDir;
	}

	subscribe(listener: (event: TodoEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(rootConversationId: string, items: TodoRecord[]): void {
		const todos = structuredClone(items.filter((item) => item.status !== "deleted"));
		for (const listener of this.listeners) {
			listener({ type: "todos_updated", rootConversationId, todos });
		}
	}

	private assertRootId(rootConversationId: string): string {
		if (typeof rootConversationId !== "string" || !ROOT_ID_PATTERN.test(rootConversationId)) {
			throw new Error("Invalid root conversation id for todos");
		}
		return rootConversationId;
	}

	private serialize<T>(rootConversationId: string, action: () => Promise<T>): Promise<T> {
		const rootId = this.assertRootId(rootConversationId);
		const prior = this.locks.get(rootId) ?? Promise.resolve();
		const run = prior.then(action, action);
		this.locks.set(
			rootId,
			run.then(
				() => {},
				() => {},
			),
		);
		return run;
	}

	private async loadBoard(rootConversationId: string): Promise<StoredTodoBoard> {
		const file = await managedFile(this.dataDir(), ["todos"], `${rootConversationId}.json`, false);
		if (!file) return { version: 1, nextId: 1, items: [] };
		try {
			const content = await readFile(file, "utf8");
			return parseBoard(JSON.parse(content));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, items: [] };
			throw error;
		}
	}

	private async saveBoard(rootConversationId: string, board: StoredTodoBoard): Promise<void> {
		const file = (await managedFile(this.dataDir(), ["todos"], `${rootConversationId}.json`, true))!;
		await writeManagedFile(file, JSON.stringify(board, null, 2));
	}

	async list(rootConversationId: string, input: TodoListInput = {}): Promise<TodoRecord[]> {
		const rootId = this.assertRootId(rootConversationId);
		return this.serialize(rootId, async () => {
			const board = await this.loadBoard(rootId);
			const includeCompleted = input.include_completed ?? true;
			return structuredClone(
				board.items.filter(
					(item) => item.status !== "deleted" && (includeCompleted || item.status !== "completed"),
				),
			);
		});
	}

	async get(rootConversationId: string, rawInput: TodoGetInput): Promise<TodoRecord | null> {
		const rootId = this.assertRootId(rootConversationId);
		const input = assertObject(rawInput, "TodoGet input");
		if (Object.keys(input).some((k) => k !== "id")) throw new Error("Unknown TodoGet field");
		const id = assertBoundedText(input.id, "id", 64);
		if (!TODO_ID_PATTERN.test(id)) throw new Error("Invalid todo id");
		return this.serialize(rootId, async () => {
			const board = await this.loadBoard(rootId);
			const match = board.items.find((item) => item.id === id && item.status !== "deleted");
			return match ? structuredClone(match) : null;
		});
	}

	async create(rootConversationId: string, rawInput: TodoCreateInput): Promise<TodoRecord> {
		const rootId = this.assertRootId(rootConversationId);
		const input = assertObject(rawInput, "TodoCreate input");
		const allowed = ["subject", "description", "activeForm", "owner", "blocks", "blockedBy", "metadata"];
		if (Object.keys(input).some((k) => !allowed.includes(k))) throw new Error("Unknown TodoCreate field");
		const subject = assertBoundedText(input.subject, "subject", MAX_SUBJECT_LENGTH);
		const description = assertBoundedText(input.description, "description", MAX_DESCRIPTION_LENGTH);
		const activeForm = assertOptionalText(input.activeForm, "activeForm", MAX_LABEL_LENGTH);
		const owner = assertOptionalText(input.owner, "owner", MAX_OWNER_LENGTH);
		const blocks = assertIdList(input.blocks, "blocks");
		const blockedBy = assertIdList(input.blockedBy, "blockedBy");
		const metadata = validateMetadata(input.metadata);

		return this.serialize(rootId, async () => {
			const board = await this.loadBoard(rootId);
			const activeCount = board.items.filter((item) => item.status !== "deleted").length;
			if (activeCount >= MAX_TODOS_PER_CONVERSATION) {
				throw new Error(`Todo limit (${MAX_TODOS_PER_CONVERSATION}) reached for this conversation`);
			}
			const now = Date.now();
			const id = String(board.nextId);
			board.nextId += 1;

			const byId = new Map(board.items.map((item) => [item.id, item]));
			const record: TodoRecord = {
				id,
				subject,
				description,
				status: "pending",
				...(activeForm ? { activeForm } : {}),
				...(owner ? { owner } : {}),
				blocks: [],
				blockedBy: [],
				...(metadata ? { metadata } : {}),
				createdAt: now,
				updatedAt: now,
			};
			byId.set(id, record);
			for (const targetId of blocks) {
				const target = byId.get(targetId);
				if (!target || target.status === "deleted") throw new Error(`Unknown blocked todo id: ${targetId}`);
				assertNoCycle(byId, id, targetId);
				if (!record.blocks.includes(targetId)) record.blocks.push(targetId);
				if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
			}
			for (const blockerId of blockedBy) {
				const blocker = byId.get(blockerId);
				if (!blocker || blocker.status === "deleted") throw new Error(`Unknown blocker todo id: ${blockerId}`);
				assertNoCycle(byId, blockerId, id);
				if (!record.blockedBy.includes(blockerId)) record.blockedBy.push(blockerId);
				if (!blocker.blocks.includes(id)) blocker.blocks.push(id);
			}
			board.items.push(record);
			// Compact ancient deleted tombstones only if total stored entries grow unreasonably large
			if (board.items.length > MAX_TODOS_PER_CONVERSATION * 2) {
				board.items = board.items.filter((item) => item.status !== "deleted");
			}
			await this.saveBoard(rootId, board);
			this.emit(rootId, board.items);
			return structuredClone(record);
		});
	}

	async update(rootConversationId: string, rawInput: TodoUpdateInput): Promise<TodoRecord> {
		const rootId = this.assertRootId(rootConversationId);
		const input = assertObject(rawInput, "TodoUpdate input");
		const allowed = [
			"id",
			"subject",
			"description",
			"status",
			"activeForm",
			"owner",
			"addBlocks",
			"addBlockedBy",
			"metadata",
		];
		if (Object.keys(input).some((k) => !allowed.includes(k))) throw new Error("Unknown TodoUpdate field");
		const id = assertBoundedText(input.id, "id", 64);
		if (!TODO_ID_PATTERN.test(id)) throw new Error("Invalid todo id");
		const subject = assertOptionalText(input.subject, "subject", MAX_SUBJECT_LENGTH);
		const description = assertOptionalText(input.description, "description", MAX_DESCRIPTION_LENGTH);
		const activeForm = assertOptionalText(input.activeForm, "activeForm", MAX_LABEL_LENGTH);
		const owner = assertOptionalText(input.owner, "owner", MAX_OWNER_LENGTH);
		const addBlocks = assertIdList(input.addBlocks, "addBlocks");
		const addBlockedBy = assertIdList(input.addBlockedBy, "addBlockedBy");
		const metadataPatch = validateMetadata(input.metadata);
		let status: TodoStatus | undefined;
		if (input.status !== undefined) {
			if (typeof input.status !== "string" || !todoStatuses.includes(input.status as TodoStatus)) {
				throw new Error("Invalid todo status");
			}
			status = input.status as TodoStatus;
		}

		return this.serialize(rootId, async () => {
			const board = await this.loadBoard(rootId);
			const byId = new Map(board.items.map((item) => [item.id, item]));
			const record = byId.get(id);
			if (!record || record.status === "deleted") {
				throw new Error(`Todo not found: ${id}`);
			}

			if (subject !== undefined) record.subject = subject;
			if (description !== undefined) record.description = description;
			if (activeForm !== undefined) record.activeForm = activeForm;
			if (owner !== undefined) record.owner = owner;
			if (metadataPatch !== undefined) {
				const merged = mergeMetadata(record.metadata, metadataPatch);
				if (merged) record.metadata = merged;
				else delete record.metadata;
			}

			if (status === "deleted") {
				record.status = "deleted";
				record.blocks = [];
				record.blockedBy = [];
				for (const peer of board.items) {
					peer.blocks = peer.blocks.filter((entry) => entry !== id);
					peer.blockedBy = peer.blockedBy.filter((entry) => entry !== id);
				}
			} else {
				if (status !== undefined) record.status = status;
				for (const targetId of addBlocks) {
					const target = byId.get(targetId);
					if (!target || target.status === "deleted") throw new Error(`Unknown blocked todo id: ${targetId}`);
					assertNoCycle(byId, id, targetId);
					if (!record.blocks.includes(targetId)) record.blocks.push(targetId);
					if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
				}
				for (const blockerId of addBlockedBy) {
					const blocker = byId.get(blockerId);
					if (!blocker || blocker.status === "deleted") throw new Error(`Unknown blocker todo id: ${blockerId}`);
					assertNoCycle(byId, blockerId, id);
					if (!record.blockedBy.includes(blockerId)) record.blockedBy.push(blockerId);
					if (!blocker.blocks.includes(id)) blocker.blocks.push(id);
				}
			}
			record.updatedAt = Date.now();
			await this.saveBoard(rootId, board);
			this.emit(rootId, board.items);
			return structuredClone(record);
		});
	}

	async deleteConversation(rootConversationId: string): Promise<void> {
		const rootId = this.assertRootId(rootConversationId);
		await this.serialize(rootId, async () => {
			const file = await managedFile(this.dataDir(), ["todos"], `${rootId}.json`, false);
			if (file) await rm(file, { force: true });
			this.emit(rootId, []);
		});
	}
}
