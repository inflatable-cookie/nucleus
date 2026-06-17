# 023 Command Evidence Persistence And Query

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Persist and query sanitized command evidence before expanding local command
execution beyond the gate-only runner skeleton.

## Scope

- Add a server helper for writing sanitized command evidence records.
- Use the command evidence storage codec from `nucleus-command-policy`.
- Route the fixed `nucleusd` command-runner smoke evidence through local state.
- Query command evidence through existing runtime metadata surfaces.
- Keep process spawning blocked.

## Out Of Scope

- Host process spawning.
- Shell passthrough.
- PTY streaming.
- Raw stdout/stderr artifact payload storage.
- Network, secret, destructive, SCM mutation, or provider lifecycle commands.
- Desktop UI.

## Decisions

- Command evidence should survive restart before command execution expands.
- Runner smoke evidence should use the same state path as other `nucleusd`
  smoke state when one is provided.
- Query output may show evidence metadata, not raw process output.
- The next process-execution decision depends on evidence persistence, timeout,
  cancellation, artifact, sandbox, and event publication behavior.

## Execution Plan

- [x] Add command evidence state write helper.
- [x] Persist `nucleusd` command-runner smoke evidence.
- [x] Add command evidence query output.
- [x] Reassess host process spawning readiness.

## Acceptance Criteria

- [x] Sanitized command evidence can be written to local server state.
- [x] Command evidence survives local state restart.
- [x] `nucleusd` can print command evidence records without raw output.
- [x] Host process spawning remains blocked until reassessment.

## Cards

- `docs/roadmaps/g01/batch-cards/152-add-command-evidence-state-write-helper.md`
- `docs/roadmaps/g01/batch-cards/153-persist-nucleusd-command-runner-smoke-evidence.md`
- `docs/roadmaps/g01/batch-cards/154-add-command-evidence-query-output.md`
- `docs/roadmaps/g01/batch-cards/155-reassess-host-process-spawning-readiness.md`

## Closeout

Command evidence now has a local server write helper, fixed `nucleusd`
runner-smoke persistence, and sanitized query output.

Host process spawning remains blocked. The next lane is local process
supervision readiness.
