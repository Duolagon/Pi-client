# Pi Desktop

macOS 优先的 Pi 桌面客户端。当前版本接入真实 Pi RPC 编码引擎，界面按原生 Claude 客户端的视觉与交互重构：左侧图标栏与会话侧栏、按日期分组的会话列表、Claude 式消息流（右侧用户气泡、可折叠工具卡片、思考过程）以及底部圆角输入框与模型／思考／权限选择。旧的演示原型保留在独立入口。

这是独立客户端源码仓库。Pi 引擎通过精确版本的 npm 依赖集成，当前固定为 `1.5.2`；依赖版本与发布包完整性记录在 `package-lock.json`。上游来源及升级流程见 [UPSTREAM.md](UPSTREAM.md)，许可与归属见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。

## 客户端截图

正式 Electron 客户端的实际运行界面。截图使用本地演示模型和临时示例项目，展示真实 Pi 文件／命令工具、会话和 Git 差异。

![Pi Desktop 浅色界面：会话、工具调用与编码结果](docs/screenshots/client-light.png)

<details>
<summary>深色模式与代码差异</summary>

![Pi Desktop 深色界面：审核真实项目代码差异](docs/screenshots/client-dark.png)

</details>

## 启动与打包

开发环境需要 Node.js **22.19.0 或更新版本**、npm、Git 和 C 编译器。macOS 可使用 Xcode Command Line Tools 提供的编译器。测试直接运行 TypeScript 源码，类型检查使用仓库锁定的 TypeScript 与 Node 类型包。

在本仓库根目录安装并构建：

```sh
npm ci --ignore-scripts
npm run build
```

构建直接使用已安装 Pi npm 包中的运行时，不需要另行克隆或构建 Pi 核心。`--ignore-scripts` 会跳过 Electron 的安装脚本，首次开发启动前须显式下载 Electron 平台运行时：

```sh
node node_modules/electron/install.js
npm run start
```

生成可运行的应用目录或 macOS ZIP：

```sh
npm run package
npm run dist:mac
```

打包时 electron-builder 会自行下载配置指定的 Electron 运行时，不要求先执行开发启动用的下载步骤。macOS Apple Silicon 的应用目录输出为 `release/desktop/mac-arm64/Pi Desktop.app`；应用内置 Electron 的 Node 运行时与 Pi RPC bundle，最终用户不需要安装 Node、编译器或 Pi。打包配置见 `desktop-builder.json`，当前本地构建未签名。

## 模型配置

默认读取 Pi 标准目录 `~/.pi/agent`，包括已有模型、认证、设置和扩展。若设置了 `PI_CODING_AGENT_DIR`，则读取该目录。可在客户端设置中指定其他配置目录。

首次使用时，在设置中选择 DeepSeek、Anthropic、OpenAI、Google 或 OpenRouter，填写 API Key 后点击“保存并使用”即可。客户端已内置官方地址、接口协议、推荐模型和模型能力参数；模型下拉列表也可直接选择其他内置模型，不需要手输模型 ID。不要将密钥发送到聊天中。

DeepSeek 默认使用 `deepseek-flash`，并提供 `deepseek-v4-pro`；模型与能力来自此版本 Pi 的内置目录。保存服务商后，聊天区的模型选择器会显示其全部内置模型，切换后可恢复。

第三方中转或自建服务请展开“高级设置”，使用自定义接口并按服务商说明填写模型 ID、基础地址和协议。可选择 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 或 Google Gemini。API 地址不包含具体请求路径、密钥或查询参数；兼容 OpenAI 的中转接口通常选择 Chat Completions，地址是否包含 `/v1` 以服务商说明为准。已有自定义连接会保留，切回官方预设需主动选择。

“测试连接”可在保存前验证密钥和所选模型。测试通过独立 Pi 进程发送一条最小请求，不加载项目文件、上下文、工具或第三方扩展，不写入当前会话；请求可能计入模型用量。保存的连接会用于当前会话和新会话，已有会话恢复其原来的模型。未修改的密钥留空即可保留。

客户端内新增的密钥通过 Electron `safeStorage` 加密保存。客户端自定义连接注册为独立的 `desktop-<provider>`，不会覆盖 Pi 的原有 `auth.json`、`models.json` 或登录状态。密钥不会返回渲染进程，也不放在进程启动参数中。已有订阅/OAuth 登录可通过原有 Pi 配置复用；当前没有独立的 OAuth 登录向导。

## 已接入

以下同时列出界面已有功能和已完成的后端接口。发送任务和执行单命令会自动捕获 Git 检查点；检查点审核／恢复、PTY、后台任务／Worktree、会话分支／树导航／CLI 历史导入当前提供后端接口，界面入口仍待接入。

