# 103 Diagnostics Query Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../024-diagnostics-control-api-query-surface.md`

## Purpose

Validate and close diagnostics control API query surface.

## Scope

- Run focused server and docs validation.
- Confirm query path is read-only.
- Advance to diagnostics DTO serialization.

## Acceptance Criteria

- [x] Diagnostics control query cards are complete or rehomed.
- [x] Read-only authority is preserved.
- [x] Next ready card points to DTO serialization.

## Outcome

- Validated diagnostics query routing, request-handler tests, docs, and
  roadmap pointer state.
- Advanced the next ready card to diagnostics DTO serialization.

## Validation

- [x] `cargo test -p nucleus-server diagnostics`
- [x] `cargo test -p nucleus-server request_handler`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if diagnostics query routing requires mutation authority.
