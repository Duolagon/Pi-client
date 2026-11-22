# 本机外部 Agent 接入契约

本机 Codex、Claude Code、Kimi Code、Antigravity CLI（`agy`）已接入后端；主 Pi 模型可主动委派、继续原生会话、收集结果和取消。前端只通过 `executors()` 的数据展示执行器，没有为单个执行器写专门界面。SSH 和跨机器项目映射尚未实现。

## 执行器与能力探测

```ts
const executors = await window.pi.externalAgents.executors();
// id: codex | claude | kimi | antigravity
// enabled, available, executable?, version?, error?, capabilities

await window.pi.externalAgents.configure({ id: "kimi", executable: "/absolute/path/to/kimi", enabled: true });
await window.pi.externalAgents.configure({ id: "kimi", executable: null }); // 恢复自动探测
await window.pi.externalAgents.configure({ id: "codex", enabled: false });
```

默认查找 PATH、macOS 常见安装目录及 Codex 的已知应用内 CLI 路径；不通过 shell 拼接命令，只运行 `--version` 探测。发现有 10 秒缓存，configure 清除缓存。执行文件必须为本机可执行普通文件的绝对路径，不接受模型提供的路径、任意 args、env、网络 endpoint 或 SSH 目标。

available 表示能找到并运行版本探测，不表示账号已经登录或当前协议可用；实际启动还会握手并验证能力。没有 Kimi 时明确返回 unavailable，不会静默改用其他执行器，也不会自动安装 CLI。

| 执行器 | 实际协议 | 审批语义 | 权限能力 |
| --- | --- | --- | --- |
| Codex | App Server JSONL / thread / turn | native，接住服务端发出的审批 | read-only/workspace-write 沙箱；不能逐工具落实任意 Pi 规则 |
| Claude Code | 固定 SDK core + 独立 helper | per-tool-hook，PreToolUse 与 canUseTool | 宿主逐工具判定、只读工具上限 |
| Kimi Code | 新版 ACP JSON-RPC | native，保留原生选项 ID 和问题表单 | 当前不提供可强制执行的只读与逐工具策略 |
| Antigravity CLI | `agy acp --disable-telemetry`，ACP v1 | native，宿主强制 `default` 手动模式并转发审批；agy 自身规则已允许/拒绝的操作不再询问 | 不提供只读模式和逐工具策略 |

capabilities 返回 transport、continuation、approvals、cancellation、readOnly、fineGrainedPolicy、approvalSemantics。前端应展示限制并禁用不可用组合；这些是本适配器的能力上限，握手仍可能因本机 CLI 过旧或不兼容而拒绝启动。

使用执行机器上各 CLI 自己的官方配置和认证。客户端不读取、复制或保存第三方 token，不提供第三方 claude.ai 登录入口。Claude SDK helper 调用所选本机 CLI，不分发 SDK 可选的 Claude 原生二进制。许可与认证边界见 [NOTICE](../NOTICE.md) 和 [调研](external-agents-research.md)。

## 主模型调用

主模型通过真正的 Pi 工具调用，而不是前端代替模型派活：

```json
{"tool":"AgentExecutors","input":{}}
{"tool":"Agent","input":{"executor":"codex","description":"修复解析器","prompt":"定位并修复解析错误，补充测试，报告变更。","subagent_type":"general-purpose","run_in_background":true}}
{"tool":"TaskOutput","input":{"task_id":"external-...","block":true,"timeout":60000}}
{"tool":"SendMessage","input":{"to":"external-...","message":"复核者发现空字符串边界，请继续修复并跑测试。","run_in_background":true}}
{"tool":"TaskStop","input":{"task_id":"external-..."}}
```

Agent 的 executor 为 `pi / codex / claude / kimi / antigravity`，省略仍为 Pi。AgentExecutors 返回本机可用性和限制；模型不能配置可执行文件。TaskList/TaskOutput/TaskStop 同时支持 Pi 与外部任务，外部结果带 executor 区分。SendMessage（兼容别名 AgentSend，`task_id` 即 `to`）先按 id 匹配外部任务，否则继续 Pi 子 Agent；不能给其他父会话的任务发消息。外部任务没有 name，只能按 task_id 寻址。

每个外部任务保留固定执行器、父会话、Worktree 和原生 session/thread ID。SendMessage/AgentSend 是下一轮指令，必须等待上一轮终止；若只剩进程清理会等待清理完成，若上一轮仍在运行则明确报错。它不会把消息投给“此目录最近的一段聊天”。进程按需关闭，下一轮显式恢复同一原生会话，不重放上一条 prompt。

持续协作采用主 Agent 路由：主 Agent 可把 Claude 的复核结论发给原 Codex 任务，再让 Kimi 补测试。原生子执行器不会自行调用宿主的 SendMessage/AgentSend 或直接读取其他任务；完整父聊天也不会复制给它们。不同执行器的可写任务各用一个 Worktree，主 Agent 审核后显式整合成果，不自动同步未提交改动。

## 前端 API

