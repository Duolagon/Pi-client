export const cronToolNames = ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete"] as const;
export type CronToolName = (typeof cronToolNames)[number];

export type CronJobSource = "tool" | "loop" | "wakeup";

export interface CronJobRecord {
	id: string;
	conversationId: string;
	project?: string;
	prompt: string;
	cron?: string;
	intervalMs?: number;
	recurring: boolean;
	durable: boolean;
	jitterMs: number;
	createdAt: number;
	expiresAt: number;
	nextRunAt: number;
	lastRunAt?: number;
	runCount: number;
	enabled: boolean;
	source: CronJobSource;
}

export interface CronCreateInput {
	prompt: string;
	cron?: string;
	interval_seconds?: number;
	recurring?: boolean;
	durable?: boolean;
}

export interface ScheduleWakeupInput {
	delay_seconds: number;
	reason: string;
	prompt?: string;
}

export type CronEvent = {
	type: "cron_updated";
	jobs: CronJobRecord[];
};
