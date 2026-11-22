# 工具、权限与模型委派接入

本文是后端接入契约。没有修改 `src/renderer/` 或 `src/prototype/`；现有通用工具卡片可以显示新模型工具的文本结果，工具管理页、子任务面板和专用卡片由前端接入。

## 工具清单与启停

```ts
const tools = await window.pi.tools.list(conversationId); // 不传则当前会话
// name, description, parameters, source, sourcePath?, exposure, namespace?,
// enabled, modelVisible, override?

await window.pi.tools.setEnabled({
  name: "bash", enabled: false, scope: "conversation", conversationId,
});
await window.pi.tools.setEnabled({ name: "grep", enabled: true, scope: "project", project });
await window.pi.tools.setEnabled({ name: "bash", enabled: null, scope: "conversation", conversationId });
```

- 清单来自运行中 Pi 的真实工具注册表，包括内置、扩展、MCP 和桌面工具，不是 `get_commands` 或 Skills 数量。
- `enabled` 表示可调用性；`modelVisible` 表示是否直接声明给模型。MCP 的 deferred/codemode 工具可能前者为 true、后者为 false。`exposure` 保留 Pi 原始语义。
- `source` 为 `builtin / extension / mcp / desktop`；`sourcePath` 可用于展示扩展来源。不是所有工具都有来源文件。
- `scope` 为 `global / project / conversation`，默认 conversation。项目路径必须是绝对路径，后端 canonicalize；会话默认当前会话。需先打开项目。
- 覆盖优先级：会话 > 项目 > 全局。`enabled:null` 删除这一层覆盖，恢复继承；没有覆盖时沿用原 Pi 工具选择。首次覆盖前的原选择会单独保存，避免会话恢复的 loadout 污染“恢复默认”。
- true 可激活已注册的可选工具，不能安装不存在的工具或启动未配置的 MCP 服务。只读/子任务权限上限仍优先。
- false 同时更新模型声明与执行前守卫。已生成但尚未执行的调用、嵌套调用仍会被拒绝；已经开始的调用不会自动回滚或中止。
- 不写用户的 Pi 配置。覆盖保存在应用数据目录 `tool-settings.json`；运行时控制文件和原选择记录也留在应用数据目录。

```ts
const unsubscribe = window.pi.tools.onEvent(async (event) => {
  if (event.type === "tools_changed") {
    // event.conversationIds 是需要重新拉取的活动 runtime；先持久化，再发事件。
    const tools = await window.pi.tools.list(conversationId);
  }
});
```

`permissions.onEvent` 与 `tools.onEvent` 订阅同一 `pi:controls:event`；按 type 区分。重载后重新读取清单，不靠事件缓存推断状态。设置已保存但 Pi 声明刷新失败时 API 会报错；执行守卫已经按新设置生效，重开会话后恢复声明。

## 细粒度权限

```ts
await window.pi.permissions.upsert({
  id: "deny-env", scope: "global", action: "deny", tool: "read", path: "**/.env",
});
await window.pi.permissions.upsert({
  id: "allow-project-tests", scope: "project", project,
  action: "allow", tool: "bash", command: { type: "prefix", argv: ["npm", "test"] },
});
await window.pi.permissions.upsert({
  id: "confirm-mcp", scope: "conversation", conversationId,
  action: "ask", tool: "mcp__github__*",
});
const { rules, effective } = await window.pi.permissions.list(conversationId);
const decision = await window.pi.permissions.check({
  conversationId, toolName: "bash", input: { command: "npm test" },
}); // action: allow | ask | deny, reason, ruleId?, targets?
await window.pi.permissions.remove("allow-project-tests");
```

`rules` 是全部已保存规则；`effective` 是所选会话经过作用域筛选、继承和只读上限处理后的配置。upsert/remove 返回当前活动会话的 effective；管理其他会话时操作后再 list(目标会话)。check 仅预览授权决定，不执行工具，也不会产生批准记录。

判定顺序：工具停用/只读上限 → deny → ask → allow → 模式默认。较窄范围的 allow 不能覆盖全局 deny。规则热更新，每次工具调用重新读取；审批返回后再次检查停用/deny，防止旧弹窗批准越过新限制。

