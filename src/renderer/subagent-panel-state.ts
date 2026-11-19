import type { ChildApprovalRequest, Conversation, DesktopTask, ExternalTask, TaskProgress } from "../shared.ts";

/** Duration (ms) to keep failed/stopped rows and completed hints visible in SubagentPanel. */
export const SUBAGENT_RETENTION_MS = 30_000;

const activeStatuses = new Set(["queued", "running", "waiting_for_input"]);

export interface SubagentPanelRow {
	id: string;
	kind: "pi" | "external";
	conversationId?: string;
	label: string;
	subagentType: string;
	status: DesktopTask["status"] | ExternalTask["status"];
	runInBackground: boolean;
	canBackground: boolean;
	/** 1 for direct child, 2 for grandchild, 3 for depth-3 descendant. */
	depth: number;
	/** Visible descendant rows under this node. */
	descendantCount: number;
	model?: string;
	tokens?: number;
	durationMs?: number;
	startedAt: number;
	updatedAt: number;
	toolUses?: number;
	lastToolName?: string;
	waitingForApproval?: boolean;
	stopReason?: string;
	task: DesktopTask | ExternalTask;
}

export interface SubagentPanelState {
	rows: SubagentPanelRow[];
	/** Number of recently completed children (within 30s) removed from rows with a `/tasks` hint. */
	completedHintCount: number;
	/** Soonest timestamp (ms) when a retained row or completed hint expires; undefined if none. */
	nextExpiryAt?: number;
}

export function isActiveTaskStatus(status: string): boolean {
	return activeStatuses.has(status);
}

/**
 * Compute visible rows and 30s retention/hint state for `SubagentPanel`:
 * - Active children always stay visible.
 * - Completed children are removed immediately and produce a 30s `/tasks` hint.
 * - Failed / cancelled / interrupted children remain visible for 30s, then disappear.
 */
