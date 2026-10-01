# Agent Team Desktop v0.3 设计：多 Agent 串行协同

## 目标、基线与范围

以 PRD 6.1–6.5 和 v0.3 路线图为验收依据：CEO 在一个 Channel 内选择多个 Agent，使用结构化 `@` 指派，或授权调度模型选择下一位；Agent 的已完成回复也可建议唤醒另一位。所有发言、工具、审批和取消归属于同一个有序 TaskRun。默认串行，最多一个当前发言者和一个当前工具效果。

当前 `0eda932` 已有 Agent CRUD、ChannelAgent 模型/权限覆盖、Agent Prompt/模型/权限表单、加密模型配置、Project/Channel 创建和切换、单 Agent 工具循环及 v0.2 的沙箱/审批/审计。缺口是 ChannelAgent 单启用索引及保存时自动禁用、单 Agent 发送路径、无 speaker/turn 身份、上下文压缩、结构化提及和循环控制；Studio 未提供头像编辑，模型中心缺编辑/删除/连通性测试/调度模型及 Ollama，Channel 缺删除和多成员管理。已有能力直接沿用，缺口按下文实施。

不加入并行调度、任意 shell、网页工具、文件删除、模板市场、fallback 链或自动升级 Provider 能力。保留 v0.2 的主进程效果边界、权限交集、审批快照、云端正文和工具结果外发同意、恢复日志与失败关闭策略。`release/` 和未跟踪的原始 PRD/UI 文件由用户保留。

## 数据与迁移

在一个 SQLite 事务中完成版本迁移，保留旧 Agent、ChannelAgent、Message 和 TaskRun 数据：

- 删除 `channel_agents_one_enabled_idx`，保留 `(channel_id, agent_id)` 主键；`saveChannelAgent` 不再自动关闭其他成员。启停或改变覆盖配置继续使相关待执行效果失效。一个 Channel 允许 N 个启用成员，但最多一个活动 TaskRun。
- `channels` 增加 `speaker_mode`（`automatic` / `manual`，默认 `automatic`）、`max_turns`（默认 30，上限 100）和 `scheduler_model_config_id`（可空，空时使用应用默认调度模型）。默认调度模型持久化在单行设置表；引用的配置删除必须先解除引用。
- `messages` 增加可空 `agent_id`、`origin`（`ceo` / `agent` / `legacy`）、`task_run_seq`。旧 Agent 消息标记 `legacy` 且不推断 Agent ID；旧行按现有 `(created_at,id)` 展示。新消息以事务分配的 TaskRun 内序号排序，跨 TaskRun 以创建顺序排序。Agent 提及只解析 `origin=agent`、`status=completed`、`agent_id` 有效的新消息。
- 新增 `task_run_events`：`id`、`task_run_id`、单调递增 `seq`、`generation`、`event_type`、`agent_id?`、`message_id?`、`tool_execution_id?`、有限长度安全元数据、`created_at`；唯一 `(task_run_id,seq)`。事件用于恢复、调度和可解释性，正文继续以 Message 为唯一来源，密钥、原始工具输出和文件正文不复制进事件。
- 新增 `agent_turns`：`id`、`task_run_id`、`ordinal`、`agent_id`、`generation`、`status`（`queued/running/waiting_approval/completed/failed/cancelled`）、`trigger_event_seq`、`message_id?`、`started_at/finished_at`；唯一 `(task_run_id,ordinal)`，每个 TaskRun 至多一个非终态 Turn。`task_runs` 增加 `current_turn_id?`、`turn_count`、`pause_reason?`，并保持现有状态枚举。等待审批仍是 `TaskRun.running`，由 Turn 和 ToolExecution 表示；不要引入仅完成一半的新 TaskRun 状态。
- 新增 `mention_queue`：`task_run_id`、`position`、`agent_id`、`source_message_id`、`source`（`ceo/agent`）、`status`；仅结构化 CEO token 或经验证的已完成 Agent 回复可写入。新增 `session_summaries`：Channel/TaskRun、覆盖的末尾事件序号、摘要正文、模型配置 ID、生成时间；结构化任务事实仍从现有 TaskRun/ToolExecution/Approval/审计记录查询。
- 提议中的提及 token 传 `agentId`、显示区间与原文；Main 验证区间、原文、当前 Channel 启用成员、去重/顺序，拒绝伪造、重名显示名或越界。不要从 CEO 普通文本正则解析 `@`。

