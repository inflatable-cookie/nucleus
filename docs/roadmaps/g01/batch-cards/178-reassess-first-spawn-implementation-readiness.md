# 178 Reassess First Spawn Implementation Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether the first real read-only spawn implementation can start after
the readiness gate exists.

## Scope

- Check readiness gate results.
- Choose first spawn implementation or another blocker lane.
- Keep next lane narrow and contract-backed.

## Out Of Scope

- Implementing process spawning.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Host-spawn readiness is explicit.
- Remaining blockers are visible.
- Next lane is narrow and contract-backed.

## Closeout

- First real spawn implementation is not ready.
- The gate exists, but backend readiness is still too coarse.
- Next lane replaces backend booleans with typed readiness descriptors.
