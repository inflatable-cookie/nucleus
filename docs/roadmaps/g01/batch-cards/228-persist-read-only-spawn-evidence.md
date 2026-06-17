# 228 Persist Read-Only Spawn Evidence

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Persist sanitized evidence from read-only spawn execution.

## Scope

- Use existing command evidence state helper.
- Store status, exit status, retention, and sanitized summary.
- Keep raw output out of persisted records.

## Out Of Scope

- Full artifact payload storage.
- Remote replay.
- UI event streaming.

## Promotion Targets

- `crates/nucleus-server`
- `apps/nucleusd`

## Acceptance Criteria

- Evidence survives store round-trip.
- Raw stdout/stderr are not persisted.
- Failure and timeout status remain visible.

## Closeout

The server helper writes the spawn boundary evidence through the existing
command evidence store.

Tests assert persisted records exclude raw stdout/stderr fields and the actual
smoke payload text. Evidence keeps status, exit status, retention mode, and a
sanitized summary.
