# 039 Read-Only Spawn Server Integration

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Wire the read-only spawn boundary into the server command runner surface and
smoke path.

## Scope

- Add a server-owned read-only spawn request helper.
- Build the local readiness descriptor stack for the smoke path.
- Persist sanitized spawn evidence through existing command evidence storage.
- Expose a narrow `nucleusd` smoke command for real read-only spawn.
- Reassess next command runner expansion.

## Out Of Scope

- General command execution API.
- Desktop UI controls.
- PTY or interactive terminal support.
- Write-enabled commands.
- Remote execution.

## Decisions

- The first real spawn should become reachable through a small server smoke
  path before expanding the command runner.
- The existing non-spawning smoke command should remain available until the new
  path is stable.
- Stored evidence must stay sanitized.

## Execution Plan

- [x] Add server read-only spawn helper.
- [x] Build local readiness stack for smoke execution.
- [x] Persist sanitized spawn evidence.
- [x] Add `nucleusd` read-only spawn smoke command.
- [x] Reassess command runner expansion.

## Acceptance Criteria

- `nucleusd` can run one bounded read-only smoke command.
- Host readiness still gates execution.
- Evidence is persisted through the existing command evidence store.
- Raw output is not persisted by default.
- Next expansion is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/226-add-server-read-only-spawn-helper.md`
- `docs/roadmaps/g01/batch-cards/227-build-local-readiness-stack-for-smoke.md`
- `docs/roadmaps/g01/batch-cards/228-persist-read-only-spawn-evidence.md`
- `docs/roadmaps/g01/batch-cards/229-add-nucleusd-read-only-spawn-smoke.md`
- `docs/roadmaps/g01/batch-cards/230-reassess-command-runner-expansion.md`

## Closeout

Implemented the first server-owned real read-only spawn smoke path.

- `run_server_read_only_spawn` calls the bounded local spawn boundary and
  persists sanitized command evidence.
- `build_local_read_only_spawn_smoke_input` composes local artifact, event
  transport, sandbox, process-control, supervisor, interruption, and authority
  readiness for one fixed smoke command.
- `nucleusd command-runner read-only-spawn-smoke` runs a structured `printf`
  invocation through the server helper.
- Effigy exposes the smoke path as
  `server:command-runner:read-only-spawn-smoke`.
- Raw stdout/stderr are not printed or persisted; only byte counts, truncation
  state, exit status, events count, and sanitized evidence summary are exposed.

Next expansion should define the control API request/admission shape for
read-only commands before accepting arbitrary client-supplied invocations.
