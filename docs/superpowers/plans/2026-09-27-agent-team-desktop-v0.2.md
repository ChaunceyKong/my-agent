# Agent Team Desktop v0.2 Implementation Plan

**Goal:** Deliver a single-Agent, approval-gated local-tool workflow that safely reads workspace files, creates drafts, and performs controlled destructive actions only after CEO approval.

**Architecture:** Electron Main owns Agent persistence, tool validation, filesystem/process effects, approvals, auditing and model tool loops. Preload adds named typed methods only; React renders Agent settings, tool/approval cards and a safe workspace tree. Existing uncommitted v0.1 changes are user-owned baseline and must be preserved.

**Tech Stack:** Electron, React, TypeScript, SQLite/Drizzle, Electron safeStorage, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-agent-team-desktop-v0.2-design.md`

## Global Constraints

- Do not reset, stage, overwrite, reformat or otherwise modify the user-owned v0.1 local changes unless an implementation change necessarily overlaps; report overlap before editing.
- Main is the only process allowed filesystem, child-process, database, credential and model-tool-loop access.
- Tools use schema-validated names and parameter objects. No tool takes a shell string, executable path from a model, or generic IPC call.
- File targets remain within the canonical Project root after lexical and `lstat`/`realpath` validation. Reject absolute paths, traversal, links escaping root, `.env`, credential paths and `.git`.
- Standard mode auto-runs reads/searches and creates only non-existing files; overwrites/replacements/processes wait for approval; delete is absent.
- Approval binds taskRunId, generation, requestHash and policy snapshot; cancellation, expiry, mismatch or unavailable policy fails closed.
- API keys, raw file contents, complete command output and model error payloads never appear in audit records or unauthorized UI data.
- A Channel has at most one enabled Agent and one live TaskRun.

---

### Task 1: Agent and Channel membership persistence

**Files:**
- Create: `electron/core/agent-service.ts`, `tests/unit/agent-service.test.ts`
- Modify: `electron/database/schema.ts`, `electron/database/repositories.ts`, `shared/types.ts`, `shared/ipc-channels.ts`, `electron/ipc/register-handlers.ts`, `electron/preload.ts`

**Produces:** `Agent`, `ChannelAgent`, `ToolPermissions`, Agent/Channel membership CRUD, and named IPC operations.

- [ ] Write tests that create/update/list an Agent, reject a missing model config, and prove enabling a second ChannelAgent disables the prior enabled member in one transaction.
- [ ] Run: `npm test -- tests/unit/agent-service.test.ts` and record the expected missing-module failure.
- [ ] Add migration tables, repositories and Main-only IPC handlers. Expose summaries through preload; never return system prompts beyond the requested editor record or credentials.
- [ ] Run targeted tests plus `npm test`, `npx tsc --noEmit`, and `npm run build`.
- [ ] Commit only Task 1 files, excluding existing user-owned dirty files unless an overlap is reported and accepted.

### Task 2: File sandbox and read-only tools

**Files:**
- Create: `electron/core/file-sandbox.ts`, `electron/core/file-tools.ts`, `tests/unit/file-sandbox.test.ts`, `tests/unit/file-tools.test.ts`
- Modify: `electron/core/workspace-validator.ts`, `shared/types.ts`

**Produces:** `resolveSafePath`, `listDirectory`, `readTextFile`, `searchTextFiles` and bounded tool-result summaries.

- [ ] Write tests for absolute paths, traversal, prefix confusion, `.env`, `.git`, symlink/reparse escape, binary input, over-limit input and safe nested files.
- [ ] Run focused tests and confirm RED before implementation.
- [ ] Implement canonical parent validation with `path.relative`, `lstat` and `realpath`; limit file size/results and return summaries rather than uncontrolled content.
- [ ] Run focused tests, full tests, TypeScript and build.
- [ ] Commit Task 2 files.

### Task 3: Tool execution, atomic draft creation and audit state

**Files:**
- Create: `electron/core/tool-engine.ts`, `electron/core/audit-service.ts`, `tests/unit/tool-engine.test.ts`
- Modify: `electron/database/schema.ts`, `electron/database/repositories.ts`, `electron/core/task-run-service.ts`, `shared/types.ts`

**Produces:** `ToolExecution`, tool request validation, atomic non-conflicting `write_file`, audited result summaries and risk classification.

- [ ] Write failing tests proving nonexistent targets create atomically, existing targets create a pending approval instead of changing data, and a racing target appearance becomes pending approval.
- [ ] Implement transactionally persisted tool state, requestHash and policy snapshots; write new files through verified-parent temporary file plus rename.
- [ ] Verify no file body enters `AuditEvent`; verify cancellation/generation invalidates a pending execution.
- [ ] Run full unit suite, type check and build; commit Task 3.

### Task 4: Approval gate and registered-process execution

**Files:**
- Create: `electron/core/approval-service.ts`, `electron/core/process-tool.ts`, `tests/unit/approval-service.test.ts`, `tests/unit/process-tool.test.ts`
- Modify: `electron/database/schema.ts`, `electron/database/repositories.ts`, `electron/core/tool-engine.ts`, `shared/types.ts`, `shared/ipc-channels.ts`, `electron/ipc/register-handlers.ts`, `electron/preload.ts`

**Produces:** immutable approval requests, approve/reject/expire IPC, registered executable CRUD and `shell:false` process execution.

- [ ] Write failing tests for one-time approval, stale requestHash, expired request, cancelled task, unauthorized executable, shell metacharacters and process abort on cancellation.
- [ ] Implement a five-minute expiry and immutable snapshots. Only approved current requests may execute.
- [ ] Register executables in settings; resolve the stored absolute path, validate independent arguments, run with fixed workspace cwd and `shell:false`.
- [ ] Run all relevant tests, full suite, TypeScript and build; commit Task 4.

### Task 5: Single-Agent model tool loop and UI

**Files:**
- Create: `electron/core/single-agent-runner.ts`, `src/components/agents/AgentManager.tsx`, `src/components/chat/ToolCard.tsx`, `src/components/chat/ApprovalCard.tsx`, `src/components/layout/WorkspaceTree.tsx`, `tests/unit/single-agent-runner.test.ts`
- Modify: `electron/ipc/register-handlers.ts`, `electron/preload.ts`, `src/App.tsx`, `src/stores/workbench-store.ts`, `src/styles/app.css`, `src/App.test.tsx`

**Produces:** structured tool loop with a maximum step limit, tool/approval rendering, Agent CRUD/Channel assignment, and workspace tree refresh.

- [ ] Add failing tests for a safe read/create loop, maximum-step failure, pending approval pause, rejected approval feedback, and no renderer-side privileged access.
- [ ] Implement Main runner that validates model tool output before ToolEngine; return tool summaries to the model only through the same TaskRun generation.
- [ ] Add UI cards and management dialogs with Chinese accessible names; use explicit unavailable states where a feature is not implemented.
- [ ] Run renderer/unit tests, TypeScript and build; commit Task 5.

### Task 6: End-to-end security acceptance

**Files:**
- Create: `tests/e2e/v02-tools.spec.ts`
- Modify: `tests/e2e/fixtures.ts`, `playwright.config.ts`

**Produces:** repeatable Electron E2E safety coverage.

- [ ] Write E2E scenarios for Agent creation/binding, safe draft creation, overwrite approval, process rejection, cancelled stale approval and restart-paused approval.
- [ ] Use a loopback OpenAI-compatible fixture and temporary workspace. Never use real credentials or a user workspace.
- [ ] Run `npm test && npm run build && npm run test:e2e`, then manually verify one user-approved real model and native directory chooser session.
- [ ] Commit Task 6 and prepare a branch-wide final review.

## Plan Self-Review

- All v0.2 spec sections map to a task: persistence (1), sandbox read tools (2), safe creation/audit (3), approval/process controls (4), model/UI loop (5), and desktop acceptance (6).
- The plan preserves user-owned v0.1 local changes and makes no deletion feature.
- Every side effect has a focused failing-test checkpoint and a complete verification checkpoint.
