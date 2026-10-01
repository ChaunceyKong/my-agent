import type { AgentSummary, AgentTeamApi, AgentTurn, CeoMentionToken, Channel, ChannelAgent, ChannelTaskSnapshot, CreateProjectRequest, Message, ModelConfigSummary, ProjectSummary, SaveModelConfigInput, StreamEvent, TaskRun } from '../../shared/types'
import { updateMentionRanges } from '../components/chat/mention-draft'

export interface Conversation {
  messages: Message[]; runs: TaskRun[]; turns: AgentTurn[]; events: ChannelTaskSnapshot['events']
  agents: AgentSummary[]; members: ChannelAgent[]; schedulerModelConfigId: string | null
  previews: Message[]; draft: string; mentions: CeoMentionToken[]; loaded: boolean; loading: boolean; error: string
}
type Action = { kind: 'send' | 'interrupt' | 'continue' | 'assign'; projectId: string; channelId: string; modelConfigId: string; runId?: string; agentId?: string; content: string; mentions: CeoMentionToken[] }
interface Consent { projectId: string; channelId: string; modelConfigId: string; purposes: string[] }
interface WorkbenchState {
  projects: ProjectSummary[]; channels: Channel[]; models: ModelConfigSummary[]; projectId: string; channelId: string; modelId: string
  conversations: Record<string, Conversation>; loading: boolean; sending: boolean; error: string; consent: Consent | null
}
export const emptyConversation: Conversation = { messages: [], runs: [], turns: [], events: [], agents: [], members: [], schedulerModelConfigId: null,
  previews: [], draft: '', mentions: [], loaded: false, loading: false, error: '' }
const unresolved = (run: TaskRun) => ['running', 'cancelling', 'paused'].includes(run.status)
const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()]

