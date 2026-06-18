# 100 Server Query Result Diagnostics Variants

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../024-diagnostics-control-api-query-surface.md`

## Purpose

Return diagnostics read models through typed server query result variants.

## Scope

- Add steward, Effigy, sync, and SCM diagnostics result variants.
- Keep result variants read-only.
- Preserve empty and unsupported outcomes.

## Acceptance Criteria

- Diagnostics query results carry typed DTO/read-model records.
- Empty diagnostics are explicit.
- Result variants do not expose mutation methods.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if result variants need durable storage ownership.
