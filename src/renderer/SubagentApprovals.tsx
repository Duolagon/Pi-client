import { useEffect, useState } from "react";
import type { ChildApprovalRequest, RpcExtensionUIResponse } from "../shared.ts";
import { PermissionDialog } from "./PermissionDialog.tsx";

/**
 * Queue of interactive approvals (`confirm | select | input | editor`) surfaced from
 * all descendant sub-agents of the active conversation.
 */
export function SubagentApprovals({
	approvals,
	rootConversationId,
	project,
	onRespond,
	fail,
}: {
	approvals: ChildApprovalRequest[];
	rootConversationId: string;
	project?: string;
	onRespond: (taskId: string, response: RpcExtensionUIResponse) => Promise<void>;
	fail: (error: unknown) => void;
}) {
	const [deferredIds, setDeferredIds] = useState<string[]>([]);
	const [reviewing, setReviewing] = useState(false);

	useEffect(() => {
		const liveIds = new Set(approvals.map((item) => item.request.id));
		setDeferredIds((prev) => (prev.some((id) => !liveIds.has(id)) ? prev.filter((id) => liveIds.has(id)) : prev));
	}, [approvals]);

	if (!approvals.length) return null;

	const activeIndex = approvals.findIndex((item) => !deferredIds.includes(item.request.id));
	if (!reviewing || activeIndex === -1) {
		return (
			<div className="cc-child-approval-launcher">
				<button
					type="button"
					className="secondary-button"
					onClick={() => {
						if (activeIndex === -1) setDeferredIds([]);
						setReviewing(true);
					}}
				>
					查看子 Agent 审批 ({approvals.length})
				</button>
			</div>
		);
	}

	const current = approvals[activeIndex];
	return (
		<PermissionDialog
			inline
			key={`${current.taskId}:${current.request.id}`}
			request={current.request}
			conversationId={current.conversationId}
			project={project}
			subagentSource={{
				taskId: current.taskId,
				name: current.name,
				description: current.description,
				subagentType: current.subagentType,
				depth: current.depth,
				rootConversationId,
			}}
			queuePosition={{ index: activeIndex, total: approvals.length }}
			respond={(response) => onRespond(current.taskId, response)}
			defer={() => {
				setDeferredIds((prev) => (prev.includes(current.request.id) ? prev : [...prev, current.request.id]));
				setReviewing(false);
			}}
			fail={fail}
		/>
	);
}
