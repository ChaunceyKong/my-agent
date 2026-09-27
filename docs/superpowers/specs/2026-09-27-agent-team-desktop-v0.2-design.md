# Agent Team Desktop v0.2 设计：单 Agent 安全交付闭环

## 目标与范围

v0.2 在已完成的 v0.1 单模型聊天、Project/Channel、TaskRun 与云端确认基础上，实现单 Agent 受限工具交付。用户可以创建一个 Agent、授予它当前 Channel 的最小工具权限，并在聊天中让它安全读取、检索、创建草稿、请求覆盖现有文件或运行已登记程序。

本期交付：

- Agent 数据模型、CRUD 与 Agent 管理界面。
- 每 Channel 的单 Agent 选择、启停与工具权限覆盖。
- 主进程工具协议、文件沙箱、只读文件工具和新文件原子写入。
- 覆盖替换与已登记进程的审批、过期、取消和审计闭环。
- 右侧安全文件树、聊天流工具卡与审批卡。

本期不提供多个 Agent 的调度、Agent 间提及、并行执行、网页访问、删除文件、任意 shell、插件系统或自动化模板市场。这些属于 v0.3 及以后。

## 基线与兼容性

当前工作区中未提交的 v0.1 修改（目录选择器拆分为命名 IPC、默认首个 Channel、相关测试与界面修改）是用户保留的基线。v0.2 不重置、覆盖、暂存或改写这些修改；开发与测试以它们为前提。

Project 是唯一工作区根；所有 Channel 共享 Project 工作区但拥有独立 Agent 选择、消息、TaskRun、审批和审计记录。

## 授权与工具边界

工具权限由三个维度相交决定：

1. Agent 的默认 `ToolPermissions`。
2. 当前 Channel 对该 Agent 的覆盖权限。
3. Channel 的审批模式：宽松、标准（默认）或严格。

模型只能输出 schema 校验过的工具请求，字段只能是工具名和独立参数。工具名称、工作区路径、已登记可执行程序、审批决定与 IPC 都不能由模型文本直接控制。模型文本、读取的文件和工具输出都是不可信数据。

工具清单：

| 工具 | 风险 | 标准模式 |
| --- | --- | --- |
| `list_dir`、`read_file`、`search_files` | 低 | 自动执行 |
| `write_file`，且目标不存在 | 中 | 原子创建并通知 |
| `write_file` 目标已存在、`replace_file_content` | 高 | 等待审批 |
| `run_process` | 高 | 等待审批 |

没有删除工具。未配置权限、工具未知、状态不匹配、取消、过期、审批不可用和任何校验错误都失败关闭。

## 数据模型

新增持久化实体：

- `agents`：id、name、avatar、title、systemPrompt、modelConfigId、defaultToolPermissions、isBuiltin、createdAt、updatedAt。
- `channel_agents`：channelId、agentId、isEnabled、modelConfigOverrideId、toolPermissionsOverride、createdAt、updatedAt；v0.2 仅允许一个 `isEnabled` 成员。
- `tool_executions`：id、taskRunId、messageId、agentId、toolName、inputJson、riskLevel、requestHash、policySnapshotJson、status、resultSummary、createdAt、updatedAt。
- `approval_requests`：id、toolExecutionId、requestHash、decision、comment、requestedAt、expiresAt、decidedAt。
- `registered_executables`：id、displayName、absolutePath、allowedArgsPolicy、isEnabled、createdAt、updatedAt。

迁移必须可重复执行。敏感正文、API Key、完整命令输出不写入审计；仅存相对路径、内容哈希、字节数、退出码和截断摘要。

## 文件沙箱

每次文件操作使用当前 Project 已验证根目录并执行以下顺序：

1. 拒绝绝对路径、空路径、NUL、`..` 越界和平台保留设备名。
2. 用 `path.resolve` 与 `path.relative` 作词法边界判断，不能用字符串前缀。
3. 对根目录和所有存在父级执行 `lstat` 加 `realpath`；解析后的路径必须仍在根内，拒绝符号链接或重解析点逃逸。
4. 拒绝 `.env`、密钥/凭据目录及显式敏感文件名；`.git` 只读策略本期默认拒绝。
5. 新文件仅可在经验证的真实父目录内写入临时文件，然后原子 rename；若目标在写入前出现则升级为审批。

