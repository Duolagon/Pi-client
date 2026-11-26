import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { toolOutputIdPattern, toolOutputOwnerPattern, toolRoundOutputBytes, type ToolOutputPage, type ToolOutputReference } from "./tool-output-types.ts";

const maximumOutputBytes = 8 * 1024 * 1024;
const archiveQuotaBytes = 64 * 1024 * 1024;
const archiveQuotaFiles = 64;
const previewBytes = 1024;
const continuationByte = (byte: number) => (byte & 0xc0) === 0x80;
const unavailable = "工具原文已过期或不属于此会话。";

export function toolOutputDirectory(root: string, conversationId: string): string {
	if (!toolOutputOwnerPattern.test(conversationId)) throw new Error(unavailable);
	return join(root, conversationId);
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
	if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const info = await lstat(path);
	if (!info.isDirectory() || (process.getuid && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error(unavailable);
}

async function outputDirectory(root: string, conversationId: string, create = false): Promise<string> {
	const directory = toolOutputDirectory(root, conversationId);
	await privateDirectory(root, create);
	await privateDirectory(directory, create);
	return directory;
}

async function ownedOutput(path: string): Promise<FileHandle> {
	const original = await lstat(path);
	if (!original.isFile()) throw new Error(unavailable);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.ino !== original.ino || info.dev !== original.dev ||
			(process.getuid && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error(unavailable);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export async function readToolOutputPage(root: string, conversationId: string, id: string, offset = 0, limit = 16 * 1024): Promise<ToolOutputPage> {
	if (!toolOutputIdPattern.test(id) || !Number.isSafeInteger(offset) || offset < 0 ||
		!Number.isSafeInteger(limit) || limit < 4 || limit > 16 * 1024) throw new Error("工具输出分页参数无效。");
	try {
		const directory = await outputDirectory(root, conversationId);
		const handle = await ownedOutput(join(directory, `${id}.txt`));
		try {
			const { size } = await handle.stat();
			if (size > maximumOutputBytes || offset > size) throw new Error(unavailable);
			const buffer = Buffer.alloc(Math.min(size - offset, limit + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			let start = 0;
			while (start < bytesRead && continuationByte(buffer[start])) start++;
			let end = Math.min(bytesRead, limit);
			while (end < bytesRead && end > start && continuationByte(buffer[end])) end--;
			return { text: buffer.toString("utf8", start, end), nextOffset: offset + end < size ? offset + end : null };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(unavailable);
		throw error;
	}
}

function clipped(buffer: Buffer, limit: number, tail: boolean): string {
	if (buffer.length <= limit) return buffer.toString("utf8");
	if (tail) {
		let start = buffer.length - limit;
		while (start < buffer.length && continuationByte(buffer[start])) start++;
		return buffer.toString("utf8", start);
	}
	let end = limit;
	while (end > 0 && continuationByte(buffer[end])) end--;
	return buffer.toString("utf8", 0, end);
}

async function shellSpill(details: unknown): Promise<{ data: Buffer; partial: boolean } | undefined> {
	const path = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
	if (typeof path !== "string" || resolve(dirname(path)) !== resolve(tmpdir()) || !/^pi-bash-[a-f0-9]{16}\.log$/.test(basename(path))) return undefined;
	const file = await ownedOutput(path).catch(() => undefined);
	if (!file) return undefined;
	try {
		const { size } = await file.stat();
		return { data: await file.read(Buffer.alloc(Math.min(size, maximumOutputBytes)), 0, Math.min(size, maximumOutputBytes), 0)
			.then(({ buffer, bytesRead }) => buffer.subarray(0, bytesRead)), partial: size > maximumOutputBytes };
	} finally {
		await file.close();
	}
}

async function prune(directory: string, currentId: string): Promise<void> {
	const files = await readdir(directory, { withFileTypes: true });
	const entries = await Promise.all(files.filter((file) => file.isFile() && /^[a-f0-9]{32}\.txt$/.test(file.name)).map(async (file) => {
		const path = join(directory, file.name);
		const info = await lstat(path).catch(() => undefined);
		return info?.isFile() ? { path, name: file.name, size: info.size, time: info.mtimeMs } : undefined;
	}));
	let count = 0;
	let size = 0;
	for (const entry of entries.filter((value) => value !== undefined).sort((a, b) =>
		Number(b.name === `${currentId}.txt`) - Number(a.name === `${currentId}.txt`) || b.time - a.time)) {
		count++;
		size += entry.size;
		if (count > archiveQuotaFiles || size > archiveQuotaBytes) await unlink(entry.path).catch(() => {});
	}
}

type Content = (TextContent | ImageContent)[];

/** One instance per desktop runtime. Reservations are synchronous, including parallel tool results. */
export class ToolOutputBudget {
	remaining = toolRoundOutputBytes;
	private writes: Promise<unknown> = Promise.resolve();
	private root: string;
	private conversationId: string;

	constructor(root: string, conversationId: string) {
		this.root = root;
		this.conversationId = conversationId;
	}

	reset(): void { this.remaining = toolRoundOutputBytes; }

	async archive(toolName: string, content: Content, details: unknown): Promise<{ content: Content; reference?: ToolOutputReference } | undefined> {
		const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		if (!text) return undefined;
		const bytes = Buffer.from(text);
		const nativeSpill = toolName === "bash" && typeof (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath === "string";
		if (bytes.length <= this.remaining && !nativeSpill) {
			this.remaining -= bytes.length;
			return undefined;
		}

		const reservation = Math.min(this.remaining, previewBytes);
		this.remaining -= reservation;
		const preview = clipped(bytes, reservation, toolName === "bash");
		const stored = this.writes.then(async () => {
			const spill = nativeSpill ? await shellSpill(details) : undefined;
			const directory = await outputDirectory(this.root, this.conversationId, true);
			const id = randomBytes(16).toString("hex");
			const data = spill?.data ?? Buffer.from(clipped(bytes, maximumOutputBytes, false));
			await writeFile(join(directory, `${id}.txt`), data, { flag: "wx", mode: 0o600 });
			await prune(directory, id).catch(() => {});
			return { id, conversationId: this.conversationId, bytes: data.length,
				partial: spill?.partial ?? (nativeSpill || bytes.length > maximumOutputBytes || Boolean((details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated)) };
		});
		this.writes = stored.catch(() => {});
		const reference = await stored.catch(() => undefined);
		const notice = reference ? `[Tool output archived: ${reference.id}. Use ReadToolOutput with id to read${reference.partial ? " retained" : " complete"} text.]`
			: "[Tool output was shortened to fit the round budget. The original could not be saved.]";
		return { content: [{ type: "text", text: `${preview ? `${preview}\n\n` : ""}${notice}` }, ...content.filter((block) => block.type !== "text")], reference };
	}
}
