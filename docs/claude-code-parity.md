# Pi Desktop 与 Claude Code 原生客户端差距分析

> 快照日期：2026-11-17
> 对比对象：Pi Desktop `0.1.0`（Pi 引擎 `1.5.2`） vs Claude Code `2.1.280`（本机 CLI）与官方 Desktop / IDE / Web 文档
> 结论口径：只比较“能力面”和“交互面”，不比较底层模型谁更聪明；服务依赖型能力单独标注。
> 2026-11-17 修复：已补工作区信任 UI 与 `--approve`/`--no-approve` 启动参数；`auto` 已改名为“跳过确认（危险）”并加常驻警告。第 3.4、4.1、4.2、4.8 节相关条目已部分关闭，其余仍是差距。
> 2026-11-18 第二阶段：新增 `acceptEdits`、自定义 Agent（`.claude/agents`、`.pi/agents`、工具白名单、模型/思考强度）与 MCP 服务器管理（用户/项目 `mcp.json`、stdio/HTTP、启停）。第 3.4、3.6、4.4、4.5、4.8 节的部分条目已关闭。
> 2026-11-18 第三阶段：新增 Claude 兼容声明式 Hooks 引擎与 `/hooks` 管理（`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `Notification`）、引擎级 `plan` 权限模式与 `ExitPlanMode`（`.pi/plans/<id>.md` + 放行 `WebFetch` 与 `Explore/Plan` 只读子 Agent）、`.claude/rules/*.md` 与 `@import` 分层记忆、`/context` 占用可视化与 `autoCompaction`/`autoRetry`/`/compact [指令]`、`AskUserQuestion` 结构化提问、`NotebookEdit`、`/btw` 侧问、`⌘F` 会话检索、`/skills` 创建管理、`.claude/settings.json` 规则导入/导出、桌面通知，以及设置中可选的 macOS `sandbox-exec`（Seatbelt）Bash 命令沙箱。

## 0. 一分钟结论

| 层面 | 判断 | 说明 |
| --- | --- | --- |
| 视觉与消息流 | **约 95%** | `>` 提示块、工具树、`⎿` 摘要、内联 Diff、Thought、Todo、结构化提问卡片、可编辑 Plan 审批条都已具备 |
| 日常本地编码 | **约 85%** | 读写、命令、Notebook、Hooks、权限规则导入导出、检查点、Git 分栏/暂存/提交、PTY、Worktree、自定义 Agent、MCP、`/context`、`/memory`/rules、引擎级 `plan` 与 macOS Bash 沙箱均已就绪 |
| 平台与生态 | **约 25%** | 仍不含需 Anthropic 云账号/外部扩展生态的功能（IDE/LSP 插件、官方插件市场、Chrome 浏览器操控、语音、云会话/Remote Control、企业托管策略、正式代码签名/自动更新） |
| 综合（15 个能力面简单平均） | **约 48%** | 详见第 2 节；这是排序用的主观评分，不是厂商基准 |

**最需要补的五件事**：OS 沙箱与安全边界、Hooks/插件扩展体系、记忆与上下文可视化、后台会话与系统通知、真正的 Plan 模式与项目规则共享。

**最不应该丢掉的三件事**：多模型/多协议接入、本机 Codex/Claude/Kimi 外部 Agent 协作、Git/Worktree/PTY/检查点组成的 GUI 工作台。

**一句话定位建议**：不要做“Claude Code 的逐条复刻”，做“本地优先、多模型、多 Agent 的图形工作台”；但配置文件格式尽量兼容 Claude Code，直接复用它的 Skills、Agents、Hooks 生态。

---

## 1. 基线、方法与边界

### 1.1 基线

- **原生客户端**：本机 `claude --version` 为 `2.1.280`。`claude --help` 已包含 `--bg`、`--cloud`、`--remote-control`、`--worktree`、`--from-pr`、`--teleport`、`--agents`、`--plugin-dir`、`--mcp-config`、`--permission-mode {acceptEdits, auto, bypassPermissions, manual, dontAsk, plan}`、`--effort`、`--fallback-model`、`--autocompact`、`--max-budget-usd`、`--json-schema`、`--output-format`、`--include-partial-messages`、`--safe-mode`、`--restricted`、`--ide`、`--chrome`、`--ax-screen-reader` 等选项。
- **原生能力参考**：Claude Code 官方文档的命令参考约 120 个条目（含别名、已移除和服务型命令），Hooks 参考列出 30+ 个事件，权限模式 6 种，平台覆盖 CLI、Desktop、VS Code、JetBrains、Web、Mobile。
- **客户端**：本仓库 `Pi Desktop 0.1.0`，Pi 引擎固定 `1.5.2`；见 [README](../README.md) 与 [UPSTREAM](../UPSTREAM.md)。
- **客户端文档**：后端契约见 [backend-api](backend-api.md)，工具与委派见 [tools-and-delegation](tools-and-delegation.md)，外部 Agent 见 [local-external-agents](local-external-agents.md)。

### 1.2 方法

- 阅读客户端源码与文档，逐项核对“界面是否可见、preload 是否暴露、后端是否实现”。
- 用本机 Claude Code CLI 的 `--help` 与官方 Markdown 文档核对原生能力。
- 对关键结论给出源码路径或文档链接；评分是作者按 15 个能力面做的主观 1–5 分评估。
- **未验证**：没有启动打包后的应用做端到端交互；没有调用真实模型；没有逐条执行原生 120 个命令；没有 Windows/Linux 实机；企业能力只按文档判断。

### 1.3 评分口径

| 分数 | 含义 |
| --- | --- |
| 5 | 对等或客户端更强 |
| 4 | 覆盖大部分，有细节差距 |
| 3 | 核心可用，但存在明显缺口 |
| 2 | 仅部分覆盖或接近原型 |
| 1 | 基本没有 |

---

## 2. 总览：15 个能力面

| 能力面 | 评分 | 判断 | 主要缺口 |
| --- | --- | --- | --- |
| 模型与接入 | 3 | 多服务商是优势，但缺 Claude 订阅登录与云厂商 | 无 OAuth 向导；Bedrock/Vertex/Azure 需手改 Pi 配置；无 fallback/advisor/fast |
| 核心工具 | 3 | 文件/命令/搜索扎实 | 无 WebSearch、LSP、NotebookEdit；提问不是结构化工具 |
| 上下文工程 | 3 | 有自动压缩与统计 | 无 `/context` 网格、缓存指标、压缩窗口、上下文窗口控制 |
| 权限/沙箱/信任 | 2 | 规则细，但没有安全边界 | 无 OS 沙箱、无工作区信任、auto 模式没有分类器 |
| 记忆/规则 | 2 | 能编辑根目录两个文件 | 无子目录按需加载、无 `.claude/rules`、无自动记忆、无 `@import` |
| 扩展体系 | 2 | Skills 可用，其余基本没有 | 无 Hooks、无插件市场、无自定义命令管理 |
| 子 Agent/编排 | 3 | 内置 + 自定义 Agent + 后台任务 | 无 fork 子 Agent、Agent Teams、Workflows、批量 Worktree |
| 会话生命周期 | 3 | 本地分支/克隆/导入很强 | 无后台挂起/接管、无云会话、无跨端共享、无 PR 会话 |
| 检查点/Git | 4 | Git 检查点与分栏 Diff 是强项 | 会话级 rewind 语义不如原生细；无评审/PR/CI |
| MCP/集成 | 2 | 只能看和开关工具 | 无服务器增删、OAuth、作用域、资源；无 IDE/Chrome/Slack |
| 界面/交互 | 4 | 视觉与消息流接近原生 | 无分栏工作区、侧问、会话内搜索、主题/键位定制、无障碍 |
| 后台/通知 | 2 | 有后台任务抽屉 | 无系统通知、无 attach/detach、重启即 interrupted |
| 分发/平台 | 2 | macOS 可打包 | 无签名/自动更新；Windows/Linux 未验收 |
| 企业/团队 | 1 | 基本没有 | 无托管策略、SSO、审计、网关 |
| 自动化/Headless | 1 | GUI 专用 | 无 `-p`/JSON/SDK；上游 Pi CLI 有，但不属于本客户端 |

**简单平均：36 / 75 = 2.4 / 5，约 48%。**
如果只看“界面对齐”，可以给到 80%；如果只看“平台/生态/企业”，大约只有 20%。

---

## 3. 能力矩阵

### 3.1 模型与接入

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 服务商 | Anthropic 一方；Bedrock、Vertex、Foundry、网关 | Anthropic、OpenAI、Google、OpenRouter、DeepSeek + 自定义协议与地址 | 客户端预设更“多模型”，但未暴露 Pi 的 Bedrock/Vertex/Azure 与企业网关 |
| 登录 | OAuth/订阅、API Key、SSO、`setup-token` | API Key；可复用已有 Pi OAuth 配置，但客户端内无 OAuth 向导 | 新用户上手路径弱 |
| 模型控制 | 模型、effort、fast mode、advisor、fallback、上下文窗口/自动压缩窗口 | 模型、思考强度、自动压缩（引擎默认，无 UI） | 缺 fallback、advisor、fast、上下文窗口控制 |
| 成本 | `/usage`、计划限额、credits | `/cost` 会话 token 与费用 | 多模型场景够用；无计划限额概念 |

证据：原生 `claude --help`；客户端 [provider-presets.ts](../src/provider-presets.ts)、[SettingsDialog.tsx](../src/renderer/SettingsDialog.tsx)、[README](../README.md) “模型配置”。

### 3.2 核心工具

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 文件读写 | Read/Write/Edit/Glob/Grep | read/write/edit/grep/find/ls | 基本对等 |
| Shell | Bash、PowerShell、后台命令、`!` Shell 模式 | bash、交互式 PTY、单次命令 | 缺提示框内 `!` 与后台 Bash 语义 |
| 网页 | WebFetch + WebSearch | 仅 WebFetch（客户端扩展） | 研究能力弱一档 |
| 代码智能 | LSP 工具、IDE 诊断、选择上下文 | 仅语法高亮 | 无诊断/跳转/符号 |
| Notebook | NotebookEdit | 无 | 数据科学场景缺口 |
| 提问 | AskUserQuestion 结构化多问题 | 通用 confirm/select/input/editor 对话框 | 能用，但不是同一工具语义 |
| 任务 | TodoWrite、TaskCreate/List/Get/Update/Output/Stop | TodoWrite（自定义）+ Agent/Task*/Worktree* | 接近，命名与参数不兼容 |
| MCP 工具 | 完整工具、资源、提示、OAuth | 工具列表与开关 | 只有“用”，没有“管” |

