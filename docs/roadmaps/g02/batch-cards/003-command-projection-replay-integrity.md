# 003 Command Projection Replay Integrity

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prove command-admission projection rebuild is deterministic and provenance
aware.

## Scope

- Rebuild command-admission projection through the repository boundary.
- Preserve last cursor/source event provenance.
- Add duplicate, malformed, and out-of-scope event tests where the current
  model can represent them.
- Keep replay side-effect free.

## Out Of Scope

- Full task timeline projection.
- Provider runtime stream replay.
- Background projector service.
- Live subscriptions.

## Promotion Targets

- `docs/contracts/018-orchestration-contract.md`
- `crates/nucleus-orchestration`
- `crates/nucleus-server`

## Acceptance Criteria

- [x] Replaying the same event set returns the same projection.
- [x] Projection provenance identifies the last source event or cursor.
- [x] Malformed records fail closed and do not silently reduce projection counts.

## Stop Conditions

- Replay invokes command execution, provider calls, SCM operations, or other
  external effects.

## Outcome

- Projection rebuild now reads through the event-store repository boundary.
- The server adapter returns event-store records in stable event-id order.
- Tests cover deterministic replay and malformed event payload rejection.