export function buildSubagentPanelState(
	tasks: DesktopTask[],
	externalTasks: ExternalTask[],
	progressMap: Record<string, TaskProgress>,
	parentConversationId: string | undefined,
	now: number,
): SubagentPanelState {
	if (!parentConversationId) return { rows: [], completedHintCount: 0 };
	let completedHintCount = 0;
	let nextExpiryAt: number | undefined;
	const trackExpiry = (at: number) => {
		if (nextExpiryAt === undefined || at < nextExpiryAt) nextExpiryAt = at;
	};

	const compare = <T extends { status: string; updatedAt: number }>(left: T, right: T) => {
		const leftActive = isActiveTaskStatus(left.status) ? 0 : 1;
		const rightActive = isActiveTaskStatus(right.status) ? 0 : 1;
		if (leftActive !== rightActive) return leftActive - rightActive;
		return right.updatedAt - left.updatedAt;
	};

	const piByParent = new Map<string, DesktopTask[]>();
	for (const task of tasks) {
		if (!task.parentConversationId) continue;
		const list = piByParent.get(task.parentConversationId) ?? [];
		list.push(task);
		piByParent.set(task.parentConversationId, list);
	}
	for (const list of piByParent.values()) list.sort(compare);

	const extByParent = new Map<string, ExternalTask[]>();
	for (const task of externalTasks) {
		if (!task.parentConversationId) continue;
		const list = extByParent.get(task.parentConversationId) ?? [];
		list.push(task);
		extByParent.set(task.parentConversationId, list);
	}
	for (const list of extByParent.values()) list.sort(compare);

	const visited = new Set<string>([parentConversationId]);
	const visit = (ownerId: string, depth: number): SubagentPanelRow[] => {
		const branchRows: SubagentPanelRow[] = [];
		const directEntries: { updatedAt: number; active: boolean; row: SubagentPanelRow; descendants: SubagentPanelRow[] }[] = [];

		for (const task of piByParent.get(ownerId) ?? []) {
			if (visited.has(task.conversationId)) continue;
			visited.add(task.conversationId);
			const descendants = visit(task.conversationId, depth + 1);
			const active = isActiveTaskStatus(task.status);
			if (!active) {
				const expiry = task.updatedAt + SUBAGENT_RETENTION_MS;
				if (now < expiry) trackExpiry(expiry);
				if (task.status === "completed" && descendants.length === 0) {
					if (now < expiry) completedHintCount++;
					continue;
				}
				if (now >= expiry && descendants.length === 0) continue;
			}
			const progress = progressMap[task.id];
			const startedAt = progress?.startedAt ?? task.stats?.startedAt ?? task.statsAtTurnStart?.startedAt ?? task.createdAt;
			directEntries.push({
				active,
				updatedAt: task.updatedAt,
				descendants,
				row: {
					id: task.id,
					kind: "pi",
					conversationId: task.conversationId,
					label: task.name || task.title || task.subagentType || task.id,
					subagentType: task.subagentType || "general-purpose",
					status: task.status,
					runInBackground: Boolean(task.runInBackground),
					canBackground: active && !task.runInBackground && Boolean(task.readOnly || task.worktreeId),
					depth,
					descendantCount: descendants.length,
					model: task.stats?.model?.id ?? task.model?.id,
					tokens: active ? progress?.tokens.total : task.stats?.tokens.total,
					durationMs: active ? Math.max(0, now - startedAt) : task.stats?.durationMs,
					startedAt,
					updatedAt: task.updatedAt,
					toolUses: active ? progress?.toolUses : task.stats?.toolUses,
					lastToolName: active ? progress?.lastToolName : undefined,
					waitingForApproval: active && (Boolean(progress?.waitingForApproval) || task.status === "waiting_for_input"),
					stopReason: task.stopReason,
					task,
				},
			});
		}

		for (const task of extByParent.get(ownerId) ?? []) {
			const active = isActiveTaskStatus(task.status);
			if (!active) {
				const expiry = task.updatedAt + SUBAGENT_RETENTION_MS;
				if (now >= expiry) continue;
				trackExpiry(expiry);
				if (task.status === "completed") {
					completedHintCount++;
					continue;
				}
			}
			directEntries.push({
				active,
				updatedAt: task.updatedAt,
				descendants: [],
				row: {
					id: task.id,
					kind: "external",
					label: task.title || task.executor,
					subagentType: `${task.executor}${task.subagentType ? `/${task.subagentType}` : ""}`,
					status: task.status,
					runInBackground: true,
					canBackground: false,
					depth,
					descendantCount: 0,
					startedAt: task.createdAt,
					updatedAt: task.updatedAt,
					durationMs: active ? Math.max(0, now - task.createdAt) : Math.max(0, task.updatedAt - task.createdAt),
					waitingForApproval: active && (task.pendingApprovals.length > 0 || task.status === "waiting_for_input"),
					task,
				},
			});
		}

		directEntries.sort((left, right) => {
			const leftActive = left.active ? 0 : 1;
			const rightActive = right.active ? 0 : 1;
			if (leftActive !== rightActive) return leftActive - rightActive;
			return right.updatedAt - left.updatedAt;
		});

		for (const entry of directEntries) {
			branchRows.push(entry.row, ...entry.descendants);
		}
		return branchRows;
	};

	const rows = visit(parentConversationId, 1);
	return { rows, completedHintCount, nextExpiryAt };
}

