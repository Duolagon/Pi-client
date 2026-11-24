import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadLocalLangfuseConfig, saveLocalLangfuseConfig, validateLocalLangfuseConfig } from "../src/langfuse-local-config.ts";

const sample = { baseUrl: "http://127.0.0.1:3100/otel-test/", publicKey: "local-fixture-public", secretKey: "local-fixture-secret" };
const testKey = randomBytes(32);

function encrypt(text: string): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", testKey, nonce);
	const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(encoded: string): string {
	const payload = Buffer.from(encoded, "base64");
	const decipher = createDecipheriv("aes-256-gcm", testKey, payload.subarray(0, 12));
	decipher.setAuthTag(payload.subarray(12, 28));
	return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

test("local tracing configuration is optional and stores credentials and collector address encrypted", async (t) => {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	assert.equal(await loadLocalLangfuseConfig(dataDir, () => assert.fail("Missing configuration should not use secure storage")), undefined);

	await saveLocalLangfuseConfig(dataDir, sample, encrypt);
	const file = join(dataDir, "observability", "langfuse.json");
	const stored = await readFile(file, "utf8");
	for (const value of Object.values(sample)) assert.ok(!stored.includes(value));
	if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.deepEqual(await loadLocalLangfuseConfig(dataDir, decrypt), {
		LANGFUSE_BASE_URL: "http://127.0.0.1:3100/otel-test",
		LANGFUSE_PUBLIC_KEY: sample.publicKey,
		LANGFUSE_SECRET_KEY: sample.secretKey,
	});

	await assert.rejects(saveLocalLangfuseConfig(dataDir, sample, () => { throw new Error(sample.secretKey); }), {
		message: "无法加密保存 Langfuse 配置。",
	});
	assert.equal(await readFile(file, "utf8"), stored);
	await assert.rejects(loadLocalLangfuseConfig(dataDir, () => { throw new Error(sample.secretKey); }), {
		message: "无法读取本机的 Langfuse 配置。",
	});
});

test("local tracing rejects invalid addresses and malformed credential objects", () => {
	assert.equal(validateLocalLangfuseConfig({ ...sample, baseUrl: " http\\://127.0.0.1:3100/ " }).baseUrl, "http://127.0.0.1:3100");
	for (const raw of [
		[sample], {}, { ...sample, extra: true }, { ...sample, publicKey: "two:parts" }, { ...sample, secretKey: "" },
		{ ...sample, secretKey: "with\nnewline" }, { ...sample, baseUrl: "file:///tmp/local.json" },
		{ ...sample, baseUrl: "https://fixture:password@localhost/" }, { ...sample, baseUrl: "https://localhost/?private=true" },
		{ ...sample, baseUrl: "https://localhost/#anchor" }, { ...sample, captureContent: "true" },
		{ ...sample, captureContent: 1 }, { ...sample, captureContent: undefined },
		{ ...sample, captureContent: true, extra: true },
	]) assert.throws(() => validateLocalLangfuseConfig(raw), { message: "Langfuse 配置无效。请检查地址和两把密钥。" });
});

test("local tracing content capture requires an explicit encrypted opt-in", async (t) => {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	const file = join(dataDir, "observability", "langfuse.json");

	await saveLocalLangfuseConfig(dataDir, { ...sample, captureContent: true }, encrypt);
	assert.doesNotMatch(await readFile(file, "utf8"), /"captureContent"/);
	assert.equal((await loadLocalLangfuseConfig(dataDir, decrypt))?.LANGFUSE_CAPTURE_CONTENT, "1");

	await saveLocalLangfuseConfig(dataDir, { ...sample, captureContent: false }, encrypt);
	assert.equal((await loadLocalLangfuseConfig(dataDir, decrypt))?.LANGFUSE_CAPTURE_CONTENT, undefined);
});

test("local tracing refuses to follow symlinked configuration files", { skip: process.platform === "win32" }, async (t) => {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	const directory = join(dataDir, "observability");
	await mkdir(directory);
	const outside = join(dataDir, "outside.txt");
	await writeFile(outside, "untouched");
	await symlink(outside, join(directory, "langfuse.json"));
	await assert.rejects(loadLocalLangfuseConfig(dataDir, decrypt), { message: "无法读取本机的 Langfuse 配置。" });
	await assert.rejects(saveLocalLangfuseConfig(dataDir, sample, encrypt), { message: "无法加密保存 Langfuse 配置。" });
	assert.equal(await readFile(outside, "utf8"), "untouched");
});