```ts
const task = await window.pi.externalAgents.start({
  executor: "claude", conversationId,
  description: "复核模块", prompt: "检查模块并报告可以复现的问题。",
  subagent_type: "Explore", run_in_background: true,
});
const tasks = await window.pi.externalAgents.list(conversationId); // 不传返回全部外部任务
const snapshot = await window.pi.externalAgents.snapshot(task.id);
const result = await window.pi.externalAgents.result(task.id, { block: false });
await window.pi.externalAgents.send({ taskId: task.id, message: "根据发现继续检查调用方", runInBackground: true });
await window.pi.externalAgents.cancel(task.id);
```

start 的 subagent_type 可省略，默认 general-purpose。Explore/Plan 要求可强制执行的只读能力；Kimi 和 Antigravity 不支持此组合。可写任务必须用 Worktree，非 Git 目录不能启动可写任务；只读任务默认共享项目读取。可传 isolation 和已归属父会话的 worktree_id。项目由 conversationId 绑定，模型不能指定任意目录。

start/send 的前端 API 返回任务状态，不阻塞等待模型完成；result 支持 block 和 0–60000 毫秒等待。模型调用 Agent 时未传 run_in_background 则按设置 `subagentDefaultBackground`（默认 true）后台运行（外部可写任务总是使用 Worktree，不适用 Pi 在非 git 项目中的“可写默认前台”规则）；外部执行器不支持 fork 和 `isolation: "remote"`，结果仍为 JSON 结构。模型前台 Agent/SendMessage 最多等待 5 分钟（SendMessage 未传 run_in_background 时按 `subagentDefaultBackground` 默认后台，AgentSend 别名默认前台）；遇人工审批提前返回状态，继续完成后再回传。run_in_background/runInBackground 为 true 时，完成、失败或被停止（用户停止、宿主权限变更、执行器自行取消、应用重启/关闭中断）会在该轮记下输出后经宿主的持久化 outbox 以 `desktop_task_notification` 交给父 Pi 会话：父会话 runtime 在运行时立即投递并触发继续处理（父会话正在一轮运行中则等这一轮结束再投递）；父进程不可用时不自动重启它，结果留到父会话下次打开（排入下一轮，界面可“立即交付”）。每轮只交付一次，应用重启后仍会补交。模型 TaskStop 和父会话中止造成的取消不通知；父会话中止（Esc）只取消前台外部任务。

任务有 id、executor、parentConversationId、parentToolCallId、title、project、workingDirectory、worktreeId、subagentType、readOnly、status、revision、turn、eventSequence、nativeSessionId、output、truncated、error、pendingApprovals。外部 ID 以 external- 开头，不能交给 Pi 的 tasks.snapshot/sessions API。

结果为 task_id、executor、parent_conversation_id、parent_tool_call_id、status、turn、native_session_id、worktree_id、working_directory、output、truncated、error、pending_approvals。只返回有界结果摘要，不能把无 output 等同于成功。连续协作沿用同一 task.id，turn 递增。

## 审批、问题与取消

```ts
await window.pi.externalAgents.respond(task.id, pending.id, { decision: "allow", optionId: nativeOptionId });
await window.pi.externalAgents.respond(task.id, pending.id, { decision: "deny" });
await window.pi.externalAgents.respond(task.id, pending.id, {
  decision: "allow", answers: { questionId: ["chosen option"] },
});
```

decision 为 allow/deny/cancel。pendingApprovals 给出宿主审批 ID、kind、toolName、input、description、options。options 是原生 optionId/label/kind，不能在前端重新编造；questions 保留原生问题 ID 和表单。不要把问题自动回答为 allow。一次批准不保存成永久授权；如需规则，应显式使用 permissions API。

回应时再次检查当前宿主策略。撤销、原生超时、取消或进程退出会发 approval_resolved，旧回应被拒绝。审批期间子任务为 waiting_for_input，主 Pi 会话仍可工作。外部审批走 externalAgents.respond，不能传给原 Pi 的 respond 或 tasks.respond。

取消先走原生协议并等待终止，必要时结束受管进程组。停止父 Pi 会话也取消它的外部任务；不影响其他父会话或独立手动 Pi 后台任务。已完成的文件修改仍保留，取消不等于 Git 撤销。应用重启把活动任务标记 interrupted，不自动付费重跑；显式 send 才恢复会话并处理新指令。

## 权限边界

保存创建时权限上限，同时继续接收父会话收紧的规则。结构化路径规则映射到对应 Worktree；父任务停用的工具不能通过继续外部会话恢复。

