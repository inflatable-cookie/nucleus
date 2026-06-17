# 159 Reassess First Host Spawn Slice

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether Nucleus is ready for a first real local read-only host-spawn
implementation.

## Scope

- Review process supervision contract and readiness types.
- Check storage, evidence, query, timeout, cancellation, sandbox, and output
  behavior.
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

- Host process spawning remains blocked.
- Remaining blockers are sandbox enforcement, event publication, artifact
  payload policy, timeout/cancellation proof, and process supervisor module
  separation.
- The next lane is process supervisor module and event boundary preparation.
