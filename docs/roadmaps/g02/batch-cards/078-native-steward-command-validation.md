# 078 Native Steward Command Validation

Status: completed
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

- [x] All 019 cards are completed or explicitly rehomed.
- [x] Contracts match implemented command-boundary records.
- [x] Next ready card points to Effigy inspection.

## Outcome

- Validated native steward command records, admission, receipt linkage, and
  server request-handler boundaries.
- Confirmed the first server boundary admits native steward commands without
  live steward execution.
- Advanced the runway to `020-effigy-command-backed-inspection.md`.

## Validation

- [x] `cargo test -p nucleus-native-harness`
- [x] `cargo test -p nucleus-engine`
- [x] `cargo test -p nucleus-server`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if command-backed inspection needs new authority contracts.
