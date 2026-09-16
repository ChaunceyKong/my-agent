# Agent Team Desktop v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, runnable Electron desktop foundation with project-scoped channels and real OpenAI-compatible streaming chat.

**Architecture:** Electron main owns SQLite, workspace validation, task state and model calls. A narrow preload bridge exposes typed IPC to a React/Zustand renderer that reproduces the three-column workbench. The app has no v0.1 write, command, approval, Agent Studio, or multi-Agent side effects.

**Tech Stack:** Electron, electron-vite, React, TypeScript, Zustand, Drizzle ORM with better-sqlite3, Electron safeStorage, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-agent-team-desktop-v0.1-design.md`

## Global Constraints

- Electron main process is the only process allowed to access SQLite, the filesystem, native dialogs, model credentials, and network model calls.
- The preload bridge must use `contextBridge`; no generic `ipcRenderer` and no Node API are exposed to Renderer.
- A Project has exactly one validated workspace root and can have many Channels; Channels share files but not messages or TaskRuns.
- No v0.1 IPC writes files, replaces files, deletes files, or executes commands.
- API keys are encrypted with Electron `safeStorage` and are never returned over IPC; UI can only receive a configured / masked state.
- A cloud model needs explicit per-project-and-model external-data confirmation before a request runs.
- TaskRun IDs gate all stream chunks. Cancelled, failed, completed, paused, or unknown TaskRuns reject later chunks.
- Startup converts persisted `running` TaskRuns to `paused`; it never resumes a model request automatically.
- UI copy is Chinese and follows `docs/UI_DESIGN_SPEC.md`; the three columns must remain functional at desktop widths.

---

## File Structure

```text
package.json                              # scripts and dependencies
electron.vite.config.ts                   # main/preload/renderer bundling
electron/main.ts                          # app lifecycle and IPC registration
electron/preload.ts                       # narrow typed bridge
electron/database/client.ts               # SQLite + Drizzle initialization
electron/database/schema.ts               # persisted entities
electron/database/repositories.ts         # project/channel/message/task/model operations
electron/core/workspace-validator.ts      # workspace and future child path validation
electron/core/task-run-service.ts         # state transition and recovery rules
electron/core/model-client.ts             # OpenAI-compatible streaming request
electron/ipc/register-handlers.ts         # IPC ownership and handlers
shared/types.ts                           # domain and IPC payload types
shared/ipc-channels.ts                    # channel constants
src/main.tsx                              # renderer entry
src/App.tsx                               # route-free workbench composition
src/stores/workbench-store.ts             # renderer state and IPC subscriptions
src/components/layout/*                   # header, navigation, right panel
src/components/chat/*                     # message stream, composer, state/error cards
src/components/settings/*                 # model settings and consent dialog
src/styles/app.css                        # prototype-aligned layout and tokens
tests/unit/*.test.ts                      # main-process domain tests
tests/e2e/*.spec.ts                       # rendered-workbench flows
playwright.config.ts                      # Electron E2E launcher
```

### Task 1: Scaffold the Electron application and typed boundary

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `electron/main.ts`, `electron/preload.ts`, `shared/types.ts`, `shared/ipc-channels.ts`, `src/main.tsx`, `src/App.tsx`, `src/styles/app.css`, `tests/unit/ipc-contract.test.ts`

**Interfaces:**
- Produces: `window.agentTeam` with `projects`, `channels`, `models`, `tasks`, and `events` namespaces; `IpcChannel` string constants.
- Consumes: no application code.

- [ ] **Step 1: Write the failing IPC contract test**

```ts
import { IpcChannel } from '../../shared/ipc-channels'

it('defines only the v0.1 renderer-to-main commands', () => {
  expect(Object.values(IpcChannel)).toEqual(expect.arrayContaining([
    'project:create', 'project:list', 'channel:create', 'channel:list',
    'message:send', 'task-run:cancel', 'model:save', 'model:list',
  ]))
  expect(Object.values(IpcChannel)).not.toContain('tool:run')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/ipc-contract.test.ts`

Expected: FAIL because the package and shared modules do not exist.

- [ ] **Step 3: Add the minimal application scaffold**

Create electron-vite scripts (`dev`, `build`, `test`, `test:e2e`), TypeScript configurations for main/preload/renderer, and the channel constants. Define the public bridge as:

```ts
export interface AgentTeamApi {
  projects: { list(): Promise<Project[]>; create(input: CreateProjectInput): Promise<Project> }
  channels: { list(projectId: string): Promise<Channel[]>; create(input: CreateChannelInput): Promise<Channel> }
  models: { list(): Promise<ModelConfigSummary[]>; save(input: SaveModelConfigInput): Promise<ModelConfigSummary> }
  tasks: { send(input: SendMessageInput): Promise<{ taskRunId: string }>; cancel(taskRunId: string): Promise<void> }
  events: { onStream(listener: (event: StreamEvent) => void): () => void }
}
```

Use `contextBridge.exposeInMainWorld('agentTeam', api)` and a `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and a preload path.

- [ ] **Step 4: Run static checks and the contract test**

Run: `npm test -- tests/unit/ipc-contract.test.ts && npm run build`

Expected: PASS; Electron main, preload, and renderer bundles are produced.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json electron.vite.config.ts tsconfig.json electron shared src tests/unit/ipc-contract.test.ts
git commit -m "feat: scaffold Electron workbench"
```

### Task 2: Persist projects and channels with validated workspace roots

**Files:**
- Create: `electron/database/client.ts`, `electron/database/schema.ts`, `electron/database/repositories.ts`, `electron/core/workspace-validator.ts`, `tests/unit/workspace-validator.test.ts`, `tests/unit/project-repository.test.ts`
- Modify: `electron/ipc/register-handlers.ts`, `shared/types.ts`

**Interfaces:**
- Consumes: `CreateProjectInput`, `CreateChannelInput`, `Project`, `Channel` from `shared/types.ts`.
- Produces: `validateWorkspaceRoot(path: string): Promise<string>`, `createProjectWithInitialChannel(input): Promise<{ project: Project; channel: Channel }>`, `listChannels(projectId): Promise<Channel[]>`.

- [ ] **Step 1: Write failing workspace and repository tests**

```ts
it('rejects a missing workspace root', async () => {
  await expect(validateWorkspaceRoot('Z:/does-not-exist')).rejects.toThrow('工作区路径不存在')
})

it('creates exactly one initial channel in a project', () => {
  const { project, channel } = createProjectWithInitialChannel({
    name: '测试项目', icon: '📁', workspacePath: fixtureRoot, firstChannelName: '主线任务协同群',
  })
  expect(channel.projectId).toBe(project.id)
  expect(listChannels(project.id)).toHaveLength(1)
})
```

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/unit/workspace-validator.test.ts tests/unit/project-repository.test.ts`

Expected: FAIL because the validator and repository do not exist.

- [ ] **Step 3: Implement SQLite schema, migration, validator, and IPC handlers**

Create `projects` and `channels` tables with foreign keys. Configure a test database path through an explicit dependency-injected factory. Resolve workspace roots using `realpath`, verify access, and return canonical roots. Register `project:list`, `project:create`, `channel:list`, and `channel:create`; `project:create` must invoke the native directory picker only when the Renderer requests browsing, and must revalidate the selected path in main.

```ts
export async function validateWorkspaceRoot(candidate: string): Promise<string> {
  await fs.access(candidate, fs.constants.R_OK)
  return fs.realpath(candidate)
}
```

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/unit/workspace-validator.test.ts tests/unit/project-repository.test.ts`

Expected: PASS, including canonical-root storage and Project/Channel isolation.

- [ ] **Step 5: Commit persistence and root validation**

```bash
git add electron/database electron/core/workspace-validator.ts electron/ipc shared tests/unit
git commit -m "feat: persist projects and channels safely"
```

### Task 3: Implement TaskRun lifecycle, messages, audit events, and recovery

**Files:**
- Create: `electron/core/task-run-service.ts`, `tests/unit/task-run-service.test.ts`
- Modify: `electron/database/schema.ts`, `electron/database/repositories.ts`, `electron/ipc/register-handlers.ts`, `shared/types.ts`

**Interfaces:**
- Consumes: existing Project/Channel repository operations.
- Produces: `startTaskRun(channelId, modelConfigId, content): TaskRun`, `cancelTaskRun(id): TaskRun`, `finishTaskRun(id, result): TaskRun`, `recoverInterruptedTaskRuns(): number`, `canAcceptChunk(id): boolean`.

- [ ] **Step 1: Write failing task-state tests**

```ts
it('changes unfinished runs to paused during recovery', () => {
  createRunningTaskRun(channel.id)
  expect(recoverInterruptedTaskRuns()).toBe(1)
  expect(getTaskRun(channel.id).status).toBe('paused')
})

it('rejects chunks after cancellation', () => {
  const run = startTaskRun(channel.id, model.id, '请分析')
  cancelTaskRun(run.id)
  expect(canAcceptChunk(run.id)).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/task-run-service.test.ts`

Expected: FAIL because TaskRun tables and service functions do not exist.

- [ ] **Step 3: Add stateful persistence and event records**

Create `messages`, `task_runs`, and `audit_events` tables. Enforce legal transitions: `queued -> running -> completed|failed|cancelled`, and `running -> paused` only during recovery. `message:send` writes the CEO message, TaskRun, and audit record in one transaction; `task-run:cancel` records cancellation and returns no tool capability.

- [ ] **Step 4: Run the task-state tests**

Run: `npm test -- tests/unit/task-run-service.test.ts`

Expected: PASS, including restart recovery and late-chunk rejection.

- [ ] **Step 5: Commit task lifecycle**

```bash
git add electron/core/task-run-service.ts electron/database electron/ipc shared tests/unit/task-run-service.test.ts
git commit -m "feat: add durable task run lifecycle"
```

### Task 4: Add encrypted model configuration, consent, and streaming model client

**Files:**
- Create: `electron/core/model-client.ts`, `electron/core/cloud-consent-service.ts`, `tests/unit/model-client.test.ts`, `tests/unit/cloud-consent-service.test.ts`
- Modify: `electron/database/schema.ts`, `electron/database/repositories.ts`, `electron/ipc/register-handlers.ts`, `shared/types.ts`

**Interfaces:**
- Consumes: `TaskRunService.canAcceptChunk`, `ModelConfigSummary`, `StreamEvent`.
- Produces: `saveModelConfig(input): ModelConfigSummary`, `recordCloudConsent(projectId, modelConfigId): void`, `requireCloudConsent(projectId, modelConfigId): void`, `streamChat(input, onEvent): Promise<void>`.

- [ ] **Step 1: Write failing safety and stream tests**

```ts
it('never returns apiKey when saving a model config', async () => {
  const saved = await saveModelConfig({ providerPreset: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-chat', apiKey: 'secret' })
  expect(saved).not.toHaveProperty('apiKey')
  expect(saved.hasApiKey).toBe(true)
})

it('does not emit a chunk once its run is cancelled', async () => {
  await streamChat({ taskRunId: cancelledRun.id, messages: [] }, emit)
  expect(emit).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/model-client.test.ts tests/unit/cloud-consent-service.test.ts`

Expected: FAIL because configuration, consent and client modules do not exist.

- [ ] **Step 3: Implement a single OpenAI-compatible client**

Store an encrypted API key in `model_configs` using `safeStorage` behind an injectable crypto adapter for tests. Support `openai` and `deepseek` presets only as base-URL defaults. Require a persisted consent row for each `(projectId, modelConfigId)` before any request. Parse server-sent stream data into `{ taskRunId, type: 'delta'|'complete'|'error', content? }`; before every emission call `canAcceptChunk`.

- [ ] **Step 4: Run the targeted tests**

Run: `npm test -- tests/unit/model-client.test.ts tests/unit/cloud-consent-service.test.ts`

Expected: PASS for credential masking, consent rejection, stream completion, network failure, and cancellation.

- [ ] **Step 5: Commit model streaming**

```bash
git add electron/core/model-client.ts electron/core/cloud-consent-service.ts electron/database electron/ipc shared tests/unit
git commit -m "feat: add consented streaming model chat"
```

### Task 5: Build the prototype-aligned three-column workbench

**Files:**
- Create: `src/stores/workbench-store.ts`, `src/components/layout/AppHeader.tsx`, `src/components/layout/ProjectNavigation.tsx`, `src/components/layout/RightCockpit.tsx`, `src/components/chat/MessageStream.tsx`, `src/components/chat/Composer.tsx`, `src/components/settings/SettingsDialog.tsx`, `src/components/settings/CloudConsentDialog.tsx`, `src/components/common/EmptyState.tsx`
- Modify: `src/App.tsx`, `src/styles/app.css`, `shared/types.ts`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `window.agentTeam` bridge and `StreamEvent` from shared types.
- Produces: project creation, channel selection, model settings, consent, message send, cancellation and stream rendering flows.

- [ ] **Step 1: Write failing renderer behavior tests**

```tsx
it('creates a project and selects its initial channel', async () => {
  render(<App />)
  await userEvent.click(screen.getByRole('button', { name: '新建项目' }))
  await userEvent.type(screen.getByLabelText('项目名称'), '内容矩阵')
  await userEvent.click(screen.getByRole('button', { name: '确认创建项目' }))
  expect(await screen.findByText('主线任务协同群')).toBeVisible()
})

it('appends valid model stream deltas to the agent reply', async () => {
  emitStream({ taskRunId: 'run-1', type: 'delta', content: '正在分析' })
  expect(await screen.findByText('正在分析')).toBeVisible()
})
```

- [ ] **Step 2: Run renderer tests to verify they fail**

Run: `npm test -- src/App.test.tsx`

Expected: FAIL because the renderer components and store are not implemented.

- [ ] **Step 3: Implement functional UI state and components**

Use the design spec's header, 256px left navigation, main chat, and collapsible 320px right cockpit. Add project/channel dialogs, settings dialog, cloud consent dialog, empty states, CEO message bubbles, Agent stream bubbles, error card, and a cancel button while a TaskRun is running. Right cockpit tabs must render real project/channel metadata and explicit unavailable states rather than simulated agents or files.

```ts
onStream(event) {
  if (event.taskRunId !== get().activeTaskRunId) return
  if (event.type === 'delta') set(state => ({ draftReply: state.draftReply + event.content }))
}
```

- [ ] **Step 4: Run renderer tests and production build**

Run: `npm test -- src/App.test.tsx && npm run build`

Expected: PASS; production renderer bundle is generated.

- [ ] **Step 5: Commit the workbench**

```bash
git add src shared src/App.test.tsx
git commit -m "feat: add project channel chat workbench"
```

### Task 6: Connect IPC end-to-end and validate desktop behavior

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/workbench.spec.ts`, `tests/e2e/fixtures.ts`
- Modify: `electron/main.ts`, `electron/ipc/register-handlers.ts`, `package.json`

**Interfaces:**
- Consumes: all public preload bridge APIs and production renderer.
- Produces: repeatable Electron E2E test entry point.

- [ ] **Step 1: Write failing Electron E2E tests**

```ts
test('creates a project, switches its channel, and persists the navigation', async ({ page }) => {
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByLabel('项目名称').fill('演示项目')
  await page.getByRole('button', { name: '确认创建项目' }).click()
  await expect(page.getByText('主线任务协同群')).toBeVisible()
  await page.reload()
  await expect(page.getByText('演示项目')).toBeVisible()
})

test('shows a configuration prompt instead of fabricating an Agent response', async ({ page }) => {
  await page.getByPlaceholder('输入任务…').fill('测试')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('请先配置模型')).toBeVisible()
})
```

- [ ] **Step 2: Run E2E tests to verify they fail**

Run: `npm run test:e2e`

Expected: FAIL until Electron launch, test-data paths, and UI selectors are wired.

- [ ] **Step 3: Add deterministic E2E startup and selectors**

Configure a separate temporary user-data directory per test run. Ensure app startup invokes interrupted-run recovery before the Renderer loads. Add accessible names and test IDs only where semantic roles are insufficient. The UI must show a configuration error for an unconfigured model and must not generate an Agent message.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run build && npm run test:e2e`

Expected: PASS. Manually run `npm run dev`, create a project using the native chooser, configure a real OpenAI-compatible model, approve the cloud disclosure, and complete one streaming reply.

- [ ] **Step 5: Commit end-to-end coverage**

```bash
git add electron package.json playwright.config.ts tests/e2e
git commit -m "test: verify desktop workbench flow"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 provide the Electron boundary, project/channel schema, workbench structure, and root validation. Task 3 provides messages, TaskRuns, audit events, cancel and recovery. Task 4 provides encrypted OpenAI-compatible configuration, disclosure consent, streams, and error behavior. Task 5 implements the specified renderer. Task 6 verifies the desktop application and no-config behavior. v0.1 non-goals remain absent.
- **Placeholder scan:** No `TODO`, `TBD`, deferred implementation instruction, or undefined task reference remains in this plan.
- **Type consistency:** `Project`, `Channel`, `ModelConfigSummary`, `TaskRun`, `StreamEvent` and `AgentTeamApi` originate in Task 1; later tasks name the exact consuming interfaces. Task 3's `canAcceptChunk` is consumed by Task 4 and the Renderer gates events by `activeTaskRunId` in Task 5.
