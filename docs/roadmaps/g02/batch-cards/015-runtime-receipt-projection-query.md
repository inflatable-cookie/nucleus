# 015 Runtime Receipt Projection Query

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Expose a read-only runtime receipt projection query through the server proof
API.

## Scope

- Receipt projection rebuild/read helper.
- Server query boundary.
- Compact response DTO if required by existing serialization.
- Focused query tests.

## Out Of Scope

- Live progress streaming.
- UI panel work.
- Provider transcript rendering.

## Promotion Targets

- `crates/nucleus-engine`
- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- [x] Runtime receipts can be queried after the read-only command proof path runs.
- [x] Query output includes receipt id, status, summary, and evidence/artifact
  refs.
- [x] Replay/query does not re-run command execution.

## Stop Conditions

- Query design requires final client protocol decisions.

## Outcome

Added typed runtime receipt query support through runtime metadata and compact
response DTOs.
