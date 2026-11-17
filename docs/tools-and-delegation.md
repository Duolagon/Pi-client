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
| Agent | `{description,prompt,subagent_type,executor?,run_in_background?,isolation?,worktree_id?}`，`subagent_type` 可为内置或自定义 Agent；默认 Pi，也可选择本机 codex/claude/kimi |
| AgentExecutors | `{}`，探测本机外部执行器与权限能力 |
| AgentSend | `{task_id,message,run_in_background?}`，继续属于本父会话的外部原生会话 |
| TaskOutput | `{task_id,block?,timeout?}`，timeout 毫秒，最多 60000，支持轮询或等待 |
| TaskStop | `{task_id}`，取消本父会话的子任务 |
| TaskList | `{}`，列出本父会话创建的子任务 |
| WorktreeCreate | `{base_ref?}`，在当前项目源仓库创建受管 Worktree |
| WorktreeList | `{}`，仅返回本父会话及其子任务拥有的 Worktree |
| WorktreeMerge | `{worktree_id}`，有保护的快进合并，不自动提交 |
| WorktreeRemove | `{worktree_id}`，保留有未合并提交的分支；脏/忽略文件阻止删除 |

Agent 的 `subagent_type`：`general-purpose / Explore / Plan`，或 `.pi/agents`、`.claude/agents` 中定义的自定义 Agent 名称（项目级定义需项目信任）。Explore/Plan/只读自定义 Agent 使用只读工具上限，默认共享项目读取；general-purpose 与可写自定义 Agent 默认 Git Worktree。无 Git 时可做只读探索；共享目录的可写委派会立即报错，避免父任务等子任务、子任务又等父任务释放目录。显式 Worktree 引用必须属于本父会话。

子会话使用独立 Pi 进程、独立上下文，只收到子任务 prompt 和正常 Pi 项目资源，不复制父聊天全文。继承父模型和思考级别、创建时权限上限，并继续接收父任务后续收紧的规则/停用。Worktree 内绝对项目路径规则映射到对应工作区。子任务不能自行选择更高权限或再创建子 Agent。

前台 Agent 等待子任务结束；遇审批提前返回状态，最多等待 5 分钟，之后用 TaskOutput 或后台通知接收结果。后台 Agent 立即返回，完成后用 `desktop_task_result` 自定义消息自动回传存活的主会话并触发继续处理。父会话已关闭/进程不可用时不自动重启它，结果仍可查询；重启应用不会重放未完成任务，它们标记 interrupted。

同父会话最多 8 个未完成委派；全局沿用后台队列默认最多 4 个运行任务。同一父会话和 toolCallId 重复请求不会创建两个子任务。显式停止父任务会取消它创建的模型子任务；主任务正常结束不会取消后台子任务。停止和拒绝都不会撤销已经完成的文件写入。

Worktree 合并/删除作为顺序工具执行：只能豁免正在等待该工具的父任务自身占用，其他活动工具、子任务、人工终端仍阻止操作。合并还要求两端干净、原目标分支未变且可快进；失败返回 blocked，不会强制覆盖。Worktree 操作不会把主会话切换到新目录；隔离执行由 Agent 的 isolation 完成。

## 给前端 Agent 的卡片与面板约定

参考 Claude Code 的“聊天内委派卡片 + 可展开子任务详情 + 后台任务列表”，使用现有接口组织交互，不需要前端发起模型工具调用。

1. `window.pi.tasks.list()` 初始化。按 `parentConversationId` 归组，以 `parentToolCallId` 对齐聊天中 Agent 工具调用；不要按任务标题匹配。
2. 监听 `tasks.onEvent` 的 `task_updated`，按 task.id + revision 更新；后台监听应放在应用级，不能只保留当前聊天的事件。
3. 卡片显示 subagentType、title、status、工作目录/Worktree、model、pendingUI 和结果来源；queued/running/waiting_for_input/completed/failed/cancelled/interrupted 都要有状态。不要在主聊天重复铺出全部子任务日志。
4. 打开详情用 `tasks.snapshot(id)`；工具流使用 `window.pi.onEvent` 按子 conversationId 路由，并和快照 eventSequence/liveTranscript 对齐。只读归档的项目目录可能已不存在，不能假定总能继续执行。
5. 审批用 `tasks.respond(id,response)`，附着在正确子任务。拒绝一次工具不等于停止整个任务；停止按钮用 `tasks.cancel(id)`。
6. 结果使用 `tasks.result(id,{block:false})`，返回 `task_id / conversation_id / parent_conversation_id / parent_tool_call_id / status / description / subagent_type / read_only / worktree_id? / working_directory / output / truncated / error? / pending_approvals`。摘要最多 48 Ki 字符，truncated=true 时详情看子会话；不要把空结果误判成成功。
7. 用已有 `tasks.workspace/diff` 审核子任务改动，用 `worktrees.merge/remove` 显式操作；不要在收到 completed 时自动合并或删除。合并返回 blocked 时呈现 reason。
8. `desktop_task_result` 是后台结果通知，不是用户新输入；主会话工具结果和任务卡片应该通过 task_id 去重。当前前端对 custom 消息的专用展示尚未实现。

类型入口：`src/shared.ts`、`src/control-types.ts`、`src/tool-control-types.ts`、`src/permission-types.ts`、`src/delegation-types.ts`。新增 IPC 安装在 `src/control-ipc.ts`，沿用主进程 sender/origin 校验。宿主令牌、随机控制命令、控制文件路径均不通过这些前端 API 暴露。

本机 Codex/Claude/Kimi 外部执行器已实现，参数、独立审批与事件流见 [本机多 Agent 接入](local-external-agents.md)。本节其余 Pi tasks/sessions 接口不用于外部任务；SSH 留待后续。
