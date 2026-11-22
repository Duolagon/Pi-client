# 桌面后端接入契约

本文描述独立客户端的后端、IPC 和 preload 接口。新增能力的完整界面入口仍待前端接入。完整 TypeScript 定义在 `src/shared.ts`，会话契约在 `src/session-types.ts`，CLI 历史契约在 `src/session-history-types.ts`。

渲染进程统一通过 `window.pi` 调用；不得自行启动 Shell、访问 Node 文件系统或直接发送未经定义的 IPC。所有 IPC 仍经过主窗口、主 frame 和应用本地 URL 校验。

## 接口总览

| 命名空间 | 方法 | 用途 |
| --- | --- | --- |
| `pi.tools` | `list / setEnabled / onEvent` | 真实工具清单、分范围启停和恢复继承 |
| `pi.permissions` | `list / upsert / remove / check / onEvent` | 细粒度规则、授权预览与热更新 |
| `pi.externalAgents` | `executors / configure / start / list / snapshot / send / result / cancel / respond / replay / onEvent` | 本机 Codex／Claude／Kimi／Antigravity 协作与独立审批流 |
| `pi.git` | `begin / finish / list / diff / restore` | 工作树检查点与安全恢复 |
| `pi.terminals` | `create / list / write / resize / close / replay / onEvent / ssh / mcpOAuth / packages` | PTY 与输出回放、SSH、MCP OAuth 和 Pi CLI 扩展管理 |
| `pi.tasks` | `start / list / snapshot / result / cancel / stopAll / deliverNow / command / respond / files / readFile / workspace / diff / onEvent` | 后台任务、模型委派结果与指定会话操作；`stopAll` 停止会话的全部后台子 Agent，`deliverNow` 立即交付待交付的子 Agent 结果 |
| `pi.worktrees` | `create / list / remove / merge` | 托管 Worktree 生命周期 |
| `pi.sessions` | `fork / clone / entries / tree / forkMessages / navigate / history / importHistory` | 会话分支、树导航和 CLI 历史导入 |
| `pi.setProjectTrust` | `setProjectTrust({ project, decision })` | 保存项目信任决定、重启相关会话并返回新快照 |
| `pi.agents` | `list / save / remove` | 自定义 Agent 定义（`.pi/agents`、`.claude/agents`） |
| `pi.mcp` | `list / save / remove` | MCP 服务器增删与启停 |
| `pi.onEvent` | 原接口保留 | 所有会话的 Pi 流式事件，按 `conversationId` 路由 |

原有前台接口继续工作。后端切换项目或会话会保留正在运行的旧会话；前端不得再假设“只有当前会话会产生事件”。前台切换时传入目标会话的 ID 调用 `pi.command(command, id)` 和 `pi.respond(response, id)`，并用 `Snapshot.activity` 显示其他会话的运行与审批状态。不同会话的写任务需要不同项目目录或 Worktree。修改全局模型连接、权限等设置前，需要停止全部运行中或排队中的任务。

流式恢复使用 `Snapshot.liveTranscript / eventSequence` 和 `DesktopEvent.sequence`。`messages` 是 Pi 已结束的消息，`liveTranscript` 补充当前生成中的 assistant 与未完成工具进度；页面重载时应一起恢复。事件序号在本次桌面宿主进程内递增，前端只重放同一 `conversationId`、且晚于快照序号的事件，避免漏接或重复追加。正式界面通过共享的 `src/transcript.ts` 和有界事件窗口处理这一过程；完整会话历史仍由 Pi 持久化。

## 项目信任

```ts
const snapshot = await window.pi.snapshot();
if (snapshot.trust?.required && !snapshot.trust.decision) {
  // 展示资源清单，由用户决定；不要默认信任。
  await window.pi.setProjectTrust({ project: snapshot.trust.project, decision: "trusted" });
}
```

`Snapshot.trust` 只在存在前台会话时返回：

- `project`：规范化后的项目绝对路径。
- `required`：是否检测到受保护项目资源。
- `resources`：项目相对路径列表，可能包含祖先 `.agents/skills` 的 `../` 路径。
- `decision`：`trusted / untrusted`，未决定时省略。

