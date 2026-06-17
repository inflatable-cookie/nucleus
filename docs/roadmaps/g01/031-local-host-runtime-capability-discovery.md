# 031 Local Host Runtime Capability Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add non-spawning local host runtime capability discovery that produces backend
readiness descriptors from real host state.

## Scope

- Discover sandbox backend capability without enforcing a sandbox.
- Discover artifact store backend capability without storing payload bytes.
- Discover event transport backend capability without publishing events.
- Discover process-control backend capability without spawning processes.
- Feed discovered descriptors into the host-spawn readiness gate.

## Out Of Scope

- Child process spawning.
- OS sandbox implementation.
- Artifact payload storage implementation.
- Event transport implementation.
- Desktop UI.

## Decisions

- First spawn implementation remains blocked.
- Backend descriptors exist, but they need a host discovery source.
- Discovery must be honest and may report unsupported/advisory capability.

## Execution Plan

- [x] Add local host runtime capability discovery vocabulary.
- [x] Add discovery fixture for unsupported local host.
- [x] Add discovery-to-gate composition.
- [x] Promote discovery boundary into contracts.
- [x] Reassess first spawn implementation readiness.

## Acceptance Criteria

- [x] Discovery produces descriptor values.
- [x] Unsupported capability keeps spawn blocked.
- [x] Discovery remains non-spawning.
- [x] Next lane is either first spawn implementation or another explicit blocker.

## Cards

- `docs/roadmaps/g01/batch-cards/185-add-local-host-runtime-discovery-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/186-add-unsupported-local-host-discovery-fixture.md`
- `docs/roadmaps/g01/batch-cards/187-compose-discovery-output-with-host-spawn-gate.md`
- `docs/roadmaps/g01/batch-cards/188-promote-local-host-runtime-discovery-boundary.md`
- `docs/roadmaps/g01/batch-cards/189-reassess-first-spawn-implementation-readiness.md`

## Closeout

- Added local host runtime discovery vocabulary.
- Added deterministic unsupported local host discovery fixture.
- Added discovery-to-gate composition.
- Promoted the boundary into the server contract.
- First spawn implementation remains blocked until concrete local sandbox,
  artifact store, event transport, and process-control backend choices are
  sequenced behind the gate.
