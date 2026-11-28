import { AcpAdapter, acpProfileFor } from "./external-kimi.ts";
import type { ExternalAdapter, ExternalProvider } from "./external-types.ts";

/** A catalog executor shares the same ACP adapter and permission boundary. */
export function createRegistryExternalAdapter(id: ExternalProvider): ExternalAdapter | undefined {
	if (!id.startsWith("acp-")) return undefined;
	const profile = acpProfileFor(id);
	return profile && new AcpAdapter(profile);
}
