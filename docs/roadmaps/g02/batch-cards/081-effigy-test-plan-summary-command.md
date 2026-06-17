# 081 Effigy Test Plan Summary Command

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Map `effigy test --plan` evidence into validation-plan summaries.

## Scope

- Add validation-plan command summary records.
- Preserve planned-only semantics.
- Link selectors, receipt refs, and evidence refs.

## Acceptance Criteria

- [x] A test plan can list selectors without claiming execution.
- [x] Execution requires a separate command or Effigy receipt.
- [x] Raw plan output is excluded from durable task history.

## Outcome

- Added test-plan command summary records.
- Preserved planned-only semantics for `effigy test --plan`.
- Marked execution claims as out of scope for plan summaries.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo test -p nucleus-engine runtime_receipt`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if plan capture is treated as test execution.