升级必须重复启动安全；旧 0/1 成员群聊仍能发送。新增启用成员的能力与 `MessageSend` 切换到 Orchestrator 在同一交付阶段完成，避免多成员已可保存但发送仍取 `.find()` 首位。`modelConfigId` 旧字段用于无 Agent 普通聊天兼容；多 Agent 的每一 Turn 以成员覆盖配置或 Agent 默认配置选择模型。

## 主进程事件与调度

所有状态转换在 Main 的同一 Channel 队列和 SQLite 写事务中分配事件序号；数据库部分唯一索引保证一个 Channel 至多一个 `running` TaskRun。事件至少包含 CEO 消息、提及入队/消费、speaker 决策、Turn 开始/完成、工具等待/决议、摘要版本、暂停/恢复/取消/结束。UI 通过命名 IPC 订阅事件并按序去重；数据库是权威状态。模型分片只更新当前 Turn 的临时展示，完成后才持久化 Agent 消息；序号及 `taskRunId + generation + turnId` 不匹配的迟到分片不得改写状态。现有单 Agent runner 必须改为返回 Turn 结果，不再自行结束整个 TaskRun 或写通用“AI 助手”消息。

选择下一位的顺序：

1. 消费 CEO 结构化提及队列，按出现顺序逐个串行执行；每次消费时重新验证成员仍启用。CEO 多个提及不并发。
2. 消费刚完成的 Agent 消息中的有效提及。仅对完整模型正文按当前成员表解析 `@名称`，名称必须唯一，目标不得为自己、不可停用；重复/未知/重名只显示原因，不路由。工具结果、文件、调度理由和摘要永不解析。
3. 手动模式等待 CEO 指派；无有效指派则把 Run 置 `paused` 并记录 `manual_selection`。
4. 自动模式使用已配置的调度模型；显式显示调度请求将发送的上下文与成员角色摘要，并在云端模型时沿用 Project/ModelConfig 的外发同意。调度模型的选择及摘要调用都单独检查外发同意，缺失即 `paused`，请求 CEO 配置或授权。只接受严格 JSON `{nextSpeaker: agentId|null, reason: string}`、字段/长度界限和当前启用成员校验；不把理由当权限依据。格式错误、超时或无配置均 `paused` 由 CEO 指派，不猜测发言者。`null` 仅在无待审批、运行工具、待验收产物或待处理提及时结束。

每个 Turn 在模型调用前重新取当前 Agent Prompt、模型覆盖和权限交集，构造经预算的上下文。Turn 完成后按单一事务写 Agent Message、完成事件、下一候选；调度决策本身持久化，重启不重复执行已经完成的 Turn。活动模型请求和工具回调均绑定 `taskRunId + generation + turnId + agentId`；切换成员/模型权限触发重新校验和旧效果失效。任一 Channel 同时最多一个 `running` TaskRun，并以数据库约束/事务校验而非仅进程内 Set 保证。

## 上下文、摘要与事实

模型输入按 System Prompt、最新已完成摘要、最近已完成群聊消息、当前触发消息排列；当前输入完整保留。为每个 ModelConfig 配置可选 contextWindow/maxOutputTokens；未知能力用保守硬上限，按 UTF-8 字节和保守 token 估算留输出余量。若 System Prompt + 当前输入已超限则失败关闭并提示 CEO 缩短输入，不能静默截断。消息从最近向前选取，上限默认 20 条；工具结果只用 v0.2 的清洗后观察摘要，且再次检查对应模型的外发同意。

