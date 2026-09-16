# Task 2 report — project and channel persistence

## Work completed

- Added main-process SQLite persistence with `better-sqlite3` and Drizzle, including an idempotent v1 migration for `projects` and `channels`, a foreign key, and a channel-project index.
- Added dependency-injected database and repository factories. Tests create isolated temporary database files rather than sharing the app database.
- Added workspace-root validation using read access, `realpath`, and directory verification. The canonical root is what reaches the repository.
- Registered main-process handlers for project and channel list/create. Project browsing is opt-in via `browseForWorkspace`; selected native-dialog paths are revalidated before storage.
- Left all file-write, command-execution, model, credential, and renderer work out of this task.

## TDD evidence

### RED

Command:

```powershell
npm test -- tests/unit/workspace-validator.test.ts tests/unit/project-repository.test.ts
```

The first sandboxed attempt could not load Vitest's config. The same command in the permitted local execution environment reached the intended RED state:

```text
Failed to load url ../../electron/database/client
Failed to load url ../../electron/core/workspace-validator
Test Files  2 failed (2)
```

### GREEN

After implementing the migration, validator, repositories, and handler registration:

```powershell
npm test -- tests/unit/workspace-validator.test.ts tests/unit/project-repository.test.ts
```

```text
Test Files  2 passed (2)
Tests  5 passed (5)
```

An additional IPC persistence test was mutation-checked. With the `channels` INSERT temporarily removed, it failed as expected because only the initial channel remained; the INSERT was restored before final verification.

```text
Tests  1 failed | 3 passed (4)
expected [ initial channel ] to deeply equal [ initial channel, created channel ]
```

## Final verification

```powershell
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Results:

```text
Test Files  3 passed (3)
Tests  7 passed (7)
TypeScript exited 0
electron-vite build exited 0
git diff --check exited 0
```

Also ran a short Electron main-process smoke test that opens and closes an in-memory `better-sqlite3` database; it exited 0, confirming the native module loads in the installed Electron runtime.

## Self-review

- Project creation and its initial channel are inserted in a single SQLite transaction.
- `channels.project_id` references `projects.id`, and list queries filter by exact project ID.
- Only the main process opens SQLite, accesses the filesystem, or opens the native picker.
- The IPC handler calls the same validator for both typed paths and picker results; it stores only a canonical root.
- The directory picker is not called for an ordinary typed `workspacePath`.
- Existing untracked files in `docs/` were not modified or staged.

## Concerns

- Vitest emits Vite's existing CJS Node API deprecation warning. It did not affect test, type-check, or build exit status.
- Database lifetime ends with the main process in this increment; an explicit close hook is not needed for the v0.1 process lifecycle and was not added outside task scope.
