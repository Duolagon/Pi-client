import { lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/**
 * Resources that Pi protects behind a project-trust decision.
 * Keep this list aligned with Pi's security documentation and startup loader.
 */
export const projectTrustResources = [
	".pi/settings.json",
	".pi/mcp.json",
	".pi/SYSTEM.md",
	".pi/APPEND_SYSTEM.md",
	".pi/extensions",
	".pi/skills",
	".pi/prompts",
	".pi/themes",
] as const;

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		// A permission error still means something is there; require a decision
		// rather than silently treating the resource as absent.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Return project-relative paths for resources that Pi would only load after a
 * trust decision. `.agents/skills` is discovered through ancestors, stopping
 * at the repository root, so the result can include `../` paths.
 */
export async function detectProjectTrustResources(project: string): Promise<string[]> {
	const found = new Set<string>();
	for (const resource of projectTrustResources) {
		if (await exists(join(project, resource))) found.add(resource);
	}
	let current = project;
	for (;;) {
		const candidate = join(current, ".agents", "skills");
		if (await exists(candidate)) {
			const path = relative(project, candidate);
			found.add(path || ".agents/skills");
		}
		if (await exists(join(current, ".git"))) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return [...found].sort();
}
