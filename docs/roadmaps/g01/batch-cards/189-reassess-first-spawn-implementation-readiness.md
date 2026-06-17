# 189 Reassess First Spawn Implementation Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether first read-only host spawn implementation can start after local
host runtime discovery exists.

## Scope

- Check discovery vocabulary.
- Check unsupported fixture coverage.
- Check discovery-to-gate composition.
- Choose first spawn implementation or another explicit blocker lane.

## Out Of Scope

- Implementing process spawning.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- First spawn readiness is explicit.
- Remaining blockers are visible.
- Next lane is narrow and contract-backed.

## Closeout

- First spawn implementation is still blocked.
- Discovery and gate composition are ready, but all concrete local runtime
  backend implementations remain unselected.
- Next lane should compile the local runtime backend implementation runway
  before attempting a real process spawn.
