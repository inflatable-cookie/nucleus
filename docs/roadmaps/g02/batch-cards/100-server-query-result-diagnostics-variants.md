# 100 Server Query Result Diagnostics Variants

Status: completed
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

- [x] Diagnostics query results carry typed DTO/read-model records.
- [x] Empty diagnostics are explicit.
- [x] Result variants do not expose mutation methods.

## Outcome

- Added diagnostics query result variants and combined snapshot shape.
- Preserved explicit empty diagnostics.

## Validation

- [x] `cargo test -p nucleus-server diagnostics`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if result variants need durable storage ownership.
