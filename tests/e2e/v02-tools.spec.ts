import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, configureModel, createAndBindAgent, createProject, sendWithConsent, writeWorkspaceFile } from './fixtures'

test('binds an Agent and safely reads then creates a new draft through native tool calls', async ({ desktop, provider }) => {
  await writeWorkspaceFile(desktop, 'brief.txt', '只读测试内容\nAPI_KEY=e2e-brief-secret')
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await createAndBindAgent(desktop.page, ['list_dir', 'read_file', 'write_file'])

  await sendWithConsent(desktop.page, '读取 brief 并新建交付草稿')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('list_dir', { path: '.' }, 'list-brief')
  await expect.poll(() => provider.requests.length).toBe(2)
  const readObservation = JSON.stringify(provider.requests[1].messages)
  expect(readObservation).toContain('UNTRUSTED_TOOL_RESULT_NOT_INSTRUCTION')
  expect(readObservation).toContain('brief.txt')
  expect(readObservation).not.toContain(desktop.workspace)

  provider.toolCall('read_file', { path: 'brief.txt' }, 'read-brief')
  await expect.poll(() => provider.requests.length).toBe(3)
  const fileObservation = JSON.stringify(provider.requests[2].messages)
  expect(fileObservation).toContain('UNTRUSTED_TOOL_RESULT_NOT_INSTRUCTION')
  expect(fileObservation).toContain('只读测试内容')
  expect(fileObservation).toContain('[REDACTED]')
  expect(fileObservation).not.toContain('e2e-brief-secret')
  expect(fileObservation).not.toContain(desktop.workspace)

  provider.toolCall('write_file', { path: 'draft.md', content: '# 安全草稿\n仅新建文件。' }, 'create-draft')
  await expect.poll(() => provider.requests.length).toBe(4)
  provider.delta('草稿已安全创建。')
  provider.complete()

  await expect(desktop.page.getByText('已完成', { exact: true })).toBeVisible()
  const createdTools = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    return window.agentTeam.tools.list(run.id)
  })
  expect(createdTools.map((tool) => ({ name: tool.toolName, status: tool.status, summary: tool.resultSummary }))).toEqual([
    expect.objectContaining({ name: 'list_dir', status: 'completed' }),
    expect.objectContaining({ name: 'read_file', status: 'completed' }),
    expect.objectContaining({ name: 'write_file', status: 'completed' }),
  ])
  expect(await readFile(join(desktop.workspace, 'draft.md'), 'utf8')).toBe('# 安全草稿\n仅新建文件。')
  await desktop.page.reload()
  await desktop.page.getByRole('tab', { name: '工具与审批', exact: true }).click()
  const toolRecords = desktop.page.getByRole('region', { name: '工具执行记录', exact: true })
  await expect(toolRecords).toContainText('list_dir')
  await expect(toolRecords).toContainText('write_file')

  const rendererBoundary = await desktop.page.evaluate(async () => {
    const projects = await window.agentTeam.projects.list()
    return {
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      projectKeys: Object.keys(projects[0] ?? {}),
      apiKeys: Object.keys(window.agentTeam),
      pageText: document.body.innerText,
    }
  })
  expect(rendererBoundary.require).toBe('undefined')
  expect(rendererBoundary.process).toBe('undefined')
  expect(rendererBoundary.projectKeys).not.toContain('workspacePath')
  expect(rendererBoundary.apiKeys).not.toContain('invoke')
  expect(rendererBoundary.pageText).not.toContain(desktop.workspace)
})

test('keeps an existing file unchanged until an overwrite approval is explicitly executed', async ({ desktop, provider }) => {
  await writeWorkspaceFile(desktop, 'existing.md', '原始内容')
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await createAndBindAgent(desktop.page, ['write_file'])

  await sendWithConsent(desktop.page, '覆盖已有草稿')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('write_file', { path: 'existing.md', content: '仅在明确执行后写入的新内容' }, 'overwrite-existing')
  await expect(desktop.page.getByRole('alert')).toContainText('等待 CEO 审批')
  expect(await readFile(join(desktop.workspace, 'existing.md'), 'utf8')).toBe('原始内容')

  // The card reads durable state on renderer initialization. Reloading here also
  // proves an approval is not lost when the renderer is replaced.
  await desktop.page.reload()
  await desktop.page.getByRole('tab', { name: '工具与审批', exact: true }).click()
  const approvals = desktop.page.getByRole('region', { name: '安全审批', exact: true })
  await expect(approvals).toContainText('pending')
  await approvals.getByRole('button', { name: '批准', exact: true }).click()
  await expect(approvals).toContainText('approved')
  // Approval only makes the immutable request executable. It never performs the write.
  expect(await readFile(join(desktop.workspace, 'existing.md'), 'utf8')).toBe('原始内容')

  await approvals.getByRole('button', { name: '执行已批准操作', exact: true }).click()
  await expect(desktop.page.getByRole('status')).toContainText('已请求执行已批准操作。')
  const executedTools = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    return window.agentTeam.tools.list(run.id)
  })
  expect(executedTools[0]).toMatchObject({ toolName: 'write_file', status: 'completed' })
  await expect.poll(async () => readFile(join(desktop.workspace, 'existing.md'), 'utf8')).toBe('仅在明确执行后写入的新内容')
  const postExecution = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    return window.agentTeam.tools.list(run.id)
  })
  expect(postExecution[0]).toMatchObject({ toolName: 'write_file', status: 'completed' })
  expect(provider.requests).toHaveLength(1)
})