const DAY = 24 * 60 * 60 * 1000;
function dayStart(value: number): number {
	const date = new Date(value);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function dayLabel(timestamp: number, now: number): string {
	const diff = Math.floor((dayStart(now) - dayStart(timestamp)) / DAY);
	if (diff <= 0) return "今天";
	if (diff === 1) return "昨天";
	if (diff < 7) return "近 7 天";
	if (diff < 30) return "近 30 天";
	return "更早";
}

export interface SidebarConversationGroups {
	groups: { label: string; items: Conversation[] }[];
	/** Sub-agent conversations grouped by their live parent conversation id. */
	childrenByParent: Map<string, Conversation[]>;
	/** Sub-agent conversations whose parent conversation no longer exists. */
	orphanedSubagents: Conversation[];
	/** All sub-agent conversations (both attached and orphaned). */
	allSubagents: Conversation[];
}

/**
 * Partition conversations for the sidebar:
 * - Top-level conversations stay in date groups.
 * - Delegated sub-agent conversations (`kind === "subagent"`) fold under their parent (`(+N)`).
 * - Orphaned sub-agents (parent deleted) move out of the sidebar into SessionsDialog's sub-agent group.
 */
export function groupSidebarConversations(conversations: Conversation[], now = Date.now()): SidebarConversationGroups {
	const presentIds = new Set(conversations.map((item) => item.id));
	const topLevel: Conversation[] = [];
	const childrenByParent = new Map<string, Conversation[]>();
	const orphanedSubagents: Conversation[] = [];
	const allSubagents: Conversation[] = [];

	const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
	for (const conv of sorted) {
		if (conv.kind === "subagent") {
			allSubagents.push(conv);
			if (conv.parentConversationId && presentIds.has(conv.parentConversationId)) {
				const list = childrenByParent.get(conv.parentConversationId) ?? [];
				list.push(conv);
				childrenByParent.set(conv.parentConversationId, list);
			} else {
				orphanedSubagents.push(conv);
			}
			continue;
		}
		topLevel.push(conv);
	}

	const order = ["今天", "昨天", "近 7 天", "近 30 天", "更早"];
	const buckets = new Map<string, Conversation[]>();
	for (const session of topLevel) {
		const label = dayLabel(session.updatedAt, now);
		const list = buckets.get(label) ?? [];
		list.push(session);
		buckets.set(label, list);
	}
	const groups = order.filter((label) => buckets.has(label)).map((label) => ({ label, items: buckets.get(label)! }));
	return { groups, childrenByParent, orphanedSubagents, allSubagents };
}

export type SubagentViewSlashDecision =
	| { action: "send" }
	| { action: "blocked"; reason: string }
	| { action: "confirm_main"; command: "compact" | "clear"; args?: string };

/**
 * Slash command rules inside a sub-agent transcript view:
 * - `/model` is disabled.
 * - `/compact` and `/clear` target the main conversation and require confirmation first.
 */
export function classifySubagentViewSlash(input: string): SubagentViewSlashDecision {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return { action: "send" };
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const cmd = match?.[1]?.toLowerCase() ?? "";
	const args = match?.[2]?.trim() || undefined;
	if (cmd === "model") return { action: "blocked", reason: "子 Agent 视图中不支持 /model，请返回主会话切换模型。" };
	if (cmd === "compact") return { action: "confirm_main", command: "compact", args };
	if (cmd === "clear") return { action: "confirm_main", command: "clear" };
	return { action: "send" };
}

/**
 * Recursively collect open interactive requests (`pendingApprovals`) from all descendant
 * Pi tasks of `rootConversationId` in the renderer's live task map.
 */
export function collectDescendantApprovals(
	tasks: DesktopTask[],
	rootConversationId: string | undefined,
): ChildApprovalRequest[] {
	if (!rootConversationId) return [];
	const results: ChildApprovalRequest[] = [];
	const visited = new Set<string>([rootConversationId]);
	const walk = (parentId: string, depth: number) => {
		for (const task of tasks) {
			if (task.parentConversationId !== parentId || visited.has(task.conversationId)) continue;
			visited.add(task.conversationId);
			for (const req of task.pendingApprovals ?? []) {
				results.push({
					taskId: task.id,
					conversationId: task.conversationId,
					description: task.title || task.subagentType || task.id,
					...(task.name ? { name: task.name } : {}),
					...(task.subagentType ? { subagentType: task.subagentType } : {}),
					depth,
					request: req,
				});
			}
			walk(task.conversationId, depth + 1);
		}
	};
	walk(rootConversationId, 1);
	return results;
}