检测范围包括 `.pi/settings.json`、`.pi/mcp.json`、`.pi/agents`、`.claude/agents`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`，以及工作目录到仓库根（有 `.git` 时）的祖先 `.agents/skills`。上下文文件 `AGENTS.md` / `CLAUDE.md` 不受信任门控。

启动 Pi RPC 时，存在受保护资源则显式传 `--approve`（信任）或 `--no-approve`（未信任/未决定）。这避免 RPC 模式无法弹 trust 提示时静默跳过项目配置，也避免把“未决定”误当成信任。

`setProjectTrust` 要求项目已打开、路径为绝对路径、决定为 `trusted / untrusted`；该项目存在运行中任务、直接命令或待审批时拒绝。决定变化会停止并重建该项目的运行时，使 Pi 重新读取项目资源；决定持久化在 `desktop.json` 的 `projectTrust`。信任只控制 Pi 是否加载项目配置，不是 OS 沙箱，也不限制已加载扩展/命令的系统权限。

## 自定义 Agent

```ts
const agents = await window.pi.agents.list(project);
await window.pi.agents.save({
  name: "reviewer",
  description: "Reviews correctness and missing tests",
  prompt: "You are a strict code reviewer. Do not edit files.",
  tools: ["read", "grep", "find"],
  model: "anthropic/claude-opus-5-5", // 可选，provider/model-id
  thinkingLevel: "high",             // 可选
  scope: "project",                  // .pi/agents；user 写入 ~/.pi/agent/agents
  project,
});
```

定义格式为 Markdown frontmatter + 正文提示词（支持多行 YAML 数组与嵌套 `hooks`）；兼容 Claude Code 的 `Read/Grep/Glob/Edit/Write/NotebookEdit/WebFetch/Bash` 等工具名，支持 `tools` 白名单、`disallowedTools` 黑名单、`model`（`provider/model-id` 或 `sonnet`/`opus`/`haiku`/`fable`/`inherit`）、`effort`/`thinkingLevel`、`permissionMode`（含 `default/acceptEdits/plan/dontAsk/bypassPermissions/read`，且不突破只读/Plan/显式规则上限）、`maxTurns`、预加载 `skills`、`memory`（`user/project/local`）、`isolation`、`background` 与作用域 `hooks`（子 Agent 结束时 frontmatter `Stop` 自动映射为 `SubagentStop`）。项目级定义与项目 `skills`/`memory`/`hooks` 仅在项目信任后加载。`.claude/agents` 条目只读展示，保存会在 `.pi/agents` 创建同名覆盖（保留既有 `hooks` 块）。内置 `general-purpose / Explore / Plan` 不可覆盖或删除。

`Agent` 工具的 `subagent_type` 可省略（默认 general-purpose），接受内置名或自定义名；未知名称报错并列出可用 Agent；`subagent_type: "fork"`（或兼容参数 `fork: true`）可将父会话当前干净上下文分支快照复制到子会话（裁剪未闭合末尾工具调用）。定义正文（内置 Agent 也有原生风格提示词）、预加载 Skill 与记忆写入私有文件，以 `--append-system-prompt` 追加到子 Agent 的 system prompt，首条用户消息只放任务本身；模型（调用参数 `model` 优先于定义）、思考强度、权限、轮次、工具策略按定义应用。父会话每轮的 system prompt 末尾附有可用 agent 清单（只含当前信任状态下可见的定义）。Agent 默认后台运行（设置 `subagentDefaultBackground`，默认 true），非 git 项目中的可写子 Agent 默认前台。详见 [tools-and-delegation.md](tools-and-delegation.md)。

设置（`saveSettings` / `Snapshot.settings`）中与子 Agent 相关的两项：`subagentDefaultBackground?: boolean`（缺省视为 true）和 `foregroundSubagentTimeoutMs?: number`（前台 Agent 最长等待，0–86400000 毫秒，0 表示一直等待，缺省 300000）。主进程 IPC 与宿主都会校验类型和范围；界面入口在设置弹窗的高级区域。

## MCP 服务器

```ts
const servers = await window.pi.mcp.list(project);
await window.pi.mcp.save({
  name: "docs",
  scope: "project",
  transport: "http",
  url: "https://example.com/mcp",
  description: "Product documentation",
  enabled: true,
  project,
});
```

`pi.mcp.list` 合并用户 `~/.pi/agent/mcp.json` 与项目 `.pi/mcp.json`；项目条目可只写 `enabled/exposure` 覆盖用户条目。`save` 保留已有 `env/headers/oauth/timeout` 等字段，只更新名称、命令、参数、URL、描述和启停；保存或删除后重启当前项目会话以重新加载 MCP。OAuth 型服务器仍需在终端运行 `pi mcp login <server>`；项目级 MCP 还要求项目信任。

## 会话分支、克隆和树导航

```ts
const { messages: choices } = await window.pi.sessions.forkMessages(conversationId);
const forked = await window.pi.sessions.fork({
  conversationId,
  entryId: choices[0].entryId,
  title: "另一种实现",
  activate: true, // 默认 true；false 保持前台选择。
});
if (!forked.cancelled) {
  // 使用 forked.conversation.id 处理新会话；selectedText 放入输入框，等待用户发送。
}
const cloned = await window.pi.sessions.clone({ conversationId, activate: false });
const { tree, leafId } = await window.pi.sessions.tree(conversationId);
const { entries } = await window.pi.sessions.entries({ conversationId });
const updates = await window.pi.sessions.entries({ conversationId, since: entries[0].id });
const navigation = await window.pi.sessions.navigate({ conversationId, targetId: entries[0].id });
// 用 navigation.snapshot 刷新消息；若有 editorText，放入输入框，不自动发送。
```

省略 `conversationId` 使用当前前台会话。`fork` 复用 Pi 原生行为：从所选用户消息**之前**创建独立 JSONL，返回该消息的 `selectedText`。`clone` 复制当前所选分支直到当前叶节点。二者保留父会话和文件，新增 `parentConversationId / forkEntryId / origin` 元数据；不会复制整个树，也不会复制 Git 检查点或后台任务所有权。空叶节点不能克隆。

`tree` 和 `entries` 保留 Pi 原生条目类型、父子关系和标签；`entries` 包含完整树，`since` 按文件追加顺序返回后续条目，未知 ID 返回错误。`forkMessages` 返回整个会话树内有文本的用户消息。已卸载或项目目录已移除的会话可离线查询，不启动模型和扩展，也不改变前台选择。

`navigate` 在原 JSONL 内选择另一分支，保留全部历史。选择用户消息或 custom message 时，Pi 将上下文定位到其父节点，并返回输入框文本；其他条目定位到选中节点。仅接受存在的 `targetId`，不接受任意文件路径。导航通过宿主私有扩展调用 Pi 原生 `navigateTree`，触发原生取消钩子，固定 `summarize: false`，不请求模型。`label` 可选。取消时返回 `cancelled: true`；不存在的节点、运行中／审批中／排队任务返回错误。

所选叶节点单独持久化，重启后恢复。若第三方扩展取消恢复或 Pi 无法表达该节点，运行时会停止并明确报错，避免继续使用错误上下文。会话操作只改变对话上下文；项目文件的回退使用 `pi.git.restore`。

`fork / clone` 返回 `{ cancelled, conversation?, selectedText?, snapshot }`；`navigate` 返回 `{ cancelled, leafId, editorText?, snapshot }`。返回的 snapshot 对应操作目标，`activate: false` 时不能据此替换全局前台选择；需以 `pi.snapshot()` 获取前台。后台任务完成后可以分支／克隆，但新会话不会继承原任务 ID、状态和审批。事件继续按新会话的 `conversationId` 路由。

## 导入已有 Pi CLI 历史

```ts
const history = await window.pi.sessions.history({
  // project: "/absolute/project", // 可选，省略显示全部项目。
  // sessionDir: "/absolute/cli-session-dir", // 可选，自定义 CLI --session-dir。
});
const selected = history.sessions[0];
const imported = await window.pi.sessions.importHistory({ token: selected.token, activate: true });
```

发现范围为当前 Pi 配置目录下的 `sessions/`，以及 Pi 会话目录配置；结果含 `roots / sessions / skipped / truncated`。会话项提供源路径、项目、标题、时间、消息／条目／分支数量、模型和已导入 ID。`project` 用于过滤来源项目。发现和解析不加载项目扩展、不读取密钥、不调用模型。

导入只接受本次进程发现后签发的 token，不接受原始文件路径。源文件发现后变化时必须重新发现；重启后 token 失效。符号链接、越界、超限或格式错误文件会被拒绝或列入 `skipped`。导入保留完整树、标签和压缩条目，旧版格式在内存迁移后生成新副本；原 CLI 文件内容和修改时间保持不变。

相同源路径与内容跨重启去重；源内容改变后可导入为另一独立版本。`importHistory` 返回 `{ conversationId, sessionFile, project, title, sourceSessionId, alreadyImported, conversation, snapshot }`。导入副本可继续编码，源项目目录不存在时以存档方式查看。应用不会自动导入或上传任何历史。

## 后台任务

```ts
const stopPiEvents = window.pi.onEvent(({ conversationId, event }) => {
  // 用 conversationId 分发到每个会话自己的消息 reducer 和审批队列。
});
const stopTaskEvents = window.pi.tasks.onEvent(({ task }) => {
  // 用 task.id 更新任务列表，按 revision 丢弃较旧状态。
});

