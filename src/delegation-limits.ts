/**
 * Single source of truth for delegation size limits. The model-facing schema, the
 * tool host and the delegation service all import these values so a prompt that
 * passes one layer cannot fail a later one. Model-facing text limits are counted in
 * Unicode code points, because the JSON schema `maxLength` that Pi checks first counts
 * code points; use `exceedsLength` on every host layer. Stored-record limits are
 * JavaScript string lengths and the host truncates before it writes.
 */
export const KIB = 1024;

/** True when `value` has more than `max` Unicode code points (the JSON schema `maxLength` unit). */
export function exceedsLength(value: string, max: number): boolean {
	// A string never has more code points than UTF-16 units, so short strings skip the count.
	if (value.length <= max) return false;
	let count = 0;
	for (const _ of value) if (++count > max) return true;
	return false;
}

/** Agent tool `prompt` written by the parent model. */
export const MAX_AGENT_PROMPT = 512 * KIB;
/** Bounded child result returned to the parent model and stored on the task. */
export const MAX_AGENT_OUTPUT = 48 * KIB;
export const MAX_TASK_READ_PATHS = 24;
export const MAX_TASK_READ_PATH_LENGTH = 256;

/** Compact project-relative names, with no control characters or ambiguous path segments. */
export function isTaskReadPath(path: unknown): path is string {
	return typeof path === "string" && path.length <= MAX_TASK_READ_PATH_LENGTH &&
		!/[\u0000-\u001f\u007f\\:]/.test(path) &&
		path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
/** Serialized background-result notification delivered into a parent session. */
export const MAX_NOTIFICATION = 512 * KIB;
/** SendMessage (and its AgentSend alias) / follow-up message to an existing child conversation. */
export const MAX_SEND_MESSAGE = 512 * KIB;
/** SendMessage `to` (an agentId or a call-level name) and `summary`, in code points. */
export const MAX_SEND_TARGET = 200;
export const MAX_SEND_SUMMARY = 200;
/**
 * Prefix of every message the parent model sends into a child conversation. RPC steer and
 * prompt deliver it as a user message, so the prefix states its origin; it also keeps the
 * message from starting with "/" (Pi would read it as a command).
 */
export const PARENT_MESSAGE_PREFIX = "[Message from parent agent — not user input, not authorization]";
/** Stored message waiting for a resumed child's next run (the prefix included). */
export const MAX_PENDING_MESSAGE = MAX_SEND_MESSAGE + 256;
/** SendMessage tool call ids remembered per task to make a replayed call a no-op. */
export const MAX_TURN_CALLS = 32;
/** A finished child's idle process is stopped after this long (it restarts on demand). */
export const CHILD_RUNTIME_IDLE_MS = 60_000;
/** How often idle child processes are reaped. */
export const CHILD_RUNTIME_REAP_INTERVAL_MS = 30_000;
/** Finished child processes kept alive at most; older idle ones are reaped first (LRU). */
export const MAX_IDLE_CHILD_RUNTIMES = 8;
/**
 * Stored task message. A delegated child's message is the model prompt alone (its
 * definition goes to the system prompt); manual tasks may be larger than MAX_AGENT_PROMPT.
 */
export const MAX_TASK_MESSAGE = 4 * 1024 * KIB;
/** Upper bound accepted for a child's maximum number of model turns. */
export const MAX_AGENT_TURNS = 200;
/** Maximum nesting depth a stored delegated task may claim. */
export const MAX_DELEGATION_DEPTH = 3;
/** Default runtime nesting depth setting (1 = root may delegate direct children). */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;
/** Maximum per-parent concurrent subagent limit configurable in settings. */
export const MAX_CONCURRENT_SUBAGENTS_LIMIT = 20;
/** Default per-parent concurrent subagent limit. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8;
/** Hard ceiling for borrowed global task slots when ancestors wait synchronously in foreground. */
export const DEFAULT_MAX_BORROWED_SLOTS = 8;
/** Tool allow/deny lists on a task or agent definition. */
export const MAX_TOOL_LIST = 50;
/** Tool names that may flow into Pi's comma-separated `--tools` argument. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
/** Cut `value` to at most `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncateText(value: string, max: number): string {
	if (value.length <= max) return value;
	const end = max > 0 && /[\uD800-\uDBFF]/.test(value[max - 1]) ? max - 1 : max;
	return value.slice(0, end);
}
/** Stored task error text; longer host errors are truncated before they are written. */
export const MAX_TASK_ERROR = 64 * KIB;
/** Stored task title. */
export const MAX_TASK_TITLE = 1000;
/** Model provider and id, matching the renderer IPC limits for `set_model` and `pi:task:start`. */
export const MAX_MODEL_PROVIDER = 300;
export const MAX_MODEL_ID = 500;
/**
 * Agent definition body, preloaded skills and memory appended to a child's system
 * prompt through a private file. Larger than one definition (64 KiB) plus skills (48 KiB).
 */
export const MAX_AGENT_SYSTEM_PROMPT = 512 * KIB;
/** Call-level Agent `name`, addressable by SendMessage. */
export const AGENT_CALL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Agent types listed to the parent model in its system prompt. */
export const MAX_LISTED_AGENTS = 64;
/** One listed agent description, in code points. */
export const MAX_LISTED_AGENT_DESCRIPTION = 1000;
/** All listed descriptions together (about 15k tokens); later entries are cut. */
export const MAX_AGENT_LISTING_CHARS = 60 * KIB;
/** Upper bound of the foreground Agent wait setting (24 hours); 0 waits without limit. */
export const MAX_FOREGROUND_SUBAGENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Foreground wait before a still-running child is handed to background delivery (0 = no automatic cutoff; use Ctrl+B to background). */
export const DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS = 0;
/** Maximum byte length of a single NDJSON progress line from `/invoke`. */
export const MAX_PROGRESS_LINE_BYTES = 16 * KIB;
/** Maximum concurrent in-flight tool host calls per session token. */
export const MAX_CONCURRENT_TOOL_CALLS_PER_TOKEN = 32;
/** Live task progress emission throttle (ms). */
export const TASK_PROGRESS_THROTTLE_MS = 250;
/** Periodic persistence interval for running task stats (ms). */
export const TASK_PROGRESS_PERSIST_MS = 5_000;
/** Maximum recent tool activities kept on a live task progress payload. */
export const MAX_RECENT_TASK_ACTIVITIES = 5;
/** SubagentStart `additionalContext` hook output appended to a child's system prompt. */
export const MAX_HOOK_ADDITIONAL_CONTEXT = 16 * KIB;
/** Skills a definition may preload; extra names are refused, not silently dropped. */
export const MAX_AGENT_SKILLS = 32;
/** Agent frontmatter `color`, kept for the renderer only. */
export const AGENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$|^[a-z]{3,20}$/;
/** MCP server names a definition may reference (inline configs are not supported). */
export const MAX_AGENT_MCP_SERVERS = 16;
/** Hot reload debounce for agent definition files. */
export const AGENT_DEFINITION_RELOAD_DEBOUNCE_MS = 1000;
