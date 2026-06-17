# 027 Host Authority Map Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add first Rust vocabulary for engine hosts and project authority maps before
runtime execution work resumes.

## Scope

- Add host identity and host form types.
- Add project authority domain vocabulary.
- Add authority assignment/map types.
- Add readiness checks that distinguish host connection from authority.

## Out Of Scope

- Host registry persistence.
- Remote protocol.
- Embedded Tauri engine wiring.
- Runtime process spawning.
- Crate renaming.

## Decisions

- Execution authority is one project authority domain, not implicit in a
  connected host.
- `nucleus-server` may hold this vocabulary for now as host API/runtime
  boundary code until a future engine crate split is chosen.
- Process-supervisor work should resume only after execution authority can be
  represented.

## Execution Plan

- [x] Add host authority map Rust vocabulary.
- [x] Add host authority readiness checks.
- [x] Reassess process-supervisor lane.

## Acceptance Criteria

- [x] Host form and host id types compile.
- [x] Project authority domains are explicit.
- [x] Authority assignment can represent embedded, sidecar, remote
  authoritative, and remote worker hosts.
- [x] Runtime lane can check execution authority before process supervision.

## Cards

- `docs/roadmaps/g01/batch-cards/168-add-host-authority-map-rust-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/169-add-host-authority-readiness-checks.md`
- `docs/roadmaps/g01/batch-cards/170-reassess-process-supervisor-lane.md`

## Closeout

Host authority-map vocabulary is in place. The process-supervisor lane can
resume, but its acceptance skeleton must check execution authority before any
supervision acceptance path.
