# 238 Route CLI Read-Only Command Through Control Handler

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Route parsed CLI read-only command input through the local control handler.

## Scope

- Build `ServerCommandKind::ReadOnlyCommand`.
- Submit it through `LocalControlRequestHandler`.
- Preserve sanitized evidence persistence.

## Out Of Scope

- Direct calls to spawn helper from CLI.
- Desktop UI.
- Raw output printing.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- CLI path uses the control API boundary.
- Accepted command persists evidence.
- Rejected command does not spawn.

## Closeout

The CLI path builds `ServerCommandKind::ReadOnlyCommand` and submits it through
`LocalControlRequestHandler`.

It does not call the spawn helper directly.
