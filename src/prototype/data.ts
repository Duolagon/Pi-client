export type Panel = "changes" | "files" | "preview" | "details";
export type Mode = "手动确认" | "接受修改" | "计划模式" | "自动执行";
export type SessionStatus = "idle" | "working" | "approval" | "done" | "stopped";
export interface Session {
	id: string;
	title: string;
	project: string;
	time: string;
	status: SessionStatus;
	custom?: boolean;
	messages: string[];
}
export interface ChangedFile {
	path: string;
	added: number;
	removed: number;
	status: "M" | "A";
	lines: { kind: "same" | "add" | "remove" | "hunk"; text: string }[];
}
export const initialSessions: Session[] = [
	{ id: "search", title: "为会话列表添加搜索功能", project: "pi", time: "刚刚", status: "approval", messages: [] },
	{ id: "theme", title: "增加深色主题支持", project: "pi", time: "28 分钟前", status: "done", messages: [] },
	{ id: "rpc", title: "梳理 RPC 会话生命周期", project: "pi", time: "1 小时前", status: "done", messages: [] },
	{ id: "welcome", title: "了解这个项目的架构", project: "pi", time: "昨天", status: "done", messages: [] },
	{ id: "web", title: "完善登录页的表单校验", project: "my-website", time: "昨天", status: "done", messages: [] },
	{ id: "web2", title: "修复移动端导航菜单", project: "my-website", time: "周五", status: "done", messages: [] },
];
export const modes: { name: Mode; description: string }[] = [
	{ name: "手动确认", description: "修改文件和运行命令前询问你" },
	{ name: "接受修改", description: "自动应用文件修改，运行命令前询问" },
	{ name: "计划模式", description: "先探索和提出计划，暂不修改代码" },
	{ name: "自动执行", description: "在已授权范围内连续执行任务" },
];
export const models = [
	{ name: "Claude Sonnet", provider: "Anthropic", note: "兼顾速度与编码能力" },
	{ name: "Claude Opus", provider: "Anthropic", note: "适合复杂推理与重构" },
	{ name: "GPT Codex", provider: "OpenAI", note: "专注软件开发任务" },
	{ name: "Gemini Pro", provider: "Google", note: "适合长上下文工作" },
];
export const changedFiles: ChangedFile[] = [
	{
		path: "src/components/SessionList.tsx",
		added: 42,
		removed: 8,
		status: "M",
		lines: [
			{ kind: "hunk", text: "@@ -12,14 +12,22 @@ export function SessionList()" },
			{ kind: "same", text: "export function SessionList({ sessions }: Props) {" },
			{ kind: "add", text: '  const [query, setQuery] = useState("");' },
			{ kind: "add", text: "  const filteredSessions = useMemo(() => {" },
			{ kind: "add", text: "    const keyword = query.trim().toLowerCase();" },
			{ kind: "add", text: "    return sessions.filter((session) =>" },
			{ kind: "add", text: "      session.title.toLowerCase().includes(keyword)" },
			{ kind: "add", text: "    );" },
			{ kind: "add", text: "  }, [sessions, query]);" },
			{ kind: "same", text: "" },
			{ kind: "same", text: "  return (" },
			{ kind: "same", text: '    <aside className="session-list">' },
			{ kind: "add", text: "      <SearchInput" },
			{ kind: "add", text: "        value={query}" },
			{ kind: "add", text: "        onChange={setQuery}" },
			{ kind: "add", text: '        placeholder="搜索会话…"' },
			{ kind: "add", text: "      />" },
			{ kind: "remove", text: "      {sessions.map((session) => (" },
			{ kind: "add", text: "      {filteredSessions.map((session) => (" },
			{ kind: "same", text: "        <SessionItem" },
			{ kind: "same", text: "          key={session.id}" },
			{ kind: "same", text: "          session={session}" },
			{ kind: "same", text: "        />" },
			{ kind: "same", text: "      ))}" },
			{ kind: "same", text: "    </aside>" },
			{ kind: "same", text: "  );" },
			{ kind: "same", text: "}" },
		],
	},
	{
		path: "src/components/SearchInput.tsx",
		added: 28,
		removed: 0,
		status: "A",
		lines: [
			{ kind: "hunk", text: "@@ -0,0 +1,28 @@ 新建文件" },
			{ kind: "add", text: 'import { Search, X } from "lucide-react";' },
			{ kind: "add", text: "" },
			{ kind: "add", text: "interface SearchInputProps {" },
			{ kind: "add", text: "  value: string;" },
			{ kind: "add", text: "  onChange: (value: string) => void;" },
			{ kind: "add", text: "  placeholder?: string;" },
			{ kind: "add", text: "}" },
			{ kind: "add", text: "" },
			{ kind: "add", text: "export function SearchInput(props: SearchInputProps) {" },
			{ kind: "add", text: "  return (" },
			{ kind: "add", text: '    <div className="search-input">' },
			{ kind: "add", text: "      <Search size={16} aria-hidden />" },
			{ kind: "add", text: "      <input" },
			{ kind: "add", text: "        value={props.value}" },
			{ kind: "add", text: "        onChange={(e) => props.onChange(e.target.value)}" },
			{ kind: "add", text: "        placeholder={props.placeholder}" },
			{ kind: "add", text: '        aria-label="搜索会话"' },
			{ kind: "add", text: "      />" },
			{ kind: "add", text: "    </div>" },
			{ kind: "add", text: "  );" },
			{ kind: "add", text: "}" },
		],
	},
	{
		path: "src/styles/sidebar.css",
		added: 13,
		removed: 4,
		status: "M",
		lines: [
			{ kind: "hunk", text: "@@ -45,5 +45,14 @@" },
			{ kind: "same", text: ".session-list {" },
			{ kind: "same", text: "  display: flex;" },
			{ kind: "same", text: "  flex-direction: column;" },
			{ kind: "remove", text: "  padding: 16px;" },
			{ kind: "add", text: "  padding: 12px;" },
			{ kind: "add", text: "  gap: 8px;" },
			{ kind: "same", text: "}" },
			{ kind: "add", text: "" },
			{ kind: "add", text: ".search-input {" },
			{ kind: "add", text: "  display: flex;" },
			{ kind: "add", text: "  align-items: center;" },
			{ kind: "add", text: "  gap: 8px;" },
			{ kind: "add", text: "  border-radius: 8px;" },
			{ kind: "add", text: "  background: var(--surface-secondary);" },
			{ kind: "add", text: "}" },
		],
	},
];
export const fileTree = [
	{ name: "src", depth: 0, folder: true },
	{ name: "components", depth: 1, folder: true },
	{ name: "SessionList.tsx", depth: 2, path: changedFiles[0].path },
	{ name: "SearchInput.tsx", depth: 2, path: changedFiles[1].path },
	{ name: "MessageList.tsx", depth: 2, path: "src/components/MessageList.tsx" },
	{ name: "Composer.tsx", depth: 2, path: "src/components/Composer.tsx" },
	{ name: "styles", depth: 1, folder: true },
	{ name: "sidebar.css", depth: 2, path: changedFiles[2].path },
	{ name: "App.tsx", depth: 1, path: "src/App.tsx" },
	{ name: "package.json", depth: 0, path: "package.json" },
	{ name: "README.md", depth: 0, path: "README.md" },
	{ name: "AGENTS.md", depth: 0, path: "AGENTS.md" },
];
