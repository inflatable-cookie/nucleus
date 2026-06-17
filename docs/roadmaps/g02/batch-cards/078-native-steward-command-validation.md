# 078 Native Steward Command Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../019-native-steward-command-boundary.md`

## Purpose

Validate and close the native steward command boundary milestone.

## Scope

- Run focused native harness, engine, server, and docs validation.
- Reconcile contracts with command record surfaces.
- Advance the runway to Effigy command-backed inspection.

## Acceptance Criteria

- All 019 cards are completed or explicitly rehomed.
- Contracts match implemented command-boundary records.
- Next ready card points to Effigy inspection.

## Validation

- `cargo test -p nucleus-native-harness`
- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if command-backed inspection needs new authority contracts.