const task = await window.pi.tasks.start({
  project: "/absolute/path/to/repository",
  message: "检查并修复测试失败",
  title: "修复测试",
  isolation: "worktree", // 默认值；要求仓库有已提交的 HEAD。
  // baseRef: "HEAD",
  // model: { provider: "desktop-deepseek", id: "deepseek-flash" },
  // thinkingLevel: "high",
});
const snapshot = await window.pi.tasks.snapshot(task.id);
```

`task.id` 与 `task.conversationId` 相同。`project` 是原项目，`workingDirectory` 是实际执行目录，`worktreeId` 标识隔离目录。源项目为子目录时，执行目录保持它在 Git 仓库内的相对位置。

`start()` 返回已登记的任务，不等待模型生成完成。状态为 `queued / running / waiting_for_input / completed / failed / cancelled / interrupted`；`revision` 单调递增。默认最多同时运行四个后台任务，超出后排队。`waiting_for_input` 占用并发名额。

同一工作目录或相互包含的目录不会并发执行写任务。`isolation: "shared"` 直接使用原目录，同目录后台任务按顺序运行；前台在该目录有写任务时，新提示会被拒绝。普通非 Git 项目可显式使用 `shared`。

新 Worktree 从选定的已提交基准创建，不复制原项目的未提交修改。也可以复用先前创建的托管目录：

```ts
const tree = await window.pi.worktrees.create({ project: "/absolute/repo", baseRef: "HEAD" });
const task = await window.pi.tasks.start({ worktreeId: tree.id, message: "分析这个独立分支" });
```

已有 Worktree 不能重新指定 `baseRef`，也不能搭配另一源仓库。新建隔离目录不改变原工作树或索引。

### 指定会话、审批和取消

```ts
await window.pi.tasks.command(task.id, { type: "steer", message: "先修复最小复现" });
await window.pi.tasks.respond(task.id, {
  type: "extension_ui_response",
  id: request.id,
  confirmed: true,
});
await window.pi.tasks.cancel(task.id);
```

审批事件仍来自 `pi.onEvent`，必须同时保留 `conversationId` 和请求 `id`。错误会话的审批会拒绝。`tasks.snapshot(id)` 不改变当前前台会话，包含该会话自己的 `pendingUI`，供页面重载后恢复审批。

继续一个任务（结束后的下一轮，或给运行中的任务补充说明）：

```ts
const sent = await window.pi.tasks.send({ taskId: task.id, message: "再补一个边界测试", notifyParent: false });
// sent.status: "resumed"（已结束的任务带完整历史开始下一轮）| "delivered_to_running_agent"
await window.pi.tasks.viewing(task.id, true); // 详情打开时上报；关闭时传 false
```

`tasks.send` 走任务状态机：`turn + 1`、重新排队、用量按轮统计。模型委派的子 Agent 默认不把用户这一轮的结果交给父会话，`notifyParent: true` 才交付。在已结束子 Agent 自己的会话里直接发送消息也会转为 `tasks.send`。已结束且无人查看的子 Agent 进程会在空闲 60 秒后被回收，下次发送时透明重启；`tasks.viewing` 上报的会话不回收。

`tasks.command` 采用现有桌面 RPC 白名单，支持提示、引导、follow-up、停止、模型／思考选择和查询等；不会开放任意切换会话路径或原始 RPC 会话替换。文件、Git 状态和差异接口均以该任务执行目录为边界。

取消是停止请求，正在结束的任务可能还在完成工具清理与检查点封存。恢复文件前，应等会话不再执行；后端会再次检查。应用重启后未完成任务标记为 `interrupted`，不会自动重复发送提示或消耗模型额度；之后可用 `tasks.send`（模型侧为 SendMessage）显式继续。前端重新调用 `tasks.list()` 恢复列表。

## 评审、浏览器验证和代码分析

`pi.pullRequest(conversationId, number?)` 使用 `gh` 读取 PR 和 CI 状态。 `pi.createDraftPullRequest(conversationId, { branch, title, body, base? })` 在用户提交表单后从已推送的当前分支创建草稿 PR。

`pi.checkPreview(url, mobile)` 在隔离的 Chromium 会话中访问回环地址并返回 HTTP 状态、标题、耗时和浏览器错误。验证窗口允许同源的 GET、HEAD 和 OPTIONS 请求。

`pi.inspectCode(conversationId, path, { line, column }?)` 在已信任项目启动适配的本地语言服务器。返回的行列从 1 开始，定义只能跳转到项目内文件。 `pi.writeMemoryFile("本机项目记忆", content)` 写入应用数据区，正文上限 24 KiB。项目规则和本机项目记忆会进入受信任项目的模型上下文。

## Git 检查点

每次新的 Pi 提示和直接 RPC `bash` 命令都会自动创建、封存检查点；同一轮运行中的引导／follow-up 共用该轮检查点。非 Git 目录不自动创建检查点。PTY 的任意交互输入没有可靠的命令边界，应使用手动检查点：

```ts
const checkpoint = await window.pi.git.begin({ conversationId: task.conversationId, label: "手动调整前" });
// 执行用户明确要求的手动修改，或使用 PTY。
await window.pi.git.finish({ checkpointId: checkpoint.id, conversationId: task.conversationId });

