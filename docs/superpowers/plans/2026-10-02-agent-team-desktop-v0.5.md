# Agent Team Desktop v0.5 — polish and release plan

Date: 2026-10-02. Baseline: `c9c988d`, v0.4.0. Continue on the current branch. Scope: PRD v0.5 roadmap and the directly related sections 14.2 / 15.

## Working boundaries

- Each scoped task is implemented by a sub-agent, independently reviewed, and repaired before the next task starts. The final gate includes a whole-scope independent review.
- Preserve the user's untracked `docs/PRD.md`, `docs/UI_DESIGN_SPEC.md`, `docs/ui_prototype.html`, and existing `release/` artifacts. Never stage these original files or overwrite old releases. New v0.5 packages, when built, go only to a separate versioned directory.
- Retain v0.4 cancellation, exact consent, fallback, tool approval/effect barriers, immutable templates, and narrow typed IPC. Renderer must not gain Node, secrets, arbitrary file/log paths, update feed editing, or process access.
- Windows is the available verification host. macOS/Linux build configuration is not evidence of successful builds, signing, installation, or platform-specific security tests. Do not claim those platforms verified without corresponding hosts.
- No remote publication, certificate creation, installation, real Provider requests, or automatic restart. New package dependencies must be limited to necessary release functionality, not a broad dependency upgrade.
- Pending user choice: trusted update provider/repository or HTTPS feed, signing identities, and release hosting credentials. Updater integration may be developed and fake-adapter tested without these, but remains disabled with an actionable status and zero network requests until an approved build-time configuration exists. Never invent a remote endpoint.

## Task 1 — themes

Implement light / dark / system selection in the existing header, visible even without a project. Default to system. Persist only the bounded theme preference in Renderer storage; deny invalid persisted values and tolerate unavailable storage. Use `matchMedia` for system changes, dispose listeners, and apply the effective theme before initial React render to avoid a light flash. No theme IPC or database migration is needed.

Make existing components, inputs, dialogs, chat, metadata, approvals, template prompts, status/error cards and focus states legible in both themes using shared color tokens. Keep layout and component behavior unchanged; do not use a global invert filter or inject rendered content into styles.

Verify preference changes, persistence, invalid values, storage errors, live system changes and cleanup with unit tests. Add real Electron tests for explicit themes across restart, system behavior and representative dialogs/template preview, with screenshots for independent visual inspection. Independently review before Task 2.

## Task 2 — controlled global errors and diagnostic logs

