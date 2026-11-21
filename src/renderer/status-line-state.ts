import type { Provider } from "../shared.ts";

const PROVIDERS: readonly Provider[] = ["anthropic", "openai", "google", "openrouter", "deepseek"];

/** Desktop connection provider of a runtime model provider ("desktop-deepseek" → "deepseek"). */
export function desktopProvider(modelProvider: string | undefined): Provider | undefined {
	const name = modelProvider?.startsWith("desktop-") ? modelProvider.slice(8) : undefined;
	return PROVIDERS.find((item) => item === name);
}
