export const teamToolNames = ["TeamCreate", "TeamDelete"] as const;
export type TeamToolName = (typeof teamToolNames)[number];

export const teamMessageTypes = [
	"message",
	"broadcast",
	"shutdown_request",
	"shutdown_response",
	"plan_approval_request",
	"plan_approval_response",
] as const;
export type TeamMessageType = (typeof teamMessageTypes)[number];

export type TeamMemberStatus = "active" | "idle" | "shutdown" | "removed";

export interface TeamMember {
	name: string;
	agentId?: string;
	conversationId?: string;
	subagentType?: string;
	status: TeamMemberStatus;
	joinedAt: number;
	updatedAt: number;
}

export interface TeamMessageRecord {
	id: string;
	teamName: string;
	from: string;
	to: string;
	type: TeamMessageType;
	content: string;
	summary?: string;
	requestId?: string;
	approve?: boolean;
	timestamp: number;
	/** Recipient conversations still awaiting native delivery. Older messages omit this. */
	pendingConversationIds?: string[];
}

export interface TeamRecord {
	name: string;
	description?: string;
	rootConversationId: string;
	leaderConversationId: string;
	members: TeamMember[];
	messages: TeamMessageRecord[];
	createdAt: number;
	updatedAt: number;
}

export type TeamEvent = {
	type: "team_updated";
	rootConversationId: string;
	team: TeamRecord | null;
};
