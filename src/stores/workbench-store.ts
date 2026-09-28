import type { AgentTeamApi, Channel, CreateProjectRequest, Message, ModelConfigSummary, ProjectSummary, SaveModelConfigInput, StreamEvent, TaskRun } from '../../shared/types'

export interface Conversation {
  messages: Message[]
  runs: TaskRun[]
  draft: string
  loaded: boolean
  loading: boolean
  error: string
}
interface PendingMessage { projectId: string; channelId: string; modelConfigId: string; content: string }
interface WorkbenchState {
  projects: ProjectSummary[]
  channels: Channel[]
  models: ModelConfigSummary[]
  projectId: string
  channelId: string
  modelId: string
  conversations: Record<string, Conversation>
  loading: boolean
  sending: boolean
  error: string
  consent: PendingMessage | null
}
export const emptyConversation: Conversation = { messages: [], runs: [], draft: '', loaded: false, loading: false, error: '' }

export function createWorkbenchStore(api: AgentTeamApi) {
  let state: WorkbenchState = { projects: [], channels: [], models: [], projectId: '', channelId: '', modelId: '', conversations: {}, loading: true, sending: false, error: '', consent: null }
  const listeners = new Set<() => void>()
  let selection = 0
  let lifecycle = 0
  let pendingEvents: StreamEvent[] | null = null
  const loadingEvents = new Map<string, StreamEvent[]>()
  const update = (patch: Partial<WorkbenchState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()) }
  const conversation = (id: string) => state.conversations[id] ?? emptyConversation
  const updateConversation = (id: string, patch: Partial<Conversation>) => update({ conversations: { ...state.conversations, [id]: { ...conversation(id), ...patch } } })

  async function reconcileCompletedReply(channelId: string, taskRunId: string) {
    const version = lifecycle
    try {
      const persisted = (await api.messages.list(channelId)).find((message) => message.taskRunId === taskRunId && message.role === 'agent' && message.status === 'completed')
      if (version !== lifecycle) return
      if (!persisted) throw new Error('Completed reply missing')
      const current = conversation(channelId)
      if (!current.runs.some((run) => run.id === taskRunId && run.status === 'completed')) return
      // Replace only this run's draft reply; a later send may already be streaming.
      const messages = current.messages.filter((message) => !(message.taskRunId === taskRunId && message.role === 'agent'))
      const requestIndex = messages.findIndex((message) => message.taskRunId === taskRunId && message.role === 'ceo')
      messages.splice(requestIndex < 0 ? messages.length : requestIndex + 1, 0, persisted)
      updateConversation(channelId, { messages })
    } catch {
      if (version === lifecycle) updateConversation(channelId, { loaded: false, error: '完整回复读取失败，请重新选择群聊重试' })
    }
  }

  function onStream(event: StreamEvent) {
    const entry = Object.entries(state.conversations).find(([, value]) => value.runs.some((run) => run.id === event.taskRunId))
    if (!entry) {
      pendingEvents?.push(event)
      loadingEvents.forEach((events) => events.push(event))
      return
    }
    const [channelId, current] = entry
    if (!current.runs.some((run) => run.id === event.taskRunId && run.status === 'running')) return
    if (event.type === 'complete') {
      updateConversation(channelId, { runs: current.runs.map((run) => run.id === event.taskRunId ? { ...run, status: 'completed', errorMessage: null } : run) })
      void reconcileCompletedReply(channelId, event.taskRunId)
      return
    }
    const replyId = `reply-${event.taskRunId}`
    const existing = current.messages.find((message) => message.taskRunId === event.taskRunId && message.role === 'agent')
    const reply: Message = existing ?? { id: replyId, channelId, taskRunId: event.taskRunId, role: 'agent', authorName: 'AI 助手', content: '', status: 'streaming', createdAt: new Date().toISOString() }
    const messages = current.messages.filter((message) => message.id !== reply.id)
    messages.push({ ...reply, content: reply.content + (event.type === 'delta' ? event.content ?? '' : ''), status: event.type === 'delta' ? 'streaming' : 'failed' })
    updateConversation(channelId, { messages,
      runs: current.runs.map((run) => run.id !== event.taskRunId || event.type === 'delta' ? run : { ...run, status: 'failed', errorMessage: event.content ?? '模型请求失败，请重试' }),
      error: event.type === 'error' ? event.content ?? '模型请求失败，请重试' : current.error,
    })
  }

  async function selectChannel(channelId: string) {
    if (!state.channels.some((channel) => channel.id === channelId)) return
    update({ channelId, consent: null })
    if (conversation(channelId).loaded || conversation(channelId).loading) return
    const version = lifecycle
    loadingEvents.set(channelId, [])
    updateConversation(channelId, { loading: true, error: '' })
    try {
      const [messages, runs] = await Promise.all([api.messages.list(channelId), api.tasks.list(channelId)])
      if (version === lifecycle) {
        const buffered = loadingEvents.get(channelId) ?? []
        const completedReplies = new Set(messages.filter((message) => message.role === 'agent' && message.status === 'completed').map((message) => message.taskRunId))
        const completedEvents = new Set(buffered.filter((event) => event.type === 'complete').map((event) => event.taskRunId))
        const reconciledRuns = runs.map((run): TaskRun => completedReplies.has(run.id) || (run.status === 'running' && completedEvents.has(run.id)) ? { ...run, status: 'completed' } : run)
        updateConversation(channelId, { messages, runs: reconciledRuns, loaded: true, loading: false })
        // Completed persisted replies win over every buffered delta, even if the run snapshot is older.
        buffered.filter((event) => reconciledRuns.some((run) => run.id === event.taskRunId && run.status === 'running')).forEach(onStream)
        for (const run of reconciledRuns) {
          if (run.status === 'completed' && !completedReplies.has(run.id)) void reconcileCompletedReply(channelId, run.id)
        }
      }
    } catch {
      if (version === lifecycle) updateConversation(channelId, { loading: false, error: '群聊记录加载失败，请重新选择群聊重试' })
    } finally { loadingEvents.delete(channelId) }
  }

  async function selectProject(projectId: string) {
    const version = ++selection
    update({ projectId, channelId: '', channels: [], consent: null, error: '' })
    try {
      const channels = await api.channels.list(projectId)
      if (version !== selection) return
      update({ channels })
      if (channels[0]) await selectChannel(channels[0].id)
    } catch { if (version === selection) update({ error: '群聊列表加载失败，请重新选择项目重试' }) }
  }

  async function initialize() {
    const version = ++lifecycle
    update({ loading: true, error: '' })
    try {
      const [projects, models] = await Promise.all([api.projects.list(), api.models.list()])
      if (version !== lifecycle) return
      update({ projects, models, modelId: models[0]?.id ?? '', loading: false })
      if (projects[0]) await selectProject(projects[0].id)
    } catch { if (version === lifecycle) update({ loading: false, error: '工作台加载失败，请检查桌面服务后重试' }) }
  }

  async function dispatch(message: PendingMessage) {
    pendingEvents = []
    try {
      const { taskRunId } = await api.tasks.send({ channelId: message.channelId, modelConfigId: message.modelConfigId, content: message.content })
      const current = conversation(message.channelId)
      const createdAt = new Date().toISOString()
      updateConversation(message.channelId, {
        draft: '', error: '',
        messages: [...current.messages, { id: `ceo-${taskRunId}`, channelId: message.channelId, taskRunId, role: 'ceo', authorName: '主理人', content: message.content, status: 'sent', createdAt }],
        runs: [...current.runs, { id: taskRunId, channelId: message.channelId, modelConfigId: message.modelConfigId, status: 'running', generation: 0, createdAt, startedAt: createdAt, finishedAt: null, errorMessage: null }],
      })
      const earlyEvents = pendingEvents
      pendingEvents = null
      earlyEvents?.filter((event) => event.taskRunId === taskRunId).forEach(onStream)
    } catch { updateConversation(message.channelId, { error: '发送失败，请检查模型配置与云端授权后重试' }) }
    finally { pendingEvents = null; update({ sending: false }) }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect() {
      const unsubscribe = api.events.onStream(onStream)
      void initialize()
      return () => { unsubscribe(); lifecycle++; selection++; pendingEvents = null; loadingEvents.clear() }
    },
    initialize, selectProject, selectChannel,
    setModel: (modelId: string) => update({ modelId, consent: null }),
    setDraft: (draft: string) => updateConversation(state.channelId, { draft }),
    async createProject(input: CreateProjectRequest) {
      const project = await api.projects.create(input)
      update({ projects: [...state.projects, project] })
      await selectProject(project.id)
    },
    async createChannel(name: string) {
      const projectId = state.projectId
      const channel = await api.channels.create({ projectId, name })
      if (state.projectId !== projectId) return
      update({ channels: [...state.channels, channel] })
      await selectChannel(channel.id)
    },
    async saveModel(input: SaveModelConfigInput) {
      const model = await api.models.save(input)
      update({ models: [...state.models.filter((item) => item.id !== model.id), model], modelId: model.id })
    },
    async send() {
      const current = conversation(state.channelId)
      if (state.sending || !current.loaded || !current.draft.trim() || !state.modelId || current.runs.some((run) => run.status === 'running')) return
      const message = { projectId: state.projectId, channelId: state.channelId, modelConfigId: state.modelId, content: current.draft.trim() }
      update({ sending: true })
      try {
        const hasConsent = await api.consent.has(message.projectId, message.modelConfigId)
        if (message.channelId !== state.channelId || message.modelConfigId !== state.modelId) { update({ sending: false }); return }
        if (!hasConsent) { update({ consent: message, sending: false }); return }
        await dispatch(message)
      } catch { updateConversation(message.channelId, { error: '云端授权状态读取失败，请重试' }); update({ sending: false }) }
    },
    dismissConsent: () => update({ consent: null }),
    async grantConsent() {
      const message = state.consent
      if (!message || state.sending) return
      update({ sending: true })
      try {
        await api.consent.grant(message.projectId, message.modelConfigId)
        update({ consent: null })
        await dispatch(message)
      } catch { update({ sending: false }); throw new Error('授权保存失败，请重试') }
    },
    async cancel() {
      const channelId = state.channelId
      const run = conversation(channelId).runs.find((item) => item.status === 'running')
      if (!run) return
      try {
        await api.tasks.cancel(run.id)
        updateConversation(channelId, { runs: conversation(channelId).runs.map((item) => item.id === run.id ? { ...item, status: 'cancelled' } : item) })
      } catch { updateConversation(channelId, { error: '取消未完成，请稍后重试' }) }
    },
  }
}
export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>
