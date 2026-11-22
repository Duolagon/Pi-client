import { AcpAdapter, type AcpProfile } from "./external-kimi.ts";

/**
 * Google Antigravity CLI (`agy`) speaks ACP v1 via `agy acp`. Its ACP server exposes no session modes,
 * so approvals follow agy's own permission settings and its prompts are forwarded to the host.
 * Actions agy's own rules already allow run without a host prompt, so dontAsk is refused and the
 * terminal sandbox is always on.
 * The host never reads or stores Antigravity credentials; agy reuses its own signed-in session.
 */
export const antigravityProfile: AcpProfile = {
	label: "Antigravity",
	args: ["acp", "--sandbox", "--disable-telemetry"],
	env: {},
	requireDefaultMode: false,
	selfApproves: true,
	fallbackToolName: "antigravity_tool",
	loginHint: "agy（或 agy acp --login）",
};

export class AntigravityAdapter extends AcpAdapter {
	constructor() { super(antigravityProfile); }
}
