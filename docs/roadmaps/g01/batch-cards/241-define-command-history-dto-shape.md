# 241 Define Command History DTO Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the sanitized command history DTO shape.

## Scope

- Evidence id.
- Command request id.
- Status.
- Exit status.
- Retention mode.
- Sanitized summary.
- Artifact refs when present.

## Out Of Scope

- Raw stdout/stderr.
- Artifact payload retrieval.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-server`

## Acceptance Criteria

- Shape is safe for clients.
- Raw output fields are absent.
- Implementation cards stay bounded.

## Outcome

The history DTO contains evidence id, command request id, status, exit status,
retention, summary, and artifact refs only.
