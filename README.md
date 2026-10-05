# Agent Team Desktop

[中文](#中文) · [English](#english)

一个将本地项目、群聊、多 Agent 协作和受控工具执行整合在一起的桌面工作台。

A desktop workspace for local projects, group conversations, multi-Agent collaboration, and controlled tool execution.

**当前版本 / Current version: v0.5.1**

## 中文

### 项目介绍

Agent Team Desktop 使用 Electron、React 和 TypeScript 构建。你可以将项目绑定到本地目录，在不同群聊中配置 Agent 的角色、模型与工具权限，通过对话完成内容策划、研究、写作或开发协作。

项目、会话和配置保存在本机 SQLite 数据库中。使用云端模型时，应用会请求相应项目与模型的外发授权；使用 Ollama 时，可以连接本机模型服务。当前应用界面主要为中文，本 README 提供中英文说明。

### 主要功能

| 功能 | 说明 |
| --- | --- |
| 本地项目与群聊 | 通过系统目录选择器绑定工作区；一个项目可以包含多个群聊，消息和任务按群聊隔离。 |
| Agent 管理 | 直接查看当前群聊的成员与启用状态；支持添加、编辑、停用、移出，以及群聊模型和权限覆盖配置。 |
| 自定义与推荐实例 | 在「添加 Agent」弹窗中创建自定义角色、导入推荐角色或添加已有 Agent；支持整队模板导入。 |
| 多 Agent 协作 | 通过输入框上方的 `@ 指派成员` 生成有效指派；支持按顺序发言、成员交接和调度模型自动选人。 |
| 成员名单查询 | 常见的纯成员查询直接读取当前群聊记录，返回人数、角色和启用状态；停用和移出后再次查询会使用最新数据。 |
| Markdown 消息 | Agent 回复支持标题、列表、引用、代码块和表格，流式输出及历史消息均可渲染。 |
| 模型配置与回退 | 支持 DeepSeek、OpenAI 兼容 API 和本机 Ollama，可配置上下文预算及最多两级备选模型。 |
| 工作区工具 | 支持目录浏览、文本读取与搜索、文件写入与替换，以及已注册程序的受控执行。 |
| 审批与恢复 | 工具权限默认拒绝；覆盖文件、受控进程等操作通过审批流程处理，记录任务、工具结果和恢复状态。 |
| 桌面体验 | 支持浅色、深色和跟随系统主题，长会话记录导航及诊断日志导出。 |

内置团队模板覆盖四类场景：

- 自媒体与内容矩阵运营。
- 商业孵化与创新项目调研。
- 文学、小说与长文创制。
- 软件开发与自动化脚本。

### 快速开始

准备 Git、Node.js 和 npm。当前依赖中的 `better-sqlite3` 要求 **Node.js 22 或更高版本**；本地开发环境为 Node.js 24.14.0、npm 11.13.0。

```bash
git clone https://github.com/ChaunceyKong/my-agent.git
cd my-agent
npm ci
npm run dev
```

`npm run dev` 启动 Electron 开发工作台。首次安装需要下载项目依赖和 Electron；模型服务由你在应用内配置。

### 使用流程

1. 点击「新建项目」，填写名称并通过系统目录选择器绑定本地工作区。项目会创建默认的「主线任务协同群」。
2. 打开「模型设置」，选择服务商并填写服务地址、模型名称及需要的 API Key。Ollama 使用本机服务地址，可通过「发现本机模型」选择已安装的模型。
3. 在右侧 `Agent` 页签点击「添加 Agent」，创建自定义角色或导入推荐实例。加入群聊后可以调整启用状态、模型覆盖和工具权限。
4. 在输入框上方选择 `@ 指派成员`，输入目标并发送。需要使用云端模型时，按应用展示的用途确认外发授权。
5. 普通回复完成后可继续发送下一条消息。需要审批的工具操作在「工具与审批」中处理；应用重启不会自动重放未完成的工具效果。

自动发言模式下，配置了调度模型时由其选择下一位成员；未配置调度模型时，默认由列表中的第一位已启用 Agent 回复。手动模式需要选择发言成员。手工输入 `@姓名` 是普通消息文本，请使用成员选择器生成指派。

可以用下面的问题查看真实群聊成员：

```text
当前群聊有多少位 Agent？请列出名单和启用状态。
```

Agent 数量与 CEO 分开计算；「已启用」表示成员可参与任务，不代表模型在线或正在发言。

### 数据与权限

- SQLite 数据库位于 Electron 用户数据目录，文件名为 `agent-team.sqlite`；项目工作区是另行选择的本地目录。
- 主进程负责数据库、文件、模型调用与密钥，渲染层通过有限的 Preload API 交互，不拥有通用文件系统或进程接口。
- API Key 使用 Electron `safeStorage` 加密保存，不回传给渲染层。云端调用可能包含当前输入、历史消息、角色提示、群聊成员记录和获准上传的工具结果。
- 文件工具仅接受工作区内的受控相对路径，并拒绝敏感路径和越界访问。Agent 权限与群聊覆盖权限共同约束工具能力。
- 普通会话不会因回复后的调度失败而要求 CEO 接管；审批、运行错误和未完成操作的恢复状态分别展示。

### 开发与验证

```bash
# 单元与组件测试
npm test -- --maxWorkers=1 --minWorkers=1

# TypeScript 类型检查
npx tsc --noEmit

# 构建主进程、Preload 与渲染层
npm run build

# 真实 Electron 端到端测试；脚本会先构建应用
npm run test:e2e
```

端到端测试使用隔离的临时用户数据和工作区，以及本地测试模型服务。历史验收报告中的测试数量属于相应版本与日期，不代表每次修改后的最新结果。

### 打包

```bash
# Windows x64：NSIS 安装版与便携版
npm run build:win

# macOS：DMG 与 ZIP，需在适合的平台环境验证
npm run build:mac

# Linux：AppImage，需在适合的平台环境验证
npm run build:linux
```

默认输出目录为 `release/<platform>-v<version>/`，例如 `release/win-v0.5.1/`。打包脚本使用 `--publish never`，且会拒绝覆盖已经存在的输出目录。重新打包时应使用新的版本或独立输出目录，保留需要的旧产物。

Windows 标准目录打包完成后，可以执行：

```bash
npm run test:package
```

该测试启动解压运行版和真正的便携启动器，检查隔离数据库、主题持久化及打包后的成员查询。测试默认查找 `release/win-v0.5.1/`；使用自定义打包目录时，需要同步调整测试中的路径。编译产物不随源码提交。

### 当前支持状态

| 项目 | 状态 |
| --- | --- |
| Windows x64 | 已完成本地开发运行、功能回归及解压运行版/便携版启动验证。 |
| Windows 安装器 | 可生成 NSIS 安装包；安装、卸载和签名分发仍需独立验收。 |
| macOS / Linux | 已配置打包目标，尚未完成对应平台的构建与运行验收。 |
| 自动更新 | 已实现受控接口；当前未配置可信发布源和签名发布流程，更新操作处于禁用状态。 |

### 源码结构与文档

```text
electron/         Electron 主进程、Preload、数据库、IPC 与任务/工具服务
src/              React 界面、主题和工作台状态
shared/           共享类型、IPC 名称与版本信息
tests/unit/       核心服务单元测试
tests/e2e/        Electron 端到端测试
tests/package/    Windows 打包程序启动测试
scripts/          平台打包脚本
docs/             设计过程与历史验收记录
```

- [v0.5 本地 Windows 验收](docs/V0.5_ACCEPTANCE.md)
- [Windows 打包验证记录](docs/V0.5_WINDOWS_PACKAGE.md)
- [长会话基准与测量边界](docs/V0.5_HISTORY_BENCHMARK.md)
- [v0.4 验收记录](docs/V0.4_ACCEPTANCE.md)
- [v0.3 验收记录](docs/V0.3_ACCEPTANCE.md)

这些报告记录各自的历史版本；当前版本以 `package.json` 和代码为准。

## English

### Overview

Agent Team Desktop is an Electron, React, and TypeScript application. Bind a project to a local workspace, configure Agent roles, models, and tool permissions in separate group conversations, and collaborate on content planning, research, writing, or development.

Projects, conversations, and configuration are stored in local SQLite. Cloud model requests require consent for the relevant project and model. Ollama connects to a local model service. The application UI is currently primarily Chinese; this README includes both Chinese and English documentation.

### Features

| Feature | Description |
| --- | --- |
| Local projects and groups | Select a workspace using the native directory picker. A project can contain multiple groups, with messages and task runs scoped to each group. |
| Agent management | See current group members and enabled states, add or edit Agents, disable or remove membership, and configure group model and permission overrides. |
| Custom and recommended Agents | Create roles, import recommended roles or existing Agents from the add dialog, or import a complete team template. |
| Collaboration | Use the member selector above the composer to create valid `@` assignments. Supports ordered turns, Agent handoffs, and model-based speaker selection. |
| Local roster queries | Common roster-only questions read actual group records and return counts, roles, and enabled states. Subsequent queries reflect membership changes. |
| Markdown replies | Headings, lists, quotes, code blocks, and tables render in streaming and persisted Agent messages. |
| Models and fallback | Configure DeepSeek, OpenAI-compatible APIs, or local Ollama models, context budgets, and up to two fallback levels. |
| Workspace tools | Browse directories, read and search text, write or replace files, and run registered programs through controlled execution. |
| Approval and recovery | Tool permissions are denied by default. File overwrites and controlled processes use approval workflows with recorded task, tool, and recovery state. |
| Desktop experience | Light, dark, and system themes, long-conversation navigation, and diagnostic log export. |

Built-in team templates cover content and social media operations, business incubation and research, fiction and long-form writing, and software development and automation.

### Quick start

Install Git, Node.js, and npm. The current `better-sqlite3` dependency requires **Node.js 22 or newer**. The local development environment uses Node.js 24.14.0 and npm 11.13.0.

```bash
git clone https://github.com/ChaunceyKong/my-agent.git
cd my-agent
npm ci
npm run dev
```

The development command opens the Electron workspace. Initial installation downloads dependencies and Electron. Configure your model service in the application.

### Workflow

1. Create a project with 「新建项目」 and select its local directory. The application creates the default group 「主线任务协同群」.
2. Open 「模型设置」 to configure a provider, endpoint, model name, and API key when required. For Ollama, use the local endpoint and 「发现本机模型」 to discover installed models.
3. Click 「添加 Agent」 in the right-side `Agent` tab to create a role or import a recommendation. Adjust enabled states, model overrides, and tool permissions after joining the group.
4. Use the `@ 指派成员` selector above the composer, enter a goal, and send. Confirm the displayed data-sharing purposes before using a cloud model.
5. After an ordinary reply completes, send the next message directly. Handle tool approvals in 「工具与审批」. Restarting the application does not automatically replay unfinished tool effects.

In automatic mode, a configured scheduler chooses speakers. Without a scheduler, the first enabled Agent in the list answers by default. Manual mode requires a selected speaker. Typing `@Name` manually creates plain text; use the member selector for a structured assignment.

For a local roster query, enter:

```text
当前群聊有多少位 Agent？请列出名单和启用状态。
```

This asks for the current group's Agent count, names, and enabled states. The CEO is counted separately. Enabled membership does not mean a model is online or currently speaking.

### Data and permissions

- The database, `agent-team.sqlite`, lives in Electron's user data directory. The project workspace is a separately selected local directory.
- Main owns database access, filesystem operations, model calls, and credentials. Renderer uses a limited Preload API without generic filesystem or process access.
- API keys are encrypted with Electron `safeStorage` and are not returned to Renderer. Authorized cloud requests can include input, history, role prompts, group roster records, and approved tool observations.
- File tools accept controlled paths relative to the workspace and reject sensitive or out-of-root paths. Agent permissions and group overrides jointly constrain tool access.
- A routing failure after an ordinary reply no longer requires CEO handoff. Approvals, execution errors, and recovery of unfinished operations have separate states.

### Development and verification

```bash
# Unit and component tests
npm test -- --maxWorkers=1 --minWorkers=1

# Type checking
npx tsc --noEmit

# Build Main, Preload, and Renderer
npm run build

# Real Electron end-to-end tests; the script builds first
npm run test:e2e
```

End-to-end tests use isolated temporary profiles and workspaces with local test model servers. Test counts in acceptance reports apply to their recorded versions and dates.

### Packaging

```bash
# Windows x64: NSIS installer and portable executable
npm run build:win

# macOS: DMG and ZIP; validate on a suitable platform
npm run build:mac

# Linux: AppImage; validate on a suitable platform
npm run build:linux
```

Output defaults to `release/<platform>-v<version>/`, such as `release/win-v0.5.1/`. The packaging script uses `--publish never` and refuses to overwrite an existing output directory. Use a new version or a separate output directory for another build while preserving needed artifacts.

After packaging Windows to the standard directory, run:

```bash
npm run test:package
```

The tests launch the unpacked application and the actual portable launcher, checking isolated SQLite, theme persistence, and packaged roster queries. They expect `release/win-v0.5.1/`; adjust test paths when using a custom output directory. Build artifacts are kept out of source commits.

### Platform and release status

| Item | Status |
| --- | --- |
| Windows x64 | Local development, functional regression, unpacked runtime, and portable startup have been verified. |
| Windows installer | NSIS output can be generated. Installation, uninstallation, and signed distribution require separate acceptance. |
| macOS / Linux | Packaging targets are configured; platform-specific build and runtime acceptance are pending. |
| Automatic updates | Controlled interfaces are implemented. Update actions are currently disabled because trusted publishing and signing are not configured. |

### Source layout and records

```text
electron/         Main, Preload, database, IPC, task and tool services
src/              React UI, themes, and workspace state
shared/           Shared types, IPC names, and app version
tests/unit/       Core service unit tests
tests/e2e/        Electron end-to-end tests
tests/package/    Windows packaged runtime tests
scripts/          Platform packaging scripts
docs/             Design history and acceptance records
```

- [v0.5 local Windows acceptance](docs/V0.5_ACCEPTANCE.md)
- [Windows package verification](docs/V0.5_WINDOWS_PACKAGE.md)
- [Long-history benchmark and measurement limits](docs/V0.5_HISTORY_BENCHMARK.md)
- [v0.4 acceptance](docs/V0.4_ACCEPTANCE.md)
- [v0.3 acceptance](docs/V0.3_ACCEPTANCE.md)

These records describe their historical versions. Refer to `package.json` and the source for the current implementation.
