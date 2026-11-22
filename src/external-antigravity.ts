import { AcpAdapter, type AcpProfile } from "./external-kimi.ts";

/**
 * Google Antigravity CLI (`agy`) speaks ACP v1 via `agy acp`. Like Kimi it advertises session modes
 * (default / accept-edits / auto / plan, checked against agy 1.5.14); the host forces "default" and refuses
 * later switches to unattended modes. In "default" agy still honors its own permission rules, so actions
 * those rules allow run without a host prompt: dontAsk is refused and the terminal sandbox is always on.
 * The host never reads or stores Antigravity credentials; agy reuses its own signed-in session.
 */
export const antigravityProfile: AcpProfile = {
	label: "Antigravity",
	args: ["acp", "--sandbox", "--disable-telemetry"],
	env: {},
	requireDefaultMode: true,
	selfApproves: true,
	fallbackToolName: "antigravity_tool",
	loginHint: "agy（或 agy acp --login）",
};

export class AntigravityAdapter extends AcpAdapter {
	constructor() { super(antigravityProfile); }
}
