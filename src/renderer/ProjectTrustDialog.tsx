import { ShieldCheck } from "lucide-react";
import { Modal } from "../prototype/ui.tsx";
import type { ProjectTrustDecision, ProjectTrustState } from "../shared.ts";

const statusLabel = (trust: ProjectTrustState): string => {
	if (trust.decision === "trusted") return "已信任，项目配置会加载";
	if (trust.decision === "untrusted") return "已禁用，项目配置不会加载";
	return "尚未决定，项目配置当前未加载";
};

export function ProjectTrustDialog({
	trust,
	busy,
	close,
	decide,
}: {
	trust: ProjectTrustState;
	busy: boolean;
	close: () => void;
	decide: (decision: ProjectTrustDecision) => void;
}) {
	return (
		<Modal title="项目配置与信任" close={close} wide>
			<div className="simple-dialog cc-trust-dialog">
				<div className="cc-trust-head">
					<ShieldCheck size={20} />
					<div>
						<strong>{statusLabel(trust)}</strong>
						<span>{trust.project}</span>
					</div>
				</div>
				<p>
					信任项目后可以启动语言服务器并加载项目规则、记忆和扩展配置。项目扩展和 MCP 服务器可以执行代码。
				</p>
				<ul className="cc-trust-list">
					{trust.resources.map((resource) => (
						<li key={resource}>
							<code>{resource}</code>
						</li>
					))}
				</ul>
				<p className="cc-trust-note">
					更改信任会重启该项目的会话；请先停止运行中的任务。未信任时，只有项目外的用户配置、AGENTS.md 与 CLAUDE.md 会加载。
				</p>
				<div className="dialog-actions">
					<button type="button" className="secondary-button" disabled={busy} onClick={() => decide("untrusted")}>
						保持禁用
					</button>
					<button type="button" className="primary-button" disabled={busy} onClick={() => decide("trusted")}>
						信任并加载
					</button>
				</div>
			</div>
		</Modal>
	);
}
