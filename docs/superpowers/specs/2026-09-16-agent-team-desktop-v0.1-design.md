# Agent Team Desktop v0.1 设计

## 目标与范围

v0.1 建立可运行的安全桌面骨架，作为后续单 Agent 工具交付与多 Agent 协同的基础。本期提供：

- Electron、React、TypeScript 桌面应用。
- 与 `docs/ui_prototype.html` 和 `docs/UI_DESIGN_SPEC.md` 一致的三栏工作台。
- 项目、Channel、消息、任务运行和模型配置的本地 SQLite 持久化。
- 项目与本地目录的一对一绑定，以及后续工具可复用的工作区路径安全校验。
- 一个 OpenAI-compatible 云端模型的加密配置和真实流式单 Agent 对话。
- 可取消、可恢复的 TaskRun 状态与审计事件。

本期不提供 Agent Studio、文件读写、命令执行、工具审批、多 Agent 编排、模板市场、Ollama 发现、自动更新或打包发布。这些能力按 PRD 路线图在后续版本实现。

## 已确认产品模型

`Project` 是本期工作区所有权的根：一个项目只绑定一个存在且可访问的本地目录。项目可以有多个 `Channel`；它们共享项目目录，但聊天记录、任务运行、消息和后续成员配置相互隔离。

首次创建 Project 时，同时创建一个首个 Channel。空状态下可新建 Project；已有项目可以创建或切换 Channel。

## 架构

应用采用 Electron + electron-vite + React + TypeScript。

- **Renderer**：React 三栏界面、Zustand UI 状态，以及来自主进程的流式状态呈现。渲染进程不使用 Node API，不能读取目录或 API Key。
- **Preload**：使用 `contextBridge` 暴露最小化、带类型的 API。所有调用走有限 IPC Channel；不暴露通用的 `ipcRenderer`。
- **Main**：注册 IPC handler，拥有 SQLite、原生目录选择器、工作区校验、模型路由、TaskRun 生命周期和审计写入。
- **Shared**：集中定义领域类型、IPC channel 名称与请求/响应形状，禁止 Renderer 与 Main 各自复制协议。

建议目录：

```text
electron/
  main.ts
  preload.ts
  ipc/
  core/
  database/
src/
  components/
  stores/
  styles/
shared/
```

## 用户界面

实现 UI 原型中的浅色紧凑三栏布局：

- 顶栏显示应用名、当前项目 / Channel 面包屑、工作区状态和右侧栏开关。
- 左栏显示项目选择、项目下的 Channel、创建入口，以及底部主理人和设置入口。
- 中栏显示当前 Channel 的聊天记录、CEO 输入框、发送/取消状态与流式 Agent 回复。
- 右栏提供成员、工作区和上下文三个页签。v0.1 使用真实 Project/Channel 状态；成员和上下文为明确的空状态或演示提示，不伪造运行结果。
- 设置以轻量对话框提供模型配置。选择 OpenAI 或 DeepSeek 只填充默认 base URL；底层始终是一种 OpenAI-compatible 配置。

## 数据与持久化

SQLite 存于 Electron `userData` 目录并由迁移初始化。v0.1 需要下列实体：

- `Project`：id、name、icon、workspacePath、createdAt、updatedAt。
- `Channel`：id、projectId、name、icon、createdAt、updatedAt。
- `Message`：id、channelId、taskRunId（可空）、role、authorName、content、status、createdAt。
- `ModelConfig`：id、providerPreset、baseUrl、modelName、encryptedApiKey、createdAt、updatedAt。
- `TaskRun`：id、channelId、modelConfigId、status（queued/running/cancelled/failed/completed/paused）、startedAt、finishedAt、errorMessage。
- `AuditEvent`：id、channelId、taskRunId（可空）、eventType、metadataJson、createdAt。

API Key 只在主进程通过 Electron `safeStorage` 加密、解密和使用；数据库或 IPC 返回值只包含脱敏状态和配置元数据。

## 工作区安全

创建项目、加载项目和未来所有工具调用均使用同一验证器：

1. 验证路径存在且可访问。
2. 解析真实路径，拒绝无法解析的链接或重解析点。
3. 对未来请求路径使用 `path.relative` 边界判断，不使用字符串前缀判断。
4. 对现有父路径进行 `lstat` 和 `realpath` 校验，确保解析后仍在项目根目录内。

v0.1 不包含任何写入、替换、删除或子进程执行工具；因此不会在审批机制尚未实现时引入真实副作用。

## 模型与任务流

1. CEO 发送消息，主进程写入 `Message`、创建 `TaskRun(queued)` 和审计事件。
2. 主进程验证可用模型与云端外发确认，然后把 TaskRun 标为 `running`。
3. 模型流分片通过预定义 IPC 事件发送；Renderer 仅接收与当前有效 TaskRun 匹配的分片并增量显示。
4. 完成时持久化 Agent 回复，写入 `TaskRun(completed)` 与审计事件。
5. 用户取消时立即将 TaskRun 标为 `cancelled`，终止可中止请求，并丢弃随后抵达的分片。
6. 启动恢复时，所有遗留的 `running` TaskRun 统一标为 `paused`，不会自动恢复模型调用。

首次将云端模型用于项目时，主进程要求确认：提示词、聊天摘要以及未来由工具读取并放入上下文的工作区内容会发送给所选服务商。确认记录按项目和模型配置保存。无 Key 或未确认时，UI 提示配置或授权，不模拟成功回答。

## 错误处理

- 无效、不可访问或链接越界的工作区：拒绝保存并显示原因。
- 缺少模型配置或 Key：阻止运行并引导至设置。
- 401、429、超时和流解析失败：将 TaskRun 标为 `failed`，在聊天流显示失败卡，不写入成功 Agent 消息。
- 取消后的迟到分片：静默丢弃并记录审计事件。
- 数据库初始化失败：显示可恢复的启动错误；不自动删除数据。

## 测试与验收

使用 Vitest 覆盖：

- Project / Channel 持久化和隔离。
- 工作区根路径、相对路径、越界路径与链接逃逸校验。
- TaskRun 状态转换、取消及启动恢复。
- 模型流的成功、失败与取消后分片丢弃。

使用 Playwright 覆盖：

- 新建项目和首个 Channel。
- Channel 切换与持久化消息展示。
- 模型设置保存与 API Key 脱敏。
- 发送、流式展示、失败和取消状态。

完成条件：开发环境可启动；用户可配置兼容 API 并完成一次真实流式单 Agent 对话；自动化测试通过；未配置 API 时不会伪造模型结果。

## 非目标与后续接口

v0.2 在这套模型上增加 Agent CRUD、文件工具、写入审批、进程登记与审批；v0.3 增加 ChannelMember、@ 提及、串行调度、上下文压缩和循环防护。所有新副作用必须复用本期工作区校验、TaskRun 身份和审计机制。