- Claude：每个 PreToolUse 都经过本地与宿主策略，未知工具在只读模式下拒绝；问题单独交互。旧 CLI 不支持原生 onFailure:block 时，helper 使用全面 catch→deny、短于原生 hook timeout 的审批期限、断管清理和进程组退出保护。
- Codex：强制并校验 untrusted/user 审批以及 read-only/workspace-write 沙箱，拒绝提权；只读任务还要求原生配置没有 MCP。原生安全操作可能无需发出审批，不能宣称和 Pi ask 模式逐次确认一致。
- Kimi：恢复后设置原生手动模式并验证确认，接收原生权限请求，不宣告客户端文件系统/终端能力。不能以 Plan 模式冒充真正只读。
- Antigravity：启动时固定开启 `--sandbox`，设置并锁定原生 `default` 手动模式，接收原生权限请求；agy 自身规则已允许的操作不经宿主审批（capabilities.approvalSemantics 为 `agent-rules`），因此拒绝 dontAsk 策略。
- Codex/Kimi/Antigravity：无法可靠执行的非宿主 deny/ask 规则或原生工具停用，会在启动时明确拒绝，不静默丢弃。仅 allow 规则允许使用原生更保守的审批。运行时修改宿主策略会停止缺少逐工具 hook 的活动任务，需显式继续。

原生 CLI 的配置、插件、hooks 和 MCP 是各执行器自己的受信代码边界；Pi 的工具钩子不是它们的 OS 沙箱。宿主不会用全局跳过审批参数解决兼容问题。root/管理员进程及恶意本机扩展的任意系统访问不在此工具权限契约的隔离承诺内。

## 事件与界面接入

```ts
const unsubscribe = window.pi.externalAgents.onEvent((packet) => {
  // taskId / executor / parentConversationId / sequence / turn / timestamp / event
  // task_updated, session, text_delta, tool_start/update/end,
  // approval, approval_resolved, usage, diagnostic
});
const replay = await window.pi.externalAgents.replay(task.id, lastSequence);
// events, latestSequence, truncated
```

沿用聊天内子任务卡片 + 后台任务面板的布局建议，加执行器标签与轮次。原生工具事件不伪装成 Pi 工具，按 taskId 展示在详情。宿主流式输出、工具结果和审批统一通过 pi:external:event，不能只订阅当前 Pi conversation 的流。

先订阅、再 snapshot/replay，用 envelope.sequence 去重，不把 revision 当作 token 序号。revision 表示状态转换，sequence 覆盖全部事件；task_updated 内嵌快照可能比其 envelope.sequence 早一个序号。重启会从事件日志恢复最大序号及原生 ID。每个任务最多保留 2000 个内存事件、约 4 MiB，磁盘日志约 8 MiB 后轮换；truncated=true 时提示历史截断，不把缺失日志当作从未执行。

输出摘要最多 48 Ki 字符，单事件大于 256 KiB 时省略为诊断提示。主模型回传、聊天卡片和任务面板用 taskId+turn 关联，避免重复追加结果。新接口尚未在当前前端建立页面或专用审批卡片，前端 Agent 需要接入上述流与回应入口。

## 构建与验证

实现入口：external-agents.ts（调度/持久化）、external-executors.ts（本机探测）、external-codex.ts、external-claude.ts、external-claude-helper.ts、external-kimi.ts、external-rpc.ts（JSONL 传输）、external-ipc.ts（主进程接口）。类型见 src/external-types.ts，并由 shared.ts 导出。

SDK 固定版本与许可见 [UPSTREAM](../UPSTREAM.md)。构建将 JavaScript SDK core 打包进 runtime/external-claude-helper.mjs，附带许可文件，不把 node_modules 或个人 CLI 复制到客户端仓库。

回归使用隔离目录、本地协议进程和脚本化模型：原生适配器协议、审批/取消、真实 Pi 主动委派、真 Git Worktree、持续会话、重启、事件回放和 IPC 均有覆盖。本机 Codex/Claude 另外做无个人凭据、无模型 prompt 的真实握手；Kimi 在当前机器未安装，尚未做本机原生验收。未调用付费模型；完整账号与模型实际生成需用户通过官方 CLI 配好后验收。

外部执行器设置、原生 ID、任务与日志仅在应用数据目录 external-agents.json / external-events 中，不属于 Git 发布内容；桌面模型密钥、宿主控制令牌不会转发给外部执行器。

## Antigravity CLI

- 探测命令名 `agy`（PATH、`~/.local/bin` 等常见目录），也可在“外部执行器”里配置绝对路径。
- 启动参数固定为 `acp --sandbox --disable-telemetry`，不传 `--dangerously-skip-permissions`。客户端不读取、不保存 Google 凭据；agy 复用自己在钥匙串里的登录。
- 未登录时 agy 返回 `Authentication required`，任务启动失败并提示先运行 `agy` 或 `agy acp --login`。
- agy 1.5.14 的 ACP 会话提供 `default`、`accept-edits`、`auto`、`plan` 四种模式。宿主和 Kimi 一样强制 `default`，之后若 agy 切到其他非 plan 模式就中止任务；没有 `default` 模式时拒绝启动。`default` 模式下 agy 仍遵守 `~/.gemini/antigravity-cli/settings.json` 里的 `permissions` 规则，被规则直接允许的操作不会出现审批，因此父会话为 dontAsk 时拒绝启动。
- 只能运行可写任务（需要 Git 仓库和独立 Worktree），不能用于 Explore/Plan。
