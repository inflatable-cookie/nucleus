# 193 Define First Local Event Transport Backend Slice

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first concrete local process event transport backend slice.

## Scope

- Pick the first transport family for supervision events.
- Define delivery and replay evidence refs.
- Require running, terminal, and cleanup-failed event support.

## Out Of Scope

- Remote streaming.
- Full subscription backpressure handling.
- Desktop rendering.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-server`

## Acceptance Criteria

- First event transport backend slice is narrow.
- Required supervision events are explicit.
- Spawn remains blocked without the other required backends.

## Closeout

- First transport slice is in-process supervision event delivery.
- Replay must use existing server event/effect storage vocabulary.
- Required first event kinds are running, terminal, and cleanup-failed.
- Remote streaming and full subscription backpressure remain out of scope.
