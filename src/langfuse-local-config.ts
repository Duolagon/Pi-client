import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { managedFile, writeManagedFile } from "./managed-path.ts";

const directory = ["observability"];
const filename = "langfuse.json";
const maxConfigBytes = 32_768;
const invalidConfig = "Langfuse 配置无效。请检查地址和两把密钥。";

export type LocalLangfuseConfig = { baseUrl: string; publicKey: string; secretKey: string; captureContent?: boolean };

export function validateLocalLangfuseConfig(raw: unknown): LocalLangfuseConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(invalidConfig);
	const keys = Object.keys(raw);
	const hasCaptureContent = keys.includes("captureContent");
	if (keys.length !== (hasCaptureContent ? 4 : 3) ||
		!["baseUrl", "publicKey", "secretKey"].every((key) => keys.includes(key))) throw new Error(invalidConfig);
	const config = raw as Record<string, unknown>;
	const { baseUrl, publicKey, secretKey } = config;
	const captureContent = hasCaptureContent ? config.captureContent : undefined;
	if (typeof baseUrl !== "string" || typeof publicKey !== "string" || typeof secretKey !== "string" ||
		(hasCaptureContent && typeof captureContent !== "boolean"))
		throw new Error(invalidConfig);
	const urlValue = baseUrl.trim().replace("\\:", ":");
	const publicValue = publicKey.trim(), secretValue = secretKey.trim();
	const url = urlValue.length <= 2048 ? URL.parse(urlValue) : null;
	if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
		!publicValue || !secretValue || publicValue.length > 4096 || secretValue.length > 4096 ||
		/[\s\u0000-\u001f\u007f:]/u.test(publicValue) || /[\s\u0000-\u001f\u007f]/u.test(secretValue) ||
		/[\n\r\t]/u.test(urlValue)) throw new Error(invalidConfig);
	return {
		baseUrl: url.href.replace(/\/+$/, ""),
		publicKey: publicValue,
		secretKey: secretValue,
		...(typeof captureContent === "boolean" ? { captureContent } : {}),
	};
}

export async function saveLocalLangfuseConfig(
	dataDir: string,
	raw: unknown,
	encrypt: (text: string) => string,
): Promise<void> {
	const config = validateLocalLangfuseConfig(raw);
	try {
		const encrypted = encrypt(JSON.stringify(config));
		if (!encrypted) throw new Error();
		const content = JSON.stringify({ version: 1, encrypted });
		if (Buffer.byteLength(content) > maxConfigBytes) throw new Error();
		const target = await managedFile(dataDir, directory, filename, true);
		if (!target) throw new Error();
		await writeManagedFile(target, content);
	} catch {
		throw new Error("无法加密保存 Langfuse 配置。");
	}
}

export async function loadLocalLangfuseConfig(
	dataDir: string,
	decrypt: (text: string) => string,
): Promise<NodeJS.ProcessEnv | undefined> {
	try {
		const target = await managedFile(dataDir, directory, filename, false);
		if (!target) return undefined;
		const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!file) return undefined;
		try {
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.size > maxConfigBytes) throw new Error();
			const stored = JSON.parse(await file.readFile("utf8")) as { version?: unknown; encrypted?: unknown };
			if (stored.version !== 1 || typeof stored.encrypted !== "string" || !stored.encrypted) throw new Error();
			const config = validateLocalLangfuseConfig(JSON.parse(decrypt(stored.encrypted)));
			return {
				LANGFUSE_BASE_URL: config.baseUrl,
				LANGFUSE_PUBLIC_KEY: config.publicKey,
				LANGFUSE_SECRET_KEY: config.secretKey,
				...(config.captureContent ? { LANGFUSE_CAPTURE_CONTENT: "1" } : {}),
			};
		} finally {
			await file.close();
		}
	} catch {
		throw new Error("无法读取本机的 Langfuse 配置。");
	}
}
