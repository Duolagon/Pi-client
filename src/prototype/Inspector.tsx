import { useState } from "react";
import {
	X,
	FileCode2,
	ChevronRight,
	ChevronDown,
	GitBranch,
	Folder,
	Search,
	Check,
	RefreshCw,
	Terminal,
	MessageSquare,
	ArrowLeft,
} from "lucide-react";
import { IconButton, highlightCode } from "./ui";
import { changedFiles, fileTree, type Panel } from "./data";
interface Props {
	panel: Panel;
	setPanel: (panel: Panel) => void;
	close: () => void;
	selected: number;
	select: (index: number) => void;
	notify: (message: string) => void;
	comment: (file: string) => void;
	commit: () => void;
	project: string;
}
export function Inspector({ panel, setPanel, close, selected, select, notify, comment, commit, project }: Props) {
	const file = changedFiles[selected];
	const [query, setQuery] = useState("");
	const [viewFile, setViewFile] = useState<string | null>(null);
	const [previewQuery, setPreviewQuery] = useState("");
	const [diffStyle, setDiffStyle] = useState("统一");
	const [reviewed, setReviewed] = useState<string[]>([]);
	const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
	const [previewRefresh, setPreviewRefresh] = useState(0);
	const fileContents: Record<string, string> = {
		"package.json":
			'{\n  "name": "pi-desktop",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "check": "tsc --noEmit",\n    "dev": "electron ."\n  }\n}',
		"README.md":
			"# Pi Desktop\n\nA desktop workspace for the Pi coding agent.\n\n## Development\n\nnpm install --ignore-scripts\nnpm run prototype\n\nThis view uses demonstration data.",
		"AGENTS.md":
			"# Project instructions\n\n- Follow existing project conventions.\n- Read relevant files before making changes.\n- Validate changes before reporting completion.",
	};
	const content = viewFile
		? (changedFiles
				.find((item) => item.path === viewFile)
				?.lines.filter((line) => line.kind !== "remove" && line.kind !== "hunk")
				.map((line) => line.text)
				.join("\n") ??
			fileContents[viewFile] ??
			`// ${viewFile}\n// 原型文件预览\n\nexport function Component() {\n  return <div>Pi Desktop</div>;\n}`)
		: "";
	return (
		<aside className="inspector" aria-label="工作区面板">
			<header className="inspector-header">
				<div role="tablist" aria-label="工作区视图">
					{(
						[
							{ key: "changes", label: "修改", count: "3" },
							{ key: "files", label: "文件" },
							{ key: "preview", label: "预览" },
						] as const
					).map((item) => (
						<button
							key={item.key}
							role="tab"
							aria-selected={panel === item.key}
							onClick={() => {
								setPanel(item.key);
								setViewFile(null);
							}}
							className={panel === item.key ? "selected" : ""}
						>
							{item.label}
							{"count" in item && <span>{item.count}</span>}
						</button>
					))}
				</div>
				<IconButton icon={X} label="关闭工作区面板" onClick={close} />
			</header>
			{panel === "changes" && (
				<>
					<div className="changes-overview">
						<div>
							<GitBranch size={14} />
							<span>当前会话的修改</span>
							<span className="diff-count">
								<b>+83</b>
								<i>−12</i>
							</span>
						</div>
						<p>
							feature/session-search <span>相对于 main</span>
						</p>
					</div>
					<div className="changed-file-list">
						{changedFiles.map((item, index) => (
							<button key={item.path} onClick={() => select(index)} className={selected === index ? "selected" : ""}>
								<FileCode2 size={14} />
								<span className="file-name" title={item.path}>{item.path.split("/").pop()}</span>
								<span className="diff-count">
									<b>+{item.added}</b>
									<i>−{item.removed}</i>
								</span>
								<span className={`file-status ${item.status}`}>{item.status}</span>
							</button>
						))}
					</div>
					<div className="diff-toolbar">
						<span title={file.path}>{file.path}</span>
						<button onClick={() => setDiffStyle(diffStyle === "统一" ? "并排" : "统一")} title="切换差异视图">
							{diffStyle}
							<ChevronDown size={10} />
						</button>
					</div>
					<div className={`diff-view ${diffStyle === "并排" ? "split" : ""}`} aria-label="代码差异">
						<div className="diff-view-inner">
							{diffStyle === "并排" ? (
								<div className="split-diff">
									{["修改前", "修改后"].map((heading, side) => (
										<div key={heading}>
											<div className="split-heading">{heading}</div>
											{file.lines
												.filter((line) => line.kind !== (side ? "remove" : "add"))
												.map((line, index) => (
													<div className={`diff-line ${line.kind}`} key={`${index}-${line.text}`}>
														<span className="line-number">{line.kind === "hunk" ? "" : index + 12}</span>
														<span className="line-sign">
															{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
														</span>
														<code>{highlightCode(line.text)}</code>
													</div>
												))}
										</div>
									))}
								</div>
							) : (
								file.lines.map((line, index) => (
									<div key={`${index}-${line.text}`} className={`diff-line ${line.kind}`}>
										<span className="line-number">{line.kind === "hunk" ? "" : index + 12}</span>
										<span className="line-sign">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}</span>
										<code>{highlightCode(line.text)}</code>
									</div>
								))
							)}
						</div>
					</div>
					<div className="diff-review">
						<button onClick={() => comment(file.path)}>
							<MessageSquare size={13} />
							对此文件提出修改
						</button>
						<button
							className={reviewed.includes(file.path) ? "reviewed" : ""}
							onClick={() =>
								setReviewed((files) =>
									files.includes(file.path) ? files.filter((name) => name !== file.path) : [...files, file.path],
								)
							}
						>
							<Check size={13} />
							{reviewed.includes(file.path) ? "已审阅" : "标记已审阅"}
						</button>
					</div>
					<div className="inspector-footer">
						<span>{reviewed.length}/3 已审阅</span>
						<button className="primary-button" onClick={commit}>
							<GitBranch size={13} />
							提交修改
							<ChevronDown size={11} />
						</button>
					</div>
				</>
			)}
			{panel === "files" && (
				<>
					{viewFile ? (
						<>
							<div className="file-preview-heading">
								<button onClick={() => setViewFile(null)}>
									<ArrowLeft size={14} />
									文件
								</button>
								<span>{viewFile.split("/").pop()}</span>
								<button onClick={() => comment(viewFile)} aria-label="引用当前文件">
									<MessageSquare size={14} />
								</button>
							</div>
							<div className="file-code">
								{content.split("\n").map((line, index) => (
									<div key={`${index}-${line}`}>
										<span>{index + 1}</span>
										<code>{highlightCode(line)}</code>
									</div>
								))}
							</div>
						</>
					) : (
						<>
							<div className="file-search">
								<Search size={14} />
								<input
									aria-label="搜索项目文件"
									placeholder="搜索文件…"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
								<kbd>⌘ P</kbd>
							</div>
							<div className="file-tree">
								<div className="tree-root">
									<ChevronDown size={13} />
									<Folder size={14} />
									{project}
									<span>示例目录</span>
								</div>
								{fileTree
									.filter(
										(item) =>
											(!query || item.name.toLowerCase().includes(query.toLowerCase())) &&
											(query ||
												!collapsedFolders.some(
													(folder) => item.path?.includes(`/${folder}/`) || (folder === "src" && item.depth > 0),
												)),
									)
									.map((item) => (
										<button
											key={item.name}
											style={{ paddingLeft: 18 + item.depth * 17 }}
											onClick={() => {
												if (item.folder)
													setCollapsedFolders((folders) =>
														folders.includes(item.name)
															? folders.filter((folder) => folder !== item.name)
															: [...folders, item.name],
													);
												else setViewFile(item.path ?? null);
											}}
										>
											{item.folder ? (
												<>
													{collapsedFolders.includes(item.name) ? (
														<ChevronRight size={12} />
													) : (
														<ChevronDown size={12} />
													)}
													<Folder size={14} />
												</>
											) : (
												<>
													<span className="tree-spacer" />
													<FileCode2 size={14} />
												</>
											)}
											<span>{item.name}</span>
											{changedFiles.some((file) => file.path === item.path) && <b className="file-status M">M</b>}
										</button>
									))}
							</div>
						</>
					)}
				</>
			)}
			{panel === "preview" && (
				<>
					<div className="preview-address">
						<span className="live-dot" />
						<span>localhost:5173</span>
						<TagLabel />
						<IconButton
							icon={RefreshCw}
							label="刷新预览"
							onClick={() => {
								setPreviewRefresh((count) => count + 1);
								setPreviewQuery("");
								notify("示例预览已刷新");
							}}
						/>
					</div>
					<div className="app-preview" key={previewRefresh}>
						<div className="preview-app-heading">
							<span>π</span>
							<strong>会话搜索</strong>
							<span>交互示例</span>
						</div>
						<div className="preview-search">
							<Search size={15} />
							<input
								aria-label="预览中搜索会话"
								placeholder="搜索会话标题…"
								value={previewQuery}
								onChange={(event) => setPreviewQuery(event.target.value)}
							/>
							{previewQuery && (
								<button onClick={() => setPreviewQuery("")} aria-label="清空预览搜索">
									<X size={12} />
								</button>
							)}
						</div>
						{["为会话列表添加搜索功能", "增加深色主题支持", "梳理 RPC 会话生命周期"]
							.filter((title) => title.includes(previewQuery))
							.map((title, index) => (
								<button className="preview-session" key={title} onClick={() => notify(`原型预览：选择了「${title}」`)}>
									<MessageSquare size={15} />
									<span>
										{title}
										<small>{index === 0 ? "刚刚" : "今天"}</small>
									</span>
									<ChevronRight size={13} />
								</button>
							))}
						{!["为会话列表添加搜索功能", "增加深色主题支持", "梳理 RPC 会话生命周期"].some((title) =>
							title.includes(previewQuery),
						) && (
							<div className="empty-result">
								<Search size={24} />
								<strong>没有找到相关会话</strong>
								<span>试试其他关键词</span>
								<button onClick={() => setPreviewQuery("")}>清空搜索</button>
							</div>
						)}
					</div>
					<div className="preview-note">此处模拟开发应用的预览与交互。</div>
				</>
			)}
			{panel === "details" && (
				<div className="details-panel">
					<h3>环境</h3>
					<p>
						<Terminal size={15} />
						本地工作区
					</p>
					<p>
						<Folder size={15} />
						{project}
					</p>
					<p>
						<GitBranch size={15} />
						feature/session-search
					</p>
					<hr />
					<h3>上下文</h3>
					<p>
						18.4k / 200k <span>9%</span>
					</p>
					<div className="context-progress">
						<span />
					</div>
					<hr />
					<h3>会话信息</h3>
					<p>示例会话 · 交互原型</p>
					<p>本阶段不连接模型或执行命令。</p>
				</div>
			)}
		</aside>
	);
}
function TagLabel() {
	return <span className="tag">示例</span>;
}
