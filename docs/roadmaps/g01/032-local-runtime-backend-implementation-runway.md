# 032 Local Runtime Backend Implementation Runway

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compile the implementation runway for concrete local runtime backends needed
before first real host process spawn.

## Scope

- Choose the first local sandbox backend slice.
- Choose the first local artifact store backend slice.
- Choose the first local event transport backend slice.
- Choose the first local process-control backend slice.
- Keep implementation sequencing behind the existing non-spawning gate.

## Out Of Scope

- Full terminal rendering.
- PTY management.
- Remote host execution.
- Desktop UI.

## Decisions

- First spawn is not ready yet.
- Runtime backend work should be introduced one backend at a time.
- The gate remains the authority for spawn readiness.
- Backend implementation order is artifact store, event transport, sandbox,
  process control, then first read-only spawn.
- Server module splits are a prerequisite because the host-spawn readiness and
  runtime support files are already crossing repo god-file thresholds.
- The first process-control slice must be read-only, finite-timeout,
  bounded-output, and non-PTY.

## Execution Plan

- [x] Compile local runtime backend implementation runway.
- [x] Define first local sandbox backend implementation slice.
- [x] Define first local artifact store backend implementation slice.
- [x] Define first local event transport backend implementation slice.
- [x] Define first local process-control backend implementation slice.
- [x] Reassess first read-only spawn implementation.

## Acceptance Criteria

- [x] First backend implementation sequence is explicit.
- [x] Each backend slice has a bounded acceptance surface.
- [x] First spawn remains blocked until all required backend slices are ready.
- [x] Next lane is a concrete backend implementation batch or another explicit
  blocker.

## Cards

- `docs/roadmaps/g01/batch-cards/190-compile-local-runtime-backend-implementation-runway.md`
- `docs/roadmaps/g01/batch-cards/191-define-first-local-sandbox-backend-slice.md`
- `docs/roadmaps/g01/batch-cards/192-define-first-local-artifact-store-backend-slice.md`
- `docs/roadmaps/g01/batch-cards/193-define-first-local-event-transport-backend-slice.md`
- `docs/roadmaps/g01/batch-cards/194-define-first-local-process-control-backend-slice.md`
- `docs/roadmaps/g01/batch-cards/195-reassess-first-read-only-spawn-implementation.md`

## Implementation Runway

Backend sequence:

1. Split server runtime readiness modules so backend work has clean ownership.
2. Implement local artifact-store backend readiness and sanitized metadata
   storage.
3. Implement in-process supervision event transport and replay wiring.
4. Implement first local sandbox readiness backend with unsupported fallback.
5. Implement first local process-control backend for read-only, finite-timeout,
   bounded-output commands.
6. Reassess first read-only spawn.

First backend slices:

- artifact store: filesystem-backed under server state root; supports sanitized
  summary and validation report payload refs first; keeps raw output and secret
  material out of default storage
- event transport: in-process event delivery plus replay through existing event
  storage vocabulary; supports running, terminal, and cleanup-failed
  supervision events first
- sandbox: unsupported/advisory fallback everywhere; first enforced profile is
  `NoFilesystemWrite`; platform support must be explicit before readiness can
  be marked ready
- process control: no shell passthrough, no PTY, no terminal rendering, no
  remote execution; finite timeout and bounded output are mandatory

## Closeout

- First spawn remains blocked.
- The next lane should split oversized server runtime modules before backend
  implementation starts.
