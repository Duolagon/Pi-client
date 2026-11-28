import type { BuiltinExternalProvider, ExternalExecutor, ExternalProvider } from "./external-types.ts";

export interface ExternalLaunch {
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
}

interface CommonDefinition {
	id: ExternalProvider;
	label: string;
	commands: readonly string[];
	installCommand?: string;
	enabledByDefault: boolean;
	capabilities: ExternalExecutor["capabilities"];
}

interface AcpDefinition extends CommonDefinition {
	acp: ExternalLaunch;
	manualMode?: string;
	loginHint?: string;
}

type ExecutorDefinition = CommonDefinition | AcpDefinition;

const capabilities = (
	transport: ExternalExecutor["capabilities"]["transport"],
	readOnly: boolean,
	approvalSemantics: ExternalExecutor["capabilities"]["approvalSemantics"] = "native",
): ExternalExecutor["capabilities"] => ({
	transport, continuation: transport !== "acp", approvals: true, cancellation: true, readOnly,
	fineGrainedPolicy: approvalSemantics === "per-tool-hook", approvalSemantics,
});

interface RegistryLaunch {
	id: string;
	name: string;
	// The installed command is read from the archive's cmd basename or the package's bin metadata.
	command: string;
	/** ACP approval mode documented by this CLI when it differs from the default mode. */
	manualMode?: string;
	distribution: (ExternalLaunch & { package: string }) | (ExternalLaunch & { installCommand: string });
}

// Launch projection of https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// (stable v1 format, 2026-11-28). Adding an entry supplies data only. Package specs are
// displayed as manual install commands. The host launches only a resolved local binary.
const registry: readonly RegistryLaunch[] = [
	{
		id: "auggie", name: "Auggie CLI", command: "auggie",
		distribution: { package: "@augmentcode/auggie@0.37.0", args: ["--acp"], env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" } },
	},
	{
		id: "gemini", name: "Gemini CLI", command: "gemini",
		distribution: { package: "@google/gemini-cli@0.71.1", args: ["--acp"] },
	},
	{
		id: "github-copilot-cli", name: "GitHub Copilot", command: "copilot",
		distribution: { package: "@github/copilot@1.0.117", args: ["--acp"] },
	},
	{
		id: "goose", name: "goose", command: "goose", manualMode: "approve",
		distribution: { args: ["acp"], installCommand: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash" },
	},
	{
		id: "kimi-code", name: "Kimi Code", command: "kimi",
		distribution: { package: "@moonshot-ai/kimi-code@2.8.1", args: ["acp"] },
	},
	{
		id: "opencode", name: "OpenCode", command: "opencode",
		distribution: { args: ["acp"], installCommand: "npm install --global @opencode/cli" },
	},
	{
		id: "qwen-code", name: "Qwen Code", command: "qwen",
		distribution: { package: "@qwen-code/qwen-code@0.28.7", args: ["--acp", "--experimental-skills"] },
	},
];

function registryInstall(entry: RegistryLaunch): string {
	const distribution = entry.distribution;
	return "package" in distribution ? `npm install --global ${distribution.package}` : distribution.installCommand;
}

const kimi = registry.find((entry) => entry.id === "kimi-code")!;
const native = [
	{
		id: "codex", label: "Codex", commands: ["codex"], enabledByDefault: true,
		installCommand: "npm install --global @openai/codex", capabilities: capabilities("app-server", true),
	},
	{
		id: "claude", label: "Claude Code", commands: ["claude"], enabledByDefault: true,
		installCommand: "npm install --global @anthropic-ai/claude-code", capabilities: capabilities("sdk", true, "per-tool-hook"),
	},
	{
		id: "kimi", label: kimi.name, commands: [kimi.command, "kimicode"], enabledByDefault: true,
		installCommand: registryInstall(kimi), capabilities: capabilities("acp", false),
		acp: { args: kimi.distribution.args, env: { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" } },
		manualMode: "default",
	},
	{
		id: "antigravity", label: "Antigravity", commands: ["agy"], enabledByDefault: true,
		capabilities: capabilities("acp", false, "agent-rules"), manualMode: "default",
		// This profile runs the installed Antigravity CLI. Its argv differs from the standalone
		// agy_acp_server archive listed in the registry.
		acp: { args: ["acp", "--sandbox", "--disable-telemetry"] }, loginHint: "agy（或 agy acp --login）",
	},
] satisfies Array<ExecutorDefinition & { id: BuiltinExternalProvider }>;

const catalog: AcpDefinition[] = registry.filter((entry) => entry.id !== kimi.id).map((entry) => ({
	id: `acp-${entry.id}`, label: entry.name, commands: [entry.command], installCommand: registryInstall(entry),
	enabledByDefault: false, capabilities: capabilities("acp", false, "agent-rules"),
	acp: { args: entry.distribution.args, env: entry.distribution.env }, manualMode: entry.manualMode,
}));

export const externalExecutorDefinitions: readonly ExecutorDefinition[] = [...native, ...catalog];
const definitions = new Map(externalExecutorDefinitions.map((definition) => [definition.id, definition]));
export const knownExternalProviders = externalExecutorDefinitions.map(({ id }) => id);

export function isExternalProvider(value: unknown): value is ExternalProvider {
	return typeof value === "string" && definitions.has(value as ExternalProvider);
}

export function externalExecutorDefinition(id: ExternalProvider): ExecutorDefinition | undefined {
	return definitions.get(id);
}

export function acpExecutorDefinition(id: ExternalProvider): AcpDefinition | undefined {
	const definition = definitions.get(id);
	return definition && "acp" in definition ? definition : undefined;
}

/** ACP restoration is optional. Only a handshake can establish which method is available. */
export function acpRestoreMethod(value: unknown): "session/resume" | "session/load" | undefined {
	if (!value || typeof value !== "object") return;
	const capabilities = value as { sessionCapabilities?: { resume?: unknown }; loadSession?: boolean };
	const resume = capabilities.sessionCapabilities?.resume;
	if (resume && typeof resume === "object") return "session/resume";
	if (capabilities.loadSession === true) return "session/load";
}
