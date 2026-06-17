# 083 Effigy Command Inspection Validation

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Validate and close Effigy command-backed inspection.

## Scope

- Run focused Effigy, steward, engine, and docs validation.
- Confirm contracts match read-only Effigy command surfaces.
- Advance to management projection sync runtime.

## Acceptance Criteria

- Effigy inspection cards are complete or rehomed.
- Raw output exclusion is validated.
- Next ready card points to projection sync runtime.

## Validation

- `cargo test -p nucleus-native-harness`
- `cargo test -p nucleus-engine`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if Effigy execution requires new command authority contracts.
