# 030 Host Runtime Backend Readiness Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Replace coarse host-spawn backend booleans with typed readiness descriptors
before any real process spawning.

## Scope

- Add sandbox backend readiness descriptors.
- Add artifact store backend readiness descriptors.
- Add process event transport readiness descriptors.
- Add process-control backend readiness descriptors.
- Rewire the host-spawn readiness gate to use descriptors instead of booleans.

## Out Of Scope

- Child process spawning.
- OS sandbox implementation.
- Artifact payload storage implementation.
- Event transport implementation.
- Desktop UI.

## Decisions

- First spawn implementation is not ready.
- The gate exists, but backend readiness is still too coarse.
- Backend descriptors must carry enough evidence for diagnostics and future
  implementation checks.

## Execution Plan

- [x] Add sandbox backend readiness descriptor.
- [x] Add artifact store backend readiness descriptor.
- [x] Add event transport backend readiness descriptor.
- [x] Add process-control backend readiness descriptor.
- [x] Rewire host-spawn readiness gate to descriptors.
- [x] Reassess first spawn implementation readiness.

## Acceptance Criteria

- [x] Backend readiness is typed, not boolean-only.
- [x] Gate blockers cite concrete backend descriptor state.
- [x] Gate remains non-spawning.
- [x] Next lane is either first spawn implementation or another explicit blocker.

## Cards

- `docs/roadmaps/g01/batch-cards/179-add-sandbox-backend-readiness-descriptor.md`
- `docs/roadmaps/g01/batch-cards/180-add-artifact-store-backend-readiness-descriptor.md`
- `docs/roadmaps/g01/batch-cards/181-add-event-transport-backend-readiness-descriptor.md`
- `docs/roadmaps/g01/batch-cards/182-add-process-control-backend-readiness-descriptor.md`
- `docs/roadmaps/g01/batch-cards/183-rewire-host-spawn-gate-to-backend-descriptors.md`
- `docs/roadmaps/g01/batch-cards/184-reassess-first-spawn-implementation-readiness.md`
