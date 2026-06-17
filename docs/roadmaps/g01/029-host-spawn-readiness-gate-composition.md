# 029 Host Spawn Readiness Gate Composition

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a non-spawning host-spawn readiness gate that composes authority, safety,
artifact, interruption, and supervisor acceptance checks.

## Scope

- Define a server-owned host-spawn readiness gate.
- Surface sandbox, artifact, event transport, timeout, cancellation, and
  process-control blockers.
- Keep the gate value-shaped and testable.
- Reassess whether a first real read-only spawn implementation can begin.

## Out Of Scope

- Child process spawning.
- OS sandbox implementation.
- Artifact payload storage implementation.
- Event transport implementation.
- Desktop UI.

## Decisions

- Real process spawning remains blocked.
- Policies now exist, but no implementation backend proves enforcement.
- The next runtime step is a composed readiness gate, not process control.

## Execution Plan

- [x] Add host-spawn readiness gate vocabulary.
- [x] Add host-spawn readiness gate tests.
- [x] Promote readiness gate surface into contracts.
- [x] Reassess first spawn implementation readiness.

## Acceptance Criteria

- [x] Readiness gate composes all known blockers.
- [x] Gate remains non-spawning.
- [x] Tests prove missing enforcement keeps spawn blocked.
- [x] Next lane is either first spawn implementation or another explicit blocker.

## Cards

- `docs/roadmaps/g01/batch-cards/175-add-host-spawn-readiness-gate-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/176-add-host-spawn-readiness-gate-tests.md`
- `docs/roadmaps/g01/batch-cards/177-promote-host-spawn-readiness-gate-surface.md`
- `docs/roadmaps/g01/batch-cards/178-reassess-first-spawn-implementation-readiness.md`
