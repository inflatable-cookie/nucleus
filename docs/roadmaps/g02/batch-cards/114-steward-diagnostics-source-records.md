# 114 Steward Diagnostics Source Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../027-diagnostics-read-model-source-integration.md`

## Purpose

Source steward diagnostics from available server-side steward records.

## Scope

- Read available steward command/proposal records.
- Return explicit empty state if records are not persisted yet.
- Do not create new persistence schemas.

## Acceptance Criteria

- Steward diagnostics use real source records when available.
- Missing source records are explicit.
- Query execution does not write records.

## Validation

- `cargo test -p nucleus-server steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source integration requires a new steward persistence contract.
