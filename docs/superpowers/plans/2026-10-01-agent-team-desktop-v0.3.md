# Agent Team Desktop v0.3 Implementation Plan

**Goal:** Deliver PRD v0.3 serial multi-Agent collaboration on the v0.2 safety foundation.

**Architecture:** Electron Main owns event ordering, speaker selection, context, model/tool calls, cancellation and persistence. Preload exposes named typed calls; React renders membership, mentions and Turn state. Keep one active TaskRun and one active Agent Turn per Channel. Implement each task on current `main`, then have a separate read-only agent review that task before starting the next.

**Spec:** `docs/superpowers/specs/2026-10-01-agent-team-desktop-v0.3-design.md`

## Invariants for every task

- Preserve untracked `docs/PRD.md`, `docs/UI_DESIGN_SPEC.md`, `docs/ui_prototype.html` and user-owned `release/`. Stage only task files. Do not reset or broadly clean the workspace.
- Main alone owns database, model requests, filesystem/process effects, approvals and credentials. No generic renderer IPC or interpretation of file/tool/summary text as instructions.
- Keep v0.2 Agent-default ∩ Channel-override tool permissions, exact approval effect bindings and cloud/tool-result consent. A Turn, tool or approval can act only for its current TaskRun generation and current enabled membership.
- One Channel has at most one running TaskRun and one nonterminal Turn. Approval wait blocks all subsequent speakers while TaskRun remains `running`.
- New side effects require meaningful regression tests; each task runs focused tests, full `npm test`, `npx tsc --noEmit`, `npm run build`, `git diff --check`. Independent review inspects changed code and tests, and fixes are re-reviewed.

## Task 1 — Durable event and Turn foundation, no multi-enable yet

**Likely files:** `electron/database/schema.ts`, `electron/database/repositories.ts`, `shared/types.ts`, new `electron/core/orchestrator-events.ts`, focused unit tests.

- Add idempotent migration for TaskRun ordered events, Agent Turn, mention queue and summary records, Message agent identity/provenance, Channel mode/budget/scheduler config. Add a database partial unique index for one `running` TaskRun per Channel. Backfill old Message provenance as `legacy`; do not infer an Agent identity.
- Keep the old unique enabled-member index and old send path in this task. Add transactional event-sequence allocation, one active Turn check, atomic TaskRun/message/event creation, and restart recovery that pauses Turn and invalidates generation.
- Verify v10 database migration with old 0/1 member chats, unique sequence under concurrent appends, no duplicate active Turn, restart without replay, no content or secrets copied into event metadata.
- Commit only Task 1 and obtain an independent review before Task 2.

## Task 2 — Atomic serial cutover and CEO structured mentions

**Likely files:** `electron/core/serial-orchestrator.ts`, `electron/core/single-agent-runner.ts`, `electron/core/task-run-service.ts`, `electron/database/repositories.ts`, `electron/database/schema.ts`, `electron/ipc/register-handlers.ts`, `electron/preload.ts`, `shared/types.ts`, `shared/ipc-channels.ts`, focused tests.

- Build Main serial Turn runner using the existing single-Agent model/tool loop and its approval, consent and file/process services. Refactor the existing runner to return a Turn outcome instead of finishing TaskRun or inserting a generic assistant message; the Orchestrator commits the real speaker Message and decides whether to continue. Bind each stream/tool effect to `taskRunId + generation + turnId + agentId` and verify enabled membership/model/permissions at start and before effect.
- In one reviewed commit, drop `channel_agents_one_enabled_idx`, stop `saveChannelAgent` from disabling peers, and replace `MessageSend`'s first-enabled-member path with the serial orchestrator. Preserve 0/1 member behavior; no-member ordinary chat stays supported.
- Accept CEO MentionTokens only from the composer schema. Validate ranges, source content, current enabled IDs, bounded count, order and duplicate handling in Main; persist ordered queue and consume one speaker at a time. Without a token and before automatic routing exists, pause with an explicit manual-selection reason.
- Verify multiple enabled members persist, two structured mentions run in order, malformed/disabled/forged token fails, concurrent sends yield one active Run, revoked member loses effect rights, approval wait blocks next Turn, legacy single Agent still works.
- Commit and independently review the migration plus routing cutover as one security-sensitive change.

## Task 3 — Agent mentions and automatic speaker selection

**Likely files:** new `electron/core/mention-parser.ts`, `electron/core/speaker-selector.ts`, `electron/core/model-client.ts`, `electron/core/serial-orchestrator.ts`, persistence and tests.

- Parse suggestions only after a completed Agent Message has a valid `agentId`. Match names against current enabled members, require a unique target and reject self/unknown/ambiguous/disabled targets. Do not inspect tools, files, summaries, legacy messages or partial streams for routing.
- Add explicit scheduler ModelConfig setting and a bounded Main model call. Require external-send consent for that exact Project/ModelConfig before scheduling; expose a preview of sent categories in UI later. Strictly validate `{nextSpeaker,reason}` and current membership; `null` completes only when no queue, approval, active tool or unaccepted artifact remains. Bad/missing model, consent, JSON or selection pauses for CEO instruction.
- Verify member changes between model decision and Turn start, invalid JSON, null while pending work, no consent, duplicate names, Agent ping-pong suggestions and untrusted-source injection.
- Commit and independently review.

