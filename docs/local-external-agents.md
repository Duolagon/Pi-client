# 本机外部 Agent 接入契约

主 Pi 模型可以委派给本机 Codex、Claude Code、Kimi Code、Antigravity CLI（`agy`）及目录中的 ACP 执行器，也可以继续原生会话、收集结果或取消任务。前端通过 `executors()` 读取目录、安装状态和能力。

## 执行器与能力探测

```ts
const executors = await window.pi.externalAgents.executors();
// id: codex | claude | kimi | antigravity | acp-<目录 ID>
// enabled, available, executable?, version?, compatibility?, installCommand?, error?, capabilities
const checked = await window.pi.externalAgents.executors({ verifyCompatibility: true });

await window.pi.externalAgents.configure({ id: "kimi", executable: "/absolute/path/to/kimi", enabled: true });
await window.pi.externalAgents.configure({ id: "kimi", executable: null }); // 恢复自动探测
await window.pi.externalAgents.configure({ id: "codex", enabled: false });
```

默认查找 PATH、macOS 常见安装目录及 Codex 的已知应用内 CLI 路径，并以 `--version` 读取版本。发现有 10 秒缓存，configure 清除缓存。自定义路径接受本机的 CLI 可执行文件绝对路径。

「外部执行器」中的「检查兼容性」在空工作目录对 Codex 和 ACP CLI 发起初始化握手，并检查 Claude Code 的流式 CLI 选项。执行器卡片显示检测到的版本和具体错误。任务启动仍会校验权限、会话恢复和登录等条件。