证据：Pi 内置工具见 [tool-control-extension.ts](../src/tool-control-extension.ts)；WebFetch/TodoWrite 见 [permission-extension.ts](../src/permission-extension.ts)；原生工具见 [tools-reference](https://code.claude.com/docs/en/tools-reference)。

### 3.3 上下文与记忆

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 自动压缩 | `/autocompact` 可调窗口，auto/100k–1M | Pi 引擎默认开启，客户端只有手动 `/compact` | 缺可见设置与触发提示 |
| 上下文可视化 | `/context` 彩色网格、优化建议、缓存字段 | `Ctx 7%` + `/status` 文本 | 缺可视化与优化建议 |
| 项目记忆 | CLAUDE.md 层级、`@import`、`.claude/rules`、自动记忆 | 界面只编辑根目录 `AGENTS.md` / `CLAUDE.md`；Pi 引擎会加载父目录上下文 | 无子目录按需加载、路径规则、自动记忆、`@import` |
| 压缩指令 | `/compact [instructions]` | `/compact` 无参数入口 | 小差距 |
| 分支摘要 | 原生支持 | Pi 分支摘要已接入 | 基本对等 |

证据：客户端 [backend.ts](../src/backend.ts) `readMemory` 只读根目录两个文件；原生见 [memory](https://code.claude.com/docs/en/memory)、[context-window](https://code.claude.com/docs/en/context-window)。

### 3.4 权限、沙箱与信任

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 权限模式 | `manual`、`acceptEdits`、`auto`、`bypassPermissions`、`dontAsk`、`plan` | `ask`、`acceptEdits`、`auto`、`read` | 缺真正的 plan、bypass/dontAsk 的显式语义 |
| 规则 | allow/ask/deny，工具/参数/路径/命令，项目 `.claude/settings.json` 可共享 | allow/ask/deny，工具/路径/命令，存应用数据 `tool-settings.json` | 规则能力强，但不可随仓库共享 |
| OS 沙箱 | macOS Seatbelt / Linux Bubblewrap，文件系统与网络隔离，凭据掩码 | **没有**；允许的命令、扩展、MCP 使用启动用户权限 | 最大安全差距 |
| 工作区信任 | 首次打开文件夹的 trust 对话框；受保护资源按信任加载 | 已有信任 UI；按决定传 `--approve`/`--no-approve`；未决定时显示横幅 | 剩余：项目配置共享、撤销粒度、批量信任 |
| 自动模式 | 分类器 + 沙箱 + 拒绝记录 | 已改名为“跳过确认（危险）”并加常驻警告；语义仍是除规则外全部放行 | 仍无风险分类器与沙箱 |
| 企业策略 | managed settings、组织策略、审计 | 无 | 企业不可用 |

证据：客户端 [permission-types.ts](../src/permission-types.ts) 只有三种模式；[permission-policy.ts](../src/permission-policy.ts) `auto` 直接 `allow`；[tool-settings.ts](../src/tool-settings.ts) 规则存应用数据；[tools-and-delegation](tools-and-delegation.md) 明确“当前无独立 OS 沙箱”。原生见 [permissions](https://code.claude.com/docs/en/permissions)、[sandboxing](https://code.claude.com/docs/en/sandboxing)。

### 3.5 扩展体系

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| Skills | SKILL.md、按需加载、`/skills` 管理、插件 Skills、`context: fork` | 能列出、搜索、调用；无创建/可见性/成本管理 | 能用，不能管 |
| Hooks | 30+ 事件，shell/HTTP/MCP/LLM/子 Agent，`/hooks` | 无声明式 Hooks；只有内部扩展和第三方 Pi 扩展 | 无法强制 lint/format/guardrail |
| 插件 | marketplace、`/plugin`、install/enable/disable、`--plugin-dir` | 无；Pi packages 机制未暴露 | 无生态 |
| 自定义命令 | `.claude/commands` + Skills 合并 | Pi prompt templates/commands 能读取，但无管理 UI | 能调用，不能运营 |
| 主题/键位 | `/theme`、`/keybindings`、`/vim` | 亮/暗/跟随系统；固定快捷键 | 个性化不足 |
| 包管理 | 插件市场 | Pi packages 有 CLI，客户端无 UI | 需离开客户端 |

证据：客户端 [LiveComposer.tsx](../src/renderer/LiveComposer.tsx) 13 个内置斜杠命令；[ControlsDialog.tsx](../src/renderer/ControlsDialog.tsx) 只有工具/MCP 开关。原生见 [hooks](https://code.claude.com/docs/en/hooks)、[plugins](https://code.claude.com/docs/en/plugins/overview)、[skills](https://code.claude.com/docs/en/skills)。

### 3.6 子 Agent 与并行编排

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 内置子 Agent | general-purpose、Explore、Plan，可自定义 | general-purpose、Explore、Plan + 自定义 Agent | 类型可扩展；缺 fork/Teams |
| 自定义 Agent | `.claude/agents`，每 Agent 可配模型、工具、Skills、Hooks、权限 | 支持 `.claude/agents`/`.pi/agents`、工具白名单、模型与思考强度 | 无 per-agent Hooks/权限、Agent Teams、fork 模式 |
| 后台子 Agent | 前台/后台、`/subtask`、fork 当前会话 | 后台任务、审批、结果回传 | 无 fork 子 Agent，子任务不继承父会话全文 |
| 并行编排 | Agent Teams、跨会话消息、`/batch` 5–30 个 worktree 子任务 | 后台任务 + Worktree，手动串行编排 | 复杂任务编排能力弱 |
| Workflows | Claude 写脚本、批量 fan-out、断点恢复 | 无 | 大规模审计/迁移场景缺 |
| Worktree | `--worktree`、`EnterWorktree`、`/batch` | 创建/合并/清理 UI + 模型工具 | 客户端体验更好，但缺批量编排 |

证据：客户端 [tools-and-delegation](tools-and-delegation.md)、[TasksDrawer.tsx](../src/renderer/TasksDrawer.tsx)、[model-delegation.ts](../src/model-delegation.ts)。原生见 [sub-agents](https://code.claude.com/docs/en/sub-agents)、[agent-teams](https://code.claude.com/docs/en/agent-teams)、[workflows](https://code.claude.com/docs/en/workflows)。

### 3.7 会话生命周期与后台运行

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 本地会话 | 新建、resume、rename、export、session picker | 侧栏、搜索、重命名、导出 HTML | 基本对等；搜索只匹配标题/项目 |
| 分支/克隆 | `/branch`、`/fork`、`--fork-session` | 会话树、fork、clone、navigate | 客户端可视化更强 |
| 后台挂起/接管 | `--bg`、`claude agents`、attach、logs、stop、rm、respawn | 后台任务抽屉；无“挂起当前会话再接管” | 缺会话级后台 |
| 并行前台会话 | Desktop 多会话、peek/reply、attach | 运行时禁用项目/会话切换；只能开后台任务 | 不能边跑边切 |
| 跨端共享 | CLI/Desktop/VS Code/Web/Mobile 共享会话与配置 | 会话在应用数据目录；导入 Pi CLI 历史是复制 | 不能无缝接力 |
| 云/远程 | `--cloud`、`--teleport`、Remote Control、Dispatch | 无 | 服务依赖，可暂不追 |
| PR 会话 | `--from-pr`、PR 状态 | 无 | 代码评审场景缺口 |
| 通知 | 会话完成通知、后台状态 | 无系统通知 | 长任务必须盯屏 |

证据：客户端 [backend-api](backend-api.md) 的会话/后台/PTY 章节；[main.tsx](../src/renderer/main.tsx) 的 `blocked` 在运行时禁用切换。原生见 [sessions](https://code.claude.com/docs/en/sessions)、[agent-view](https://code.claude.com/docs/en/agent-view)、[remote-control](https://code.claude.com/docs/en/remote-control)。

### 3.8 检查点、Git、评审与 PR

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 检查点 | `/rewind`，会话 + 代码；可 summarize；有限制（Bash 改动不追踪、子 Agent 改动不恢复） | Git 快照，按文件/全部恢复，冲突检测 | 代码回滚更细；会话级 rewind 语义不如原生 |
| Git UI | CLI 依赖 git；Desktop 有 Diff 视图 | 文件面板、暂存/取消暂存/放弃/提交、Unified/Split Diff | 客户端更强 |
| 代码评审 | `/code-review`、`/security-review`、`/simplify`、ultrareview | 无 | 缺质量工作流 |
| PR/CI | `gh`、`--from-pr`、`/autofix-pr`、PR 状态、GitHub Actions/GitLab | 无 | 缺团队协作闭环 |

证据：客户端 [WorkspacePanel.tsx](../src/renderer/WorkspacePanel.tsx)、[CheckpointsDialog.tsx](../src/renderer/CheckpointsDialog.tsx)、[git-snapshots.ts](../src/git-snapshots.ts)。原生见 [checkpointing](https://code.claude.com/docs/en/checkpointing)、[code-review-local](https://code.claude.com/docs/en/code-review-local)。

### 3.9 界面与交互

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 消息流 | `>` 提示块、工具树、`⎿` 摘要、内联 Diff | 已对齐，且 Thoughts/Todo/Plan 条完整 | 基本对等 |
| 工作区 | Desktop 可拖拽分栏：Chat/Diff/Browser/Terminal/Editor | 固定侧栏 + 检查器 + 终端抽屉 | 缺可拖拽多面板 |
| 侧问 | `/btw` 不污染主会话 | 无 | 缺 |
| 会话内搜索 | 有 | 只能搜会话标题/项目 | 缺 |
| 主题/键位 | 多主题、自定义键位、Vim | 3 种主题、固定键位、无 Vim | 缺 |
| 无障碍 | CLI `--ax-screen-reader`、色盲友好主题 | 有 aria 标签，但无专门模式 | 缺 |
| 多面板布局 | Desktop 可拖拽分栏、多会话 | 单窗口固定布局 | 缺 |

证据：客户端 [TranscriptView.tsx](../src/renderer/TranscriptView.tsx)、[CommandPalette.tsx](../src/renderer/CommandPalette.tsx)；原生见 [desktop](https://code.claude.com/docs/en/desktop)、[interactive-mode](https://code.claude.com/docs/en/interactive-mode)。

### 3.10 平台与集成

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| IDE | VS Code、JetBrains、`--ide`、`/ide` | 无 | 缺编辑器内的 selection/diff/diagnostics |
| 浏览器 | Chrome 集成、`--chrome`、`/chrome` | 仅 localhost iframe 预览 | 缺真实浏览器控制 |
| 桌面控制 | computer use（macOS） | 无 | 缺 |
| 语音 | `/voice` | 无 | 缺 |
| SSH | Desktop SSH 环境、CLI 天然支持 | 明确未实现 | 缺 |
| CI/Slack | GitHub Actions、GitLab、Slack、Code Review | 无 | 服务型，暂不追 |

证据：客户端 [PreviewPanel.tsx](../src/renderer/PreviewPanel.tsx)、[README](../README.md) 限制章节。原生见 [platforms](https://code.claude.com/docs/en/platforms)。

### 3.11 分发、平台与企业

| 能力 | Claude Code 原生 | Pi Desktop | 差距 |
| --- | --- | --- | --- |
| 签名/公证 | 有 | `identity: null`，未签名 | Gatekeeper 警告 |
| 自动更新 | 有，`claude update` | 无 | 手动更新 |
| 跨平台 | macOS/Windows/Linux | macOS 优先；Linux 未实机；Windows ConPTY 未实现 | 覆盖面不足 |
| 企业 | managed settings、SSO、审计、网关、策略 | 无 | 企业不可用 |
| Headless/SDK | `-p`、JSON、stream-json、SDK | 无（上游 Pi CLI 有） | 自动化缺口 |

证据：客户端 [desktop-builder.json](../desktop-builder.json)、[package.json](../package.json)、[backend-api](backend-api.md) 终端章节。原生见 [setup](https://code.claude.com/docs/en/setup)、[headless](https://code.claude.com/docs/en/headless)。

---

## 4. 九个关键差距

### 4.1 安全边界：沙箱、信任与 auto 模式（P0）

**原生**：权限规则只是第一层；第二层是 OS 沙箱（macOS Seatbelt、Linux Bubblewrap），限制文件系统与网络，并可掩码凭据；第三层是工作区信任与托管策略。`auto` 模式有分类器和拒绝记录，`bypassPermissions` 是显式危险选项。

**客户端**：规则系统很细（工具/路径/命令/作用域），但没有任何 OS 级边界。`docs/tools-and-delegation.md` 明确“当前无独立 OS 沙箱”。`auto` 模式在 [permission-policy.ts](../src/permission-policy.ts) 里直接 `allow`，没有风险分类器；本次已改名为“跳过确认（危险）”并加常驻警告，但语义仍接近原生的 `bypassPermissions`，而不是原生的 `auto`。

**影响**：提示注入、恶意 MCP、误执行的 `rm`/`curl` 都能以启动用户权限运行。本次已用“跳过确认（危险）”命名与常驻警告降低误解，但安全边界仍未建立。

**建议**：
1. ~~增加工作区信任对话框~~（本次已完成基础版：资源清单、信任 UI、RPC 显式决定、重启生效）。
2. 为 bash/PTY 增加 macOS Seatbelt 包装（后续 Linux Bubblewrap），至少提供“沙箱内执行”开关与网络允许列表。
3. ~~把 `auto` 改名~~（本次已完成）；下一步增加分类器，并在 UI 上持续显示“未沙箱”状态。
4. 把权限规则从应用数据迁移到可共享的项目配置，或提供导入/导出。

**归属**：客户端 + Pi 引擎；工作量 L（macOS 先做，跨平台更大）。

### 4.2 工作区信任与项目级配置（P0，已修复基础版）

**原生**：首次打开项目会弹 trust 对话框；批准后才加载 `.claude/settings.json`、hooks、MCP、Skills、插件；拒绝则只加载安全内容。

**客户端（修复前）**：没有 trust UI，也没有在启动主 RPC 时传 `--approve`（[backend.ts](../src/backend.ts) 的 `args` 只传 session、extension、model）。Pi 文档明确：Print/JSON/RPC 模式无法弹 trust 提示；默认 `defaultProjectTrust: "ask"` 时，项目级受保护资源会被**跳过**（除非用户已在 `trust.json` 保存决定，或全局设为 `always`）。

**本次修复**：新增 `src/project-trust.ts` 检测受保护资源；`Snapshot.trust` 暴露 `required / resources / decision`；打开项目时显示横幅与“项目配置与信任”对话框；`setProjectTrust` 保存决定并重启相关会话；启动参数按决定传 `--approve` 或 `--no-approve`。测试见 [project-trust.test.ts](../test/project-trust.test.ts)。剩余：信任撤销粒度、批量/父目录信任、信任变更审计。

**影响（修复前）**：项目 `.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts` 可能完全不生效；用户会以为“客户端不支持项目配置”。这是一个不会报错、很难排查的坑。

**后续建议**：把 trust 作为打开项目的第一步（目前已用横幅提示）；继续支持信任撤销、批量信任与父目录资源展示；对未信任项目保留明显状态。

**归属**：客户端；工作量 S–M。

### 4.3 Hooks、插件与自定义命令（P1）

**原生**：30+ 个 Hook 事件（PreToolUse、PostToolUse、SessionStart、Stop、UserPromptSubmit、Notification、SubagentStop、PreCompact 等），支持 shell/HTTP/MCP/LLM/子 Agent handler；`/hooks` 可查看与管理；插件市场提供可分享的 Skills、Agents、Hooks、MCP 配置。

**客户端**：没有声明式 Hooks，也没有插件/市场/命令管理。只有内部扩展（权限、导航、工具控制）和用户已安装的 Pi 扩展。Skills 能列出和调用，但不能创建、隐藏、查看上下文成本。

**影响**：无法强制“每次编辑后跑 lint/format”“禁止改 .env”“会话结束发通知”这类确定性规则；团队工作流无法打包分享；生态无法生长。

**建议**：先实现 Claude 兼容的 Hooks 子集（PreToolUse、PostToolUse、SessionStart、Stop、UserPromptSubmit、Notification），读取 `.claude/settings.json` 与 Pi 配置；再做 `/hooks` UI；最后做插件/包管理器。**格式兼容优先于功能数量**，这样用户可以直接把 Claude Code 的配置带过来。

**归属**：客户端 + Pi 引擎；工作量 M–L。

### 4.4 自定义 Agent 与编排（P1）

**原生**：`.claude/agents` 可定义每个子 Agent 的说明、系统提示、模型、effort、工具、Skills、Hooks、权限；支持前台/后台、fork 当前会话、Agent Teams、跨会话消息、`/batch` 批量 worktree 子任务、Workflows 脚本编排。

**客户端**：已有 `general-purpose / Explore / Plan` 与 `.claude/agents`、`.pi/agents` 自定义定义；支持 per-agent 工具白名单、模型、思考强度和提示词，子 Agent 使用独立 Pi 进程、独立上下文、后台、审批、结果回传、Worktree。仍没有 fork 当前会话为子 Agent、Agent Teams、Workflows 与 `/batch` 式批量 Worktree 编排。

**影响（基础版已缓解）**：已能沉淀评审员/调试员等角色；但仍不能把当前会话 fork 成子 Agent，也没有 Agent Teams/Workflows 的自动编排。

**后续建议**：~~解析 `.claude/agents`/`.pi/agents` 并加管理 UI~~（已完成）；继续补 per-agent Hooks/权限、fork 子 Agent、`/batch` 式批量 Worktree、Teams/Workflows。

**归属**：客户端为主；工作量 M–L。

### 4.5 MCP 全生命周期（P1）

**原生**：`claude mcp add/list/get/login/logout/remove/serve`；`.mcp.json` 项目作用域；OAuth 登录与 token 刷新；资源与提示；`/mcp` 交互管理；健康检查与失败重连。

**客户端**：已支持用户 `~/.pi/agent/mcp.json` 与项目 `.pi/mcp.json` 的服务器增删、启停、stdio/HTTP、描述与项目覆盖；保存后重启项目会话。仍没有应用内 OAuth 登录、连接健康状态、资源/提示浏览与工具暴露管理；项目级 MCP 仍受信任门控。

**影响（基础版已缓解）**：普通 stdio/HTTP 服务器可在客户端增删启停；OAuth 型 MCP 仍需离开客户端执行 `pi mcp login`；项目级 MCP 仍受信任门控。

**后续建议**：~~MCP 管理页~~（基础版已完成）；继续补应用内 OAuth、连接健康状态、资源/提示浏览、工具暴露管理与 `.mcp.json` 兼容。

**归属**：客户端；工作量 M。

### 4.6 记忆与上下文可视化（P1）

**原生**：CLAUDE.md 层级发现、`@import`、`.claude/rules` 路径规则、自动记忆；`/context` 网格与优化建议；`/autocompact` 窗口；缓存命中率；`/compact [instructions]`。

**客户端**：界面只能编辑项目根 `AGENTS.md` / `CLAUDE.md`（[backend.ts](../src/backend.ts) `readMemory`）；Pi 引擎会加载父目录上下文，但没有子目录按需加载、`.claude/rules`、自动记忆或 `@import`；`/compact` 无参数；`Ctx 7%` 只有百分比；没有 context 网格或缓存指标。

**影响**：长会话容易爆上下文；子目录规范、语言规则、个人偏好无法分层加载；用户不知道上下文被什么占满。

**建议**：实现层级记忆发现（根 → 子目录 → `.claude/rules`）与 `@import`；增加自动记忆写入路径；做 `/context` 面板（按工具/文件/记忆/系统提示分项）；把自动压缩窗口和触发提示暴露出来；显示缓存命中率。

**归属**：客户端 + Pi 引擎；工作量 M。

### 4.7 后台会话、并行与通知（P1）

**原生**：`--bg` 把当前会话挂到后台；`claude agents` 查看/attach/logs/stop/rm/respawn；Desktop 多会话并行、peek/reply；完成通知；PR 状态；重启后可恢复。

**客户端**：后台任务是独立会话（[TasksDrawer.tsx](../src/renderer/TasksDrawer.tsx)），支持审批、停止、Worktree、外部 Agent 续写；但前台会话运行时禁用项目/会话切换（[main.tsx](../src/renderer/main.tsx) 的 `blocked`），没有“挂起当前会话/接管后台会话”，重启把未完成任务标为 `interrupted`，没有系统通知。

**影响**：长任务必须占用前台；不能边跑边看另一个会话；离开电脑就不知道任务是否完成。

**建议**：增加会话级后台/接管、持久化 supervisor、系统通知（完成/待审批/失败）、运行中切换会话、任务列表的 peek/reply；把“后台任务”从工具面板提升为一级视图。

**归属**：客户端 + 后台进程管理；工作量 L。

### 4.8 权限模式与规则共享（P1）

**原生**：6 种模式，尤其 `acceptEdits`（自动接受编辑、命令仍询问）是日常效率关键；`plan` 是引擎级权限模式；规则写在 `.claude/settings.json`，可随仓库共享；`dontAsk`/`bypassPermissions` 有明确语义。

**客户端**：已有 `ask/acceptEdits/auto/read`；`acceptEdits` 只自动允许项目内 `edit/write`，命令仍按规则询问；`plan` 仍是 UI 约定（切只读 + 填提示词 + 最后一条消息后显示审批条，见 [main.tsx](../src/renderer/main.tsx)），不是引擎级模式，也没有计划文件、计划编辑与工具级 `ExitPlanMode` 审批。而且只读判定只放行 `read/grep/find/ls` 与少量任务工具，`WebFetch` 与 `Agent` 会被拒绝，计划阶段查文档/派探索子 Agent 会受限。规则存应用数据（[tool-settings.ts](../src/tool-settings.ts)），团队无法共享。

**影响**：日常编辑摩擦大；Plan 模式容易被误用为“只读模式”；团队策略无法版本化。

**建议**：~~增加 `acceptEdits`~~（已完成）；把 `plan` 做成真正的权限模式（只读工具集 + 计划产物 + 审批后切换）；项目规则写入 `.pi/settings.json` 或 `.claude/settings.json`，支持导入/导出/继承。

**归属**：客户端 + Pi 引擎；工作量 S–M。

### 4.9 分发工程（P0，面向发布）

**原生**：签名/公证安装包、自动更新、`claude doctor`、macOS/Windows/Linux 原生安装器。

**客户端**：`desktop-builder.json` 的 `identity: null`；没有 autoUpdater；README 明确“正式代码签名和自动更新尚未实现”；macOS 优先，Linux 未实机，Windows ConPTY 未实现。

**影响**：Gatekeeper 警告、手动更新、跨平台采用受限；这会直接卡住外部用户。

**建议**：签名/公证、electron-updater、CI 发布流水线、崩溃/日志上报、Windows/Linux 验收（至少 WSL/Linux 先跑通）。这不是“功能差距”，但是“能不能交付”的差距。

**归属**：发布工程；工作量 M。

---

## 5. 客户端相对优势

这些是 Claude Code 原生客户端没有或不如客户端的地方，建议在路线图中保留并放大：

1. **多模型、多协议**：Anthropic、OpenAI、Google、OpenRouter、DeepSeek + 自定义 base URL/协议；适合按任务选模型、成本优化、避免单一供应商锁定。见 [provider-presets.ts](../src/provider-presets.ts)。
2. **本机外部 Agent 协作**：主 Pi 模型可主动委派 Codex、Claude Code、Kimi Code，保留原生会话、审批、续写、取消；Claude Code 原生不具备“调用 Codex/Kimi”的能力。见 [local-external-agents](local-external-agents.md)。
3. **GUI 工作台**：文件树、分栏 Diff、暂存/提交、交互 PTY、Worktree 合并/清理、会话树可视化、HTML 导出；这些比纯终端更直观。
4. **Git 检查点按文件恢复**：带冲突检测、整批预检、失败部分恢复；比“整段回滚”更细。见 [backend-api](backend-api.md) 检查点章节。
5. **密钥隔离**：API Key 用 Electron `safeStorage` 加密，不返回渲染进程，不放在启动参数；比明文配置文件好。见 [README](../README.md)。
6. **本地优先与中文界面**：不依赖云、无强制账号、中文交互；对中文用户和隐私敏感场景有吸引力。
7. **会话历史导入**：能发现并显式导入 Pi CLI 历史副本，保留树与标签；迁移路径清晰。
8. **成本可见**：每会话 token/费用直接显示，适合多模型对比。

---

## 6. 路线图

> 排序原则：先“能不能信/能不能交付”，再“日常效率”，最后“生态与平台”。工作量是粗略估计。

### P0：信任与交付（2–4 周）

| 交付物 | 归属 | 验收标准 |
| --- | --- | --- |
| 工作区信任对话框 + RPC 显式信任决定 + 资源清单（基础版已完成） | 客户端 | 打开含 `.pi` 的项目时，用户能看到将加载什么；批准后项目 MCP/Skills/Settings 生效；拒绝后明确提示 |
| macOS Seatbelt 沙箱包装（bash/PTY），网络允许列表，UI 状态 | 客户端 + 引擎 | 沙箱内命令无法写项目外路径/访问未允许域名；UI 持续显示沙箱状态 |
| `auto` 改名与常驻警告（已完成）；分类器待做 | 客户端 | 用户不会把“自动执行”误认为“智能审批”；高风险操作有额外确认 |
| 签名/公证 + 自动更新 + CI 发布 | 发布工程 | 外部用户下载后无 Gatekeeper 警告；新版本可自动更新 |

### P1：日常对等（1–2 个月）

| 交付物 | 归属 | 验收标准 |
| --- | --- | --- |
| Claude 兼容 Hooks 子集：PreToolUse、PostToolUse、SessionStart、Stop、UserPromptSubmit、Notification + `/hooks` UI | 客户端 + 引擎 | 能配置“编辑后 lint”“禁止改 .env”“会话结束通知”，并在工具调用处生效 |
| 自定义 Agent（基础版已完成）：解析 `.claude/agents`/`.pi/agents`，per-agent 模型/工具/提示词 + 管理 UI；Hooks/权限待做 | 客户端 | 用户能创建“reviewer/debugger”并在聊天中委派；模型/工具按定义生效 |
| MCP 管理（基础版已完成）：增删/启停、stdio/HTTP、作用域；OAuth/健康状态/资源浏览待做 | 客户端 | 可在客户端添加普通 MCP；OAuth 仍需 `pi mcp login` |
| 记忆层级：根/子目录/`.claude/rules`/`@import` + 自动记忆 + `/context` 面板 + 自动压缩设置 | 客户端 + 引擎 | 子目录规范能自动加载；用户能看到上下文构成并调整压缩窗口 |
| 后台会话：挂起/接管、运行中切换、持久化 supervisor、系统通知 | 客户端 | 长任务可后台运行；离开电脑能收到完成通知；重启后可接管 |
| 权限：`acceptEdits`（已完成）、真正的 `plan` 模式、项目规则共享/导入导出 | 客户端 + 引擎 | 编辑不再每次确认；Plan 有明确产物与审批；团队规则可随仓库走 |

### P2：生态与平台（一个季度+）

| 交付物 | 归属 | 说明 |
| --- | --- | --- |
| 插件/包市场：安装、启停、更新、权限审查 | 客户端 | 对齐 Claude 插件生态；优先兼容 `.claude` 插件格式 |
| IDE/LSP：VS Code/JetBrains 或 LSP 客户端、selection 上下文、诊断 | 客户端 | 这是开发者工作流的关键，但投入大 |
| WebSearch、NotebookEdit、结构化 AskUserQuestion | 客户端 + 引擎 | 补齐工具面；WebSearch 可先接第三方搜索 API |
| 代码评审/安全评审/PR/CI | 客户端 + 服务 | `/code-review`、PR 状态、GitHub/GitLab 集成 |
| 主题/键位/Vim/无障碍/分栏工作区/多面板 | 客户端 | 长期体验打磨 |
| Agent Teams/Workflows/批量 Worktree | 客户端 + 引擎 | 大规模并行编排，ROI 取决于用户结构 |
| 云会话/Remote Control/Mobile/企业策略 | 平台 | 仅在产品战略需要时投入 |

---

## 7. 不建议逐条追的方向

1. **云会话、Web、Mobile、Remote Control、Dispatch**：需要 Anthropic 级账号体系与云基础设施；对一个本地桌面客户端，ROI 低，除非产品要转向云端。
2. **企业 SSO、审计、网关、托管策略**：销售驱动，个人/小团队客户端不必先做。
3. **Slack、GitHub Actions、Chrome、computer use**：服务平台依赖强、维护成本高；先把本地工作流做扎实。
4. **120 个斜杠命令全量复刻**：数量不等于体验；按“会话、上下文、扩展、协作、评审”场景补，不要按清单刷。
5. **Artifacts/Design/Slides 等 Anthropic 服务型能力**：不是本地客户端的主战场。

**更值得做的“兼容层”**：读取 `.claude/agents`、`.claude/skills`、`.claude/settings.json`（权限/Hooks）、`.mcp.json`，让用户把 Claude Code 的配置直接带过来。Pi 已经支持 Claude Code 的 Skills 路径与 `CLAUDE.md`，继续扩展这一优势，比另造一套生态更划算。

---

## 8. 附录

### 8.1 命令覆盖抽样

| 场景 | 原生代表命令 | 客户端对应 | 判断 |
| --- | --- | --- | --- |
| 会话 | `/clear` `/resume` `/branch` `/fork` `/rename` `/export` | `/new`、侧栏、会话树、重命名、HTML 导出 | 部分对等 |
| 上下文 | `/compact` `/context` `/autocompact` `/rewind` | `/compact`、`/rewind`、Ctx% | 部分 |
| 扩展 | `/hooks` `/plugin` `/skills` `/agents` `/mcp` | `/mcp`（仅工具开关） | 大部分缺失 |
| 权限 | `/permissions` `/sandbox` `/config` | `/permissions`、设置对话框 | 部分 |
| 模型 | `/model` `/effort` `/fast` `/advisor` `/usage` | 模型/思考选择、`/cost` | 部分 |
| 协作 | `/subtask` `/batch` `/workflows` `/tasks` `/goal` `/loop` | `/tasks`、后台任务 | 部分 |
| 质量 | `/code-review` `/security-review` `/simplify` `/verify` `/run` `/doctor` | 无 | 缺失 |
| 平台 | `/ide` `/chrome` `/voice` `/mobile` `/remote-control` `/desktop` `/teleport` | 无 | 缺失 |

原生命令参考约 120 个条目（含别名、已移除和服务型命令）；客户端内置 13 个斜杠命令（[LiveComposer.tsx](../src/renderer/LiveComposer.tsx)）+ 18 项命令面板动作 + Pi 动态命令/Skills。数量差距很大，但应按场景而不是数量来补。

### 8.2 Pi 引擎已有、客户端未暴露

这些是“UI 接入就能补”的快速收益：

- MCP 服务器增删/登录/作用域/资源（Pi 有 `pi mcp`、OAuth、资源）。
- ~~工作区信任~~（本次已接入：检测资源、信任 UI、`--approve`/`--no-approve`、持久化与重启）。
- 主题、键位、prompt templates、packages（Pi 有 CLI/配置）。
- 自动压缩/自动重试设置（Pi 有 settings，客户端后端也代理了 `set_auto_compaction`/`set_auto_retry`，但没有 UI）。
- 父目录上下文与 `AGENTS.override.md`（Pi 已有；客户端界面未暴露，也没有子目录按需加载、`.claude/rules`、自动记忆）。
- headless/JSON/SDK（Pi CLI 有，客户端未提供入口）。
- Skills 创建/校验/分享与 `disable-model-invocation`（Pi CLI 有；客户端只做调用）。
- 会话目录可配置并与 Pi CLI 对齐（当前固定应用数据目录 + 复制导入）。

### 8.3 代码落点（建议）

| 能力 | 主要落点 |
| --- | --- |
| 工作区信任 | [backend.ts](../src/backend.ts) 的 `startRuntime` 启动参数、[main.ts](../src/main.ts) 对话框、[preload.ts](../src/preload.ts) 与 [shared.ts](../src/shared.ts) 新 API |
| 沙箱 | [backend.ts](../src/backend.ts) 的 bash 执行、[terminal-service.ts](../src/terminal-service.ts) 的 PTY spawn、[rpc.ts](../src/rpc.ts) 子进程环境 |
| Hooks | 新增 hooks 执行/配置模块；启动时注入扩展；[ControlsDialog.tsx](../src/renderer/ControlsDialog.tsx) 管理页 |
| 自定义 Agent | [model-delegation.ts](../src/model-delegation.ts)、[tool-control-extension.ts](../src/tool-control-extension.ts)、新 agent 解析器；[TasksDrawer.tsx](../src/renderer/TasksDrawer.tsx) |
| MCP 管理 | 新增 MCP 管理模块；[control-ipc.ts](../src/control-ipc.ts) 与 [control-types.ts](../src/control-types.ts)；[ControlsDialog.tsx](../src/renderer/ControlsDialog.tsx) |
| 记忆/上下文 | [backend.ts](../src/backend.ts) 的 `readMemory` 扩展；新 context loader；[MemoryStatusDialog.tsx](../src/renderer/MemoryStatusDialog.tsx) |
| 后台会话 | [backend.ts](../src/backend.ts) 的 runtime 生命周期与持久化；[main.ts](../src/main.ts) 通知；[main.tsx](../src/renderer/main.tsx) 切换逻辑 |
| 权限模式 | [permission-types.ts](../src/permission-types.ts)、[permission-policy.ts](../src/permission-policy.ts)、[tool-settings.ts](../src/tool-settings.ts)、[LiveComposer.tsx](../src/renderer/LiveComposer.tsx) |
| 分发 | [desktop-builder.json](../desktop-builder.json)、[scripts/build.mjs](../scripts/build.mjs)、CI workflow |

### 8.4 证据清单

**客户端源码/文档**
- [README](../README.md)、[UPSTREAM](../UPSTREAM.md)、[backend-api](backend-api.md)、[tools-and-delegation](tools-and-delegation.md)、[local-external-agents](local-external-agents.md)
- [permission-types.ts](../src/permission-types.ts)、[permission-policy.ts](../src/permission-policy.ts)、[tool-settings.ts](../src/tool-settings.ts)
- [backend.ts](../src/backend.ts)、[main.ts](../src/main.ts)、[desktop-builder.json](../desktop-builder.json)
- [main.tsx](../src/renderer/main.tsx)、[LiveComposer.tsx](../src/renderer/LiveComposer.tsx)、[ControlsDialog.tsx](../src/renderer/ControlsDialog.tsx)、[TasksDrawer.tsx](../src/renderer/TasksDrawer.tsx)、[MemoryStatusDialog.tsx](../src/renderer/MemoryStatusDialog.tsx)

**原生文档**
- [Commands](https://code.claude.com/docs/en/commands)、[Permissions](https://code.claude.com/docs/en/permissions)、[Sandboxing](https://code.claude.com/docs/en/sandboxing)、[Hooks](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)、[Agent view](https://code.claude.com/docs/en/agent-view)、[Workflows](https://code.claude.com/docs/en/workflows)、[Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Plugins](https://code.claude.com/docs/en/plugins/overview)、[Skills](https://code.claude.com/docs/en/skills)、[MCP](https://code.claude.com/docs/en/mcp)
- [Memory](https://code.claude.com/docs/en/memory)、[Sessions](https://code.claude.com/docs/en/sessions)、[Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Desktop](https://code.claude.com/docs/en/desktop)、[Platforms](https://code.claude.com/docs/en/platforms)、[Remote Control](https://code.claude.com/docs/en/remote-control)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)、[Statusline](https://code.claude.com/docs/en/statusline)、[Output styles](https://code.claude.com/docs/en/output-styles)

### 8.5 未验证项

- 打包应用的端到端交互、真实模型调用、真实 MCP/OAuth 服务。
- Windows/Linux 实机；Windows ConPTY；Linux PTY。
- Claude Code 120 个命令的逐条行为；本报告按 `--help` 与文档归类。
- 企业托管策略、SSO、审计；只按文档判断“原生有、客户端没有”。
- 原生 Desktop 的拖拽分栏、computer use、Dispatch 等；只按文档判断，未实机对比。

---

**最后判断**：Pi Desktop 已经跨过“看起来像 Claude Code”的阶段，接下来要跨“敢不敢把真实仓库交给它”和“团队能不能把配置带进来”这两道坎。前者靠信任、沙箱、权限模式；后者靠 Hooks、Agents、MCP、配置兼容。把这两件事做好，再叠加多模型与外部 Agent 协作，就不需要逐条复刻原生客户端。
