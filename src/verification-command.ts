const RUNNER_WRAPPER = /^(?:(?:npx(?:\s+--(?:yes|no-install))?|npm\s+exec(?:\s+--)?|uv\s+run|bundle\s+exec|pnpm\s+exec|bunx)\s+|\.\/node_modules\/\.bin\/)/i;
const VERIFY_RUNNER = /^(?:vitest|jest|mocha|ava|pytest|py\.test|tsc|tsd|eslint|flake8|mypy|pyright|rspec|phpunit|ctest)(?:\s|$)/i;
const VERIFY_TASK = /^(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?|(?:cargo|go|make|gradle|mvn)\s+)(?:tests?|check|typecheck|type-check|lint|build|clippy|verify)(?:[:_-][\w:-]+)?(?:\s|$)|^(?:npm|pnpm|yarn|bun|deno)\s+run\s+ci(?:[:_-][\w:-]+)?(?:\s|$)/i;
const VERIFY_MODE = /^(?:node\s+(?:[^\n]*?\s)?--test\b|python3?\s+-m\s+(?:pytest|unittest)\b)/i;
const VERIFY_FORMAT = /^(?:biome\s+(?:ci|check|lint)|ruff\s+check)(?:\s|$)|^(?:prettier|ruff\s+format|biome\s+format)\s+.*(?:\s|^)--check(?:\s|$)|^prettier\s+--check(?:\s|$)/i;
const ASSIGNMENTS = /^(?:[a-z_][a-z_0-9]*=[^\s]+\s+)+/i;
const SHELL_CONTROL = /[\n\r;&|<>!`]|\$\(/;
const MUTATING_OPTIONS = /(?:^|\s)--(?:fix|fix-only|write|apply|update-snapshots?)(?:[=\s]|$)/i;

/** Classify a single verification command whose exit can be attributed to the check. */
export function isVerifyCommand(command: string): boolean {
	const text = command.trim().replace(ASSIGNMENTS, "");
	const runner = text.replace(RUNNER_WRAPPER, "");
	return !SHELL_CONTROL.test(command) && !MUTATING_OPTIONS.test(text) &&
		(VERIFY_RUNNER.test(runner) || VERIFY_FORMAT.test(runner) || VERIFY_TASK.test(text) || VERIFY_MODE.test(text));
}