每 10 个已完成 Agent Turn 触发一次摘要，只有在调度模型可用且已获相应外发同意时执行。摘要覆盖事件序号前缀；生成失败保留旧摘要并压缩近期窗口，无法满足预算时暂停。摘要仅是辅助文字，不能替代结构化 TaskRun 目标、审批结果、工具事实、产物路径和验收状态。摘要文本、文件正文和工具结果不会触发提及或授权。

## 失控防护、插话和恢复

最多 30 个完成或启动的 Agent Turn（Channel 可配置），同一 Agent 连续 3 Turn、`A→B→A→B` 重复 3 次均暂停并给 CEO 可见原因。单 Agent 模型调用 120 秒超时；工具调用继续使用 v0.2 边界，新增 60 秒单工具超时的可取消调用约束，无法可靠中止的效果进入现有待清理/恢复状态，不伪称已取消。调度和摘要请求同样有限时及 AbortSignal。暂停后只能由 CEO 明确指派或继续，且再次校验预算/成员/同意。

CEO 插话按事务先停止旧 Turn、使 TaskRun generation 递增并进入取消流程，再 Abort 模型及可取消工具；保留已有不可逆效果和审计，丢弃旧代次后续分片/请求/回调。确认旧 Run 已终止或处于需人工恢复的安全状态后，才为新 CEO 消息创建 Run。正常取消、重启恢复、成员撤权均遵循代次栅栏。审批等待期间不启动下一位 Agent；批准只按现有 requestHash/generation/policy snapshot 执行已批准效果，拒绝/过期仍安全终止该 Turn。v0.3 不自动从待审批点重放模型调用；CEO 明确点击“继续”后，以新的 Turn/代次和已持久化的结果摘要重建上下文。不能完成的效果先进入恢复处理并暂停 Run。重启时 `running` Run/Turn 置 `paused`、递增 generation，不能自动重放调度、工具或批准。

## 模型中心、Channel 和 Studio 的 v0.3 缺口

- 模型中心在现有加密存储上增加配置编辑/删除（有引用时拒绝）、有限时连通性测试、默认调度模型选择。密钥只在 Main 解密，不经 Renderer 回显；连接测试显示安全摘要。Ollama 自动发现固定本机地址/用户明确配置的本机地址，通过有限时 `/api/tags` 列模型，按已验证兼容能力走本地聊天适配；无 API Key，不称本地为云端，也不绕过工具能力校验。模型不支持原生工具调用时只提供无工具对话。
- Studio 补头像/身份名片编辑及 Channel 内独立启停、模型/权限覆盖 UI；权限始终与 Agent 默认值求交集。
- Channel 补删除前确认，删除事务必须处理未完成 Run/审批和依赖；运行中先取消且等安全终态，不以级联删除掩盖未完成效果。保留多个 Channel 的隔离、创建和切换。

## 界面与验收

Composer 用成员选择器插入结构化提及，显示多目标顺序。群聊显示每条 Agent 消息的真实 Agent 身份、当前发言者、选人理由摘要、等待审批、暂停原因、轮数和 CEO“指派/继续/取消”操作。调度失败或云端同意缺失时呈可恢复的暂停，不自动改选。Renderer 无 Node、文件、密钥或任意 IPC 能力。

重点测试：从旧 v10 数据迁移后 0/1 成员兼容；N 成员启停及权限撤销；CEO 多提及顺序；Agent 完成输出有效/无效/重名提及；文件/工具/摘要注入不触发；无配置/未同意/非法调度 JSON 只暂停；摘要预算和结构化事实；循环、超时、插话、重启与旧代次效果；审批等待/批准后显式继续；双发送竞争仍只产生一个活动 Run。Electron E2E 使用临时工作区及本机假 Provider 验证串行群聊和 UI，不使用真实密钥。真实外部 Provider 和原生 Windows 交互另列手工验收。
