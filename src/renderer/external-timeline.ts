import { truncateText } from "../delegation-limits.ts";
import type { ExternalEvent } from "../external-types.ts";

type Usage = Extract<ExternalEvent["event"], { type: "usage" }>;
type Plan = Extract<ExternalEvent["event"], { type: "plan" }>;
type Event = Extract<ExternalEvent["event"], { type: "tool_start" | "tool_update" | "tool_end" | "plan" | "usage" | "diagnostic" }>;
export type ExternalTimelineEvent = Pick<ExternalEvent, "sequence" | "turn" | "timestamp"> & { event: Event };

interface ToolItem {
	kind: "tool";
	sequence: number;
	timestamp: number;
	name?: string;
	output?: string;
	partialOutput?: boolean;
	isError?: boolean;
}
interface PlanItem { kind: "plan"; sequence: number; timestamp: number; plan: Plan }
type Item = ToolItem | PlanItem | { kind: "diagnostic"; sequence: number; timestamp: number; message: string };
export interface ExternalTimelineTurn { turn: number; items: Item[]; usage?: Usage }

const MAX_EVENTS = 2000;
const MAX_TOOL_OUTPUT = 4000;

export function timelineEvent({ sequence, turn, timestamp, event }: ExternalEvent): ExternalTimelineEvent | undefined {
	if (event.type === "tool_start") {
		// Keep the tool label; the native input may include large file bodies or private data.
		return { sequence, turn, timestamp, event: { type: "tool_start", id: event.id, name: truncateText(event.name, 200), input: null } };
	}
	if (event.type === "tool_update")
		return { sequence, turn, timestamp, event: { ...event, text: truncateText(event.text, MAX_TOOL_OUTPUT) } };
	if (event.type === "tool_end")
		return { sequence, turn, timestamp, event: { ...event, output: event.output === undefined ? undefined : truncateText(event.output, MAX_TOOL_OUTPUT) } };
	if (event.type === "plan" || event.type === "usage" || event.type === "diagnostic") return { sequence, turn, timestamp, event };
}

/** Playback may resolve after events from the same task have arrived live. */
export function mergeExternalTimeline(current: ExternalTimelineEvent[], incoming: ExternalTimelineEvent[]): ExternalTimelineEvent[] {
	if (!incoming.length) return current;
	if (incoming.length === 1 && (!current.length || incoming[0].sequence > current.at(-1)!.sequence))
		return [...current.slice(1 - MAX_EVENTS), incoming[0]];
	const bySequence = new Map(current.map((event) => [event.sequence, event]));
	for (const event of incoming) bySequence.set(event.sequence, event);
	return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_EVENTS);
}

/** Collapse updates into their native tool calls and retain each turn's latest plan and usage. */
export function externalTimelineTurns(events: ExternalTimelineEvent[]): ExternalTimelineTurn[] {
	const turns = new Map<number, { timeline: ExternalTimelineTurn; tools: Map<string, ToolItem>; plan?: PlanItem }>();
	for (const { event, sequence, turn, timestamp } of events) {
		let group = turns.get(turn);
		if (!group) {
			group = { timeline: { turn, items: [] }, tools: new Map() };
			turns.set(turn, group);
		}
		if (event.type === "usage") {
			const usage = group.timeline.usage ?? { type: "usage" };
			group.timeline.usage = { ...usage, ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) };
		} else if (event.type === "plan") {
			if (group.plan) group.plan.plan = event;
			else {
				group.plan = { kind: "plan", sequence, timestamp, plan: event };
				group.timeline.items.push(group.plan);
			}
		} else if (event.type === "diagnostic") {
			group.timeline.items.push({ kind: "diagnostic", sequence, timestamp, message: event.message });
		} else {
			let tool = group.tools.get(event.id);
			if (!tool) {
				tool = { kind: "tool", sequence, timestamp };
				group.tools.set(event.id, tool);
				group.timeline.items.push(tool);
			}
			if (event.type === "tool_start") tool.name = event.name;
			else if (event.type === "tool_update") {
				const combined = (tool.output ?? "") + event.text;
				tool.output = truncateText(combined, MAX_TOOL_OUTPUT);
				tool.partialOutput ||= combined.length > MAX_TOOL_OUTPUT || event.text.length >= MAX_TOOL_OUTPUT;
			} else {
				tool.isError = event.isError;
				if (event.output !== undefined) {
					tool.output = event.output;
					tool.partialOutput = event.output.length >= MAX_TOOL_OUTPUT;
				}
			}
		}
	}
	return [...turns.values()].reverse().map(({ timeline }) => timeline);
}
