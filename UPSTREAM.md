# Pi 上游依赖与升级记录

本仓库独立维护 Pi Desktop 客户端，通过 npm 集成 [earendil-works/pi](https://github.com/earendil-works/pi) 的编码引擎。Pi 上游的 Git 历史、用户配置和个人会话不属于本仓库的发布内容。

## 当前固定版本

| 依赖 | 精确版本 | 用途 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `1.5.2` | RPC 进程、原生会话管理及扩展 API |
| `@earendil-works/pi-ai` | `1.5.2` | 模型类型、目录和内容处理 |
| `@earendil-works/pi-agent-core` | `1.5.2` | 消息协议类型 |

`package.json` 使用精确版本，不使用 `^`、`~` 或 `latest`。`package-lock.json` 同时锁定传递依赖、下载来源及 npm 发布包的 `integrity`，应与依赖修改一起提交。`npm ci --ignore-scripts` 根据锁文件安装，并校验下载包的完整性。

构建脚本从已安装 Pi 包读取 RPC bundle、运行时资源和辅助模块，再复制到应用内。开发者无需预先构建 Pi 上游源码；用户运行打包后的应用也无需全局安装 Pi。

## 安装与构建

开发环境需要 Node.js 22.19.0 或更新版本、npm、Git 和 C 编译器。依赖生命周期脚本默认跳过；构建所需的原生 PTY helper 由本仓库的显式构建步骤编译。

```sh
npm ci --ignore-scripts
npm run build
npm run check
node --test test/*.test.ts
```

开发启动另外执行 `node node_modules/electron/install.js`，然后 `npm run start`。生成应用使用 `npm run package` 或 `npm run dist:mac`，electron-builder 会下载该目标所需的 Electron。

## 升级 Pi

1. 阅读目标版本的上游 changelog，确认 RPC、扩展和会话文件格式变化。同步更新各项 Pi 直接依赖的精确版本，并检查传递依赖与生命周期脚本变化。
2. 使用 `npm install --ignore-scripts` 更新依赖和锁文件，审核 `package-lock.json` 中版本、来源与 integrity 的变化。提交中记录升级原因及兼容性处理。
3. 完整构建并运行上述检查。重点验证 `rpc-entry` 与运行时资源、`fork / clone / get_tree / get_entries`、原生 `navigateTree`、取消钩子、旧会话读取和导入。
4. 运行会话生命周期回归，验证父子身份、空白会话、未结束任务关闭和所选分支重启恢复。测试使用本地 faux 模型和临时目录。
5. 验收打包后的 Git 检查点、PTY、后台任务／Worktree、会话树及历史导入；确认运行时资源和许可声明随应用分发。包内验收入口见 [后端接口文档](docs/backend-api.md#构建与验证)。
6. 在下表增加升级记录，注明版本、兼容性修改和验证范围。真实模型验证若另行进行，凭据、个人项目内容与会话不得随记录发布。

## 记录

| 日期 | Pi 版本 | 变更与验证范围 |
| --- | --- | --- |
| 2026-11-17 | `1.5.2` | 建立独立客户端仓库，保留桌面源码与原型入口；通过 npm 精确版本集成。后端回归和打包验收流程见接口文档。 |

2026-11-17 依赖检查：`npm audit --omit=dev` 未报告生产依赖漏洞。完整检查报告的 6 项 moderate 来自 electron-builder 开发打包链的 minimatch；当前使用本仓库固定的构建配置。npm 建议的顶层自动修复会降级 electron-builder，因此保留已验收版本，等待兼容修复后单独升级。

## 归属与发布

Pi 的上游 MIT 版权及许可声明保留在 [NOTICE.md](NOTICE.md)。分发包含 Pi 的应用或源码时，一并保留相应许可文件及依赖自身携带的声明。其他第三方依赖各自遵循其发布包中的许可。

发布清单应包括源码、文档、合成测试 fixture、包清单和锁文件。依赖目录、构建产物、环境文件、密钥、真实会话、终端记录、日志和本地验收录制应留在仓库外。修改忽略规则时，保持 `src/prototype/` 原型源码可被版本管理，仅忽略根目录的生成产物 `prototype/`。