随应用内置的 ACP 目录从官方注册表提取启动参数，目前包括 Auggie、Gemini CLI、GitHub Copilot、goose、OpenCode 和 Qwen Code。目录执行器安装后可在设置中主动启用，例如 `acp-qwen-code`。设置仅展示需要手动执行的安装命令。兼容性检查结果按本机执行文件路径和版本保存，已确认不兼容的版本无法启动任务。ACP 未提供会话恢复能力时，运行中排队的指令在同一进程内继续，进程关闭后需新建任务。运行时直接启动已安装的本机 CLI，所有目录执行器共用 ACP 适配器。 [ACP 注册表](https://github.com/agentclientprotocol/registry)

| 执行器 | 实际协议 | 审批语义 | 权限能力 |
| --- | --- | --- | --- |
| Codex | App Server JSONL / thread / turn | native，接住服务端发出的审批 | read-only/workspace-write 沙箱；不能逐工具落实任意 Pi 规则 |
| Claude Code | 固定 SDK core + 独立 helper | per-tool-hook，PreToolUse 与 canUseTool | 宿主逐工具判定、只读工具上限 |
| Kimi Code | 新版 ACP JSON-RPC | native，保留原生选项 ID 和问题表单 | 当前不提供可强制执行的只读与逐工具策略 |
| Antigravity CLI | `agy acp --disable-telemetry`，ACP v1 | native，宿主强制 `default` 手动模式并转发审批；agy 自身规则已允许/拒绝的操作不再询问 | 不提供只读模式和逐工具策略 |
| ACP 目录中的执行器 | 注册表提供的本机 stdio 启动参数，ACP v1 | 转发原生审批，原生规则可自行授权 | 可写任务使用 Worktree，细粒度禁用规则和 dontAsk 会阻止运行 |

capabilities 返回 transport、continuation、approvals、cancellation、readOnly、fineGrainedPolicy、approvalSemantics。前端应展示限制并禁用不可用组合；这些是本适配器的能力上限，握手仍可能因本机 CLI 过旧或不兼容而拒绝启动。

使用执行机器上各 CLI 自己的官方配置和认证。客户端不读取、复制或保存第三方 token，不提供第三方 claude.ai 登录入口。Claude SDK helper 调用所选本机 CLI，不分发 SDK 可选的 Claude 原生二进制。许可与认证边界见 [NOTICE](../NOTICE.md) 和 [调研](external-agents-research.md)。

## multi 编排档位

在会话下方的「编排档位」选择 `multi`，也可以输入 `/multi on`。在「设置 → 模型路由与评审」可为主会话选择主控模型及思考强度，为 Codex、Claude Code、Kimi Code 各自填写原生模型和思考强度。留空的选项沿用会话或对应 CLI 的设置。执行器仍需在「外部执行器」中启用，并完成本机 CLI 登录。

主控配置在 `multi` 轮次期间应用。单轮 `ultracode` 指令结束后会话回到 `multi`。从 `multi` 创建的外部任务在续写时沿用同一原生会话。任务单独填写的模型与强度优先，其余字段读取最新的执行器配置。能力和权限校验随每轮继续生效。

Kimi Code 通过 ACP 会话公布可选的模型和思考强度。旧版 CLI 可以沿用当前模型，切换模型或思考强度需要支持对应会话配置项的版本。

每轮可写任务完成后，检查点提供已跟踪和未跟踪文件的变更摘要，包含文件状态、行数和 Worktree。小差异随结果回传补丁，较大的差异保留文件及检查点引用。主控可通过 `TaskOutput` 查看摘要，并用 `WorktreeMerge` 显式合并已审查的改动。

## 主模型调用

主模型通过真正的 Pi 工具调用，而不是前端代替模型派活：

```json
{"tool":"AgentExecutors","input":{}}
{"tool":"Agent","input":{"executor":"codex","description":"修复解析器","prompt":"定位并修复解析错误，补充测试，报告变更。","subagent_type":"general-purpose","run_in_background":true}}
{"tool":"TaskOutput","input":{"task_id":"external-...","block":true,"timeout":60000}}
{"tool":"SendMessage","input":{"to":"external-...","message":"复核者发现空字符串边界，请继续修复并跑测试。","run_in_background":true}}
{"tool":"TaskStop","input":{"task_id":"external-..."}}
```

Agent 的 executor 支持 `pi / codex / claude / kimi / antigravity` 与目录中以 `acp-` 开头的 ID，省略仍为 Pi。AgentExecutors 返回本机可用性和限制；模型不能配置可执行文件。TaskList/TaskOutput/TaskStop 同时支持 Pi 与外部任务，外部结果带 executor 区分。SendMessage（兼容别名 AgentSend，`task_id` 即 `to`）先按 id 匹配外部任务，否则继续 Pi 子 Agent；不能给其他父会话的任务发消息。外部任务没有 name，只能按 task_id 寻址。

每个外部任务保留固定执行器、父会话、Worktree 和原生 session/thread ID。运行中使用 SendMessage 时，Codex 尝试 `turn/steer`，Claude Code 使用 Agent SDK 的现有输入流。ACP 和无法接受追加的执行器会把消息排到下一轮。同一任务的排队消息合并到下一轮，上一轮结果仍可交付。工具结果用 `delivery` 描述即时追加或排队状态。

新建外部任务时可以传 `model` 和 `effort` 覆盖该任务的默认值。设置传给执行器的原生接口。结果的 `usage` 包含能核实的本轮输入、输出、缓存 token 和美元费用。客户端按原生会话的累计统计计算差额。缺少供应方报告的费用会显示为空。

持续协作采用主 Agent 路由：主 Agent 可把 Claude 的复核结论发给原 Codex 任务，再让 Kimi 补测试。原生子执行器不会自行调用宿主的 SendMessage/AgentSend 或直接读取其他任务；完整父聊天也不会复制给它们。不同执行器的可写任务各用一个 Worktree，主 Agent 审核后显式整合成果，不自动同步未提交改动。

### 结构化结果

外部 `Agent` 和 `externalAgents.start` 接受可选的 `output_schema`。请传入 16 KiB 以内的内联 JSON Schema 对象，可用属性、类型和枚举等约束。引用和自定义正则表达式需改写为内联约束。客户端独立校验每次结果，校验通过的值通过 `structured_output` 返回给 `Agent`、`TaskOutput` 和后台完成通知。续写沿用启动时的 schema，结果大小最多 48 KiB。

Codex 使用 `turn/start.outputSchema`，Claude Code 使用 Agent SDK 的 `outputFormat`。ACP 执行器从提示词读取 schema，对首个无效结果在同一原生会话中重问一次。二次校验仍失败时，任务保留最后输出并报告错误。[Codex App Server](https://developers.openai.com/codex/app-server/) · [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

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

结果为 task_id、executor、parent_conversation_id、parent_tool_call_id、status、turn、native_session_id、worktree_id、working_directory、output、truncated、error、pending_approvals。可写任务的已结束轮次还会在可用时包含 changes。连续协作沿用同一 task.id，turn 递增。

## 审批、问题与取消

```ts
await window.pi.externalAgents.respond(task.id, pending.id, { decision: "allow", optionId: nativeOptionId });
await window.pi.externalAgents.respond(task.id, pending.id, { decision: "deny" });
await window.pi.externalAgents.respond(task.id, pending.id, {
  decision: "allow", answers: { questionId: ["chosen option"] },
});
```

decision 为 allow/deny/cancel。pendingApprovals 给出宿主审批 ID、kind、toolName、input、description、options。options 是原生 optionId/label/kind，不能在前端重新编造；questions 保留原生问题 ID 和表单。不要把问题自动回答为 allow。「本会话内允许」在客户端内存中保存这个任务的完全相同操作。客户端每次向执行器发送单次许可，并继续服从最新的宿主权限规则。

回应时再次检查当前宿主策略。撤销、原生超时、取消或进程退出会发 approval_resolved，旧回应被拒绝。审批期间子任务为 waiting_for_input，主 Pi 会话仍可工作。外部审批走 externalAgents.respond，不能传给原 Pi 的 respond 或 tasks.respond。

当前会话的外部请求显示在聊天内，其他会话的请求可从任务抽屉处理。审批数包含在 macOS Dock 角标中，应用失焦时使用系统通知。Claude、Codex 的问题列表和 ACP 支持的字符串或多选表单由客户端填写后按原生字段返回。

取消先走原生协议并等待终止，必要时结束受管进程组。停止父 Pi 会话也取消它的外部任务；不影响其他父会话或独立手动 Pi 后台任务。已完成的文件修改仍保留，取消不等于 Git 撤销。应用重启把活动任务标记 interrupted，不自动付费重跑；显式 send 才恢复会话并处理新指令。

## 权限边界

保存创建时权限上限，同时继续接收父会话收紧的规则。宿主在「接受编辑」模式下会直接允许符合策略的 Worktree 文件编辑，对转发到宿主且未匹配显式规则的 Shell 命令继续要求确认。结构化路径规则映射到对应 Worktree。父任务停用的工具不能通过继续外部会话恢复。

- Claude：每个 PreToolUse 都经过本地与宿主策略，Plan 与只读任务使用原生只读工具上限。问题单独交互。项目级及本地 Claude 设置仅在所属项目得到明确信任后加载，未决定及不信任时仅加载用户设置。旧 CLI 不支持原生 onFailure:block 时，helper 使用全面 catch→deny、短于原生 hook timeout 的审批期限、断管清理和进程组退出保护。
- Codex：强制并校验 untrusted/user 审批以及 read-only/workspace-write 沙箱。Plan 与只读任务使用 read-only 沙箱，并要求原生配置没有 MCP。原生安全操作可能无需发出审批，不能宣称和 Pi ask 模式逐次确认一致。
- Kimi：恢复后设置原生手动模式并验证确认，接收原生权限请求，不宣告客户端文件系统/终端能力。不能以 Plan 模式冒充真正只读。
- Antigravity：启动时固定开启 `--sandbox`，设置并锁定原生 `default` 手动模式，接收原生权限请求；agy 自身规则已允许的操作不经宿主审批（capabilities.approvalSemantics 为 `agent-rules`），因此拒绝 dontAsk 策略。
- Codex/Kimi/Antigravity：无法可靠执行的非宿主 deny/ask 规则或原生工具停用，会在启动时明确拒绝，不静默丢弃。仅 allow 规则允许使用原生更保守的审批。运行时修改宿主策略会停止缺少逐工具 hook 的活动任务，需显式继续。

外部进程继承客户端配置的代理、排除地址和 CA 环境变量，具体支持取决于执行器。已配置最低余额时，独立认证的外部账户无法由 Pi 核对，因此任务会明确停止启动。设置美元费用上限后，Claude 使用 SDK 的 USD 上限，其他执行器明确拒绝该组合。可并行子任务从父会话剩余额度分配预算。用量统计计入执行器实际报告的计数，Claude 费用按累计报告差额统计。SDK 费用为估算值，原生执行器没有报告的用量仍无法计入。

可写外部任务在自己的 Worktree 记录每轮恢复点。任务抽屉中的「查看检查点」可预览并按文件恢复。恢复仍检查文件是否在检查点后另有修改，并遵循父会话当前权限。

原生 CLI 的配置、插件、hooks 和 MCP 是各执行器自己的受信代码边界；Pi 的工具钩子不是它们的 OS 沙箱。宿主不会用全局跳过审批参数解决兼容问题。root/管理员进程及恶意本机扩展的任意系统访问不在此工具权限契约的隔离承诺内。

## 事件与界面接入

```ts
const unsubscribe = window.pi.externalAgents.onEvent((packet) => {
  // taskId / executor / parentConversationId / sequence / turn / timestamp / event
  // task_updated, session, text_delta, tool_start/update/end,
  // approval, approval_resolved, plan, usage, diagnostic
});
const replay = await window.pi.externalAgents.replay(task.id, lastSequence);
// events, latestSequence, truncated
```

沿用聊天内子任务卡片 + 后台任务面板的布局建议，加执行器标签与轮次。原生工具事件不伪装成 Pi 工具，按 taskId 展示在详情。宿主流式输出、工具结果和审批统一通过 pi:external:event，不能只订阅当前 Pi conversation 的流。

先订阅、再 snapshot/replay，用 envelope.sequence 去重，不把 revision 当作 token 序号。revision 表示状态转换，sequence 覆盖全部事件；task_updated 内嵌快照可能比其 envelope.sequence 早一个序号。重启会从事件日志恢复最大序号及原生 ID。每个任务最多保留 2000 个内存事件、约 4 MiB，磁盘日志约 8 MiB 后轮换；truncated=true 时提示历史截断，不把缺失日志当作从未执行。

输出摘要最多 48 Ki 字符，单事件大于 256 KiB 时省略为诊断提示。主模型回传、聊天卡片和任务面板用 taskId+turn 关联，避免重复追加结果。「任务与 Worktree」可选择执行器并回放任务时间线，包括原生工具、计划步骤和执行器已报告的用量。

## 差异与独立审查

任务详情展示从任务起点到当前检查点的累计差异，可按文件查看、应用到项目或丢弃 Worktree 中的改动。应用前会对照任务的基准版本检查每个目标，遇到冲突会列出文件。丢弃决定会随检查点保存，后续应用、审查和候选对比只使用剩余改动。原始轮次检查点保留历史。可把评审意见发送给同一原生会话。

`Agent({ description, review_of })` 可对当前父会话的外部任务启动独立只读审查。默认选择另一家支持只读的执行器。审查输入包含原始需求和从任务起点到当前检查点的差异，实现方的报告留在原任务中。

从已完成的可写任务主动开启「比较方案」，可选 2 或 3 个候选执行器，并按候选指定模型与强度。每个候选在独立 Worktree 处理同一原始需求。对比视图按各候选从任务开始到所选检查点的累计改动去重，合并相同的完整补丁，并保留各方案的失败和用量。

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
