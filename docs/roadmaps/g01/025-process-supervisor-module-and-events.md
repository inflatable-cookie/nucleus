# 025 Process Supervisor Module And Events

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare the process supervisor module boundary and event publication shape
without spawning child processes.

## Scope

- Draft a process supervisor module boundary.
- Define event payloads for accepted, blocked, running, terminal, and cleanup
  failed supervision states.
- Keep event payloads evidence-ref based and raw-output free.
- Keep sandbox enforcement blockers visible.

## Out Of Scope

- Child process spawning.
- PTY streaming.
- Raw artifact payload storage.
- Network, secret, destructive, SCM mutation, or provider lifecycle commands.
- Desktop UI.

## Decisions

- The next runtime step is not spawn. It is the module and event boundary that
  will make spawn observable and testable.
- Event records may point at command evidence; they must not copy stdout/stderr.
- Sandbox enforcement remains the main blocker for a true `NoFilesystemWrite`
  host-spawn path.
- This lane is paused until the engine-first host authority model is promoted
  through architecture and contracts.
- Host authority-map vocabulary now exists. This lane may resume, but process
  supervisor acceptance must check execution authority before accepting work.

## Execution Plan

- [x] Draft process supervisor module and event boundary.
- [x] Add process supervision event types.
- [x] Add process supervisor acceptance skeleton.
- [x] Reassess first read-only host-spawn implementation.

## Acceptance Criteria

- [x] Process supervisor boundary is separate from command authority.
- [x] Process supervision events carry refs, not raw output.
- [x] Acceptance skeleton does not spawn child processes.
- [x] Host-spawn readiness remains explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/160-draft-process-supervisor-module-and-event-boundary.md`
- `docs/roadmaps/g01/batch-cards/161-add-process-supervision-event-types.md`
- `docs/roadmaps/g01/batch-cards/162-add-process-supervisor-acceptance-skeleton.md`
- `docs/roadmaps/g01/batch-cards/163-reassess-read-only-host-spawn-implementation.md`
