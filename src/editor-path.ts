/**
 * Resolves a tool or workspace path against the project for "在编辑器中打开".
 * Dependency-free so the renderer can use it; the main process re-validates the
 * result (absolute, existing, inside a known project or worktree).
 */
export function resolveEditorPath(project: string | undefined, path: string): string | undefined {
	const value = path.trim().replace(/^@/, "");
	if (!value || value.includes("\0") || value.startsWith("~")) return undefined;
	let joined: string;
	if (value.startsWith("/")) joined = value;
	else if (project && project.startsWith("/")) joined = `${project.replace(/\/+$/, "")}/${value}`;
	else return undefined;
	const parts: string[] = [];
	for (const segment of joined.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return `/${parts.join("/")}`;
}