- 本地项目选择；新建、切换、重命名会话；会话持久化与重启恢复。
- 真实模型列表、模型切换、支持的思考强度、流式文本和思考内容。
- Pi 的真实读写文件、编辑和命令工具；显示工具参数、输出和执行错误。
- 手动确认、自动执行和只读模式；扩展的确认、选择、输入和编辑器对话框。
- 停止任务、运行中追加引导消息、直接执行命令、停止命令。
- 实际项目文件查看、Git 状态及暂存/未暂存/未跟踪文件差异。
- 文本和图片附件、已有 Skills/扩展命令列表、会话 HTML 导出、上下文压缩与用量统计。
- 配置的 MCP 工具通过 Pi 本身加载并执行；当前没有独立 MCP 管理页面。项目级资源仍遵循 Pi 自身的信任规则。
- 后端 Git 检查点：Pi 提示和直接命令自动捕获，支持差异、按文件／全部安全恢复及冲突结果。
- 原生 PTY 服务：持续 Shell、标准输入、Ctrl-C、尺寸调整、序号回放与子进程清理。
- 后台多会话任务与 Worktree：并发、排队、取消、独立审批路由、快进合并及安全清理。
- 会话分支、当前分支克隆、完整会话树与条目查询、树节点导航及重启恢复所选分支。
- Pi CLI 历史发现与显式导入：保留完整分支树，导入为独立副本并去重，不修改原始 CLI 文件。

新增后端能力通过 preload/IPC 提供给负责界面的开发者。完整接入契约、示例与限制见 [后端接口文档](docs/backend-api.md)。

权限确认作用于 Pi 工具调用，不等同于操作系统沙箱。只读模式限制工具并阻止客户端直接命令执行；其他模式下，命令工具使用启动用户的系统权限。

## 数据和限制

桌面会话索引及客户端设置保存在 Electron 的应用数据目录，实际会话 JSONL 保存在该目录的 `sessions/`。桌面端不自动导入 CLI 的所有历史会话。

现有界面的“终端”仍是原命令执行面板；新 PTY、任务和检查点后端通过 `window.pi.terminals/tasks/git/worktrees` 提供。应用网页预览、Git 暂存／提交、正式签名和自动更新尚未实现。自定义连接匹配 Pi 已知的服务商和模型 ID 时，沿用其能力与计费元数据；未知模型使用通用上下文、输出上限和占位价格。

`PI_DESKTOP_DATA_DIR` 和 `PI_DESKTOP_WORKSPACE` 可指定独立的数据和初始项目目录，供开发及隔离验证使用。普通启动会等待用户选择项目，不会把 Finder 的当前目录当成项目。

## 校验

```sh
npm run check
node --test test/*.test.ts
```

首次校验前先执行 `npm ci --ignore-scripts` 和 `npm run build`。类型检查不启动模型；测试使用的原生 PTY helper 由构建步骤生成。

macOS 实际窗口与前后端互通验证：

```sh
npm run package
npm run verify:client
# 同时重新生成上方的客户端截图：
npm run verify:client -- --screenshots
```

交互验证会启动正式打包应用，使用独立临时目录和本地演示模型，检查模型／思考选择、附件隔离与限制、工具审批、流式重载恢复与停止、文件修改与 Git 差异、命令面板，以及真实 preload 的会话树、检查点、PTY、后台任务和 Worktree 接口。

测试使用独立临时目录与脚本化本地测试模型，运行真实 Pi Agent 循环和读写/命令工具，不使用真实模型凭据或付费 API。

模型连接测试另外启动本地 HTTP/SSE 服务，验证实际 Pi 请求的协议、认证、错误处理和密钥隔离。macOS 客户端另已完成 DeepSeek 真实连接及只读项目分析验收；凭据和会话数据不随源码发布。Google 协议尚未完成本地服务或真实服务验证，其他服务商的真实账户权限也未逐一验收。

## 旧界面原型

```sh
npm run prototype
npm run prototype:app
```

`prototype/index.html`、端口 4317 的原型页面及 `Pi Desktop Preview.app` 均是早期演示入口，不连接正式客户端后端。演示中的代码和执行输出为预设数据；正式入口是 `Pi Desktop.app`。

## 源码与本地数据

提交客户端源码、文档、合成测试数据和锁文件。构建产物、依赖目录、环境文件、密钥、个人 Pi 配置、会话 JSONL、终端记录和运行日志不应进入仓库；测试和应用数据使用仓库外的独立目录。发布源码前也应检查暂存清单，避免把本地验收数据、截图或录制带入提交。