Add a Renderer error boundary and friendly unexpected-error recovery without silently resuming tasks or retrying effects. Treat network status as a browser connectivity hint, not proof that a Provider or local Ollama is available. Preserve existing specific controlled model/approval/recovery guidance; do not weaken safety to match speculative PRD recovery examples (no automatic destructive database reset, no truncating the user's goal, no malformed-tool retry after effects).

Main owns bounded date-rotated diagnostic logs retaining seven days and a native export dialog. Log controlled codes and safe context only, not arbitrary Error stacks/messages, model prompts, Provider bodies, file contents, absolute workspace paths, API keys or encrypted credentials. New Renderer error reporting, if needed, accepts a strict allowlist of codes, not free-form payloads. Log export is an explicit user operation through narrow IPC with Main-chosen paths. Catch startup/window failures and report safely; fatal Main errors exit safely rather than continuing in an unknown state. Test retention, redaction-by-construction, rejected payloads, export cancellation/errors, and UI recovery fences.

## Task 3 — measured long-conversation performance

Establish a reproducible synthetic long-conversation baseline. Bound mounted message rows with a minimal variable-height virtual/windowed list that retains access to all history, preserves scroll anchors when reading history, follows new output only near the bottom, and keeps complete durable messages distinct from stream previews. Retain author/actual-model provenance and accessible log behavior.

Coalesce burst stream-driven snapshot refreshes while preserving generation/Turn guards, terminal refreshes and the existing poll fallback. Lazy-load only noncritical heavy UI when measurements justify it. Do not debounce away the first visible token, hide older history permanently, change dispatch timing/consent, or impose a new history storage limit. Verify mounted row bounds, older history navigation, streaming updates, cancellation/stale events and functional E2E; record measured results without presenting development timings as packaged performance guarantees.

## Task 4 — updater integration

Integrate `electron-updater` in Main using the installed electron-builder v26 compatible contract. Use build-time trusted feed configuration only. Disable automatic download and install-on-quit; expose sanitized fixed-state status/check/download/install actions through narrow IPC. No calls in development, unsupported portable modes, or unconfigured builds. No metadata URLs/release HTML/raw updater errors to Renderer.

Require explicit user actions for download and restart/install. Recheck all durable task, process, approval and unclosed publication/recovery barriers before install; reject while any remain unresolved. Main must own an exclusive `install-pending` gate: entry into that state and the final barrier check are serialized with task/effect entry points, including already accepted but not yet executed operations. Reject new Runs, resumes, tool executions and other side-effect entry points until actual exit; reject installation when a preexisting operation is still in flight. Clear the gate on install failure or cancellation, without releasing any durable cleanup barrier. Verify delayed-exit interleavings and blocked new work with fake adapters. Do not terminate tasks to install an update. Handle concurrent checks/actions, progress bounds and unsupported/unavailable/error states honestly. Keep signing verification enabled; do not bypass certificate checks to make a test pass. Fake adapters verify the state machine and zero-network unavailable mode. Real signed update verification remains blocked until release infrastructure is supplied and tested.

Reference: [electron-builder v26 auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/). macOS updates require signing and the ZIP metadata target in addition to DMG; Windows auto-update uses NSIS, not portable EXE.

## Task 5 — release configuration and Windows package verification

Update product/lock/display version to `0.5.0`; add explicit Windows NSIS/portable, macOS DMG/ZIP and Linux AppImage build scripts/configuration without publishing. Use a separate `release/win-v0.5.0` output for Windows, and platform-specific directories for other hosts. Inspect native SQLite packaging and runtime dependencies; do not assume a development build proves ASAR/native-module correctness.

Build Windows artifacts without overwriting existing user releases. Smoke-test the packaged executable against isolated userData/workspace with no external model requests, verify database creation, theme persistence, narrow preload access and native directory selection where feasible. Record artifact hashes/sizes and whether signing is present. Do not install the app or publish artifacts without explicit authorization. macOS/Linux build and signed-update delivery remain manual/host-dependent acceptance items.

## Task 6 — final desktop acceptance

Run the complete unit suite with one worker, type check, build and all old/new real Electron tests. Validate light/dark/system views visually, unexpected-error recovery, long-history interaction and update-unavailable states as well as the existing fallback/template/approval/cancellation paths. Obtain final independent whole-scope review and repair findings. Record exact results, Windows artifact paths, observed performance and all unverified infrastructure/platform checks in `docs/V0.5_ACCEPTANCE.md`.

## Completion rule

Do not label the entire v0.5 release complete merely because Task 1 or a build configuration passes. All implemented stages require independent review. If release/update infrastructure or platform hosts are missing, report the delivered local functionality separately from the blocked release acceptance, including the exact user decision or external evidence still needed.

## Progress — 2026-10-02

Task 1 is implemented and independently reviewed PASS at `1ca4728`. Task 2 is independently reviewed PASS at `a628817`. Task 3 is independently reviewed PASS at `b8e7b30`. No unresolved findings remain in these stages. Tasks 4–6 have not started; the next implementation scope is updater integration. Product version remains `0.4.0` until the release configuration stage.

- Theme implementation: `68efa28`. Full single-worker unit suite 529/529, all real Electron tests 37/37, type check, build and diff check passed at that commit.
- Visual QA found native dark placeholder contrast of 3.55:1. The scoped CSS/E2E fix `1ca4728` uses the muted token for input and textarea placeholders. Real computed-style assertions measured 5.06:1 in light and 7.73:1 in dark.
- After that style-only fix: theme unit tests 10/10, theme Electron tests 5/5, type check, build and diff check passed. The entire suite was not rerun for this final one-rule style patch.
- The independent reviewer separately ran theme/App unit tests 28/28, type check and diff check, and locked the final review to `1ca4728`.
- Root inspected all six regenerated light/dark settings, validation/focus and template-preview screenshots in `test-results/`; visual QA passed. Screenshots are disposable test outputs, not release artifacts. System-color changes were simulated with Chromium media emulation in the real Electron app.
- No dependencies, IPC or database changes, no package build, and no external model requests. Original untracked user documents retained their initial SHA-256; existing `release/` artifacts were untouched.
- Trusted update hosting and signing configuration are still pending user input; no automatic update network or publication operation was introduced.

## Task 2 progress — 2026-10-03

- Implementation commit: `a628817`. Main records only UTC timestamps, fixed diagnostic codes and allowlisted sources. Logs use `logs/error-YYYY-MM-DD.log`, rather than a single active `error.log`; each day is capped at 64 KiB, with seven UTC dates retained. Export reads at most seven bounded files and reconstructs allowlisted records, discarding injected fields/content instead of copying raw files.
- Renderer has only typed code reporting and explicit native-dialog export returning exported/cancelled status, never an output path. Export cancellation writes nothing; failures show fixed guidance. Native dialogs were substituted in Electron Main for automated export tests; manual OS chooser interaction was not separately verified.
- Friendly render/global error recovery does not replay, continue or cancel tasks. Browser offline status remains a hint and does not disable local/Ollama controls. Main fatal handling reports fixed guidance and exits; it does not claim that external processes were terminated or durable cleanup barriers resolved. Existing startup retry/exit and task recovery fences remain intact.
- Implementation agent completed the full single-worker unit suite: 544/544. Root verified type check, build, diff check and the final complete real Electron suite: 40/40 (2.8 minutes). No external Provider requests were made; model tests use loopback fixtures.
- The earlier full Electron run failed one new 900px recovery test because the expanded narrow-window cockpit intercepted its send click. The final test uses the normal collapse button before sending, retaining real React fault injection, reload, unchanged request count, one completed write effect and durable file assertions. The separate offline/banner test keeps the cockpit expanded and checks header/panel geometry and theme controls.
- Independent review found and repaired two P2 issues: an unsupported Vitest assertion and banner-induced cockpit/header overlap. The reviewer independently reran scoped tests 37/37, type check and diff check. Final review PASS is locked to `19e09df..a628817`, with no unresolved findings.
- Root visually inspected all four regenerated light/dark error-boundary and narrow-window banner screenshots; fixed guidance and controls are legible, and the cockpit no longer overlays the header. Screenshots are disposable test outputs.
- No dependency/version changes or package builds. Original untracked user document SHA-256 values remain unchanged; existing `release/` artifacts were not modified. The entire v0.5 release is not yet complete.

## Task 3 progress — 2026-10-03

- Implementation commit: `b8e7b30`. Messages, streaming previews, model attempts and Run status rows share a timestamp-ordered, variable-height window with stable IDs, measured heights, six-row overscan and at most 80 mounted rows. Complete history remains persisted and accessible through native scrolling and earliest/latest navigation. Actual-model provenance and attempt-not-success wording remain intact.
- Reading uses a row-ID/pixel-offset anchor. Only readers within 80 px of the bottom follow new output. Pure viewport-height changes preserve bottom/read position without awaiting polling. Channel-key reset and observer disposal prevent inherited scroll state; preview replacement does not duplicate completed replies.
- Bound deltas display immediately while snapshot reads are coalesced per channel over 40 ms. Unknown bindings and terminal events still trigger immediate refresh, including a follow-up when an older read is in flight. Generation/Turn/step guards, consent/dispatch behavior and 750 ms polling remain intact; timers are cleared on lifecycle changes and deletion.
- Reproducible isolated fixture: 3,000 messages + 900 attempts + 300 completed Runs. Baseline mounted 4,200 rows / 24,000 DOM descendants; the final latest-position window mounted 7 rows / 62 descendants while snapshot IPC still returned all durable counts. Estimated scroll extent is refined as rows are visited. See `docs/V0.5_HISTORY_BENCHMARK.md`; different readiness markers and single development-host timing observations are not a controlled speed ratio or packaged-performance guarantee.
- Earlier full Electron verification exposed six failures from duplicate article roles on window wrappers and one from a 26 px leading-padding anchor offset. Both product issues were repaired without relaxing old assertions. Independent review also prompted timestamp ordering so long-history first tokens remain visible and explicit pure-height resize coverage.
- Final serial verification at the committed source: full single-worker unit suite 559/559 (102.67 seconds), type check, build and complete real Electron suite 42/42 (2.8 minutes). Independent review separately ran final window/provenance/store tests 45/45, type check and diff check; PASS locked to `ab95f3c..b8e7b30`, with no unresolved findings.
- Root re-inspected the four final earliest/middle/completed-stream/light-dark screenshots; visual QA passed. Real Electron coverage waits for actual preload delivery and durable Renderer counts before testing anchors, and checks first-token viewport visibility, cancellation/late events and channel changes.
- No dependency, database, IPC, version or package changes; no speculative lazy loading. Original user documents retain their SHA-256 and `release/` is untouched. Task 4 remains unstarted; trusted update hosting/signing configuration is still pending, and the entire v0.5 release is not complete.
