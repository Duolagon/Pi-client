# External agent integration research

调研日期：2026-11-17。以下保留官方协议核对与设计依据。调研后已实现本机外部执行器，现有 Agent 可选择 Pi/Codex/Claude/Kimi，具体行为与限制以 [本机接入契约](local-external-agents.md) 为准；SSH 与跨机器协作尚未实现。调研与回归均不读取个人登录文件，不调用付费模型。

## Codex

桌面产品优先接入 `codex app-server --listen stdio://`，而不是驱动交互 TUI。官方 App Server 提供长期会话、增量输出、工具事件和双向审批。初始化后使用 thread/start、turn/start；保存 thread ID，用 thread/resume 恢复，turn/interrupt 取消当前轮；命令和文件修改的 requestApproval 需按原 request ID 回答。[App Server](https://developers.openai.com/codex/app-server/)

简单后台批处理可用 `codex exec --json`，但预设权限的作业接口不能代替完整桌面审批桥。TypeScript SDK 适合程序化启动和消费流；本项目要保留审批、继续对话与原生工具过程，第一版直接适配 App Server 更合适。[Non-interactive mode](https://developers.openai.com/codex/noninteractive/)、[Codex SDK](https://developers.openai.com/codex/sdk/)

本次本机只做了可执行文件探测、版本和 help 检查：Codex `0.169.0-alpha.11.1`、Claude Code `2.1.280` 可找到，`kimi / kimicode` 未在当前 PATH 找到。没有启动模型轮次，也没有读取登录文件或验证付费账号。GUI PATH 与其他服务器可能不同，此结果不能代表远端安装状态。Codex 的本机版本是 alpha，适配时必须按实际版本生成协议定义并做能力检查，不能依赖滚动官方文档的全部字段。

## Claude

### 推荐入口与调用能力

有完整双向交互需求时，优先使用官方 TypeScript Agent SDK。SDK运行 Claude Code binary，提供同一套工具循环、权限、会话和扩展能力；流式输入支持长期会话、追加消息、实时输出和中断。不是把 Claude 模型 API 当作已实现的 Claude Code Agent。[SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)、[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

已有 CLI 可以通过 `claude -p`、`--output-format stream-json`、`--verbose`、`--include-partial-messages` 输出逐行事件。子 Agent 的 `parent_tool_use_id` 可关联到发起调用；若需转发其文本，应核对版本是否支持 `--forward-subagent-text`。这适合可观测的非交互执行；不能仅凭输出是 JSON 就假定审批通道已打通。[CLI programmatic usage](https://code.claude.com/docs/en/headless)

### 审批、取消与会话恢复

`canUseTool` 可挂起工具授权及 `AskUserQuestion`，直到客户端返回决定；取消信号也应清理对应待审批项。某些工具会先被规则或模式允许，因而不会进入这个回调：若要实施统一宿主策略，必须同时核对 `PreToolUse` 与规则评估顺序。[Approval callbacks](https://code.claude.com/docs/en/agent-sdk/user-input)、[SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

流式输入可用 SDK `interrupt()` 中断。其取消回执能力随 CLI 版本协商；恢复时不要盲目重发已排队消息。CLI 的 SIGTERM 是终止进程，并不等于完成当前轮；适配器应先协议中断，再在超时后升级为进程终止。[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)、[CLI shutdown](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)

应保存明确的 session ID 并使用 `resume`。`continue` 会选择目录内最近会话，不适合多个并行子任务共享工作目录的路由。会话恢复恢复的是对话，不会自动恢复被修改的文件；文件恢复仍由宿主检查点负责。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

### 登录复用的边界

普通 CLI 与 API/SDK 产品认证要分别看待。官方 SDK 文档明确限制未经批准的第三方产品提供 claude.ai 登录或订阅额度；不能因为技术上可启动已登录 CLI，就宣称产品已经获得该授权。产品默认认证方案应按官方 API 方式设计，用户自有 CLI 模式须独立说明其适用范围。`--bare` 不读取 OAuth 或系统钥匙串，因此不能用它同时承诺复用订阅登录。[Authentication guidance](https://code.claude.com/docs/en/agent-sdk/overview#get-started)、[Bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

## Kimi Code

### 优先识别当前版本，避免误用旧 Wire

官方 `MoonshotAI/kimi-cli` 仓库现已归档，并引导迁移到 `MoonshotAI/kimi-code`。旧 Python CLI 的 `kimi --wire` 是 JSON-RPC 双向协议，有 `prompt`、`cancel`、审批/外部工具请求；只能作为旧版本兼容路线，不应成为新接入的默认协议。[Legacy repository](https://github.com/MoonshotAI/kimi-cli)、[Legacy Wire](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html)

当前版本优先使用 `kimi acp`：进程通过 stdin/stdout 交换 JSON-RPC，日志走 stderr，无启动 banner。`initialize` 返回实际版本和能力；工具卡片、模型选择及模式菜单应按协商结果呈现，不能硬编码文档某个版本的全部能力。[Current ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)

### 审批、取消、恢复与登录

当前 ACP 实现覆盖 `session/new`、`session/prompt`、`session/cancel`、`session/load`、`session/resume`、`session/list`、`session/fork` 与会话关闭等方法。`session/update` 传递文本、工具状态及计划；`session/request_permission` 用于审批和问题。`load` 会重放历史，`resume` 不重放，应区分事件重放和新增事件，防止界面重复。[ACP capabilities](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)

审批响应应保留服务端提供的 option ID 和取消结果，不能把所有问题压成一个布尔值。取消后仍应等待原请求的合法终止响应；连接丢失应标为未知/中断，不能当成执行成功。[ACP tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)、[ACP cancellation](https://agentclientprotocol.com/protocol/v1/cancellation)

官方 IDE 文档明确说明，ACP 子进程复用该机器现有认证状态；缺少认证时先在该机器完成官方登录。客户端无需读取、复制或上传其 token。macOS GUI 的 PATH 与终端可能不同，应保存经用户选择、探测到的可执行文件绝对路径。[IDE integration](https://moonshotai.github.io/kimi-code/en/guides/ides.html)

`kimi web` 也提供 REST/WebSocket Server API，支持会话和交互，但当前标记 Beta；若未来采用，必须绑定具体版本，并以该实例生成的 `/openapi.json` 与 `/asyncapi.json` 为准。首版无需为纯子进程协作额外启动并暴露 HTTP 服务。[Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html)

## 本机与 SSH 传输建议

以下为本项目的设计建议，并非声明已实现：

- 本机 Claude 用 SDK helper（完整审批）或受限 CLI 非交互适配器；Kimi 用 ACP。统一向宿主提供启动、事件、审批响应、中断、结果与恢复能力，同时保留执行器能力差异。
- SSH 连接优先使用无 PTY 的 stdio 通道，远端启动固定 helper 或 ACP 进程，协议 stdout 与诊断 stderr 分开。Claude helper 的 SDK 和 binary 都部署在远端；Kimi 直接在远端启动 `kimi acp`。远端使用远端登录及会话，避免搬运个人凭据。
- OpenSSH 会把远端命令参数拼接后交给远端执行；不能误把本地 `spawn(args)` 当作远端 argv 安全边界。应使用固定远端 helper，任务正文走协议 stdin；远端项目路径由配置映射并校验。[OpenSSH manual](https://man.openbsd.org/ssh)
- 不向远端 ACP 宣告由本机实现的文件或终端能力，除非确实实现了远端路径映射。服务器项目的读写、终端和 Worktree 必须在同一服务器执行。
- SSH 断开不等于远端任务已停止。需要远端监督进程、显式 task/session ID、恢复状态和幂等操作；取消先调用协议，再等待确认，最后按配置升级到终止远端受管进程。

## 接入验收建议

先用协议录制/本地假 Agent 测试流式拆包、重复事件、审批拒绝、审批取消、进程异常、会话重连和版本能力降级；再由用户在本机/服务器显式配置真实执行器完成验收。每个外部任务至少展示执行器、所在机器、项目/Worktree、状态、待审批数量及结果来源，避免将外部 Agent 的工具误显示为 Pi 原生工具。

## 本项目建议架构与协作方式

以下为调研时的整体方案；本机执行器与主 Agent 路由现已落地，SSH 分支仍是后续设计：

```text
Pi 主 Agent / 用户
        │ 统一的委派、结果、消息、停止接口
外部任务调度器 ── 主机与执行器注册表 ── 项目/Worktree 映射
        │
        ├─ Codex Adapter  ── App Server
        ├─ Claude Adapter ── Agent SDK helper
        └─ Kimi Adapter   ── ACP
                 │
        本机子进程 / SSH 远端受管 helper
```

执行器注册表记录用户选定的 executable、hostId、版本、能力、并发上限和可用状态，不保存第三方登录 token。内部统一 start、send、interrupt、respond、resume、events、result 接口，同时保留每家原始事件与会话 ID。外部任务 ID 与 native session/thread/turn ID 分开；不能把 Codex thread ID 当成 Pi conversation ID。

对主模型建议将 Agent 扩展为显式选择 `executorId / hostId / role / prompt / isolation`，由已注册白名单解析执行文件和项目路径；模型不能传任意 shell 命令或 SSH 目标。已有 Pi Agent 的参数保持兼容，现已加入 executor 字段及 AgentSend/AgentExecutors；hostId 等远程字段仍不支持。

协作不应只做三个一次性命令。第一层是主 Agent 同时委派、观察、收集结果；第二层增加持久会话的 send/resume，可让 Codex 修复、Claude 复核、Kimi 补测试，并由主 Agent 转发结构化问题和结论。先采用有界的星形消息路由，每条消息带 taskId、sender、recipient、序号和回复关联；多方互发是另一步，不要默认形成无限互调循环。

每个可写任务独占 Worktree，同一机器上的只读任务可共享项目。不同服务器的 Worktree 不是本机 Worktree：远程仓库由远端 helper 管理，成果通过显式 commit/patch 传递并审核，不能让本机 merge 接口接受远端绝对路径。对同一文件的冲突由主 Agent 审核后串行整合，不自动选任意一个结果覆盖。

Pi 自身的工具权限钩子无法拦截外部进程内部的 Bash/文件工具。必须通过各 adapter 下发可表达的限制、接住原生审批，再由宿主策略取交集；执行器无法表达的限制应报 unsupported 或使用 OS 隔离，不能仅靠 prompt 声称只读。禁止用全局跳过审批参数解决协议接入问题。

前端沿用本次新增的父子任务卡片模式，但需要增加 executor、host、原生会话跳转/继续、能力差异、待审批状态及结果来源。原始工具调用带 executor 前缀；外部流和 Pi 流分别归档，通过统一任务 ID 汇总，避免重复事件和 session ID 碰撞。

建议分两步实现：先完成本机三家 adapter、版本/安装探测、统一任务事件和审批，验证“主 Agent 派活 → 外部原生 Agent 执行 → 回传结果 → 继续协作”；随后增加 SSH 受管 worker、掉线恢复、远端项目与 Worktree、跨机器成果审核。本机执行协议、权限桥及持续协作现已实现；跨机器执行、远端项目与成果传递仍需后续开发。
