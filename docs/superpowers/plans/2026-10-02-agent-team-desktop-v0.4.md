# Agent Team Desktop v0.4 — implementation and verification

Date: 2026-10-02. Baseline: `02fb582`, v0.3.0. Implement on the current branch.

## Scope and decisions

Deliver PRD 9.3 and the v0.4 roadmap: configured model fallback, the four built-in teams from PRD 1.1 (5 / 5 / 5 / 4 roles), and a preview/import/copy-and-edit template marketplace. Existing untracked PRD, UI specification/prototype and release outputs belong to the user and remain untouched. External template files, a remote marketplace, extra Providers, auto-update and installers are outside this milestone.

Each task is implemented by a sub-agent, independently reviewed and repaired before the next task. The final gate includes a branch-wide independent review and real Electron tests against temporary workspaces and loopback fake Providers.

## Fallback contract

- Each ModelConfig has an optional `fallbackConfigId` pointing to another existing config. Reject self-links, cycles, and paths with more than two fallback transitions. An edit validates all upstream paths, not just the edited node. Referenced configs cannot be deleted; migration preserves populated v16 data and foreign keys.
- 429: retry twice after cancellable 2s and 4s delays. 5xx: one immediate retry. A single network timeout exceeding 30s: one retry. Connection refusal/network transport failure may retry once, except local Ollama refusal gives the actionable service-start message. 401: no retry and no fallback. Other 4xx, malformed protocols, consent/configuration/capability/budget errors, cancellation and stale state do not trigger automatic retries.
- After eligible retries are exhausted, follow the configured fallback chain, at most twice. Every actual candidate has its own configuration snapshot, budget, capability checks, Project/ModelConfig cloud consent and tool-result consent when observations are present. No automatic consent grants.
- Retry and fallback are allowed only before any visible response delta or native tool-call bytes have been observed. Never concatenate output from different attempts or replay tools. Once a Turn has executed a tool, further model hops stay on the successful actual model and do not automatically retry/fallback. Reconstructed previous-effect facts remain subject to exact tool-result consent.
- Attempts have a 30s network deadline and an abortable delay. Keep a 120s aggregate deadline; a whole Agent Turn also keeps its existing 120s ceiling. Scheduler/summary calls receive the same bounded retry policy, with a 120s aggregate ceiling to allow a timed-out attempt to retry. No attempt may outlive cancellation/generation fences.
- Separate configured routing from actual request provenance. TaskRun retains its configured chat model; AgentTurn records configured and actual models. Main records bounded attempt/switch facts, and completed messages/decisions/summaries identify the actual successful model. Failed attempts must not be described as successful output.
- Tools and approval snapshots bind to the actual selected model and a configuration fingerprint, in addition to the existing Run/generation/Turn/member/permission/process/file identities. Never persist credentials in a new policy or return them to Renderer. Membership/config changes cannot terminalize already executing effects before cleanup.
- Version the new model-bound tool policy. On upgrade, invalidate unclaimed legacy pending tool/approval requests with an audit reason rather than inventing historical actual-model identity. Already claimed process/file effects keep their executing/publication/recovery records until proven closed or explicitly recovered; policy migration must not release their Channel barrier.
- Before each outward request and before accepting/persisting output, validate configured routing, the fallback path and candidate snapshots, Run/generation/Turn/member state, and exact consent. A successful fallback is pinned for subsequent tool hops in the Turn. Schema-validation failure from scheduler/summary does not retry as a network failure.
- Exhaustion and missing fallback consent pause for CEO intervention with sanitized, actionable errors. UI displays actual model switches. Primary behavior stays compatible when no fallback is configured.

## Templates contract

- Main owns a static immutable catalog of four teams. Every role has its PRD name, emoji, title, specific system prompt, responsibilities and output format. Prompts must not claim tools were used, fabricate evidence, or authorize side effects. Built-ins contain no credentials, directories or process registrations.
- User chooses an existing model and Channel before importing. One SQLite transaction validates the whole team and creates editable user-owned Agent copies plus enabled Channel memberships; no half-import, no network call and no task starts. Import during an active/paused/cleanup Run is rejected with guidance to finish the task first.
- Copies have `isBuiltin=false` and optional source template ID. Tool permissions default to denied. Repeated imports create unique names that remain unambiguously mentionable in the Channel and never overwrite existing Agents. The catalog is unchanged by Studio edits or deletions.
- Preview shows all roles and prompts. One-click import copies the selected team. Copy-and-edit allows role identity/prompt/model edits using the existing Studio model/permission workflow, then creates a copy; edits cannot mutate the built-in catalog or grant permissions through arbitrary template metadata.

## Task 1 — configuration and model provenance foundation

Add fallback config storage/validation, referential delete checks and safe summaries; record configured/actual model identity and snapshots for Turns, direct chat and auxiliary calls as needed. Extend narrow APIs/types without turning on automatic fallback yet. Extend policy snapshots with actual model fingerprint while preserving existing executing-effect barriers and old-schema behavior.

Verify populated migration, upstream chains/cycles/depth/atomic edits, references, no credential IPC leakage, model/member revocation and approval snapshot compatibility. Commit and obtain independent review.

## Task 2 — bounded retry/fallback runtime

Implement a small reusable attempt policy used by chat/speaker/summary calls; preserve each consumer's response validation. Integrate actual-model callbacks/results into runner, direct-chat commit, Orchestrator and summaries. Bind budgets/consents/provenance at each attempt and pin successful tool-model routing. Persist safe switch facts for UI. Keep all terminal effects and cancellation controls safe.

Verify 429 timing, 5xx, timeout, 401, malformed response, exhausted chains, cancellation during delay/request, config changes, missing consent, small fallback budget, local capability refusal, partial delta/tool-call failure without retry, actual-model tool-result consent and effect exactly-once. Commit and independently review.

## Task 3 — built-in catalog and transactional copies

Implement the four exact PRD teams and typed list/preview/import/copy services, optional Agent source identity and transactional unique-name import. Keep original Studio CRUD behavior.

Verify 5/5/5/4 roles, immutable originals, valid custom copies, default-denied permissions, duplicate import names, rollback on invalid model/Channel/role, concurrent delete/task barriers, persistence after restart and exact IPC allowlist. Commit and independently review.

## Task 4 — configuration/template UI and desktop acceptance

Expose fallback selection and clear chain/status/consent information in Model Hub and chat. Add template cards, previews, team import and copy-to-edit integration with Studio. Refresh models/members safely across navigation and async actions. Update package/lock version to 0.4.0 and future builder output to `release/win-v0.4.0` without building an installer.

Use real Electron UI with fake Providers to verify fallback and actual-model display, independent consent, tool flow, cancellation and no replay; import each team, repeated copies, preview/edit persistence and template isolation. Run full unit suite, type check, build and all legacy/new Electron tests. Perform visual QA and final branch-wide independent review. Record exact verified results and remaining real Provider/Ollama/packaged-native manual checks.

## Completion

All four tasks and independent reviews pass with no unresolved high/medium findings; the PRD v0.4 roadmap is usable in the desktop UI; v0.3 tests and user files are preserved. Automated fake-provider tests do not establish real Provider/Ollama or packaged native-picker behavior.