## Task 4 — Bounded context and summaries

**Likely files:** new `electron/core/context-manager.ts`, summary service, `electron/core/serial-orchestrator.ts`, model-config types/schema/repository and tests.

- Build prompts from Agent Prompt, latest completed summary, newest completed messages and full current input. Use model-specific context window when known and conservative fallback otherwise; reserve output budget. If mandatory layers exceed budget, pause with an actionable error.
- Every 10 completed Agent Turns, summarize only a covered event prefix. Require the chosen model's external-send consent and retain old summary on failure. Read structured TaskRun/tool/approval facts from records, not the summary. Keep v0.2 sanitized tool observations and tool-result consent on each model hop.
- Verify long multilingual input, model budget uncertainty, summary failure/retry, no loss of current message, exact covered sequence, consent per Provider, tool observations not promoted into instructions.
- Commit and independently review.

## Task 5 — Loop limits, cancellation, interruption and explicit resume

**Likely files:** `electron/core/serial-orchestrator.ts`, `electron/core/task-run-service.ts`, model/tool timeout boundaries, repository transitions, named IPC and tests.

- Enforce Channel max Turns (default 30), three same-Agent consecutive Turns, repeated `A→B→A→B` cycles, 120-second Agent model timeout and bounded scheduler/summary/tool calls. Pauses show a reason and need CEO action.
- CEO interruption increments old Run generation and cancels old Turn before creating the next Run. Abort cancellable calls, fence late chunks/tool results and preserve any already committed effect. Restart pauses without re-running a decision or tool.
- Approval wait leaves Run `running` and blocks another Turn. Approval executes only the immutable prior request; CEO explicit continue starts a fresh Turn/generation from persisted safe facts. Rejection/expiry/cancellation and recovery states cannot silently restart.
- Verify stop-vs-file effect race, old-generation chunks, two competing CEO sends, interrupt while approval pending, timeout of model/process, process cleanup pending, restart and explicit resume.
- Commit and independently review.

## Task 6 — PRD v0.3 configuration gaps

**Likely files:** `electron/core/model-client.ts`, `electron/database/repositories.ts`, `electron/ipc/register-handlers.ts`, `shared/types.ts`, `src/components/settings/SettingsDialog.tsx`, `src/components/agent/AgentManager.tsx`, Channel UI and tests.

- Extend Model Hub with edit, reference-aware delete, bounded connection test and default scheduler ModelConfig. Preserve encrypted key handling and do not expose keys or raw Provider errors. Add Ollama local model discovery and compatible local chat path; validate capabilities before enabling native tools, no fabricated tool call from prose.
- Complete existing Studio identity card with avatar editing; retain current Prompt/model/tool-permission editor. Add Channel-specific member enable/disable and model/permission overrides. Add Channel delete confirmation and safe handling of active Run/approval before removing records.
- Verify missing Ollama, invalid local endpoint/model, key never returned, model in use cannot delete, Channel deletion while a side effect is pending, revoked override cannot grant Agent-denied tool.
- Commit and independently review. If this task is too large, split Model Hub and Studio/Channel into two sequential reviewed commits without expanding scope.

## Task 7 — Collaborative UI and desktop acceptance

**Likely files:** `src/components/chat/Composer.tsx`, `src/components/chat/MessageStream.tsx`, `src/components/agent/AgentManager.tsx`, `src/App.tsx`, store, styles, preload/IPC types and `tests/e2e/v03-collaboration.spec.ts`.

- Add member picker inserting structured mentions, ordered chips, current speaker/Agent identity, Turn/approval/pause state, safe scheduling reason, CEO assign/continue/cancel controls and clear consent prompt for scheduling/summary calls. Keep UI display derived from persisted state after reload.
- Use temporary workspace and loopback fake Providers for Electron E2E: CEO @A,@B in order, completed Agent @handoff, automatic schema decision, manual fallback, approval barrier, CEO interrupt and restart. Validate no stale stream/tool effect leaks across generations and no secrets sent to Renderer.
- Run focused tests, full unit suite, type check, build and Electron E2E. Conduct branch-wide independent final review. Manual acceptance: user-approved real model session, Ollama installed/running if available, and packaged Windows native directory picker. Do not claim these as automated passes.
- Commit reviewed Task 7; report exact passing checks and remaining manual checks.

## Completion gate

All seven tasks have implementation commits and independent reviews with no unresolved high/medium findings. The desktop test proves serial multi-Agent flow, approval and cancellation safety. Existing v0.1/v0.2 behavior and user-owned files are preserved. No v0.3 installer is generated unless separately requested.
