# 207 Add In-Process Supervision Event Channel Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add vocabulary for the first local in-process supervision event channel.

## Scope

- Represent delivery channel identity.
- Represent supported event kinds.
- Represent bounded in-process delivery posture.
- Keep replay as a metadata contract, not a full store.

## Out Of Scope

- Network streaming.
- Durable replay implementation.
- Process spawn.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Running, terminal, and cleanup-failed event kinds are represented.
- Delivery posture is testable without IO.
- Replay readiness remains explicit and separate.