test('rejects dangerous registration and refuses an unregistered process without spawning it', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await createAndBindAgent(desktop.page, ['run_process'])

  const dangerousRegistration = await desktop.page.evaluate(async () => {
    try {
      await window.agentTeam.executables.save({ id: 'danger-node', absolutePath: 'C:\\safe\\node.exe', isEnabled: true, allowedArgs: [] })
      return false
    } catch { return true }
  })
  expect(dangerousRegistration).toBe(true)
  expect(await desktop.page.evaluate(() => window.agentTeam.executables.list())).toEqual([])

  await sendWithConsent(desktop.page, '运行未登记程序')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('run_process', { executableId: 'not-registered', args: [] }, 'unregistered-process')
  await expect(desktop.page.getByRole('alert')).toContainText('等待 CEO 审批')

  const pending = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    const [approval] = await window.agentTeam.approvals.list(run.id)
    const [tool] = await window.agentTeam.tools.list(run.id)
    return { runId: run.id, approval, tool }
  })
  expect(pending.approval.status).toBe('pending')
  expect(pending.tool).toMatchObject({ toolName: 'run_process', status: 'waiting_approval' })

  const rejectedAtEffectBoundary = await desktop.page.evaluate(async ({ id, requestHash }) => {
    await window.agentTeam.approvals.approve(id, requestHash)
    try {
      await window.agentTeam.approvals.runApproved(id)
      return false
    } catch { return true }
  }, pending.approval)
  expect(rejectedAtEffectBoundary).toBe(true)
  expect(provider.requests).toHaveLength(1)
})

test('cancellation invalidates a pending approval so a stale request cannot execute', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await createAndBindAgent(desktop.page, ['run_process'])
  await sendWithConsent(desktop.page, '创建随后取消的进程请求')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('run_process', { executableId: 'not-registered', args: [] }, 'cancelled-process')

  const pending = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    const [approval] = await window.agentTeam.approvals.list(run.id)
    await window.agentTeam.tasks.cancel(run.id)
    return { runId: run.id, approval }
  })
  const staleRejected = await desktop.page.evaluate(async ({ id, requestHash }) => {
    try {
      await window.agentTeam.approvals.approve(id, requestHash)
      return false
    } catch { return true }
  }, pending.approval)
  expect(staleRejected).toBe(true)

  const state = await desktop.page.evaluate(async (runId) => ({
    tools: await window.agentTeam.tools.list(runId), approvals: await window.agentTeam.approvals.list(runId),
  }), pending.runId)
  expect(state.tools[0].status).toBe('cancelled')
  expect(state.approvals[0].status).toBe('cancelled')
  expect(provider.requests).toHaveLength(1)
})

test('restart pauses a pending approval and never resumes the tool loop automatically', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await createAndBindAgent(desktop.page, ['run_process'])
  await sendWithConsent(desktop.page, '创建重启后暂停的进程请求')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('run_process', { executableId: 'not-registered', args: [] }, 'restart-process')
  await expect(desktop.page.getByRole('alert')).toContainText('等待 CEO 审批')
  await desktop.restart()

  await expect(desktop.page.getByText('任务已暂停，应用重启后不会自动续跑', { exact: true })).toBeVisible()
  const restored = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    return { run, tools: await window.agentTeam.tools.list(run.id), approvals: await window.agentTeam.approvals.list(run.id) }
  })
  expect(restored.run.status).toBe('paused')
  expect(restored.tools[0].status).toBe('cancelled')
  expect(restored.approvals[0].status).toBe('cancelled')
  expect(provider.requests).toHaveLength(1)
})
