/** The canonical project-relative plan file for a desktop conversation. */
export function planRelativePath(conversationId: string): string {
	if (!/^[a-zA-Z0-9._-]+$/.test(conversationId)) throw new Error("会话标识无效。");
	return `.pi/plans/${conversationId}.md`;
}