const points = await window.pi.git.list(task.conversationId);
const changes = await window.pi.git.diff({ checkpointId: checkpoint.id, conversationId: task.conversationId });
const result = await window.pi.git.restore({
  checkpointId: checkpoint.id,
  conversationId: task.conversationId,
  paths: ["src/example.ts"], // 省略表示恢复全部变化路径。
});
```

`conversationId` 可省略，此时使用当前前台会话。`diff` 可另传 `path` 筛选单文件。检查点状态为 `pending / ready / partially-restored / restored`，`changes` 包含新增、修改、删除、类型变化、大小、权限和二进制标记。

`restore()` 的正常返回结果包含 `status / checkpoint / restored / skipped / conflicts`。`status` 为 `restored / unchanged / conflict / partial`。冲突应展示给用户，不应当作网络失败盲目重试。

恢复规则：

- 保存并恢复工作文件，Git 索引和 HEAD 保持不变；用户原先未提交的修改属于恢复基线。
- 覆盖跟踪文件及未忽略的未跟踪文件；不捕获 `.git` 和忽略文件。
- 当前内容、类型、可执行权限必须仍匹配检查点的结束状态；已等于开始状态则跳过。
- 先检查整批路径、HEAD、目录结构及内容完整性。后续外部编辑或符号链接逃逸会产生冲突。
- 跨文件恢复不是操作系统事务；执行期间发生新冲突时停止并返回 `partial` 和已恢复路径。
- 有 Pi 任务执行或该项目有未关闭 PTY 时，恢复被拒绝。只读模式也禁止恢复。
- 单文件上限 64 MB、单次捕获总内容上限 512 MB、路径上限 50,000；超限明确失败。

检查点记录开始到结束期间整个工作树的变化，可能包括外部程序同期修改，不能将它标成“仅 Agent 修改”。恢复前应提供差异审核。`pending` 必须先封存后才能恢复。

## PTY 终端

```ts
const stopTerminalEvents = window.pi.terminals.onEvent((event) => {
  if (event.type === "terminal_data") {
    // 按 terminalId 路由，按 sequence 去重，再交给终端模拟器。
  }
});
const terminal = await window.pi.terminals.create({
  conversationId: task.conversationId,
  cols: 100,
  rows: 30,
});
await window.pi.terminals.write(terminal.id, "pwd\r");
await window.pi.terminals.resize(terminal.id, 120, 40);
await window.pi.terminals.write(terminal.id, "\u0003"); // Ctrl-C
const replay = await window.pi.terminals.replay(terminal.id, 0);
await window.pi.terminals.close(terminal.id);
```

创建参数也可以省略，默认绑定当前会话。`project` 不允许渲染进程指定，后端从会话解析；可选 `shell` 必须是本机可执行的绝对路径。

终端为 `forkpty` 创建的真实终端，支持持续 Shell、标准输入、前台作业信号与 `stty` 尺寸。输出来自 `terminal_data`，退出来自 `terminal_exit`。创建前先订阅事件，创建后再 `replay` 补齐初始输出并按序号去重。

`replay` 返回 `terminal / chunks / earliestSequence / nextSequence / truncated`。默认保留最近 1 MB／2048 块及 64 个已退出终端；历史被截断时应提示。终端状态为 `starting / running / closing / exited`。

单次输入上限 1 MB，总待发送队列上限 4 MB。调用方应等待 `write()`，超限会返回背压错误；不要无限重发。数据可包含 NUL、Ctrl-C 等控制字符。

只读模式禁止创建和输入；切换只读会关闭已有 PTY。关闭应用会清理终端及其前后台子进程；终端清理完成后才发退出事件。PTY 输出不自动进入模型上下文。

回放只在本次应用进程内保留，页面重载可恢复，应用退出不会维持终端进程。本轮已验收 macOS；Linux 源码可构建但未实机验收，Windows ConPTY 尚未实现。

## Worktree 审核、合并和清理

```ts
const trees = await window.pi.worktrees.list();
const result = await window.pi.worktrees.merge(task.worktreeId!);
if (result.status === "blocked") {
  // 显示 reason，由用户处理提交、分叉或目标目录状态。
}
const removed = await window.pi.worktrees.remove(task.worktreeId!);
// removed.branchRetained 为 true 时，提示未合入分支仍保留。
```

只管理本应用创建的 Worktree。`merge` 固定合并到创建时记录的源目录／目标分支，仅接受干净的已提交工作树和快进；分叉、目标分支漂移、活动任务、活动终端、忽略文件覆盖风险均会阻止。它不隐式提交或推送。

`remove` 不使用强制删除。脏目录、忽略文件及活动任务／终端都会阻止清理；未合入的已提交分支会保留。只读模式禁止创建、删除和合并。

清理隔离目录后，`tasks.snapshot(id)` 仍可读取持久化消息，返回 `archived: true`；检查点列表与差异也保留。前端应禁用继续执行和文件操作。恢复文件和继续任务要求实际工作目录存在。

## 构建与验证

所有命令在本仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run build
npm run check
node --test test/*.test.ts
```

