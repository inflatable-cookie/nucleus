# 101 Request Handler Diagnostics Query Routing

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../024-diagnostics-control-api-query-surface.md`

## Purpose

Route diagnostics queries through the local request handler.

## Scope

- Handle steward, Effigy, sync, and SCM diagnostics queries.
- Return empty or unsupported diagnostics when source records are absent.
- Do not mutate local state.

## Acceptance Criteria

- Local handler returns diagnostics responses.
- Missing source records are explicit.
- Query handling does not write state.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo test -p nucleus-server request_handler`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if handler routing needs new source persistence contracts.
