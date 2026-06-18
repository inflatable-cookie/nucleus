# 101 Request Handler Diagnostics Query Routing

Status: completed
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

- [x] Local handler returns diagnostics responses.
- [x] Missing source records are explicit.
- [x] Query handling does not write state.

## Outcome

- Routed diagnostics queries through the local request handler.
- Returned empty read-only diagnostics until source integration lands.

## Validation

- [x] `cargo test -p nucleus-server diagnostics`
- [x] `cargo test -p nucleus-server request_handler`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if handler routing needs new source persistence contracts.
