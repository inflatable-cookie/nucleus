# 174 Reassess Read Only Host Spawn Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether a first real read-only host-spawn slice is ready after safety,
artifact, timeout, and cancellation policy work.

## Scope

- Check sandbox enforcement posture.
- Check artifact payload retention policy.
- Check timeout and cancellation contract.
- Choose either first spawn implementation or another blocker lane.

## Out Of Scope

- Implementing process spawning.
- Broadening command scopes.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Host-spawn readiness is explicit.
- Any remaining blockers are visible.
- Next lane is narrow and contract-backed.

## Closeout

- Real process spawning remains blocked.
- Safety, artifact, timeout, and cancellation policy surfaces exist.
- No implementation backend proves sandbox enforcement, artifact payload
  storage, event transport, or process control yet.
- Next lane is non-spawning host-spawn readiness gate composition.