Pi 引擎来自精确锁定的 `@earendil-works/pi-coding-agent@1.5.2` 与 `@earendil-works/pi-ai@1.5.2`，构建从已安装的 npm 包组装运行时，无需额外构建上游仓库。`package-lock.json` 记录解析结果和发布包 integrity；升级步骤见 [UPSTREAM.md](../UPSTREAM.md)。

`npm run build:backend` 只编译后端、preload、权限／导航扩展、会话读取辅助程序和原生 PTY helper，保留已有 UI 构建产物。首次构建使用完整的 `npm run build`。

本机开发构建需要 Node.js 22.19.0 或更新版本、Git 和 C 编译器；最终应用携带 Node 运行时与已编译 helper。独立测试使用临时仓库、真实 Pi 进程与本地脚本化模型，不读取真实密钥或调用付费 API。

首次开发启动前执行 `node node_modules/electron/install.js`，再运行 `npm run start`。`npm run package`／`npm run dist:mac` 由 electron-builder 自行下载打包使用的 Electron 运行时。

`test/packaged-backend-smoke.ts` 可用 esbuild 打包为独立脚本，再由目标 `.app/Contents/MacOS/Pi Desktop` 以 `ELECTRON_RUN_AS_NODE=1` 执行。参数依次为目标 `Contents/Resources` 和 `test/fixtures/faux-provider.js` 的绝对路径。已从 `/tmp` 验收打包后的两路 Pi 运行时、自动检查点与恢复、Worktree 清理后存档读取，以及包内原生 PTY，未启动或修改前端。

`test/packaged-session-smoke.ts` 使用同样的参数和执行方式，另已从 `/tmp` 验证包内的分支、克隆、树查询、私有原生导航扩展、所选分支重启恢复与 CLI 历史导入。两类验收仅使用临时数据和本地 faux 模型。

## 工具控制与主动委派补充

新增 `window.pi.tools`、`window.pi.permissions` 和 `window.pi.tasks.result`；真实模型工具 Agent、TaskOutput/Stop/List 及 Worktree 工具已接入。完整参数、权限规则、热更新语义、父子事件路由和前端卡片约定见 [tools-and-delegation.md](tools-and-delegation.md)。前端页面没有随本次后端接入修改。

本机外部执行器另见 [local-external-agents.md](local-external-agents.md)。外部 Agent 的审批和事件使用独立命名空间，不能用 Pi tasks.respond/snapshot 代替；主模型使用 Agent 的 executor 和 SendMessage（兼容别名 AgentSend）持续协作。`pi.terminals.ssh(conversationId, host, startPi)` 启动 SSH 终端，使用系统 OpenSSH 配置和远端安装的 Pi。SSH 终端拥有独立的回放与生命周期。
