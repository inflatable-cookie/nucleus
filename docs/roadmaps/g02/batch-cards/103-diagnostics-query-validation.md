# 103 Diagnostics Query Validation

Status: planned
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

- Diagnostics control query cards are complete or rehomed.
- Read-only authority is preserved.
- Next ready card points to DTO serialization.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo test -p nucleus-server request_handler`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics query routing requires mutation authority.