`list_dir`、`read_file` 与 `search_files` 只返回大小受限、编码验证后的内容或摘要；二进制与超大文件不进入模型上下文。

## 审批与执行状态

TaskRun 仍为单 Channel 串行单位。工具请求携带 `taskRunId`、generation、工具参数、权限快照和 `requestHash`。

```text
running
  -> tool_requested
  -> executing -> running
  -> waiting_approval -> approved -> executing -> running
  -> waiting_approval -> rejected | expired | cancelled
  -> completed | failed | cancelled
```

批准只对完全相同的 requestHash、TaskRun generation 和 policy snapshot 有效。审批 5 分钟后自动 `expired`；用户拒绝、取消 TaskRun、切换为新的 generation 或 Agent 被禁用后，所有待执行副作用均失效。每个转换生成脱敏 `AuditEvent`。

## 进程执行

`run_process` 只接受设置中预先登记的 `executableId` 和参数数组。Main 解析登记的绝对路径，验证当前 Agent/Channel 的授权和每个参数的该程序白名单策略，以已验证工作区为 `cwd` 用 `spawn` 或 `execFile` 和 `shell: false` 启动。

不接受命令字符串、管道、重定向、环境变量注入或 Agent 指定可执行路径。审批通过前不得创建子进程；取消或超时终止仍可终止的子进程并丢弃迟到输出。

## 模型与界面流

单 Agent 运行把 Agent system prompt、已授权工具 schema 与经预算的近期消息发送给模型。工具请求先进入主进程验证和状态机；完成结果仅以受限摘要回填下一轮模型上下文。工具循环有最大步数，超过后 TaskRun 失败并提示 CEO。

UI 新增：

- Agent 管理页：创建、编辑、删除前检查引用、模型绑定和默认权限矩阵。
- Channel 设置：选择一个启用 Agent 与 Channel 权限覆盖。
- 聊天工具卡：工具、相对路径或注册程序、状态及安全摘要。
- 审批卡：风险原因、不可变参数摘要、到期时间、批准/拒绝；未提供“修改参数后直接执行”。
- 右侧工作区 Tab：安全列出的目录结构和刚生成文件通知。

所有 UI 数据经命名、类型化 preload IPC 获取；Renderer 不接触 Node、文件、子进程、API Key 或完整审批策略内部数据。

## 错误与恢复

- 工具参数/schema 错误、未授权、路径越界、敏感文件、过大/二进制输入：拒绝并在工具卡显示安全错误。
- 审批超时、取消或快照失配：不执行副作用，持久化终态审计。
- 程序失败：记录退出码和截断 stderr 摘要；不将完整环境或密钥发送到 UI/模型。
- 异常退出：`running`/`waiting_approval` TaskRun 恢复为 `paused`；待审批操作不自动继续，子进程不自动重启。

## 验收与测试

Vitest 覆盖：

- Agent 与 ChannelAgent CRUD、单启用约束与权限交集。
- 路径前缀伪造、绝对路径、`..`、链接逃逸、`.env` 与 `.git` 拒绝。
- 新建原子写入、并发目标冲突升级审批、读取/搜索的大小与编码限制。
- requestHash、审批快照、拒绝、过期、重复批准、取消与迟到工具事件。
- 已登记可执行文件、参数数组、禁止 shell 元字符、取消时中止子进程。
- 单 Agent 工具循环的成功、最大步数与安全错误回填。

Electron E2E 覆盖：创建 Agent、将其绑定 Channel、读取工作区、创建新草稿、请求覆盖并批准、拒绝进程执行、重启后恢复 paused 审批状态。真实模型 Provider 和本机程序登记由手动验收完成，不用测试凭据伪造成功。

## 非目标后的接口

v0.3 会建立在 `channel_agents`、TaskRun generation、结构化工具事件和审批状态机之上，实现多 Agent 串行路由、@ 提及、上下文压缩和循环防护。不得为预期的并行调度放宽 v0.2 的单 Channel 单执行约束。
