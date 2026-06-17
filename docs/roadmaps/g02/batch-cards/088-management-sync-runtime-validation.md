# 088 Management Sync Runtime Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../021-management-projection-sync-runtime.md`

## Purpose

Validate and close management projection sync runtime.

## Scope

- Run focused engine, native harness, and docs validation.
- Confirm contracts match sync plan and assistance surfaces.
- Advance to SCM working session runtime.

## Acceptance Criteria

- Projection sync runtime cards are complete or rehomed.
- No import flow silently overwrites task meaning.
- Next ready card points to SCM session runtime.

## Validation

- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-native-harness`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if SCM provider mutation is required.
