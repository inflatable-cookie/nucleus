# 083 Effigy Command Inspection Validation

Status: completed
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

- [x] Effigy inspection cards are complete or rehomed.
- [x] Raw output exclusion is validated.
- [x] Next ready card points to projection sync runtime.

## Outcome

- Validated the native harness, engine, docs, and roadmap pointer surfaces.
- Closed Effigy command-backed inspection without adding command authority.
- Advanced the next ready card to management projection sync runtime.

## Validation

- [x] `cargo test -p nucleus-native-harness`
- [x] `cargo test -p nucleus-engine`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if Effigy execution requires new command authority contracts.