- tool 支持 `* / ?` 名称匹配，可按整个 MCP 服务前缀授权。
- path 只匹配结构化 `input.path`。支持项目相对或绝对路径，`*` 不跨目录，完整路径段 `**` 可以跨目录。按 Pi 的目标解析规则处理 `~`、`@`、file URL 等，并检查已有祖先的真实路径和符号链接。
- path 不分析 Bash 字符串内访问的文件，也不分析任意 MCP 私有参数。它不是 Shell 文件隔离或网络域名防火墙。
- command 支持 `{type:"exact",value:"npm test"}` 或 `{type:"prefix",argv:["npm","test"]}`。prefix 至少含可执行文件和一个参数，按参数边界匹配，不能用字符串前缀把 `npm test-malicious` 当成 `npm test`。
- 命令 allow 只适用于单个可解析的直接命令；管道、重定向、替换、包装器等不能借窄命令 allow 扩权。deny/ask 会检查复合命令并对不透明语法保守处理。
- ask：项目内内置读取默认放行，越出项目的读取需要确认；其他工具默认询问。安全的 TaskOutput/TaskList/TaskStop/WorktreeList 默认无需写操作审批。
- auto：除显式规则和上限外直接授权，**没有风险分类器**。acceptEdits：项目内 `edit/write` 自动允许，项目外写入与命令仍按规则询问。read：只允许读取和安全状态工具，不能通过 allow 规则提升为写模式。
- 人工在客户端提交的单条 Bash 已是用户指令，不再产生模型工具确认弹窗，但仍执行 deny/停用/只读限制。PTY 是独立的人机终端接口，不经过每条模型工具规则。

沿用 `pendingUI`、`respond`、`tasks.respond` 处理确认。“始终允许”可由前端创建明确的规则后再确认本次调用；不要把任何确认都保存成 `tool:*`。当前无独立 OS 沙箱；允许的 Shell、扩展和 MCP 仍使用其进程的系统权限。工具规则不承诺约束恶意本地扩展的任意进程代码。

## 模型主动委派

运行时直接向主模型注册下列工具，模型可主动选择；不依赖用户先点后台任务按钮。名字和前后台委派方式参考 Claude Code，但不是调用 Anthropic 的 Agent 工具服务，也不承诺其全部参数兼容。

| 工具 | 参数与结果 |
| --- | --- |
| Agent | `{description,prompt,subagent_type?,model?,run_in_background?,name?,isolation?,worktree_id?,executor?,fork?,mode?,team_name?}`，`subagent_type` 缺省为 general-purpose，`"fork"` 复制父会话分支上下文快照（与兼容参数 `fork: true` 等价）；`model` 为 `sonnet/opus/haiku/fable/inherit`；默认 Pi，也可选择本机 codex/claude/kimi/antigravity；`mode`、`team_name` 接收后忽略并在结果中提示 |
| AgentExecutors | `{}`，探测本机外部执行器与权限能力 |
| SendMessage | `{to,message,summary?,run_in_background?}`，按 agentId 或 `name` 继续本父会话自己的子 Agent（Pi 或外部）：运行中的直接送达，已结束/停止/中断的带完整历史开始下一轮，见下文“SendMessage 续聊” |
| AgentSend | `{task_id,message,run_in_background?}`，SendMessage 的兼容别名（`task_id` 即 `to`，默认前台）；仍可调用，但不再向模型声明 |
| TaskOutput | `{task_id,block?,timeout?}`，`task_id` 也可以是 `name`；timeout 毫秒，最多 60000，支持轮询或等待 |
| TaskStop | `{task_id}`，按 agentId 或 `name` 取消本父会话的子任务；找不到时报错并列出正在运行的子 Agent |
| TaskList | `{}`，列出本父会话创建的子任务；已结束且有统计的 Pi 子任务带 `name` 和 `usage {total_tokens,tool_uses,duration_ms}`，便于一次比较各子任务成本 |
| WorktreeCreate | `{base_ref?}`，在当前项目源仓库创建受管 Worktree |
| WorktreeList | `{}`，仅返回本父会话及其子任务拥有的 Worktree |
| WorktreeMerge | `{worktree_id}`，有保护的快进合并，不自动提交 |
| WorktreeRemove | `{worktree_id}`，保留有未合并提交的分支；脏/忽略文件阻止删除 |

