# 195 Reassess First Read-Only Spawn Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether the first read-only host process spawn implementation can
start after backend implementation slices are defined.

## Scope

- Check sandbox backend slice.
- Check artifact store backend slice.
- Check event transport backend slice.
- Check process-control backend slice.
- Choose first spawn implementation or another explicit blocker.

## Out Of Scope

- Implementing the spawn itself.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- First spawn readiness is explicit.
- Remaining blockers are visible.
- Next lane is narrow and contract-backed.

## Closeout

- First read-only spawn is still blocked.
- Remaining blocker is not missing concept coverage; it is implementation
  readiness plus module ownership.
- Next lane should split oversized server runtime modules before adding
  concrete backend implementation.
