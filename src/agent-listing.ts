import type { AgentDefinition } from "./agent-types.ts";
import {
	MAX_AGENT_LISTING_CHARS,
	MAX_LISTED_AGENT_DESCRIPTION,
	MAX_LISTED_AGENTS,
	truncateText,
} from "./delegation-limits.ts";

/**
 * The agent types a parent model may delegate to. The host writes them to
 * `<tools dir>/agents.json`; the parent's tool-control extension appends them to the
 * system prompt before each run, so definition changes take effect on the next turn.
 */
export interface AgentListingEntry {
	name: string;
	description: string;
	/** Short tool summary, e.g. `read, grep, find, ls` or `All tools`. */
	tools: string;
	/** Claude-style alias or `provider/id`, when the definition pins one. */
	model?: string;
	readOnly: boolean;
}
export interface AgentListing {
	version: 1;
	agents: AgentListingEntry[];
	/** Entries or description text left out to stay within the listing budget. */
	truncated: boolean;
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function oneLine(value: string, max: number): string {
	return truncateText(value.replace(/\s+/g, " ").trim(), max);
}

/**
 * Build the listing from definitions the host already resolved for the project's trust
 * state (untrusted projects contribute no project-scope agents). Sorted by name so the
 * same definitions always produce the same text.
 */
export function buildAgentListing(definitions: AgentDefinition[]): AgentListing {
	const sorted = [...definitions].filter((item) => namePattern.test(item.name)).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const agents: AgentListingEntry[] = [];
	let budget = MAX_AGENT_LISTING_CHARS;
	let truncated = sorted.length > MAX_LISTED_AGENTS;
	for (const definition of sorted.slice(0, MAX_LISTED_AGENTS)) {
		let description = oneLine(definition.description || definition.name, MAX_LISTED_AGENT_DESCRIPTION);
		if (description.length > budget) {
			truncated = true;
			description = truncateText(description, Math.max(0, budget));
		}
		budget -= description.length;
		const tools = definition.tools?.length
			? oneLine(definition.tools.slice(0, 20).join(", "), 300)
			: definition.readOnly ? "Read-only tools" : "All tools";
		const model = definition.model ? `${definition.model.provider}/${definition.model.id}` : definition.modelAlias;
		agents.push({
			name: definition.name,
			description,
			tools,
			...(model ? { model: oneLine(model, 200) } : {}),
			readOnly: definition.readOnly,
		});
	}
	return { version: 1, agents, truncated };
}

/** Validate the listing file again inside the Pi process; it is rendered into the prompt. */
export function parseAgentListing(value: unknown): AgentListing {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent listing");
	const input = value as Record<string, unknown>;
	if (input.version !== 1 || !Array.isArray(input.agents) || input.agents.length > MAX_LISTED_AGENTS || typeof input.truncated !== "boolean")
		throw new Error("Invalid agent listing");
	const agents = input.agents.map((item): AgentListingEntry => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid agent listing");
		const entry = item as Record<string, unknown>;
		if (
			typeof entry.name !== "string" || !namePattern.test(entry.name) ||
			typeof entry.description !== "string" || entry.description.length > MAX_LISTED_AGENT_DESCRIPTION ||
			typeof entry.tools !== "string" || entry.tools.length > 300 ||
			(entry.model !== undefined && (typeof entry.model !== "string" || entry.model.length > 200)) ||
			typeof entry.readOnly !== "boolean"
		)
			throw new Error("Invalid agent listing");
		return {
			name: entry.name,
			description: oneLine(entry.description, MAX_LISTED_AGENT_DESCRIPTION),
			tools: oneLine(entry.tools, 300),
			...(entry.model ? { model: oneLine(entry.model, 200) } : {}),
			readOnly: entry.readOnly,
		};
	});
	return { version: 1, agents, truncated: input.truncated };
}

/** Deterministic system prompt section; empty when there is nothing to list. */
export function formatAgentListing(listing: AgentListing): string {
	if (!listing.agents.length) return "";
	const lines = listing.agents.map((agent) => {
		const traits = [`Tools: ${agent.tools}`, ...(agent.model ? [`Model: ${agent.model}`] : []), ...(agent.readOnly ? ["read-only"] : [])];
		return `- ${agent.name}: ${agent.description} (${traits.join("; ")})`;
	});
	return [
		"# Available agent types",
		'Use these names as subagent_type in the Agent tool (default general-purpose; "fork" forks this conversation).',
		...lines,
		...(listing.truncated ? ["(Some agent types or descriptions were omitted to keep this list short.)"] : []),
	].join("\n");
}
