export type WerewolfClaimStatus = "verified" | "contradicted" | "unverified";

export interface WerewolfEvidence {
	summary: string;
	expected?: string;
	actual?: string;
	reproduction?: string;
	source?: string;
}

export interface WerewolfClaim {
	id: string;
	quote?: string;
	requirements?: string;
	description: string;
	status: WerewolfClaimStatus;
	evidence?: WerewolfEvidence;
}

export interface WerewolfReview {
	id: string;
	replyTimestamp: number;
	replyEntryId?: string;
	checkpointId?: string;
	createdAt: number;
	revision?: string;
	status: "pending" | WerewolfClaimStatus;
	claims: WerewolfClaim[];
	error?: string;
}

export interface WerewolfState {
	conversationId: string;
	enabled: boolean;
	reviews: WerewolfReview[];
}

export interface DesktopWerewolfAPI {
	state(conversationId: string): Promise<WerewolfState>;
	setEnabled(conversationId: string, enabled: boolean): Promise<WerewolfState>;
	replay(conversationId: string, reviewId: string, claimId: string): Promise<{ status: WerewolfClaimStatus; evidence: WerewolfEvidence }>;
	onEvent(listener: (state: WerewolfState) => void): () => void;
}
