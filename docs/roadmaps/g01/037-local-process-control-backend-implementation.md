# 037 Local Process-Control Backend Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Implement the first local process-control backend slice for a read-only command
spawn runway.

## Scope

- Add local process-control backend implementation boundary.
- Represent spawn, timeout, cancellation, and cleanup readiness.
- Keep the first slice read-only and bounded-output only.
- Compose process-control readiness into local runtime discovery.
- Reassess first read-only spawn implementation readiness.

## Out Of Scope

- Shell passthrough.
- PTY or terminal rendering.
- Long-running interactive commands.
- Remote process execution.
- Write-enabled command profiles.

## Decisions

- Process control is the final backend before first read-only spawn because it
  crosses closest to child-process behavior.
- First readiness stays value-only; real spawn should be a separate lane after
  this descriptor is concrete.
- Timeout, cancellation, and cleanup readiness must all be explicit.

## Execution Plan

- [x] Add local process-control backend boundary.
- [x] Define read-only spawn control readiness.
- [x] Add process-control readiness discovery.
- [x] Compose process-control readiness with runtime discovery.
- [x] Reassess first read-only spawn implementation readiness.

## Closeout

The first local process-control backend slice is implemented in
`nucleus-server`.

Implemented surface:

- `LocalProcessControlBackend`
- `LocalProcessControlBackendId`
- `LocalProcessControlRuntime`
- `LocalProcessControlReadinessProfile`
- `with_local_process_control_readiness`

The backend can report concrete readiness for the first bounded read-only spawn
control profile. Spawn, finite timeout, cooperative cancellation, cleanup
failure reporting, shell passthrough exclusion, and PTY exclusion are explicit.

Runtime discovery can now replace the unsupported process-control descriptor
with concrete local readiness. With artifact store, event transport, sandbox,
and process-control readiness composed, the host-spawn readiness gate can
report ready without spawning.

The next lane is the first real read-only spawn implementation.

## Acceptance Criteria

- Process-control readiness can be concrete without spawning.
- Spawn, timeout, cancellation, and cleanup readiness are all represented.
- Host-spawn readiness can become ready when all backend descriptors are
  concrete.
- The next lane is explicit about whether real read-only spawn can begin.

## Cards

- `docs/roadmaps/g01/batch-cards/216-add-local-process-control-backend-boundary.md`
- `docs/roadmaps/g01/batch-cards/217-define-read-only-spawn-control-readiness.md`
- `docs/roadmaps/g01/batch-cards/218-add-process-control-readiness-discovery.md`
- `docs/roadmaps/g01/batch-cards/219-compose-process-control-readiness-with-runtime-discovery.md`
- `docs/roadmaps/g01/batch-cards/220-reassess-first-read-only-spawn-implementation.md`