export function createWorkbenchStore(api: AgentTeamApi) {
  let state: WorkbenchState = { projects: [], channels: [], models: [], projectId: '', channelId: '', modelId: '', conversations: {}, loading: true, sending: false, error: '', consent: null }
  const listeners = new Set<() => void>()
  let selection = 0; let lifecycle = 0; let channelRevision = 0; let pendingAction: Action | null = null
  const refreshing = new Map<string, { again: boolean; promise: Promise<void> }>()
  const buffered: StreamEvent[] = []
  const previewBindings = new Map<string, { generation: number; step: number }>()
  const update = (next: Partial<WorkbenchState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
  const conversation = (id: string) => state.conversations[id] ?? emptyConversation
  const patch = (id: string, next: Partial<Conversation>) => update({ conversations: { ...state.conversations, [id]: { ...conversation(id), ...next } } })

  function delta(channelId: string, event: StreamEvent): boolean {
    const current = conversation(channelId)
    const run = current.runs.find((item) => item.id === event.taskRunId)
    if (!run || run.status !== 'running' || event.generation !== run.generation) return false
    const turn = run.currentTurnId ? current.turns.find((item) => item.id === run.currentTurnId && item.status === 'running' && item.generation === run.generation) : undefined
    if (run.currentTurnId && (!turn || event.turnId !== turn.id || event.agentId !== turn.agentId)) return false
    if (!run.currentTurnId && (event.turnId || event.agentId)) return false
    const id = `preview-${turn?.id ?? run.id}`
    const step = event.step ?? 0; const binding = previewBindings.get(id)
    if (binding?.generation === run.generation && step < binding.step) return false
    const old = binding?.generation === run.generation && binding.step === step ? current.previews.find((item) => item.id === id)?.content ?? '' : ''
    previewBindings.set(id, { generation: run.generation, step })
    const agent = current.agents.find((item) => item.id === turn?.agentId)
    const preview: Message = { id, channelId, taskRunId: run.id, agentId: turn?.agentId ?? null, origin: turn ? 'agent' : 'legacy', taskRunSeq: null,
      role: 'agent', authorName: agent?.name ?? 'AI 助手', content: old + (event.content ?? ''), status: 'streaming', createdAt: turn?.startedAt ?? run.startedAt ?? run.createdAt }
    patch(channelId, { previews: [...current.previews.filter((item) => item.id !== id), preview] })
    return true
  }
  async function refreshChannel(channelId = state.channelId) {
    if (!channelId || !state.channels.some((item) => item.id === channelId)) return
    const active = refreshing.get(channelId)
    if (active) { active.again = true; return active.promise }
    const version = lifecycle
    const refresh = { again: false, promise: Promise.resolve() }
    refreshing.set(channelId, refresh)
    refresh.promise = (async () => {
      do {
        refresh.again = false
        try {
          const readRevision = channelRevision
          const snapshot = await api.tasks.snapshot(channelId)
          if (version !== lifecycle || !state.channels.some((item) => item.id === channelId)) return
          const current = conversation(channelId)
          const previews = current.previews.filter((preview) => snapshot.runs.some((run) => run.id === preview.taskRunId && run.status === 'running'
            && previewBindings.get(preview.id)?.generation === run.generation
            && (run.currentTurnId ? preview.id === `preview-${run.currentTurnId}` && snapshot.turns.some((turn) => turn.id === run.currentTurnId && turn.status === 'running') : preview.id === `preview-${run.id}`)))
          // A completed Turn does not complete its collaborative Run.
          patch(channelId, { messages: unique(snapshot.messages), runs: unique(snapshot.runs), turns: unique(snapshot.turns), agents: snapshot.agents, members: snapshot.members,
            schedulerModelConfigId: snapshot.schedulerModelConfigId,
            events: unique(snapshot.events).sort((a, b) => snapshot.runs.findIndex((run) => run.id === a.taskRunId) - snapshot.runs.findIndex((run) => run.id === b.taskRunId) || a.seq - b.seq),
            previews, loaded: true, loading: false,
            mentions: current.mentions.filter((token) => snapshot.members.some((member) => member.agentId === token.agentId && member.isEnabled)),
            error: snapshot.runs.at(-1)?.status === 'failed' ? snapshot.runs.at(-1)?.errorMessage ?? '模型请求失败，请重试' : current.error })
          if (readRevision === channelRevision) update({ channels: state.channels.map((item) => item.id === channelId && snapshot.channel.updatedAt >= item.updatedAt && JSON.stringify(item) !== JSON.stringify(snapshot.channel) ? snapshot.channel : item) })
          const pending = buffered.filter((event) => snapshot.runs.some((run) => run.id === event.taskRunId))
          for (const event of pending) { buffered.splice(buffered.indexOf(event), 1); delta(channelId, event) }
        } catch { if (version === lifecycle) patch(channelId, { loading: false, error: '群聊记录加载失败，请重新加载重试' }) }
      } while (refresh.again && version === lifecycle)
    })().finally(() => { if (refreshing.get(channelId) === refresh) refreshing.delete(channelId) })
    return refresh.promise
  }
  function onStream(event: StreamEvent) {
    const entry = Object.entries(state.conversations).find(([, current]) => current.runs.some((run) => run.id === event.taskRunId))
    const channelId = entry?.[0] ?? state.channelId
    const known = entry?.[1].runs.find((run) => run.id === event.taskRunId)
    if (event.type === 'delta' && known && (known.status !== 'running' || event.generation !== known.generation)) return
    if (event.type === 'delta' && !delta(channelId, event) && buffered.length < 256) buffered.push(event)
    if (event.type !== 'tool_call') void refreshChannel(channelId)
  }
  async function selectChannel(channelId: string) {
    if (!state.channels.some((channel) => channel.id === channelId)) return
    pendingAction = null; update({ channelId, consent: null }); patch(channelId, { loading: !conversation(channelId).loaded, error: '' }); await refreshChannel(channelId)
  }
  async function selectProject(projectId: string) {
    const version = ++selection
    pendingAction = null; update({ projectId, channelId: '', channels: [], consent: null, error: '' })
    try { const channels = await api.channels.list(projectId); if (version !== selection) return; update({ channels }); if (channels[0]) await selectChannel(channels[0].id) }
    catch { if (version === selection) update({ error: '群聊列表加载失败，请重新选择项目重试' }) }
  }
  async function initialize() {
    const version = ++lifecycle; update({ loading: true, error: '' })
    try {
      const [projects, models] = await Promise.all([api.projects.list(), api.models.list()]); if (version !== lifecycle) return
      update({ projects, models, modelId: models.some((model) => model.id === state.modelId) ? state.modelId : models[0]?.id ?? '', loading: false })
      if (projects[0]) await selectProject(projects[0].id)
    } catch { if (version === lifecycle) update({ loading: false, error: '工作台加载失败，请检查桌面服务后重试' }) }
  }
  async function execute(action: Action) {
    try {
      const input = { channelId: action.channelId, modelConfigId: action.modelConfigId, content: action.content, mentions: action.mentions }
      if (action.kind === 'send') await api.tasks.send(input)
      else if (action.kind === 'interrupt') await api.tasks.interrupt(action.runId!, input)
      else if (action.kind === 'assign') await api.tasks.assign(action.runId!, action.agentId!)
      else await api.tasks.continue(action.runId!)
      patch(action.channelId, action.kind === 'send' || action.kind === 'interrupt' ? { draft: '', mentions: [], error: '' } : { error: '' })
      await refreshChannel(action.channelId)
    } catch { patch(action.channelId, { error: '操作未完成，请核对模型授权、审批和任务清理状态后重试' }) }
    finally { update({ sending: false }) }
  }
  async function authorize(action: Action) {
    const current = conversation(action.channelId); const channel = state.channels.find((item) => item.id === action.channelId)
    const requirements = new Map<string, string[]>()
    const add = (id: string, purpose: string) => requirements.set(id, [...(requirements.get(id) ?? []), purpose])
    const enabled = current.members.filter((member) => member.isEnabled)
    if (!enabled.length) add(action.modelConfigId, '普通对话：当前输入、历史消息、既有摘要')
    for (const member of enabled) {
      const agent = current.agents.find((item) => item.id === member.agentId)
      if (agent) add(member.modelConfigOverrideId ?? agent.modelConfigId, `Agent ${agent.name}：角色提示、当前输入、完成的历史与摘要、任务状态、获准的脱敏工具结果`)
    }
    if (current.schedulerModelConfigId && enabled.length) {
      if (channel?.speakerMode === 'automatic' && enabled.length > 1) add(current.schedulerModelConfigId, '自动选人：已启用成员 ID、名称、角色、最近完成消息（最多 3000 字）')
      add(current.schedulerModelConfigId, '每 10 个完成轮次的摘要：此前摘要与已完成的会话前缀，不含原始工具输入')
    }
    for (const [modelConfigId, purposes] of requirements) {
      if (!await api.consent.has(action.projectId, modelConfigId)) {
        if (state.channelId !== action.channelId) { update({ sending: false }); return }
        pendingAction = action; update({ consent: { projectId: action.projectId, channelId: action.channelId, modelConfigId, purposes }, sending: false }); return
      }
    }
    if (state.channelId === action.channelId) { pendingAction = null; update({ consent: null }); await execute(action) } else update({ sending: false })
  }
  async function act(kind: Action['kind'], agentId?: string) {
    const current = conversation(state.channelId); const run = current.runs.find(unresolved)
    if (state.sending || !current.loaded || !state.modelId) return
    if (kind === 'send' && (run || !current.draft.trim())) return
    if (kind === 'interrupt' && (run?.status !== 'running' || !current.draft.trim())) return
    if ((kind === 'continue' || kind === 'assign') && !run) return
    const action: Action = { kind, agentId, runId: run?.id, projectId: state.projectId, channelId: state.channelId, modelConfigId: run?.modelConfigId ?? state.modelId, content: current.draft, mentions: current.mentions }
    update({ sending: true })
    try { await refreshChannel(); await authorize(action) }
    catch { patch(action.channelId, { error: '授权状态读取失败，请重试' }); update({ sending: false }) }
  }
  async function stop(terminate: boolean) {
    const channelId = state.channelId; const run = conversation(channelId).runs.find(unresolved)
    if (!run || state.sending) return
    update({ sending: true })
    try { if (terminate) await api.tasks.terminate(run.id); else await api.tasks.cancel(run.id); patch(channelId, { error: '' }) }
    catch { patch(channelId, { error: '任务仍需安全清理，请查看工具与审批或人工进程核验说明' }) }
    finally { await refreshChannel(channelId); update({ sending: false }) }
  }
  return {
    getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect() {
      const unsubscribe = api.events.onStream(onStream); const timer = setInterval(() => { void refreshChannel() }, 750); void initialize()
      return () => { clearInterval(timer); unsubscribe(); lifecycle++; selection++; buffered.length = 0; pendingAction = null; refreshing.clear(); previewBindings.clear() }
    },
    initialize, selectProject, selectChannel, refreshChannel,
    setModel: (modelId: string) => { pendingAction = null; update({ modelId, consent: null }) },
    setDraft: (draft: string) => { const current = conversation(state.channelId); patch(state.channelId, { draft, mentions: updateMentionRanges(current.draft, draft, current.mentions) }) },
    insertMention(agentId: string, start: number, end: number) {
      const current = conversation(state.channelId); const agent = current.agents.find((item) => item.id === agentId)
      if (!agent || !current.members.some((member) => member.agentId === agentId && member.isEnabled) || current.mentions.some((token) => token.agentId === agentId) || current.mentions.length >= 16) return
      const text = `@${agent.name}`; const draft = current.draft.slice(0, start) + text + ' ' + current.draft.slice(end)
      const mentions = [...updateMentionRanges(current.draft, draft, current.mentions), { agentId, start, end: start + text.length, text }].sort((a, b) => a.start - b.start)
      patch(state.channelId, { draft, mentions })
    },
    async createProject(input: CreateProjectRequest) { const project = await api.projects.create(input); update({ projects: [...state.projects, project] }); await selectProject(project.id) },
    async createChannel(name: string) {
      const projectId = state.projectId; const version = selection; const selectedChannelId = state.channelId
      const channel = await api.channels.create({ projectId, name }); if (state.projectId !== projectId) return
      channelRevision++; update({ channels: [...state.channels, channel] }); if (version === selection && state.channelId === selectedChannelId) await selectChannel(channel.id)
    },
    updateChannel: (channel: Channel) => { if (state.channels.some((item) => item.id === channel.id)) { channelRevision++; update({ channels: state.channels.map((item) => item.id === channel.id ? channel : item) }); void refreshChannel(channel.id) } },
    async removeChannel(channelId: string) {
      const projectId = state.projectId; const version = selection; await api.channels.remove({ channelId, confirmation: 'delete_channel_records' })
      const revision = ++channelRevision; const conversations = { ...state.conversations }; delete conversations[channelId]
      const remaining = state.channels.filter((item) => item.id !== channelId)
      update({ conversations, channels: remaining, consent: state.consent?.channelId === channelId ? null : state.consent, channelId: state.channelId === channelId ? '' : state.channelId })
      let channels = remaining
      try { channels = await api.channels.list(projectId) }
      catch { if (state.projectId === projectId && version === selection && revision === channelRevision) update({ error: '群聊已删除，列表刷新失败，请重新加载工作台' }) }
      if (state.projectId !== projectId || version !== selection) return
      if (revision === channelRevision) update({ channels }); else channels = state.channels
      if (!channels.some((item) => item.id === state.channelId) && channels[0]) await selectChannel(channels[0].id)
    },
    async saveModel(input: SaveModelConfigInput) { const model = await api.models.save(input); update({ models: [...state.models.filter((item) => item.id !== model.id), model], modelId: model.id }) },
    async refreshModels() { const models = await api.models.list(); update({ models, modelId: models.some((model) => model.id === state.modelId) ? state.modelId : models[0]?.id ?? '' }); await refreshChannel() },
    send: () => act('send'), interrupt: () => act('interrupt'), continue: () => act('continue'), assign: (agentId: string) => act('assign', agentId), cancel: () => stop(false), terminate: () => stop(true),
    dismissConsent: () => { pendingAction = null; update({ consent: null }) },
    async grantConsent() {
      const consent = state.consent; const action = pendingAction; if (!consent || !action || state.sending) return
      update({ sending: true })
      try { await api.consent.grant(consent.projectId, consent.modelConfigId, { allowToolResultUpload: true }); await refreshChannel(action.channelId); await authorize(action) }
      catch { update({ sending: false }); throw new Error('授权保存失败，请重试') }
    },
  }
}
export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>
