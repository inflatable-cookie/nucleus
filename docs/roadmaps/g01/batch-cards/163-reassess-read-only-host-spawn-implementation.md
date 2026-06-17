# 163 Reassess Read Only Host Spawn Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether a real local read-only host-spawn implementation is ready.

## Scope

- Check supervisor boundary and event types.
- Check sandbox, output, artifact, timeout, and cancellation blockers.
- Choose the next narrow lane.

## Out Of Scope

- Implementing process spawning.
- Broadening command scopes.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Host-spawn readiness is explicit.
- Remaining blockers are visible.
- Next lane is narrow and contract-backed.

## Closeout

- Real host spawning remains blocked.
- Process supervisor events and acceptance are in place, but safety policy is
  not complete.
- Next lane is host execution safety and artifact policy.
