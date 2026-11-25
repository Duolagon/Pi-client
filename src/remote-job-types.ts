export type RemoteJobTrackInput = { conversationId: string; projectDir: string; useProjectCredentials?: boolean } & (
	| { kind: "kaggle-notebook"; notebook: string; version: number }
	| { kind: "kaggle-submission"; competition: string; submissionId: string }
);

export const remoteJobStatuses = ["unknown", "queued", "running", "awaiting-score", "completed", "failed", "cancelled"] as const;
export type RemoteJobStatus = (typeof remoteJobStatuses)[number];

export const remoteJobErrorCodes = ["credentials", "access", "not-found", "unavailable", "invalid-response"] as const;
export type RemoteJobErrorCode = (typeof remoteJobErrorCodes)[number];

export interface RemoteJobEvidence {
	/** Count of entries returned by the version-specific provider file list. */
	artifactCount?: number;
	artifactsMore?: boolean;
	publicScore?: string;
}

export type RemoteJobRecord = RemoteJobTrackInput & {
	id: string;
	url: string;
	status: RemoteJobStatus;
	createdAt: number;
	updatedAt: number;
	checkedAt?: number;
	queryError?: { code: RemoteJobErrorCode; at: number };
	evidence?: RemoteJobEvidence;
};

export interface RemoteJobObservation {
	status: RemoteJobStatus;
	evidence?: RemoteJobEvidence;
	/** A partial observation can succeed before the artifact query fails. */
	queryError?: RemoteJobErrorCode;
}

export type RemoteJobQuery = (job: RemoteJobTrackInput, signal: AbortSignal) => Promise<RemoteJobObservation>;