Agent 的 `subagent_type`：`general-purpose / Explore / Plan`，或 `.pi/agents`、`.claude/agents` 中定义的自定义 Agent 名称（项目级定义需项目信任）。缺省为 general-purpose；未知名称报 `Agent type 'x' not found. Available agents: …`。除 `mode`、`team_name` 外的未知参数仍被拒绝；`isolation: "remote"` 明确报不支持。`name` 须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`，同一父会话中不能与仍在运行的子 Agent 重名。

模型选择优先级：调用参数 `model` > 定义中的 `model` > 父会话当前模型。调用参数中的别名在父会话可用模型中按名称匹配（同服务商优先），匹配不到直接报错，不静默回退；`inherit` 使用父会话模型。fork 忽略 `model`（结果中提示）。

前后台默认值：`run_in_background ?? 定义的 background ?? 设置 subagentDefaultBackground（默认 true）`，即 Agent 默认后台运行、立即返回。Explore/Plan/只读自定义 Agent 使用只读工具上限，默认共享项目读取；git 项目中 general-purpose 与可写自定义 Agent 默认 Git Worktree。非 git 项目中可写子 Agent 没有 Worktree，未显式指定后台时**默认改为前台**并共享项目目录写入：父会话阻塞在这次工具调用上（包括子 Agent 等待审批期间），不会与子 Agent 并发写同一目录；宿主为此豁免正在等待它的父会话对目录的占用。后台、共享、可写三者同时成立时拒绝并提示“请设 run_in_background:false，或在 git 仓库中用 worktree”。git 项目里共享目录的可写委派仍然拒绝（父会话一轮的 Git 恢复点会覆盖子 Agent 的修改）。显式 Worktree 引用必须属于本父会话。外部执行器（codex/claude/kimi/antigravity）的可写任务始终使用 Worktree，同样遵循后台默认值。外部执行器使用自己配置的模型、只能按 task_id 寻址：带 `model`（`inherit` 除外）或 `name` 的外部 Agent 调用直接报错，不静默丢弃；`mode`、`team_name` 同 Pi 子 Agent 一样忽略并在结果的 `warnings` 中提示。

同一条助手消息中的工具调用，只要没有 sequential 工具，Pi 会并行执行。父会话扩展在 `message_end` 记下每个 Agent 调用同批次中“可能改文件”的其它调用数（已注册、且不在 read/grep/find/ls、Task*/WorktreeList/AgentExecutors、Agent/SendMessage/AgentSend 之列的工具，如 write、edit、bash），随 `/invoke` 的 `batch: {writers}` 交给宿主（宿主校验：仅 Agent/SendMessage/AgentSend、非负整数、无多余字段）。续聊非 git 共享目录的可写子 Agent 时同样要求它是该消息中唯一会改文件的调用。非 git 项目中前台共享目录的可写子 Agent 必须是该消息中唯一会改文件的调用，否则拒绝并提示单独再调用一次 Agent；只读子 Agent、git 项目中的 Worktree 子 Agent 不受此限制。未上报批次（旧扩展）时不做此检查。

Agent 的工具结果是给模型读的文本，不再是 JSON：

- 后台启动：`Async agent launched successfully.` + `agentId: <id>`（有 `name` 时附上）+ Worktree 路径/分支 + “结果会自动以 <task-notification> 送达，不要轮询；用 TaskStop 取消”，排队中的任务注明 queued。
- 前台完成：经过注入转义的子 Agent 报告 + `agentId: <id>`（Explore/Plan 以外附 `use SendMessage with to: <id> to continue this agent`）+ Worktree 路径/分支 + `<usage>subagent_tokens: N\ntool_uses: N\nduration_ms: N</usage>`。maxTurns 截断、失败、停止各有一行前缀说明；没有输出时为 `(Subagent completed but returned no output.)`。
- 结构化结果（`DelegatedTaskResult`，含 `name`、`usage`、`warnings`）放在工具结果的 `details` 里，供界面使用，不进入模型上下文。
- 工具结果的 `usage` 填子 Agent 本轮的 token 增量，Pi 会把它计入父会话的 `get_session_stats`，但不影响父会话的上下文用量。子任务记录 `stats = {tokens{input,output,cacheRead,cacheWrite,total}, cost, toolUses, startedAt, durationMs, model}`，由子 Agent 每轮开始时的 `statsAtTurnStart` 与结束时的 `get_session_stats` 相减得到（fork 继承的历史不计入）。界面汇总全局成本时应排除子会话，避免重复计算。后台通知的 `<usage>` 使用同样的行格式。后台（含超时转后台的前台）子 Agent 的本轮用量随通知请求的 `usage {provider, model, usage}` 交给父会话扩展（Pi 进程内再次校验）；父会话确认收到该结果（追加 ack 条目）后，再用 Pi 会话管理器的 `appendUsage("subagent", …)` 追加一条 usage 条目，`get_session_stats` 会把它计入父会话。先 ack 后计数：极端情况下崩溃只会少计，不会因重放重复计数；排队到下一轮的结果在该轮开始取走时计数。扩展 API 只暴露只读会话视图，这里依赖锁定版本 Pi 会话管理器的 `appendUsage`，缺失时结果照常交付、只是不计数。

agent 清单与 system prompt：

- 宿主在每个父会话的工具控制目录原子写入 `agents.json`（最多 64 项，按名称排序，每项描述最多 1000 字符、合计约 60 Ki 字符，超出截断并注明），只包含当前信任状态下可见的定义：未信任项目不列出项目级 Agent。runtime 启动、用户每次发送消息前、AgentsDialog 保存/删除定义后都会重写；项目信任变化会重启 runtime，也随之更新。子会话不能再委派，写入空清单。
- 父会话扩展在 `before_agent_start` 中把列表写入 `event.systemPromptOptions.sections.agent_types`（结构化 system prompt 的一个命名段落），不返回 `systemPrompt`：返回它会让 Pi 把整段 prompt 强制替换为不透明文本，丢掉其它扩展在 `context_with_system` 中加入的段落（用户/项目记忆 `desktopProjectMemory`），并把工具说明冻结在本轮开头。同样的定义总是生成同样的文本，以保护 prompt 缓存；定义变化时 Pi 只下发该段落的增量。
- 定义正文（含内置 general-purpose/Explore/Plan 的原生风格 prompt：只读约束、汇报格式，Explore 支持 quick/medium/very thorough）、预加载 skills 和 memory 写入 `<dataDir>/agent-prompts/<taskId>.md`（0600），子进程以 `--append-system-prompt <file>` 追加到 system prompt，首条用户消息只放 `prompt` 本身。任务记录 `systemPromptFile`，加载 `desktop.json` 时校验它必须是 `agent-prompts/<该任务 id>.md`。显式 `--append-system-prompt` 会替代 Pi 自动发现的 `APPEND_SYSTEM.md`，宿主会把 Pi 本应发现的那个文件（信任项目的 `.pi/APPEND_SYSTEM.md` 优先，其次 Agent 目录的）一并传入。不替换 Pi 默认 system prompt。

默认情形下，子会话使用独立 Pi 进程与干净上下文；显式传入 `fork: true` 时可复制父会话当前已完成的上下文分支快照（不干扰父会话进程，末尾未完成的 `toolCall` 轮次会被自动裁剪）。创建时继承模型或自定义模型别名、思考强度、权限上限，并继续接收父任务后续收紧的规则/停用。Worktree 内绝对项目路径规则映射到对应工作区。子任务不能自行选择更高权限或再创建子 Agent。

前台 Agent 等待子任务结束；遇审批提前返回状态（非 git 共享目录的可写子 Agent 除外，见上），最多等待设置 `foregroundSubagentTimeoutMs`（默认 300000 毫秒，0 表示一直等待，上限 24 小时）。超时仍未结束的前台子任务转为后台交付（`runInBackground: true`），完成后像后台子任务一样回传。等待由宿主的任务更新事件唤醒，不再按 100 ms 轮询。父会话扩展调用宿主 `/invoke` 用 `node:http`（独立连接、无客户端超时），不用 `fetch()`：Pi 给全局 fetch 装的 dispatcher 按 `httpIdleTimeoutMs`（默认 5 分钟）限制响应头等待，超时会被宿主当成父会话断开而取消前台子 Agent。现在只有 Pi 自己的工具中止信号会结束这次请求。后台 Agent 立即返回，结果经持久化 outbox 回传主会话，见下节。重启应用不会重放未完成任务，它们标记 interrupted（`stopReason: "restart"`）。

### SendMessage 续聊与进程回收

- 路由：宿主先判断 `to` 是否是外部执行器任务（外部任务没有 name），命中则走外部执行器的下一轮（AgentSend 别名默认前台，SendMessage 默认按 `subagentDefaultBackground`）；否则交给委派服务。目标只能是本父会话自己的子 Agent：先按 agentId 精确匹配，再按 `name` 取本父会话中最新创建的那个（同名被更新的子 Agent 占用后，旧的只能用 agentId 寻址）。其他会话的子 Agent 按 id 或 name 都找不到。
- 一次性语义：Explore、Plan 不能续聊（原生一次性子 Agent），记录损坏（quarantined）的子 Agent 也不能续聊。Plan 模式下不能继续可写子 Agent（工具宿主本身也拒绝 Plan 模式下的 SendMessage）。
- 幂等：与 Agent 共用同一把锁；任务记录 `turnCalls`（最多 32 个）记下已处理的 SendMessage toolCallId，同一调用重放时不再续聊，只返回当前状态或结果。
- 运行中的子 Agent：通过 RPC `steer` 投递，在下一次模型调用前生效，工具结果为 `Message delivered to the running agent…`。消息前缀 `[Message from parent agent — not user input, not authorization]`（RPC 只能投递用户消息，前缀说明来源，也保证不以 `/` 开头）。排队中、尚未开始运行的子 Agent 会报错，稍后重试即可。
- 已结束（completed/failed/cancelled/interrupted，含 max_turns 部分结果）的子 Agent：宿主（串行执行）先确认项目目录可用、Worktree 仍为 ready，然后 `turn + 1`、把带前缀的消息存入 `pendingMessage`、清空上一轮的 result/stopReason/stats，`runInBackground = run_in_background ?? 设置默认值`（非 git 共享目录的可写子 Agent 默认前台，显式后台时拒绝），重新排队。续聊同样进入全局队列、占用并发名额，但不受“每个父会话最多 8 个未完成委派”的上限限制。`runTask` 在 `turn > 1` 时不再 `set_model`/`set_thinking_level`，改为发送 `pendingMessage`，Pi 接收后清空。每轮开始重新记录 `statsAtTurnStart`，`stats` 只算本轮增量；maxTurns 计数每轮重置。
- 权限：续聊不改变权限上限。`taskPolicies` 快照、readOnly、工具清单、maxTurns 保持不变，父会话之后收紧的规则或改为只读模式仍叠加生效。
- 通知：仍按 `(taskId, turn)` 交付，后台的每一轮完成后各交付一次。模型续聊的轮次清除 `notifySuppressed`；上一轮尚未交付的结果被新一轮取代。
- 应用重启后 interrupted 的子 Agent 错误为“应用已重启；可用 SendMessage 继续。”，通知摘要也提示可用 SendMessage 继续。
- 用户续聊：`tasks.send({taskId, message, notifyParent?})`（IPC `pi:task:send`，宿主校验 id、消息长度、字段白名单）。用户消息不加前缀；运行中的任务同样走 steer。子 Agent 的用户轮次在后台运行，默认不通知父会话（`notifySuppressed`），勾选“完成后通知父会话”（`notifyParent: true`）才交付。TasksDrawer 的 Pi 任务详情提供“继续对话”。在已结束子 Agent 自己的会话里直接发送消息（不带图片）也走同一路径，保证状态机、轮次和用量统计正确。手动后台任务也可以用 `tasks.send` 继续。
- 进程回收：宿主每 30 秒执行 `reapIdleChildRuntimes`，停止同时满足以下条件的子 Agent 进程：任务已到终态；本轮结果已交付或被抑制（或是前台任务）；没有待处理的审批；不是当前会话，也没有被界面查看（`pi:conversation:viewing`，TasksDrawer 打开详情时上报）；没有活动的子任务、外部子任务或终端；空闲已满 60 秒。空闲的已结束子进程超过 8 个时，按最近活动时间从旧到新回收，不等 60 秒。回收前等待 settling（含 SubagentStop hook），用 `stopRuntime(…, "capture")` 保存会话 leaf。之后续聊时 `ensureRuntime` 用 `--session` 和保存的 leaf 透明重启，并重新带上 `--append-system-prompt`。读取结果（TaskOutput、`tasks.result`）不会启动进程；`tasks.snapshot` 查看已回收的已结束子 Agent 时从会话存档读取，不启动进程。

### 后台结果交付（outbox）

- 任务记录带 `turn`（首轮为 1）、`notifiedTurn`、`notifySuppressed`，三者在 `desktop.json` 加载时校验。待交付条件：有父会话、`runInBackground`、已到终态、`notifiedTurn !== turn`、未被抑制。没有单独的通知表，交付内容在投递时按任务记录现场生成。升级前已结束的记录视为已交付，不会回放旧结果。
- 投递哪些：`completed`（含 `max_turns` 的部分结果）、`failed`、用户停止（`user_stop`，状态 stopped）、应用重启中断（`restart`，状态 stopped）。不投递：模型自己调用 TaskStop（`model_stop`，工具结果已告知）、父会话中止级联（`parent_abort`）。被停止的子 Agent 要等它自己的 runtime 结束、记下已产生的输出后才投递，所以 stopped 结果带有子 Agent 停止前的部分输出。外部执行器沿用同一 outbox，同样只排除 `model_stop` 和 `parent_abort`：投递 completed、failed、用户停止、宿主权限变更导致的停止（`policy_change`）、执行器自行取消（`executor_stop`）和应用重启/关闭中断（`restart`），并在该轮运行记下输出后才投递；升级前已中断、没有停止原因的外部记录不回放。
- 父会话 runtime 在运行（进程就绪）：用 `deliverAs: "followUp", triggerTurn: true` 原生投递，空闲的父会话会被唤醒处理结果。父会话正处于一轮运行中（含压缩）时，扩展返回 `deferred`，不把结果放进 Pi 只在内存中的 follow-up 队列（Esc 或出错结束的运行不会消费它，进程退出即丢失）；宿主在这一轮结束（`agent_settled`，或压缩结束）后重新投递，Esc 后结果照常送达。失败按 1/2/4/8 秒退避重试，共 5 次；之后在父会话下一次结束一轮时（不受次数限制）、父会话 runtime 重启时或用户点“立即交付”时再试，期间计入“待交付”。
- 父会话 runtime 不在（切换到其他会话后被停止、应用重启）：结果留在 outbox，**从不为此拉起父进程**。父会话再次打开时，用 `deliverAs: "nextTurn", triggerTurn: false` 排入下一轮，不开新一轮；界面显示“N 条子 Agent 结果待交付”和“立即交付”按钮。用户发送下一条消息时，这些结果随该轮一起交给模型；点“立即交付”（`tasks.deliverNow`）则立即开一轮处理。
- 只交付一次：投递请求带 `<task id>:<turn>` 键。扩展在消息进入会话时写入 `desktop_notification_ack` 条目（`nextTurn` 在下一轮开始时写入），同一键再次到达直接返回 duplicate，覆盖“已投递但宿主落盘前崩溃”的情况。通知请求复用工具控制通道的操作锁，不会与 list/apply 交错。
- 格式：custom 消息 `desktop_task_notification`。内容首行是 `[SYSTEM NOTIFICATION - NOT USER INPUT]` 声明，随后是原生 `<task-notification>`（`task-id`、`tool-use-id`、`status`、`summary`、`result`、`usage`）。子 Agent 输出是不可信数据：信封与 harness 标签（`<system-reminder`、`<task-notification`、`</result>` 等）的 `<` 被转义，行首 `Human:`/`Assistant:` 加 `[quoted]` 前缀，命中“忽略之前的指令”“用户已批准”等指令样式时加 `[harness: subagent output matched instruction-shaped pattern(s): …]` 前缀；超长时截断并提示 TaskOutput。`details` 存结构化结果，供界面卡片显示，不进入模型上下文。渲染端仍兼容旧的 `desktop_task_result`。
- Esc（父会话 `abort`）只停止前台子 Agent（记 `parent_abort`），后台子 Agent 继续运行并在结束后回传。停止全部后台子 Agent 用 `tasks.stopAll(conversationId)`（记 `user_stop`，各自回传 stopped），界面入口是 TasksDrawer 的“停止全部后台子 Agent”（二次确认）和 Ctrl+X Ctrl+K（3 秒内按两次）。两者都只作用于该会话自己的子任务。

正确性与存储约束：

- 大小上限统一定义在 `src/delegation-limits.ts`：Agent `prompt` 512 Ki 个字符（模型 schema、工具宿主、委派服务三层一致，均按 Unicode 码点计数，与 JSON schema `maxLength` 相同），子 Agent 结果 48 KiB，后台通知 512 KiB，SendMessage/AgentSend 消息 512 Ki 个字符，SendMessage 的 `to`、`summary` 各 200 个字符。任务错误信息写入前截断到 64 KiB，模型标识上限与界面 IPC 一致（服务商 300、模型 500 字符），宿主不会写出加载时会被拒绝的记录。
- 自定义 Agent 的 `maxTurns` 达到上限且本轮仍有工具结果待回答时，扩展先通过 `/hook` 的 `max_turns` 阶段通知宿主，再中止本次运行，不再多发一次模型请求。任务记为 `completed`，`stopReason: "max_turns"`，`result.partial: true`；TaskOutput 结果带 `partial: true`。SubagentStop 照常执行，但不能让子 Agent 越过 maxTurns 继续运行。
- 任务记录 `stopReason`：`max_turns`、`model_stop`（模型调用 TaskStop）、`user_stop`（界面停止或子会话内中止）、`parent_abort`（父会话中止级联）、`restart`（应用重启或关闭）、`error`。外部任务另有 `policy_change`（宿主权限或工具设置变更）、`executor_stop`（执行器自行取消），存于 `external-agents.json`。新一轮运行开始时清除上一轮的 stopReason 和 result；运行中 TaskOutput 返回实时输出，不带上一轮的 `partial`。TaskStop 在取消前读取实时输出，子 Agent 结束后记录的结果随后覆盖它。应用崩溃或强制退出后，重启时从子会话保存的记录中只读补回最终文本（`partial: true`），不启动子进程。
- TaskOutput / 前台等待读取结果没有副作用：终态任务只读持久化的 `task.result`，进行中的任务只从已运行的子进程读取最新文本，不会为读取结果而启动或唤醒子进程。子进程已退出时，结果从会话存档补写。
- `fork: true` 无法复制父会话记录（找不到或无法读取父会话文件、没有可继承的消息）时直接报 `Fork failed: …`，并清理已创建的子会话和新建的 Worktree，不再静默降级为全新上下文。
- `desktop.json` 中的任务逐字段校验：标识格式、状态枚举、工具名（不得含逗号等，最多 50 个）、maxTurns（1–200 整数）、delegationDepth、父会话必须存在且父链无环；未知字段丢弃。只用于显示的字段（标题、提示、错误、结果）超长时截断而不是丢弃整条记录，格式错误的模型选择回退为默认模型。安全相关字段无效时：普通任务被丢弃；子 Agent 记录（带父链、子 Agent 类型或权限记录）改为最小的隔离记录 `quarantined: true`，其会话固定为只读、不能再委派子 Agent、不会自动运行，父会话存在时保留父链，从而不会退化为不受限的根会话。两种情况都在 `engineError` 中提示，没有对应子任务的 `taskPolicies` 同时清理。

同父会话最多 8 个未完成委派；全局沿用后台队列默认最多 4 个运行任务。同一父会话和 toolCallId 重复请求不会创建两个子任务。中止父会话只取消它正在等待的前台子任务；后台子任务继续运行，需用“停止全部后台子 Agent”显式停止。取消一个子任务会级联取消它自己的全部子任务。停止和拒绝都不会撤销已经完成的文件写入。

Worktree 合并/删除作为顺序工具执行：只能豁免正在等待该工具的父任务自身占用，其他活动工具、子任务、人工终端仍阻止操作。合并还要求两端干净、原目标分支未变且可快进；失败返回 blocked，不会强制覆盖。Worktree 操作不会把主会话切换到新目录；隔离执行由 Agent 的 isolation 完成。

## 给前端 Agent 的卡片与面板约定

参考 Claude Code 的“聊天内委派卡片 + 可展开子任务详情 + 后台任务列表”，使用现有接口组织交互，不需要前端发起模型工具调用。

1. `window.pi.tasks.list()` 初始化。按 `parentConversationId` 归组，以 `parentToolCallId` 对齐聊天中 Agent 工具调用；不要按任务标题匹配。
2. 监听 `tasks.onEvent` 的 `task_updated`，按 task.id + revision 更新；后台监听应放在应用级，不能只保留当前聊天的事件。`task_notifications` 事件给出 `{conversationId, pending}`，即该会话待交付的结果数；初始值见 `Snapshot.pendingTaskNotifications`。
3. 卡片显示 subagentType、title、status、工作目录/Worktree、model、pendingUI 和结果来源；queued/running/waiting_for_input/completed/failed/cancelled/interrupted 都要有状态。不要在主聊天重复铺出全部子任务日志。
4. 打开详情用 `tasks.snapshot(id)`；工具流使用 `window.pi.onEvent` 按子 conversationId 路由，并和快照 eventSequence/liveTranscript 对齐。只读归档的项目目录可能已不存在，不能假定总能继续执行。
5. 审批用 `tasks.respond(id,response)`，附着在正确子任务。拒绝一次工具不等于停止整个任务；停止按钮用 `tasks.cancel(id)`。
6. 结果使用 `tasks.result(id,{block:false})`，返回 `task_id / conversation_id / parent_conversation_id / parent_tool_call_id / status / description / subagent_type / read_only / worktree_id? / working_directory / output / truncated / error? / pending_approvals`。摘要最多 48 Ki 字符，truncated=true 时详情看子会话；不要把空结果误判成成功。
7. 用已有 `tasks.workspace/diff` 审核子任务改动，用 `worktrees.merge/remove` 显式操作；不要在收到 completed 时自动合并或删除。合并返回 blocked 时呈现 reason。
8. `desktop_task_notification` 是后台结果通知，不是用户新输入；界面按 `details` 显示状态徽标、描述、Markdown 报告和用时，不显示原始 JSON。旧会话中的 `desktop_task_result` 仍按原样显示。
9. `tasks.stopAll(conversationId)` 返回 `{stopped}`；`tasks.deliverNow(conversationId)` 返回 `{pending}`（交付后仍未送达的数量）。两者在宿主端校验会话存在，只作用于该会话自己的子任务；子 Agent 会话不能调用 deliverNow。
10. `tasks.send({taskId, message, notifyParent?})` 返回 `{status: "resumed" | "delivered_to_running_agent", task}`；`tasks.viewing(conversationId, viewing)` 在打开/关闭子任务详情时上报，被查看的子 Agent 进程不会被回收。

类型入口：`src/shared.ts`、`src/control-types.ts`、`src/tool-control-types.ts`、`src/permission-types.ts`、`src/delegation-types.ts`。新增 IPC 安装在 `src/control-ipc.ts`，沿用主进程 sender/origin 校验。宿主令牌、随机控制命令、控制文件路径均不通过这些前端 API 暴露。

本机 Codex/Claude/Kimi/Antigravity 外部执行器已实现，参数、独立审批与事件流见 [本机多 Agent 接入](local-external-agents.md)。本节其余 Pi tasks/sessions 接口不用于外部任务；SSH 留待后续。
